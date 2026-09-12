import { envMs, withTimeout, type TimeoutGuard } from '../util/abort'
import { bridgePathInfo, resilient, type EndpointSink } from '../util/resilience'
import type { WsiInfo, WsiRegion, WsiThumbnail, WsiTissueMask } from './wsiTypes'

/** 桥接**单次 HTTP** 的默认墙钟上限（env `PATHASK_BRIDGE_TIMEOUT_MS`，默认 300_000）。
 *  取值依据：实测最慢的**合法**路径是 4.95GP 单层巨片冷重算组织掩膜 ≈205s，5min 是其 ~1.5×
 *  ——超时是「抓死锁」不是「压性能」。比工具预算(300~420s)略小是刻意的：
 *  桥端先于工具预算到点，错误能落到 BRIDGE_TIMEOUT 而不是笼统的 TOOL_TIMEOUT。 */
export const DEFAULT_BRIDGE_TIMEOUT_MS = 300_000

/**
 * WSI 桥接客户端：对 wsi-bridge/server.py（OpenSlide FastAPI 服务）的 TS 封装。
 * 所有读取都在桥端完成，本客户端只做 HTTP + 坐标/倍率换算。
 */
/** 归一化 slide_id 后写入 URL path 段：剥掉目录前缀（lastIndexOf('/') 之后），
 *  否则含 `/` 的 id（如 histai/HISTAI-mixed/case_00001）会让 Starlette 在路由前解码 %2F → 路径断裂，
 *  {slide_id} 只取到第一个 `/` 前 → 404 → 读图工具全失败 → 0 证据弃诊。
 *  注意：这里不剥文件扩展名（.tiff 的去扩展名由 resolveWsiId 与桥端 _resolve 处理），只保证 URL 段无斜杠。 */
function normalizeSlideId(slideId: string): string {
  const i = slideId.lastIndexOf('/')
  return i >= 0 ? slideId.slice(i + 1) : slideId
}

export class WsiClient {
  /** `sink`：分端点观测（Step 0）。不传则只走熔断、不记耗时（探针/脚本用裸 WsiClient 的情形）。 */
  constructor(
    readonly baseUrl = process.env.PATHASK_BRIDGE_URL ?? 'http://127.0.0.1:8787',
    private readonly sink?: EndpointSink,
  ) {}

  /** MIL 推理：在线抽特征（复用桥端掩膜+CONCH 缓存）→ RRTMIL 权重 → slide 级预测。 */
  async milInference(slideId: string, capabilityId: string, maxPatches?: number, signal?: AbortSignal): Promise<MilPrediction> {
    return this.post('/mil', { slide_id: slideId, capability_id: capabilityId, max_patches: maxPatches }, signal)
  }

  private bridgeTimeoutMs(): number {
    return envMs('PATHASK_BRIDGE_TIMEOUT_MS', DEFAULT_BRIDGE_TIMEOUT_MS)
  }

  /** 桥接调用失败的重写：**本层加的超时由本层认领**。
   *  裸 `TimeoutError` 的 message 是 "The operation was aborted due to timeout"，不含任何层信息
   *  → 分类器只能落到笼统的 TOOL_TIMEOUT，「怎么改」也就指错了方向（桥端无响应 ≠ 工具逻辑/参数问题）。
   *  重写成「WSI 桥接超时 …」后 `guessPhase` 判 bridge → BRIDGE_TIMEOUT。
   *  ⚠️ 调用方 signal 的中止**原样放行**：两者可能同时成立，中止语义优先（ABORTED 不能被改写吞掉）。 */
  private bridgeError(err: unknown, path: string, guard: TimeoutGuard, caller?: AbortSignal): Error {
    if (!caller?.aborted && guard.timedOut()) {
      return new Error(`WSI 桥接超时 ${this.bridgeTimeoutMs()}ms 无响应: ${path}`)
    }
    return err instanceof Error ? err : new Error(String(err))
  }

