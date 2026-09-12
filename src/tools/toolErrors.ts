/**
 * 工具错误分类 + 「可行动」错误文本。
 *
 * pi-agent loop 的 `createErrorToolResult` 把 `err.message` 原样当 tool-result
 * 文本回给模型（`isError:true`，`details` 整个丢弃）；**框架零重试**。
 * 本模块一处定义 code 空间，并产出固定结构的文本。**不做自动重试**：重试与否由模型读到「可否重试」后自行决定。
 *
 * 【框架语义 · 勿接 afterToolCall】`afterToolCall` 一旦 throw 会**丢掉真实 tool result**。
 * 所以 PathAsk 的错误处理**全部在本层完成**，不依赖任何 pi-agent 钩子（防后人误接）。
 */
import type { ToolErrorCode, ToolErrorRecord, PathAskSession } from '../types'

export type { ToolErrorCode }

/** 「合法备选」注入：让模型能自我纠正，而不是拿着同一个错参数反复重试。 */
export interface Alternatives {
  /** 列表标签，如 `slide_id` / `region_ref` / `patch_ref` */
  label: string
  values: string[]
}

export interface ClassifyContext {
  tool?: string
  /** 调用阶段提示（调用点自己知道；缺省时按 message 关键词猜）。用于区分「桥接连不上」与「VLM 连不上」。 */
  phase?: 'bridge' | 'vlm' | 'llm'
  /** makeTool 判定：**本工具的预算计时器**触发（区别于 agent abort，也区别于工具内部自己的超时） */
  timedOut?: boolean
  /** makeTool 判定：agent/session 主动 abort（用户停止 / per-case 墙钟截止）。
   *  ⚠️ 步数上限**不**走 abort：由 `PATHASK_MAX_TOOLS`（`resolveMaxTools()`）在 `beforeToolCall`
   *  里**优雅收尾**（拦探索类工具 + terminate），abort 只留给用户停止与 per-case 截止这两条真中断路径。 */
  aborted?: boolean
  budgetMs?: number
  elapsedMs?: number
  alternatives?: Alternatives
  /** 已保留的进度（k/n） */
  partial?: { done: number; total?: number }
  /** 瞬时故障预算状态——只对瞬时类 code 有值，见 `consumeTransientBudget` */
  transient?: TransientBudgetState
  /** 瞬时故障预算的**消费点**：分类器算出 code 后回调，由它决定要不要扣令牌。
   *  做成回调而不是先分类再重建文本，是因为「扣令牌」和「渲染文本」必须看到同一个 code——
   *  两趟分类会让两条真相有机会分叉（而本模块的全部价值就是只有一条真相）。 */
  transientFor?: (code: ToolErrorCode) => TransientBudgetState | undefined
  /** 语义重复状态的**读取点**：分类器算出 code 后回调。与 `transientFor` 同样做成回调——
   *  「取状态」与「渲染文本」必须看到同一个 code。**只由 `makeTool` 的抓取路径传**：
   *  熔断器（`resilience.ts`）也调 `classifyToolError`，它不该（也不能）往病例账本里数次数。 */
  semanticRepeatFor?: (code: ToolErrorCode) => SemanticRepeatState | undefined
}

export interface ToolErrorInfo {
  code: ToolErrorCode
  retryable: boolean
  /** 原始异常 message（诊断/账本用） */
  message: string
  /** 给模型看的结构化文本：失败 → 为什么 → 影响 → 怎么改 → 可否重试 (+备选/进度) */
  text: string
}

/** 每个 code 的「为什么 / 影响 / 怎么改 / 可否重试」四元组——本模块的核心内容。
 *  `fix` 是给 agent 的行动指令：**参数类错误给做法，基础设施类错误明确劝退重试**。 */
