/**
 * 端点级韧性：**分端点观测** + **熔断**。
 *
 * 【为什么有这一步】超时治理「有界但不自适应」：每个工具一个固定墙钟，到点即降级，但**没有跨调用的
 * 健康状态**。桥接挂死时，每个后续病例都要各自再付一次 300s 才拿到同样的结论。
 *
 * 【三条设计取舍，都是刻意的】
 *  1. **只动失败路径**。成功路径的预算与语义一字不改 → 跑次之间仍可比（评测靠锁 env 快照，
 *     浮动预算等于把「同配置可复现」的地板抽掉）。
 *  2. **连接类失败 ≠ 超时类失败**。
 *     - 连接被拒/重置：**关于服务健康的无歧义证据** → 直接记服务级熔断。
 *     - 超时：**模糊证据**（可能是这张巨片慢，不是服务死了）→ 只记 `(端点, slide)` 级；
 *       只有**跨片子**在窗口内累计够多张都超时，才升级为服务级。否则一张病态巨片能把整个服务判死、
 *       误伤后面所有病例。
 *  3. **只有瞬时类计数**。HTTP 4xx、参数错、EISDIR 这类业务/代码错误**不进熔断**——那是数据问题不是健康信号。
 *     把业务失败当健康信号是这类机制的经典自伤：一个坏 id 就能把整条链熔断。
 *     判定复用 `classifyToolError` → **模型看到的 code 与熔断计的数是同一个判定**，不会两套真相。
 *
 * 【与重试预算的关系】两者**独立**，各做一件事，不互相触发：
 *  - 熔断负责「别再付墙钟」（跨病例、进程级）；
 *  - 预算负责「别再说同一句话」（病例级、只改给模型的文本）。
 *  实践上它们大致同时到点（连续 3 次瞬时失败既耗尽默认预算、也到熔断阈值），但把它们耦合起来会让
 *  「一次个案预算耗尽」误伤全局健康状态，所以不耦合。
 */
import { classifyToolError, isDeliberateAbort, type ToolErrorCode } from '../tools/toolErrors'

export type EndpointKey = 'bridge' | 'vlm' | 'llm'

/** 分端点观测的回调（metrics 结构化实现即可；探针/脚本可不传）。 */
export interface EndpointSink {
  endpointCall(endpoint: string, op: string, ms: number, outcome: 'ok' | 'fail' | 'blocked'): void
}

/** 熔断拒绝时的**措辞**——这是**契约**，必须与 `toolErrors.codeFromMessage` 的词表逐字对应，
 *  所以刻意写成字面量而**不是**由标签拼出来。 */
const REJECT_PHRASE: Record<EndpointKey, string> = {
  bridge: 'WSI 桥接不可用',
  vlm: 'Patho-R1 vLLM 不可用',
  llm: '决策 LLM 不可用',
}

/** 熔断拒绝时抛的 code（必须是 CATALOG 里已有的，且 `codeFromMessage` 认得出——见本文件末的措辞约束）。 */
const REJECT_CODE: Record<EndpointKey, ToolErrorCode> = {
  bridge: 'BRIDGE_UNAVAILABLE',
  vlm: 'VLM_UNREACHABLE',
  llm: 'LLM_UNREACHABLE',
}