  /** 所有桥接调用都接受可选 signal（2026-09-10）：此前 `get`/`post` 是**裸 fetch，连 signal 都不传**
   *  → agent.abort() / 工具预算 都掐不断在途 HTTP，工具「跑一半挂了」只能干等。调用方传 ctx.signal。
   *
   *  无 signal 时也必须带上限（2026-09-11）：那种情况下此前只能靠 undici 自身 ~300s 默认值兜底，
   *  且抛的是 undici 内部错误 → 分类器只能判 UNKNOWN。现在超时由本层掌控（`bridgeError` 认领）
   *  → BRIDGE_TIMEOUT，且**工具预算之外也成立**（health、runner 的 sys-* 系统调用同样有界）。 */
  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const info = bridgePathInfo(path)
    // Step 0/1：分端点观测 + 熔断。熔断中**不发请求**（这才是「桥挂掉不必每个病例各付 300s」的落点）。
    // scope 从 URL 里的 slide id 取——超时类失败按片子分片，避免一张病态巨片判死整个服务。
    return resilient({ endpoint: 'bridge', op: info.op, scope: info.scope, sink: this.sink }, async () => {
      const guard = withTimeout(signal, this.bridgeTimeoutMs())
      let res: Response
      try {
        res = await fetch(`${this.baseUrl}${path}`, { signal: guard.signal })
      } catch (err) {
        throw this.bridgeError(err, path, guard, signal)
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`WSI 桥接 ${res.status}: ${body || path}`)
      }
      return res.json() as Promise<T>
    })
  }

  private async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const info = bridgePathInfo(path)
    return resilient({ endpoint: 'bridge', op: info.op, scope: info.scope, sink: this.sink }, async () => {
      const guard = withTimeout(signal, this.bridgeTimeoutMs())
      let res: Response
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: guard.signal,
        })
      } catch (err) {
        throw this.bridgeError(err, path, guard, signal)
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`WSI 桥接 POST ${res.status}: ${text || path}`)
      }
      return res.json() as Promise<T>
    })
  }

  /** 桥接服务是否可用（真实 WSI 路径的总开关） */
  async health(): Promise<{ status: string; slides: number }> {
    return this.get('/health')
  }

  async info(slideId: string, signal?: AbortSignal): Promise<WsiInfo> {
    return this.get(`/slides/${encodeURIComponent(normalizeSlideId(slideId))}/info`, signal)
  }

  async thumbnail(slideId: string, maxDim = 1024, signal?: AbortSignal): Promise<WsiThumbnail> {
    return this.get(`/slides/${encodeURIComponent(normalizeSlideId(slideId))}/thumbnail?max_dim=${maxDim}`, signal)
  }

  async tissueMask(slideId: string, maxDim = 2048, signal?: AbortSignal): Promise<WsiTissueMask> {
    return this.get(`/slides/${encodeURIComponent(normalizeSlideId(slideId))}/tissue-mask?max_dim=${maxDim}`, signal)
  }

  async readRegion(slideId: string, x: number, y: number, w: number, h: number, level: number, signal?: AbortSignal): Promise<WsiRegion> {
    return this.get(
      `/slides/${encodeURIComponent(normalizeSlideId(slideId))}/region?x=${Math.round(x)}&y=${Math.round(y)}&w=${Math.round(w)}&h=${Math.round(h)}&level=${level}`,
      signal,
    )
  }

  /** 目标倍率 → 最接近的 OpenSlide 层级。base=objective_power（如 40×），downsample[d] 为该层下采样倍数。 */
  levelForMagnification(info: WsiInfo, objective: number, mag: number): number {
    const target = objective / mag
    let best = 0
    let bestDiff = Infinity
    for (let d = 0; d < info.level_downsamples.length; d++) {
      const diff = Math.abs(info.level_downsamples[d] - target)
      if (diff < bestDiff) {
        bestDiff = diff
        best = d
      }
    }
    return best
  }

  /** PLIP 编码：图片（本地路径或 data-uri）与/或文本 → 归一化向量。 */
  async embed(images: string[] = [], texts: string[] = [], signal?: AbortSignal): Promise<{ image_vectors?: number[][]; text_vectors?: number[][] }> {
    return this.post('/embed', { images, texts }, signal)
  }

  /** CONCH 编码：图片/文本 → 归一化向量（detect_roi 检索首选，病理专用双塔 512 维）。 */
  async conchEmbed(images: string[] = [], texts: string[] = [], signal?: AbortSignal): Promise<{ image_vectors?: number[][]; text_vectors?: number[][] }> {
    return this.post('/conch-embed', { images, texts }, signal)
  }

  /** CONCH 未归一化特征（STREAM MIL 训练特征协议，ln_contrast 池化）——run_mil 特征抽取用。 */
  async conchEmbedRaw(images: string[], signal?: AbortSignal): Promise<{ image_vectors: number[][] }> {
    return this.post('/conch-embed-raw', { images }, signal)
  }
}

/** run_mil 推理结果（POST /mil 返回结构）。 */
export interface MilPrediction {
  label: string
  confidence: number
  probs: Record<string, number>
  num_patches: number
  attention_hotspots: { x: number; y: number; attn: number }[]
  model_arch: string
  capability_id?: string
  total_candidates?: number
  elapsed_ms?: number
}