const CATALOG: Record<ToolErrorCode, { label: string; why: string; impact: string; fix: string; retryable: boolean }> = {
  SLIDE_NOT_FOUND: {
    label: 'slide 不存在',
    why: '传入的 slide_id 既不在本会话 WSI 注册表（wsilist）也不在缓存里。',
    impact: '本次调用没有读片，未产生任何观测证据。',
    fix: '从下面列出的可用 slide_id 里**原样**挑一个重传（带目录前缀的完整 id 最稳）；不要自己改写 id、拼路径或加/去扩展名。',
    retryable: true,
  },
  REGION_NOT_FOUND: {
    label: 'region_ref 不存在',
    why: 'region_ref 不在本会话的 ROI 缓存里（可能还没采样，或 ref 被写成了别的形式）。',
    impact: '未切块、未描述，本次调用无观测。',
    fix: '先调 detect_roi（或让导航器预置基线）拿到真实 ROI，再一次传下面列出的 region_ref 之一；**不要手抄 x/y/w/h**——坐标解析交给工具。',
    retryable: true,
  },
  REGION_REQUIRED: {
    label: '缺 region 参数',
    why: '既没给 region 也没给 region_ref。',
    impact: '无法定位要切哪块组织。',
    fix: '传 region_ref（推荐，来自 detect_roi / perceive 输出）或完整 region 对象（slide_id/x/y/w/h/magnification）。',
    retryable: true,
  },
  DEGENERATE_REGION: {
    label: '区域过小/非方形（护栏拒绝）',
    why: `区域尺寸低于最小边长护栏，或不是方形，切出来的块没有可判读的组织结构。`,
    impact: '护栏直接拒绝，未切块（避免产出无意义的形态描述）。',
    fix: '改用更大的区域——detect_roi 返回的 ROI 都是合法的；不要传手工换算的小坐标。',
    retryable: false,
  },
  PATCH_NOT_FOUND: {
    label: 'patch_ref 不存在',
    why: 'patch_ref 不在 patchCache 里（该 patch 还没切出来，或 ref 被规范化成了别的形式）。',
    impact: '未做形态描述，本次调用无新观测。',
    fix: '先调 inspect_region / perceive 生成 patch，再传下面列出的 patch_ref；或省略 patch_ref 让工具用当前全部候选。',
    retryable: true,
  },
  CASE_NOT_FOUND: {
    label: '病例号无记录',
    why: '该 case_id 在临床/知识表里没有对应记录（常见原因：把 slide_id 或文件 basename 当 case_id 传了）。',
    impact: '本次查询没有返回任何临床信息，未产生证据。',
    fix: '从下面列出的 case_id 里挑；注意 case_id 与 slide_id 不是同一个东西。',
    retryable: true,
  },
  NO_ROI: {
    label: '当前无候选 ROI',
    why: '当前 slide 在会话里还没有任何候选区域。',
    impact: '无区域可感知。',
    fix: '先调 detect_roi 采样（或由导航器预置基线），再重调本工具。',
    retryable: true,
  },
  NO_EVIDENCE: {
    label: '证据库为空',
    why: '会话证据库里还没有可用的观察证据。',
    impact: '无法做综合分析 / 反事实 / 报告。',
    fix: '先调 scan_overview、perceive 或 verify_region 收集形态观察证据，再重调本工具。',
    retryable: true,
  },
  NO_PRIOR_ANALYSIS: {
    label: '尚未生成综合推断',
    why: '还没调用过 analyze_evidence，没有可成文的推断。',
    impact: '报告无法生成。',
    fix: '按顺序来：先 analyze_evidence 生成综合推断，再调 generate_report。',
    retryable: true,
  },
  BRIDGE_UNAVAILABLE: {
    label: 'WSI 桥接不可达',
    why: 'WSI 桥接服务（OpenSlide 读片）拒绝连接或不可达。',
    impact: '本次调用没有真实读片，未产生观测。',
    fix: '这是**基础设施问题，不是参数问题**——用同样的参数重试不会成功。确认桥接服务在跑（默认 :8787），或改用已有缓存/已切好的区域。',
    retryable: false,
  },
  BRIDGE_TIMEOUT: {
    label: 'WSI 桥接超时',
    why: '桥接在预算内没有返回（大图冷重算 mask / 首次打开超大 WSI 可能真的慢）。',
    impact: '本次调用无观测；若是冷重算，服务端可能仍在计算。',
    fix: '不要立刻重试同一区域。可改用一个更小的倍率/更小的区域，或等一会再调（冷缓存已被填充时第二次会快）。',
    retryable: false,
  },
  BRIDGE_HTTP: {
    label: 'WSI 桥接返回错误状态',
    why: '桥接返回了非 2xx 响应（4xx 多为请求参数问题：区域越界 / slide 找不到；5xx 是服务端故障）。',
    impact: '本次调用无观测。',
    fix: '看状态码：4xx → 检查 slide_id / 区域坐标是否越界后换参数重试；5xx → 服务端问题，不要重试，先报告。',
    retryable: true,
  },
  VLM_TIMEOUT: {
    label: '病理 VLM 超时',
    why: '形态描述模型在超时内没有返回。',
    impact: '该 patch 没有形态描述，无对应证据。',
    fix: '一次少传几个 patch_ref（分摊单次时长）后再试；同参数直接重试收益低。',
    retryable: false,
  },
  VLM_UNREACHABLE: {
    label: '病理 VLM 不可达',
    why: '连不上形态描述模型的 vLLM 服务。',
    impact: '本次调用没有任何形态描述产出。',
    fix: '基础设施问题，不是参数问题——不要重试；先确认 VLM 服务地址/端口可达。',
    retryable: false,
  },
  VLM_HTTP: {
    label: '病理 VLM 返回错误状态',
    why: '形态描述模型返回了非 2xx（多为服务端过载或输入图片异常）。',
    impact: '该 patch 无描述。',
    fix: '换个区域/倍率再试，或稍后再调；同一张图反复重发通常无效。',
    retryable: false,
  },
  VLM_EMPTY: {
    label: '病理 VLM 返回空内容',
    why: '模型返回了空字符串（偶发采样抖动）。',
    impact: '该 patch 无描述。',
    fix: '可以原样重试一次（抖动通常自愈）；若连续为空则换区域。',
    retryable: true,
  },
  VLM_DEGENERATE: {
    label: 'VLM 输出退化',
    why: '模型钩进了记忆里的筛检脚手架，只吐重复骨架（Step N: …）、零诊断内容。',
    impact: '该证据被标记 degenerate，**不参与投票/置信聚合/反事实**（等同无效观察）。',
    fix: '不要重试同一区域——这是模型行为不是参数问题。换区域/倍率，或依赖其他已有证据。',
    retryable: false,
  },
  LLM_MISSING_KEY: {
    label: '缺少决策 LLM 密钥',
    why: '环境里没有配置决策 LLM 的 API key。',
    impact: '决策层无法运行，本病例拿不到综合推断。',
    fix: '环境问题，不是参数问题：配置 .env 里的 key 后重跑；重试本工具无效。',
    retryable: false,
  },
  LLM_TIMEOUT: {
    label: '决策 LLM 超时',
    why: '决策模型在超时内没有返回。',
    impact: '本次综合分析未产出。',
    fix: '可以重试一次（长上下文首包偶发慢）；若连续超时，先减少要分析的前置证据量。',
    retryable: true,
  },
  LLM_UNREACHABLE: {
    label: '决策 LLM 不可达',
    why: '连不上决策 LLM 服务。',
    impact: '本次综合分析未产出。',
    fix: '基础设施/网络问题，不要重试；先确认服务地址与代理可达。',
    retryable: false,
  },
  LLM_HTTP: {
    label: '决策 LLM 返回错误状态',
    why: '决策模型返回了非 2xx（限流/额度/服务端）。',
    impact: '本次综合分析未产出。',
    fix: '看状态码：429/5xx 稍后再试一次；401/403 是密钥问题，重试无效。',
    retryable: false,
  },
  LLM_EMPTY: {
    label: '决策 LLM 空响应',
    why: '决策模型返回了空内容。',
    impact: '本次综合分析未产出。',
    fix: '可以重试一次（偶发）；若连续为空，检查上下文是否过长被截断。',
    retryable: true,
  },
  LLM_BAD_JSON: {
    label: '决策 LLM 输出非 JSON',
    why: '决策模型的输出里找不到可解析的 JSON 结构。',
    impact: '本次综合分析未产出。',
    fix: '可以重试一次（采样抖动，同一 prompt 常能自愈）。',
    retryable: true,
  },
  CAPABILITY_INVALID: {
    label: '能力配置不匹配',
    why: '请求的预测类别不在该能力注册的 labels 里，或该能力在当前会话不可用。',
    impact: '本次调用未执行。',
    fix: '改用注册表里该能力声明的标签，或换一个可用能力；这是配置问题，原样重试无效。',
    retryable: false,
  },
  TOOL_TIMEOUT: {
    label: '工具超时（预算用尽）',
    why: '本次工具调用超过了墙钟预算。',
    impact: '工具被中断；**已经产生的观测被保留**（标记 partial），未完成的部分没有证据。',
    fix: '缩小一次请求的范围（少传区域/patch，或先只做一部分）后再调；同参数直接重试大概率再次超时。已有证据可以继续用于推理。',
    retryable: true,
  },
  ABORTED: {
    label: '会话被中止',
    why: '会话被主动中止（用户停止 / 评测的工具数上限 / 单例墙钟截止）。',
    impact: '工具被中断；已产生的观测被保留（标记 partial）。',
    fix: '不要重试——本次会话的预算已经结束。已有证据仍然可用；如仍需要完整结果，请新开一次会话。',
    retryable: false,
  },
  UNKNOWN: {
    label: '未分类异常',
    why: '工具内部抛出了未归类的异常。',
    impact: '本次调用未完成。',
    fix: '看 message 判断；换一种参数或换一条路径（例如换区域、换工具）再试，不要原样重放。',
    retryable: true,
  },
}