function numEnv(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

interface BreakerCfg {
  threshold: number
  cooldownMs: number
  maxCooldownMs: number
  slideEscalation: number
  windowMs: number
}

/** ⚠️ 每次调用时读 env（与 `envMs`/`resolveToolBudgetMs` 同一约定）——探针可以临时改 env 生效。 */
function cfg(): BreakerCfg {
  return {
    threshold: numEnv('PATHASK_BREAKER_THRESHOLD', 3),
    cooldownMs: numEnv('PATHASK_BREAKER_COOLDOWN_MS', 30_000),
    maxCooldownMs: numEnv('PATHASK_BREAKER_MAX_COOLDOWN_MS', 300_000),
    slideEscalation: numEnv('PATHASK_BREAKER_SLIDE_ESCALATION', 3),
    windowMs: numEnv('PATHASK_BREAKER_WINDOW_MS', 120_000),
  }
}

/** 单条熔断状态机：closed →（连续 N 次失败）→ open →（冷却到点）→ half-open 单探测 → closed / 重开。 */
class Breaker {
  private consecutive = 0
  private open = false
  private openedAt = 0
  private cooldownMs = 0
  private probeInFlight = false
  /** 熔断次数（观测用；连续开关会推高它） */
  trips = 0

  /** 放行？冷却到点后**只放一个探测**过，其余继续拒绝。 */
  tryPass(now: number, c: BreakerCfg): { ok: true; probe: boolean } | { ok: false; retryAfterMs: number } {
    if (!this.open) return { ok: true, probe: false }
    const wait = this.openedAt + this.cooldownMs - now
    if (wait > 0) return { ok: false, retryAfterMs: wait }
    if (this.probeInFlight) return { ok: false, retryAfterMs: this.cooldownMs }
    this.probeInFlight = true
    return { ok: true, probe: true }
  }

  onSuccess(): void {
    this.consecutive = 0
    this.open = false
    this.openedAt = 0
    this.cooldownMs = 0
    this.probeInFlight = false
  }

  onFailure(now: number, c: BreakerCfg): void {
    this.probeInFlight = false
    if (this.open) {
      // half-open 探测失败 → 重开，冷却翻倍（退避就在这里，**不在工具层 sleep**：
      // 工具里睡会从工具预算里扣，变成「预算花在等」而不是「花在干活」，还会污染 partial 的 k/n）
      this.cooldownMs = Math.min(this.cooldownMs * 2, c.maxCooldownMs)
      this.openedAt = now
      return
    }
    this.consecutive += 1
    if (this.consecutive >= c.threshold) {
      this.open = true
      this.openedAt = now
      this.cooldownMs = c.cooldownMs
      this.trips += 1
    }
  }

  /** 显式熔断（超时类跨片升级用）。 */
  trip(now: number, c: BreakerCfg): void {
    if (this.open) return
    this.open = true
    this.openedAt = now
    this.cooldownMs = c.cooldownMs
    this.trips += 1
  }

  isOpen(): boolean {
    return this.open
  }
}

/** 所有端点的熔断注册表（进程级单例：桥/VLM/LLM 都是**共享服务**，健康状态本就该跨病例累积）。 */
class Registry {
  private service = new Map<EndpointKey, Breaker>()
  private scoped = new Map<string, Breaker>()
  /** endpoint → scope → 最近一次超时时间戳[]（跨片升级判定用） */
  private timeoutScopes = new Map<EndpointKey, Map<string, number[]>>()

  private svc(e: EndpointKey): Breaker {
    let b = this.service.get(e)
    if (!b) {
      b = new Breaker()
      this.service.set(e, b)
    }
    return b
  }

  private scopedFor(e: EndpointKey, scope: string): Breaker {
    const k = `${e}:${scope}`
    let b = this.scoped.get(k)
    if (!b) {
      b = new Breaker()
      this.scoped.set(k, b)
    }
    return b
  }

  /** 检查是否放行。`scope` = slide id（拿不到时按服务级处理，见下方注释）。 */
  tryPass(e: EndpointKey, scope: string | undefined): { ok: true } | { ok: false; retryAfterMs: number; scope: string } {
    const c = cfg()
    const now = Date.now()
    const svc = this.svc(e)
    const s = svc.tryPass(now, c)
    if (!s.ok) return { ok: false, retryAfterMs: s.retryAfterMs, scope: 'service' }
    if (scope) {
      const sc = this.scopedFor(e, scope).tryPass(now, c)
      if (!sc.ok) {
        // 服务级已放行（或放了探测），但**这张片子**自己熔断中 → 必须把服务级的探测标记撤回，
        // 否则那个 probeInFlight 永远等不到 onSuccess/onFailure，服务级会卡在 half-open。
        if (s.probe) svc.onSuccess()
        return { ok: false, retryAfterMs: sc.retryAfterMs, scope }
      }
    }
    return { ok: true }
  }

  recordSuccess(e: EndpointKey, scope: string | undefined): void {
    this.svc(e).onSuccess()
    if (scope) this.scopedFor(e, scope).onSuccess()
  }

  /** `kind`：connection = 无歧义的服务死亡证据；timeout = 模糊证据（先归 slide，跨片才升级）。 */
  recordFailure(e: EndpointKey, scope: string | undefined, kind: 'connection' | 'timeout'): void {
    const c = cfg()
    const now = Date.now()
    if (kind === 'connection') {
      this.svc(e).onFailure(now, c)
      return
    }
    // 无 scope（拿不到 slide 上下文）：无法区分「这张片慢」与「服务死」。
    // 保守取服务级——若取 (端点,固定键) 级则永远不会跨片升级，等于永不熔断，服务挂死时继续无限期付墙钟。
    // 实践中 ctx.session.currentWsiId 恒有值，此分支近乎不可达。
    if (!scope) {
      this.svc(e).onFailure(now, c)
      return
    }
    this.scopedFor(e, scope).onFailure(now, c)
    // 跨片升级：窗口内**够多张不同片子**都超时 → 这才是不像「某张片慢」的证据
    const per = this.timeoutScopes.get(e) ?? new Map<string, number[]>()
    const arr = (per.get(scope) ?? []).filter((t) => now - t < c.windowMs)
    arr.push(now)
    per.set(scope, arr)
    this.timeoutScopes.set(e, per)
    let distinct = 0
    for (const [, ts] of per) {
      if (ts.some((t) => now - t < c.windowMs)) distinct += 1
    }
    if (distinct >= c.slideEscalation) {
      this.svc(e).trip(now, c)
      this.timeoutScopes.delete(e) // 清账：升级已发生，别让旧时间戳反复触发
    }
  }

  /** 探针用：清空全部状态（生产不调用）。 */
  reset(): void {
    this.service.clear()
    this.scoped.clear()
    this.timeoutScopes.clear()
  }

  snapshot(): Record<string, { trips: number; open: boolean }> {
    const out: Record<string, { trips: number; open: boolean }> = {}
    for (const [k, b] of this.service) out[k] = { trips: b.trips, open: b.isOpen() }
    return out
  }
}

const registry = new Registry()

/** 探针/测试用：清空熔断状态。 */
export function resetBreakers(): void {
  registry.reset()
}

/** 熔断状态快照（观测/断言用）。 */
export function breakerSnapshot(): Record<string, { trips: number; open: boolean }> {
  return registry.snapshot()
}

export interface ResilientOpts {
  endpoint: EndpointKey
  /** 观测用的操作名（`region`/`tissue-mask`/`describe`/`decide`…） */
  op: string
  /** 健康状态的**作用域**＝slide id：超时类失败按它分片，避免一张病态巨片判死整个服务。 */
  scope?: string
  sink?: EndpointSink
}

/**
 * 端点调用的统一包装：**熔断检查 → 计时 → 观测 → 按类记账**。
 * 三个真实网络边界（WsiClient 的 get/post、VLM fetch、决策 LLM fetch）共用它，语义只此一份。
 *
 * 行为保证：
 *  - 熔断中 → **不发请求**，毫秒级抛已分类好的错误（就是「不再付第二次 300s」的落点）；
 *  - 调用方主动中止（agent.abort / 工具预算）**不记为端点失败**（那是我们的决定，不是服务不健康）；
 *  - 其余异常**原样上抛**（本层不改写语义，只观测 + 记账）。
 */
export async function resilient<T>(o: ResilientOpts, fn: () => Promise<T>): Promise<T> {
  const pass = registry.tryPass(o.endpoint, o.scope)
  if (!pass.ok) {
    o.sink?.endpointCall(o.endpoint, o.op, 0, 'blocked')
    const secs = Math.ceil(pass.retryAfterMs / 1000)
    // ⚠️ 措辞约束：这条 message 必须被 `codeFromMessage` 认成 REJECT_CODE。
    //    且**不能出现「超时」二字**——`isTimeoutish` 会先命中，把熔断误分类成 *_TIMEOUT（探针有断言守）。
    const where = pass.scope === 'service' ? '服务' : `本片(${pass.scope})`
    throw new Error(`${REJECT_PHRASE[o.endpoint]}（熔断中：${where}连续失败，冷却剩余 ${secs}s）。`)
  }
  const t0 = Date.now()
  try {
    const r = await fn()
    o.sink?.endpointCall(o.endpoint, o.op, Date.now() - t0, 'ok')
    registry.recordSuccess(o.endpoint, o.scope)
    return r
  } catch (err) {
    const ms = Date.now() - t0
    if (isDeliberateAbort(err)) {
      // 中止是我们自己的决定，不是端点不健康：记耗时但不记失败、不动熔断计数
      o.sink?.endpointCall(o.endpoint, o.op, ms, 'ok')
      throw err
    }
    o.sink?.endpointCall(o.endpoint, o.op, ms, 'fail')
    // 只有**瞬时类**才进熔断：业务/数据/代码类失败（PATCH_NOT_FOUND、EISDIR、HTTP 4xx…）不是健康信号
    const info = classifyToolError(err, { phase: o.endpoint })
    if (info.code === 'BRIDGE_TIMEOUT' || info.code === 'VLM_TIMEOUT' || info.code === 'LLM_TIMEOUT') {
      registry.recordFailure(o.endpoint, o.scope, 'timeout')
    } else if (info.code === 'BRIDGE_UNAVAILABLE' || info.code === 'VLM_UNREACHABLE' || info.code === 'LLM_UNREACHABLE') {
      registry.recordFailure(o.endpoint, o.scope, 'connection')
    }
    throw err
  }
}

/** 从桥接 URL path 推 `op` 与 `scope`（slide id）——`/slides/<id>/region?...` → op=region, scope=<id>。 */
export function bridgePathInfo(path: string): { op: string; scope?: string } {
  const m = path.match(/^\/slides\/([^/?]+)\/([^?]+)/)
  if (!m) return { op: path.replace(/^\//, '').split('?')[0] || 'unknown' }
  return { op: decodeURIComponent(m[2]), scope: decodeURIComponent(m[1]) }
}

export type { ToolErrorCode }
