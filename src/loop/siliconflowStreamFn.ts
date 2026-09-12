/**
 * SiliconFlow 决策者 StreamFn
 *
 * 把 Pi-Agent Context（User/Assistant/ToolResult 消息 + 工具定义）翻译成 SiliconFlow
 * chat/completions 请求（OpenAI 兼容），流式解析 SSE，回放为 Pi AssistantMessageEvent。
 *
 * 数据流：
 *   Pi UserMessage        → {role:'user', content}
 *   Pi AssistantMessage   → {role:'assistant', content: 文本, tool_calls:[...]}（thinking 不回放）
 *   Pi ToolResultMessage  → {role:'tool', tool_call_id, content}
 *   Pi Tool (TypeBox schema)→ {type:'function', function:{name, description, parameters}}
 *
 * 网络：若部署环境需经代理出网，SiliconFlow 走 SILICONFLOW_PROXY（兼 HTTP CONNECT）。
 * 用 undici fetch + ProxyAgent——Node 全局 fetch 不接受 dispatcher 选项。
 *
 * key 不硬编码：读 options.apiKey（loop 注入）或 process.env.SILICONFLOW_API_KEY（.env）。
 */
import 'dotenv/config'
import { EventStream } from '@earendil-works/pi-ai'
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Message,
  Model,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  Usage,
} from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { fetch } from 'undici'
import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_CONTEXT_WINDOW,
  DEFAULT_LLM_MODEL,
  endpointLabel,
  llmApiKey,
  llmProxyAgent,
  thinkingFields,
} from '../util/llmEndpoint'

// ============ 端点解析（默认硅基流动；env 可切本地 vLLM） ============
// ⚠️ 这里在**模块作用域**读 process.env 是安全的：本文件第 18 行 `import 'dotenv/config'`
//    在 const 求值之前已执行。若日后把 dotenv 挪走，下面两行会静默读不到 .env。
export const LLM_BASE_URL = (process.env.PATHASK_LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL).replace(/\/+$/, '')

// ============ Model 对象（free tier：¥0/M tokens） ============
export const QWEN3_8B: Model<'openai-completions'> = {
  id: process.env.PATHASK_LLM_MODEL ?? DEFAULT_LLM_MODEL,
  name: `Qwen3-8B (${endpointLabel(LLM_BASE_URL)})`,
  api: 'openai-completions',
  // ⚠️ 已知名不副实（本地端点时仍报 'siliconflow'）：它是 pi-ai 的 Model 身份字段，会被回放进
  //    AssistantMessage。真正的端点身份看 baseUrl / LLM_BASE_URL。
  provider: 'siliconflow',
  baseUrl: LLM_BASE_URL,
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: Number(process.env.PATHASK_LLM_CONTEXT_WINDOW ?? DEFAULT_LLM_CONTEXT_WINDOW),
  maxTokens: 8192,
  compat: { supportsStrictMode: false, thinkingFormat: 'qwen' },
}

// ============ 事件流（done/error 判定完成） ============
class SiliconFlowStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === 'done' || event.type === 'error',
      (event) => {
        if (event.type === 'done') return event.message
        if (event.type === 'error') return event.error
        throw new Error('Unexpected event type')
      },
    )
  }
}

// ============ helpers ============
const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function createAssistantMessage(
  model: Model<any>,
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
  usage: Usage,
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason,
    timestamp: Date.now(),
  }
}

/** SiliconFlow usage JSON → Pi Usage（免费模型 cost 全 0；reasoning_tokens 可选子集） */
function usageFromJson(u: any): Usage {
  if (!u) return EMPTY_USAGE
  const input = u.prompt_tokens ?? 0
  const output = u.completion_tokens ?? 0
  const total = u.total_tokens ?? input + output
  const reasoning = u.completion_tokens_details?.reasoning_tokens
  const usage: Usage = {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: total,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
  if (typeof reasoning === 'number') usage.reasoning = reasoning
  return usage
}

/** 工具参数是流式拼接的 JSON 字符串，攒完再 parse；中间态/坏 JSON → 空对象（loop 有 TypeBox 校验兜底） */
function safeParseArgs(s: string): Record<string, any> {
  if (!s.trim()) return {}
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

// ============ Pi Message → OpenAI chat messages ============
interface ChatMessage {
  role: string
  content: string | null
  tool_call_id?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
}

function textOf(content: Message['content']): string {
  if (typeof content === 'string') return content
  return content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
}

function toChatMessages(messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: textOf(m.content) })
    } else if (m.role === 'assistant') {
      const text = m.content
        .filter((c): c is TextContent => c.type === 'text')
        .map((c) => c.text)
        .join('')
      const toolCalls = m.content.filter((c): c is ToolCall => c.type === 'toolCall')
      const cm: ChatMessage = { role: 'assistant', content: toolCalls.length > 0 ? null : text }
      if (toolCalls.length > 0) {
        cm.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }))
      }
      out.push(cm)
    } else if (m.role === 'toolResult') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: textOf(m.content) })
    }
  }
  return out
}