// ---------- 提取 ----------

function errName(err: unknown): string {
  return err instanceof Error ? err.name : ''
}
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : JSON.stringify(err ?? '')
}
/** 栈首帧（`at fn (file:line:col)`）。只在 UNKNOWN 时给模型——分类成功的错我们已经知道原因，
 *  栈对模型是噪声；未分类的必须带上线索，否则「未分类异常」等于没说。 */
function errFrame(err: unknown): string {
  if (!(err instanceof Error) || !err.stack) return ''
  const line = err.stack.split('\n').find((l) => /^\s+at /.test(l))
  return line ? line.trim() : ''
}
/** Node/undici 系统错误码（含 cause 链——undici 把 ECONNREFUSED 放在 cause.code）。 */
function sysCode(err: unknown): string {
  const seen = new Set<unknown>()
  let cur: unknown = err
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur)
    const c = (cur as { code?: unknown }).code
    if (typeof c === 'string') return c
    cur = (cur as { cause?: unknown }).cause
  }
  return ''
}
function pickStatus(msg: string): number | undefined {
  const m = msg.match(/(?:HTTP|桥接 POST|桥接)\s*(\d{3})/) ?? msg.match(/\b(4\d{2}|5\d{2})\b/)
  return m ? Number(m[1]) : undefined
}
/** 无 phase 提示时按 message 关键词猜服务归属（调用点最好显式传 phase）。 */
function guessPhase(msg: string): 'bridge' | 'vlm' | 'llm' | undefined {
  if (/WSI 桥接|bridge|run_mil 无法执行/.test(msg)) return 'bridge'
  if (/vLLM|Patho-R1|Qwen3-VL|形态描述/.test(msg)) return 'vlm'
  // 「本地 LLM」/「LLM 端点」= util/llmEndpoint.endpointLabel 在非硅基端点下的措辞
  // （streamFn 的 `HTTP <status>` / `无响应体` / 缺 key 三条错误）。改标签必须同步这里。
  if (/决策 LLM|SiliconFlow|SILICONFLOW|本地 LLM|LLM 端点/.test(msg)) return 'llm'
  return undefined
}

