/** 会话级指标：工具耗时 / LLM token / VLM 调用 → 单次阅片成本摘要。
 *  挂 PathAskSession.metrics，由 runner subscribe 工具事件计时、streamFn message usage 聚合。 */

export interface ToolStat {
  tool: string
  calls: number
  totalMs: number
  p50Ms: number
  p95Ms: number
  /** 失败调用数 */
  failures: number
  errorsByCode: Record<string, number>
}

/** 分端点（bridge/vlm/llm）的分位数。
 *  `tools`/`tool_ms` 只到**工具**粒度，答不了「这 451s 是桥端掩膜重算、VLM 排队、还是决策 LLM 多转了两轮」。
 *  自适应阈值在没这个之前全是拍脑袋——这是它的**存在理由**，也是熔断阈值的唯一依据。 */
export interface EndpointStat {
  endpoint: string
  op: string
  /** 真正发出去的调用数（含失败；**不含**熔断拦截） */
  calls: number
  failures: number
  /** 熔断拦截数（没发请求就返回；毫秒级，不进延迟分位数，否则会把 p50 拉低成假象） */
  blocked: number
  totalMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}

/** 加权 token 用量：`input + reasoning + 4×output`。
 *
 *  **为什么需要加权**：`llmInputTokens` 与 `llmOutputTokens` 不是同一种成本。output 是逐字生成的，
 *  单价高且无法被 prompt cache 命中；input 虽大，绝大部分是每轮重放的 system prompt + 工具 schema，
 *  可被缓存。直接相加会把「上下文长」和「话多」当成同一件事。
 *
 *  **为什么放在 metrics 而不是 governance**：它是对 `SessionMetricsSummary` 的纯派生量，
 *  和 p50/p95 一样属于「指标怎么读」的范畴；governance 只是它的第一个消费者（预算判定）。
 *  放在这里也让 `evalRow` 能直接落盘加权用量，不必为此 import 治理层。
 *
 *  reasoning 计入 input 侧：它同样是要喂回去的上下文重量，且观测值恒为 0，不影响今天的判定。 */
export function tokensWeighted(
  m: { llmInputTokens: number; llmOutputTokens: number; llmReasoningTokens?: number },
): number {
  return m.llmInputTokens + (m.llmReasoningTokens ?? 0) + 4 * m.llmOutputTokens
}

export interface SessionMetricsSummary {
  elapsedMs: number
  toolCalls: number
  totalToolMs: number
  tools: ToolStat[]
  llmCalls: number
  llmInputTokens: number
  llmOutputTokens: number
  llmReasoningTokens: number
  vlmCalls: number
  /** 工具失败总数 + 按 code 分布（ToolErrorCode） */
  toolErrors: number
  toolErrorsByCode: Record<string, number>
  /** 分端点耗时/失败（bridge/vlm/llm）：定位「慢在哪一层」的唯一观测面 */
  endpoints: EndpointStat[]
}

export class SessionMetrics {
  private starts = new Map<string, { tool: string; at: number }>()
  private perTool = new Map<string, number[]>()
  private perToolErrors = new Map<string, Record<string, number>>()
  /** 分端点：key=`endpoint:op` → 延迟样本[] + 失败/拦截计数 */
  private perEndpoint = new Map<string, { endpoint: string; op: string; ms: number[]; failures: number; blocked: number }>()
  private t0 = Date.now()

  llmCalls = 0
  llmInputTokens = 0
  llmOutputTokens = 0
  llmReasoningTokens = 0
  vlmCalls = 0
  toolErrors = 0
  toolErrorsByCode: Record<string, number> = {}

  /** 工具执行开始（runner subscribe tool_execution_start，key=toolCallId） */
  toolStart(callId: string, tool: string): void {
    this.starts.set(callId, { tool, at: Date.now() })
  }