function toChatTools(tools: Tool[]): { type: 'function'; function: { name: string; description: string; parameters: unknown } }[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

// ============ StreamFn ============
export const siliconflowStreamFn: StreamFn = (model, context, options) => {
  const stream = new SiliconFlowStream()
  // 端点相关三项（key / 代理 / 思考字段）统一走 util/llmEndpoint，与决策路径
  // （analyzeEvidence.ts:callDecisionLlm）共用同一份判定。
  const baseUrl = model.baseUrl || LLM_BASE_URL
  const label = endpointLabel(baseUrl)
  const apiKey = options?.apiKey ?? llmApiKey(baseUrl)
  // 代理地址必须走环境变量（默认回环，部署时按需覆盖）。
  // ⚠️ 内网/回环端点返回 undefined（=不挂 dispatcher）：undici 的 ProxyAgent **不读 NO_PROXY**，
  //    否则指向内网自建端点会被强行经 SILICONFLOW_PROXY 转发而连不通。
  const proxyAgent = llmProxyAgent(baseUrl)
  const debug = process.env.PATHASK_DEBUG === '1'
  // 默认关 thinking：决策协议的自省/元认知靠 prompt 引导，不依赖模型 thinking 模式。
  // QWEN_THINKING=1 可显式开启。
  const enableThinking = process.env.QWEN_THINKING === '1' && model.reasoning
  const tStart = Date.now()
  const dbg = (...args: unknown[]) => {
    if (debug) console.error(`[streamFn +${((Date.now() - tStart) / 1000).toFixed(1)}s]`, ...args)
  }

  void (async () => {
    try {
      // ⚠️ 文案同时含 SILICONFLOW_API_KEY 字面量：guessPhase 与
      //    LLM_MISSING_KEY 都按它匹配，改措辞会静默错分类。
      if (!apiKey) throw new Error('缺少 SILICONFLOW_API_KEY（.env 或 PATHASK_LLM_API_KEY）')
      if (!context.messages.length) throw new Error('context.messages 为空')

      const messages = toChatMessages(context.messages)
      const tools = context.tools && context.tools.length > 0 ? toChatTools(context.tools) : undefined
      const url = `${baseUrl}/chat/completions`

      const body: Record<string, unknown> = {
        model: model.id,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: model.maxTokens ?? 4096,
        // 编排器(agent 循环)采样温度：0.3——比 provider 默认(≈0.7)低得多(压 agent 路径方差、提升可复现)，
        // 又高于 0(agent 长循环在 temp0 易退化为重复/死循环)。env PATHASK_EXEC_TEMP 可覆盖。
        temperature: Number(process.env.PATHASK_EXEC_TEMP ?? '0.3'),
      }
      if (tools) body.tools = tools
      // thinking 开关的**请求体形态随端点而异**（详见 util/llmEndpoint.thinkingFields）：
      //  · 硅基流动：认顶层 `enable_thinking`（私有扩展），且须显式双向传——不传关不掉。
      //  · vLLM：顶层是**彻底的空操作**（OpenAIBaseModel extra="allow" → 不报 400，但掏不到），
      //    唯一被转给 Jinja 模板的是 `chat_template_kwargs`。实测顶层 ≡ 什么都不传，
      //    kwargs 才是真关。用错形态不报错、只静默慢一倍多且行为与硅基基线发散。
      Object.assign(body, thinkingFields(baseUrl, enableThinking))

      dbg(`请求发出: messages=${messages.length} tools=${tools?.length ?? 0} thinking=${enableThinking} 最后role=${messages[messages.length - 1]?.role}`)
      // 编排器这一跳**刻意不挂自有超时**（区别于 WsiClient 的 PATHASK_BRIDGE_TIMEOUT_MS）：
      // 流式长回合时「总时长」没有合理上限（thinking 长的回合本来就要几分钟），掐总时长会误伤合法路径；
      // 而「卡住不动」已由 undici 自身兜底（headers 300s / chunk 间 300s 无字节即报错）→ 不存在无声挂死。
      // agent.abort() 经 options.signal 照样能掐断。若要再加护栏，应加在**到首字节**这一段，不要加在整体。
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        dispatcher: proxyAgent,
        signal: options?.signal,
      })
      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        // label：硅基端点仍逐字是 'SiliconFlow'（靠它判 phase=llm）；
        // 本地端点得 '本地 LLM'——该词表已同步扩过，别再改回去。
        throw new Error(`${label} HTTP ${res.status}: ${errText.slice(0, 300)}`)
      }
      if (!res.body) throw new Error(`${label} 无响应体`)
      dbg('HTTP 200，开始读流')

      // —— SSE 流式解析 + 事件回放 ——
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let streamDone = false

      // 累积内容块：按出现顺序（thinking → text → tool_calls），每个 delta 事件的 partial 都是完整快照
      const blocks: (TextContent | ThinkingContent | ToolCall)[] = []
      let thinkingIdx = -1
      let textIdx = -1
      const toolIdxByCall = new Map<number, number>() // OpenAI 工具 index → blocks 位置
      const toolCalls = new Map<number, { id: string; name: string; args: string }>() // 工具 index → 累积
      let finishReason: string | undefined
      let usageJson: unknown

      const partial = (): AssistantMessage =>
        createAssistantMessage(model, [...blocks], 'pending', usageFromJson(usageJson))

      let chunkCount = 0
      while (!streamDone) {
        const { value, done: readDone } = await reader.read()
        if (readDone) break
        chunkCount++
        if (chunkCount === 1) dbg('收到首个数据块')
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''
        for (const part of parts) {
          for (const line of part.split('\n')) {
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (!data) continue
            if (data === '[DONE]') {
              streamDone = true
              break
            }
            let json: any
            try {
              json = JSON.parse(data)
            } catch {
              continue
            }
            if (json.usage) usageJson = json.usage
            const choice = json.choices?.[0]
            if (!choice) continue
            if (choice.finish_reason) finishReason = choice.finish_reason
            const delta = choice.delta ?? {}

            // Qwen3 thinking（enable_thinking=true 时经 reasoning_content 下发）
            if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
              if (thinkingIdx < 0) {
                thinkingIdx = blocks.length
                blocks.push({ type: 'thinking', thinking: '' })
                stream.push({ type: 'thinking_start', contentIndex: thinkingIdx, partial: partial() })
              }
              const t = blocks[thinkingIdx] as ThinkingContent
              blocks[thinkingIdx] = { type: 'thinking', thinking: t.thinking + delta.reasoning_content }
              stream.push({ type: 'thinking_delta', contentIndex: thinkingIdx, delta: delta.reasoning_content, partial: partial() })
            }

            if (typeof delta.content === 'string' && delta.content.length > 0) {
              if (textIdx < 0) {
                textIdx = blocks.length
                blocks.push({ type: 'text', text: '' })
                stream.push({ type: 'text_start', contentIndex: textIdx, partial: partial() })
              }
              const t = blocks[textIdx] as TextContent
              blocks[textIdx] = { type: 'text', text: t.text + delta.content }
              stream.push({ type: 'text_delta', contentIndex: textIdx, delta: delta.content, partial: partial() })
            }

            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                if (tc?.index === undefined) continue
                const callIdx = tc.index
                if (!toolCalls.has(callIdx)) {
                  const id = tc.id ?? `call_${callIdx}`
                  const name = tc.function?.name ?? ''
                  toolCalls.set(callIdx, { id, name, args: '' })
                  const cIdx = blocks.length
                  toolIdxByCall.set(callIdx, cIdx)
                  blocks.push({ type: 'toolCall', id, name, arguments: {} })
                  stream.push({ type: 'toolcall_start', contentIndex: cIdx, partial: partial() })
                }
                const cur = toolCalls.get(callIdx)!
                if (tc.id) cur.id = tc.id
                if (tc.function?.name) cur.name = tc.function.name
                if (tc.function?.arguments) cur.args += tc.function.arguments
                const cIdx = toolIdxByCall.get(callIdx)!
                blocks[cIdx] = { type: 'toolCall', id: cur.id, name: cur.name, arguments: safeParseArgs(cur.args) }
                stream.push({ type: 'toolcall_delta', contentIndex: cIdx, delta: tc.function?.arguments ?? '', partial: partial() })
              }
            }
          }
          if (streamDone) break
        }
      }

      // —— 收尾事件 ——
      if (thinkingIdx >= 0) {
        stream.push({
          type: 'thinking_end',
          contentIndex: thinkingIdx,
          content: (blocks[thinkingIdx] as ThinkingContent).thinking,
          partial: partial(),
        })
      }
      if (textIdx >= 0) {
        stream.push({
          type: 'text_end',
          contentIndex: textIdx,
          content: (blocks[textIdx] as TextContent).text,
          partial: partial(),
        })
      }
      for (const [, cIdx] of toolIdxByCall) {
        stream.push({ type: 'toolcall_end', contentIndex: cIdx, toolCall: blocks[cIdx] as ToolCall, partial: partial() })
      }

      const hasTools = toolCalls.size > 0
      const reason: AssistantMessage['stopReason'] = hasTools ? 'toolUse' : finishReason === 'length' ? 'length' : 'stop'
      const final = createAssistantMessage(model, blocks, reason, usageFromJson(usageJson))
      dbg(`流结束: chunks=${chunkCount} finish=${finishReason ?? '无'} blocks=${blocks.map((b) => b.type).join(',')} 耗时=${((Date.now() - tStart) / 1000).toFixed(1)}s`)
      stream.push({ type: 'done', reason, message: final })
    } catch (err) {
      const aborted = options?.signal?.aborted
      const errorMessage = aborted
        ? '决策请求被中断（aborted）'
        : `SiliconFlow 决策请求失败: ${err instanceof Error ? err.message : String(err)}`
      const error = createAssistantMessage(model, [], aborted ? 'aborted' : 'error', EMPTY_USAGE)
      error.errorMessage = errorMessage
      stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error })
    } finally {
      // 关连接池（请求流已读完）。代理 key 读取失败等场景下 close 可能未初始化——吞掉。
      // 内网端点无 ProxyAgent（llmProxyAgent 返回 undefined），故须可选链。
      proxyAgent?.close().catch(() => {})
    }
  })()

  return stream
}