const NET_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'])
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])

function isTimeoutish(err: unknown, msg: string, code: string): boolean {
  return errName(err) === 'TimeoutError' || TIMEOUT_CODES.has(code) || /timed? ?out|超时/i.test(msg)
}
/** abort 判定。⚠️ `AbortSignal.timeout()` 的 TimeoutError message 本身就是
 *  "The operation was aborted due to timeout" → 只按 message 判会把**超时误判成中止**，
 *  于是 TOOL_TIMEOUT/BRIDGE_TIMEOUT/VLM_TIMEOUT/LLM_TIMEOUT 全部被吞掉。超时优先排除。 */
function isAbortish(err: unknown, msg: string, code: string): boolean {
  if (errName(err) === 'AbortError') return true
  if (isTimeoutish(err, msg, code)) return false
  return /aborted|The operation was aborted/i.test(msg)
}
function isNetworkish(err: unknown, msg: string, code: string): boolean {
  return NET_CODES.has(code) || /fetch failed|socket hang up|connect ECONNREFUSED|无法连接/i.test(msg)
}

/** 调用方**主动中止**（agent.abort / 工具预算到点 / 用户停止）——区别于「端点不健康」。
 *  熔断记账用它排除中止：中止是我们自己的决定，不该把服务判成病态。
 *  ⚠️ 复用 `isAbortish`：它已排除「超时被误判成中止」的情形。 */
export function isDeliberateAbort(err: unknown): boolean {
  const msg = errMessage(err)
  return isAbortish(err, msg, sysCode(err))
}