  /** 工具执行结束（tool_execution_end，key=toolCallId 配对，防并发工具计时串线） */
  toolEnd(callId: string): void {
    const s = this.starts.get(callId)
    if (!s) return
    this.starts.delete(callId)
    const ms = Date.now() - s.at
    const arr = this.perTool.get(s.tool) ?? []
    arr.push(ms)
    this.perTool.set(s.tool, arr)
  }

  /** LLM 每轮 usage（runner subscribe message_start 取 event.message.usage） */
  recordLlm(usage: { input?: number; output?: number; reasoning?: number } | undefined): void {
    this.llmCalls++
    this.llmInputTokens += usage?.input ?? 0
    this.llmOutputTokens += usage?.output ?? 0
    this.llmReasoningTokens += usage?.reasoning ?? 0
  }

  /** VLM（Patho-R1）成功调用一次（describe_patch / verify_region 真路径） */
  recordVlm(): void {
    this.vlmCalls++
  }

  /** 工具失败一次（makeTool 的 catch / softError → recordToolError 调用）。 */
  toolFail(_callId: string, tool: string, code: string): void {
    this.toolErrors++
    this.toolErrorsByCode[code] = (this.toolErrorsByCode[code] ?? 0) + 1
    const m = this.perToolErrors.get(tool) ?? {}
    m[code] = (m[code] ?? 0) + 1
    this.perToolErrors.set(tool, m)
  }

  /** 端点调用一笔（`EndpointSink` 的结构化实现——`util/resilience.ts` 只依赖这个签名）。
   *  `blocked`（熔断拦截）不纳入延迟样本：它没发请求，0ms 会把分位数拉成假象。 */
  endpointCall(endpoint: string, op: string, ms: number, outcome: 'ok' | 'fail' | 'blocked'): void {
    const key = `${endpoint}:${op}`
    let e = this.perEndpoint.get(key)
    if (!e) {
      e = { endpoint, op, ms: [], failures: 0, blocked: 0 }
      this.perEndpoint.set(key, e)
    }
    if (outcome === 'blocked') {
      e.blocked += 1
      return
    }
    e.ms.push(ms)
    if (outcome === 'fail') e.failures += 1
  }

  endpointStats(): EndpointStat[] {
    return [...this.perEndpoint.values()]
      .map((e) => {
        const sorted = [...e.ms].sort((a, b) => a - b)
        return {
          endpoint: e.endpoint,
          op: e.op,
          calls: e.ms.length,
          failures: e.failures,
          blocked: e.blocked,
          totalMs: e.ms.reduce((s, x) => s + x, 0),
          p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
          p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
          maxMs: sorted[sorted.length - 1] ?? 0,
        }
      })
      .sort((a, b) => b.totalMs - a.totalMs)
  }

  toolStats(): ToolStat[] {
    return [...this.perTool.entries()]
      .map(([tool, arr]) => {
        const sorted = [...arr].sort((a, b) => a - b)
        const errorsByCode = this.perToolErrors.get(tool) ?? {}
        return {
          tool,
          calls: arr.length,
          totalMs: arr.reduce((s, x) => s + x, 0),
          p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
          p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
          failures: Object.values(errorsByCode).reduce((s, x) => s + x, 0),
          errorsByCode,
        }
      })
      .sort((a, b) => b.totalMs - a.totalMs)
  }

  summary(): SessionMetricsSummary {
    const tools = this.toolStats()
    const toolCalls = tools.reduce((s, x) => s + x.calls, 0)
    const totalToolMs = tools.reduce((s, x) => s + x.totalMs, 0)
    return {
      elapsedMs: Date.now() - this.t0,
      toolCalls,
      totalToolMs,
      tools,
      llmCalls: this.llmCalls,
      llmInputTokens: this.llmInputTokens,
      llmOutputTokens: this.llmOutputTokens,
      llmReasoningTokens: this.llmReasoningTokens,
      vlmCalls: this.vlmCalls,
      toolErrors: this.toolErrors,
      toolErrorsByCode: { ...this.toolErrorsByCode },
      endpoints: this.endpointStats(),
    }
  }
}