/** message 词表 → code（顺序敏感：先具体后泛化）。 */
function codeFromMessage(msg: string): ToolErrorCode | undefined {
  if (/未知 slide|slide .*不存在|找不到.*slide/i.test(msg)) return 'SLIDE_NOT_FOUND'
  // softError 是显式传 code 的，不需要靠词表；但**裸 throw** 路径（工具内部/下游库）仍靠这里兜底，
  // 所以把各工具实际的 miss 文案（"未找到 region_ref: …" / "未找到 X 的临床记录"）也纳入词表。
  if (/未知 region_ref|未找到 region_ref|region_ref .*不存在/i.test(msg)) return 'REGION_NOT_FOUND'
  if (/未知 patch_ref|未找到 patch_ref|patch_ref .*不存在/i.test(msg)) return 'PATCH_NOT_FOUND'
  if (/病例不存在|未知 case_id|未找到 .*的临床记录/i.test(msg)) return 'CASE_NOT_FOUND'
  if (/WSI 桥接不可用|bridge 不可用|run_mil 无法执行/.test(msg)) return 'BRIDGE_UNAVAILABLE'
  // 熔断拒绝（util/resilience.ts）——措辞是**契约**：必须命中这里，且不得含「超时」二字
  // （`isTimeoutish` 在本函数**之前**判定，含「超时」会被误分类成 *_TIMEOUT）。
  if (/vLLM 不可用|Patho-R1 不可用/.test(msg)) return 'VLM_UNREACHABLE'
  if (/决策 LLM 不可用/.test(msg)) return 'LLM_UNREACHABLE'
  if (/WSI 桥接 (POST )?\d{3}/.test(msg)) return 'BRIDGE_HTTP'
  if (/缺少 SILICONFLOW_API_KEY|缺少.*API_KEY/i.test(msg)) return 'LLM_MISSING_KEY'
  if (/决策 LLM HTTP/.test(msg)) return 'LLM_HTTP'
  if (/决策 LLM 空响应/.test(msg)) return 'LLM_EMPTY'
  if (/决策 LLM (非 JSON|JSON 解析失败)/.test(msg)) return 'LLM_BAD_JSON'
  if (/vLLM HTTP/.test(msg)) return 'VLM_HTTP'
  if (/返回空内容/.test(msg)) return 'VLM_EMPTY'
  if (/证据库为空/.test(msg)) return 'NO_EVIDENCE'
  if (/请先调用 analyze_evidence/.test(msg)) return 'NO_PRIOR_ANALYSIS'
  if (/反事实需要一条可移除的证据/.test(msg)) return 'NO_EVIDENCE'
  if (/不在能力|无 mock 预测|不在当前 registry|能力未注册/.test(msg)) return 'CAPABILITY_INVALID'
  return undefined
}

/** 组装给模型的固定结构文本。 */
export function buildToolErrorText(
  tool: string,
  code: ToolErrorCode,
  opts: { detail?: string; message?: string; raw?: string; budgetMs?: number; elapsedMs?: number; alternatives?: Alternatives; partial?: { done: number; total?: number }; transient?: TransientBudgetState; semanticRepeat?: SemanticRepeatState } = {},
): string {
  const c = CATALOG[code] ?? CATALOG.UNKNOWN
  const lines: string[] = [`[${tool}] 失败（${code} · ${c.label}）`]
  const whyBits = [c.why]
  if (opts.detail) whyBits.push(opts.detail)
  if (opts.budgetMs && opts.elapsedMs) whyBits.push(`预算 ${opts.budgetMs}ms，已运行 ${opts.elapsedMs}ms。`)
  lines.push(`  为什么：${whyBits.join(' ')}`)
  lines.push(`  影响：${c.impact}`)
  lines.push(`  怎么改：${c.fix}`)
  // 语义重复达阈值 → **替换**「可否重试」这一行（不是追加）。它是覆盖而非补充：同一 id 已失败 N 次时
  // 「可以按上面的怎么改调整后再试」读起来就是「重放一次也行」，而那正是要劝退的动作。
  // 措辞刻意点 `id` 而不是 `参数`：自愈路径恰恰是**换 id**，这里劝退的是「原样重放同一个 id」。
  const rep = opts.semanticRepeat
  lines.push(
    rep
      ? `  ⛔ 同一 (${tool}, ${code}) 本病例已失败 ${rep.count} 次（阈值 ${rep.threshold}）：**别再原样重放同一个 id**——` +
        `改用可用列表里的其他项、换别的证据路径、或直接用已有证据给结论。`
      : `  可否重试：${c.retryable ? '可以（按上面的「怎么改」调整后再试）' : '不必——按上面的「怎么改」换路径，别原样重放'}`,
  )
  // 未分类异常必须把原文与栈首帧交给模型（否则「未分类」这条信息量为零）
  if (opts.raw) {
    const raw = opts.raw.length > 400 ? `${opts.raw.slice(0, 400)}…` : opts.raw
    lines.push(`  原始错误：${raw}`)
  }
  if (opts.partial && opts.partial.done > 0) {
    const n = opts.partial.total ? `/${opts.partial.total}` : ''
    lines.push(`  已完成：${opts.partial.done}${n}（这些观测已保留在证据库，标记 partial，可继续用于推理）`)
  }
  // 瞬时故障预算。**写在上一条「可否重试」之后**——它是覆盖，不是补充：
  // 耗尽时上面那句「可以按…调整后再试」必须被这句推翻，否则模型会读到互相矛盾的两句话。
  if (opts.transient) {
    const { remaining, limit, exhausted } = opts.transient
    lines.push(
      exhausted
        ? `  ⛔ 瞬时故障预算已用尽（${limit}/${limit}）：本病例不要再调用依赖同一服务的工具（同一参数重放不会成功）。` +
            `改用其他证据路径（换区域/换倍率/依赖已有证据），或直接给出现有证据能支持的结论并声明不确定。`
        : `  瞬时故障预算：本病例还剩 ${remaining}/${limit} 次（超时/连不上这类故障可重试，但会消耗预算）。`,
    )
  }
  const alt = opts.alternatives
  if (alt?.values.length) {
    const shown = alt.values.slice(0, 20)
    const more = alt.values.length > shown.length ? ` …（共 ${alt.values.length} 个）` : ''
    lines.push(`  可用 ${alt.label}：${shown.join(', ')}${more}`)
  }
  return lines.join('\n')
}

/** 哪些 code 必须把原始 message 一并交给模型。
 *  `fix` 里写了「下面列出的…」的引用类必须在内——否则那句指令指向空气。 */
function rawFor(code: ToolErrorCode): boolean {
  return code === 'UNKNOWN' || code === 'SLIDE_NOT_FOUND' || code === 'REGION_NOT_FOUND'
    || code === 'PATCH_NOT_FOUND' || code === 'CASE_NOT_FOUND'
}

/** 分类一个异常（throw 路径与调用点显式分类都用它）。 */
export function classifyToolError(err: unknown, ctx: ClassifyContext = {}): ToolErrorInfo {
  const tool = ctx.tool ?? 'tool'
  const message = errMessage(err)
  const code0 = sysCode(err)
  const phase = ctx.phase ?? guessPhase(message)
  const status = pickStatus(message)

  let code: ToolErrorCode
  let detail = ''
  if (ctx.aborted || isAbortish(err, message, code0)) {
    // abort 引发的 fetch 失败长得像网络错误，所以要最先判（isAbortish 已排除超时误判）
    code = 'ABORTED'
  } else if (ctx.timedOut) {
    code = 'TOOL_TIMEOUT'
  } else if (isTimeoutish(err, message, code0)) {
    code = phase === 'bridge' ? 'BRIDGE_TIMEOUT' : phase === 'vlm' ? 'VLM_TIMEOUT' : phase === 'llm' ? 'LLM_TIMEOUT' : 'TOOL_TIMEOUT'
  } else {
    const byMsg = codeFromMessage(message)
    if (byMsg) {
      code = byMsg
      if (code === 'BRIDGE_HTTP' && status) detail = `状态码 ${status}。`
    } else if (isNetworkish(err, message, code0)) {
      code = phase === 'bridge' ? 'BRIDGE_UNAVAILABLE' : phase === 'vlm' ? 'VLM_UNREACHABLE' : phase === 'llm' ? 'LLM_UNREACHABLE' : 'UNKNOWN'
      detail = `底层错误：${code0 || message}（阶段：${phase ?? '未知'}）。`
    } else {
      code = 'UNKNOWN'
    }
  }

  const info = CATALOG[code]
  return {
    code,
    retryable: info.retryable,
    message,
    text: buildToolErrorText(tool, code, {
      detail,
      message,
      // 带原文的情形有两类：
      //  ① UNKNOWN——不给原文等于什么都没说，另附栈首帧；
      //  ② **id 引用类**——它们的 `fix` 写着「从下面列出的 X 里挑」，而**可用列表就在原始 message 里**
      //     （`未知 patch_ref: p1。可用 patch_ref: …`）。
      raw: rawFor(code) ? [message, code === 'UNKNOWN' ? errFrame(err) : ''].filter(Boolean).join(' | ') : undefined,
      budgetMs: ctx.budgetMs,
      elapsedMs: ctx.elapsedMs,
      alternatives: ctx.alternatives,
      partial: ctx.partial,
      transient: ctx.transient ?? ctx.transientFor?.(code),
      semanticRepeat: ctx.semanticRepeatFor?.(code),
    }),
  }
}

// ---------- 瞬时故障重试预算 ----------

/**
 * 哪些失败算「瞬时故障」——**与「语义错误」的分界就是本模块最重要的一刀**：
 *
 *  - **瞬时类**（本集合）：服务没回话。原样重放*可能*成功，但没有新信息，且每次都付墙钟。
 *    给它们一个病例级令牌桶（默认 3），耗尽后错误文本转终态、劝模型换策略。
 *  - **语义类**（PATCH_NOT_FOUND / REGION_NOT_FOUND / SLIDE_NOT_FOUND / CASE_NOT_FOUND…）：模型拿错了 id。
 *    这类**刻意不给上界**——结构化错误里已经附了「可用备选」列表，照着改 id 重试是**唯一的自愈路径**
 *    给它设令牌 = 把我们自己唯一的纠错通道掐掉。
 *    它另有的天然上界是产品层的 `PATHASK_MAX_TOOLS`（`resolveMaxTools()`，
 *    默认 15，在 `beforeToolCall` 里拦非收尾类工具并 terminate）+ 单例墙钟截止，足够。
 *  - **抖动类**（VLM_EMPTY / LLM_EMPTY / LLM_BAD_JSON）：单次廉价且常自愈 → 不消耗预算。
 *    理由：扣令牌会让「一次采样抖动」和「服务挂死」受到同样惩罚，而前者重试成本极低。
 *  - **TOOL_TIMEOUT 算瞬时**：工具预算耗尽说明这个病例正在恶化，正是该收紧的时候。
 */
export const TRANSIENT_CODES: ReadonlySet<ToolErrorCode> = new Set<ToolErrorCode>([
  'BRIDGE_TIMEOUT',
  'BRIDGE_UNAVAILABLE',
  'VLM_TIMEOUT',
  'VLM_UNREACHABLE',
  'LLM_TIMEOUT',
  'LLM_UNREACHABLE',
  'TOOL_TIMEOUT',
])

export function isTransientCode(code: ToolErrorCode): boolean {
  return TRANSIENT_CODES.has(code)
}

export interface TransientBudgetState {
  remaining: number
  limit: number
  exhausted: boolean
}

/** 令牌上限（env `PATHASK_TRANSIENT_RETRY_BUDGET`，默认 3）。默认 3 的依据：默认熔断阈值也是 3，
 *  即「模型被劝退」与「服务被判病态」大致同时到点，两条机制不会互相打架也不会都失灵。 */
export function resolveRetryBudget(): number {
  const v = Number(process.env.PATHASK_TRANSIENT_RETRY_BUDGET)
  return Number.isFinite(v) && v >= 0 ? v : 3
}

/** 消费一个瞬时令牌并返回状态；**非瞬时 code 返回 undefined 且不消费**。
 *  预算挂 `session.retryBudget`（惰性初始化）。 */
export function consumeTransientBudget(session: PathAskSession, code: ToolErrorCode): TransientBudgetState | undefined {
  if (!isTransientCode(code)) return undefined
  const limit = resolveRetryBudget()
  if (!session.retryBudget) session.retryBudget = { remaining: limit, spent: 0, byCode: {} }
  const b = session.retryBudget
  if (b.remaining > 0) {
    b.remaining -= 1
    b.spent += 1
    b.byCode[code] = (b.byCode[code] ?? 0) + 1
  }
  return { remaining: b.remaining, limit, exhausted: b.remaining === 0 }
}

// ---------- 语义重复提示（**默认关**） ----------

export interface SemanticRepeatState {
  /** 含本次在内的第几次同 `(tool, code)` 失败。 */
  count: number
  threshold: number
}

/** 阈值（env `PATHASK_SEMANTIC_REPEAT_HINT`，**默认 0 = 关**）。
 *
 *  语义类错误（PATCH_NOT_FOUND / REGION_NOT_FOUND / SLIDE_NOT_FOUND / CASE_NOT_FOUND…）**刻意不设令牌上界**：
 *  结构化错误里附了「可用备选」，照着改 id 是唯一的自愈路径，给它设令牌等于掐掉自己的纠错通道。
 *  但「不设上界」不等于「没有代价」——代价不是墙钟（一次 `findPatchByRef` 几乎不耗时），
 *  而是**同一个死 id 反复出现在 transcript 里**，把模型的注意力钉死在一条走不通的路上。
 *  所以这里有第二条、**更软**的通道：不改调用行为、不消费任何令牌，只把「可否重试」那一行换成终态措辞，
 *  劝模型改**参数**而不是重放。与 `PATHASK_TRANSIENT_RETRY_BUDGET` 同一设计原则（只改模型看到什么）。
 *
 *  ⚠️ **只对非瞬时 code 生效**。瞬时类的重复由 `consumeTransientBudget` 管，两层同时给终态措辞会互相打架
 *  （一边说「还剩 2 次」一边说「别再重试」）——而瞬时类的终态措辞本来就是它自己那条预算的职责。 */
export function resolveSemanticRepeatHint(): number {
  const v = Number(process.env.PATHASK_SEMANTIC_REPEAT_HINT)
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
}

/** 本次调用是第几次同 `(tool, code)` 失败（**含本次**）。未达阈值或关闭时返回 `undefined`（→ 文案逐字如初）。
 *  ⚠️ 必须在 `recordToolError` **之前**调用：账本里还没有本次这条，"含本次"才是对的。 */
export function semanticRepeatState(
  session: PathAskSession,
  tool: string,
  code: ToolErrorCode,
): SemanticRepeatState | undefined {
  if (isTransientCode(code)) return undefined
  const threshold = resolveSemanticRepeatHint()
  if (threshold <= 0) return undefined
  const prior = (session.toolErrors ?? []).filter((r) => r.tool === tool && r.code === code).length
  const count = prior + 1
  return count >= threshold ? { count, threshold } : undefined
}

// ---------- 记录 ----------

/** 追加一条失败账本（makeTool 的 catch 与 softError 共用）。账本是 session 级的，不依赖框架钩子。 */
export function recordToolError(session: PathAskSession, rec: ToolErrorRecord): void {
  if (!session.toolErrors) session.toolErrors = [] // 老会话对象兜底
  session.toolErrors.push(rec)
  session.metrics?.toolFail?.(rec.toolCallId, rec.tool, rec.code)
}

/** 把本次 toolCallId 产生的证据标 partial（原地改：EvidenceStore.allNodes() 返回引用）。
 *  超时/中断时**不回滚**——这些观测是真的，且 describeCache 让重发廉价；打标 + 报 k/n 即可。 */
export function markPartialEvidence(session: PathAskSession, toolCallId: string): number {
  let k = 0
  for (const n of session.evidenceStore.allNodes()) {
    if (n.source.toolCallId === toolCallId) {
      n.source.partial = true
      k += 1
    }
  }
  return k
}

// ---------- return 路径（miss，不 throw）----------

/** miss 路径的**返回式**软错误：保留「模型看到文本、非 isError」的既有语义（不改变这些分支的行为），
 *  只把文本升级成结构化 + 记一条账本。 */
export function softError(
  ctx: { session: PathAskSession; toolCallId: string },
  tool: string,
  code: ToolErrorCode,
  opts: { detail?: string; alternatives?: Alternatives; extra?: Record<string, unknown> } = {},
): { text: string; details: Record<string, unknown> } {
  // 软错误同样消耗瞬时预算（它也能报 BRIDGE_UNAVAILABLE 一类瞬时 code）
  const text = buildToolErrorText(tool, code, {
    detail: opts.detail,
    alternatives: opts.alternatives,
    transient: consumeTransientBudget(ctx.session, code),
    semanticRepeat: semanticRepeatState(ctx.session, tool, code),
  })
  recordToolError(ctx.session, { toolCallId: ctx.toolCallId, tool, code, message: opts.detail ?? code, atMs: Date.now() })
  return {
    text,
    details: { error: code, structured: true, ...(opts.alternatives ? { available: opts.alternatives.values } : {}), ...(opts.extra ?? {}) },
  }
}

/** 工具预算（ms）：spec 显式 > 全局 env > 默认。 */
export const DEFAULT_TOOL_TIMEOUT_MS = 300_000
export function resolveToolBudgetMs(meta: { timeoutMs?: number } | undefined): number {
  const env = Number(process.env.PATHASK_TOOL_TIMEOUT_MS)
  if (meta?.timeoutMs) return meta.timeoutMs
  if (Number.isFinite(env) && env > 0) return env
  return DEFAULT_TOOL_TIMEOUT_MS
}
