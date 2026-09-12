/**
 * 编排 loop 的「有界上下文压缩」。
 *
 * 病根：agent 每轮把「已累积的全部消息历史」原样重发给 Qwen3-8B（无跨轮记忆，每轮重发增长中的输入），
 * 输入 token 随轮数近似线性增长。
 *
 * 方案：作为 pi-agent-core `transformContext`（每轮 LLM 调用前对 messages 生效一次），
 * 当历史超预算时把最旧的「完整 turn」(`assistant(tool_calls)` + 其 `toolResult`s) 折叠成一行紧凑摘要，
 * 只保留最近的 K 轮 + 首条问题。：
 *  - **LLM-free**：不用 generateSummary（那是会话树 + LLM 摘要调用，会反加成本）；只用 estimateTokens 判预算。
 *  - **结构安全**：只在 turn 边界折叠（整组删 `assistant(tool_calls)`+后续 toolResult），永不拆散
 *    `assistant → tool_result` 配对，不破坏 toChatMessages 的 OpenAI tool_calls/tool_call_id 对应。
 *  - **摘要保「已做过的工具」**：折叠行写明工具名 + 参数要点 + 结果 gist，防止 agent 回忆不起来而重跑
 *    scan/inspect/describe（那会抵消压缩收益）。
 *  - 折叠摘要插入为正数第一段 user 消息（在首条问题后、首个保留 assistant 前）——user 后可接 assistant(tool_calls)，
 *    OpenAI 交替合法；末条保持 user/toolResult（当前 turn 依赖）。
 *
 * 证据库感知：toolResult 原文若能用 toolCallId 定位到会话证据节点，就用节点的【归纳句 gist】
 * 替代原文 slice(0,80)。slice 从头取 80 字会砍掉 VLM 末尾归纳句（ruleMatch/genericScore 赖以打票的倾向
 * 信号）。归纳句 = 保真 claim 里信息价值最高的一句——
 * 「证据感知」而非「位置截断」。定位不到（如 describe 缓存回放未走 addEvidence、非证据类工具结果）回退原文 slice。
 *
 * 语义边界：gist 只做「提取+去套话」，**不产 conf、不产 polarity**（归纳句里的 benign/malignant 是 VLM 读出的
 * 形态印象，不是确诊；guilty 与否由下游 ruleMatch/polarity/决策 LLM 校验）。详见 claimGist.ts。
 *
 * 门控：PATHASK_CTX_COMPACT=1 开启；PATHASK_CTX_KEEP_TURNS（默认 8）保最近轮数；
 *       PATHASK_CTX_KEEP_TOKENS（默认 12000）超此才触发（估算）。
 */
import { estimateTokens } from '@earendil-works/pi-agent-core'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { summaryGist } from '../tools/claimGist'
import type { EvidenceStore } from '../evidence/EvidenceStore'

/** PathAsk 实际只用 user/assistant/toolResult 三种；AgentMessage 是含 BashExecutionMessage 等的联合。
 *  这里用一个窄结构型，访问时经 as 断言只读到这三个变体共有的 content/role。 */
type NarrowMsg = { role: string; content?: unknown }
type Block = { type?: string; text?: string; name?: string; arguments?: unknown }

/** 消息正文（text / tool_calls 参数 / tool 结果的字符串化长度），用于摘要与估算。 */
function contentOf(m: AgentMessage): { toolCallNames: string[]; argsPreview: string; textPreview: string } {
  const nm = m as unknown as NarrowMsg
  const toolCallNames: string[] = []
  let argsPreview = ''
  const content = nm.content
  if (Array.isArray(content)) {
    let texts = ''
    for (const c of content) {
      const b = c as Block
      if (b.type === 'text') texts += b.text ?? ''
      else if (b.type === 'toolCall') {
        toolCallNames.push(b.name ?? '(?)')
        const args = typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {})
        argsPreview += (argsPreview ? ' ' : '') + `${b.name}((${args.slice(0, 40)}))`
      }
    }
    if (nm.role === 'assistant' && texts.trim()) argsPreview = `说明: ${texts.trim().slice(0, 40)} · ` + argsPreview
    return { toolCallNames, argsPreview, textPreview: texts }
  }
  return { toolCallNames, argsPreview, textPreview: typeof content === 'string' ? content : '' }
}

function toolResultContent(m: AgentMessage): string {
  const content = (m as unknown as NarrowMsg).content
  let t = ''
  if (Array.isArray(content)) {
    for (const c of content) if ((c as Block).type === 'text') t += (c as Block).text ?? ''
  } else if (typeof content === 'string') t = content
  return t
}

/** 折返 gist 的一个证据条目：toolCallId → 节点最小信息（compactContext 用它拼 `[ev-N] tool 溯源: 归纳句`）。 */
export interface GistEvidence {
  id?: string
  tool: string
  coords?: { x?: number; y?: number; w?: number; h?: number }
  magnification?: number
  claim: string
}

/** 折返 gist 的来源：给定 toolCallId，从证据库定位证据节点最小信息。找不到返回 undefined（走原文 slice 兜底）。 */
export type EvidenceLookup = (toolCallId: string) => GistEvidence | undefined

/** 从会话证据库构造 EvidenceLookup（toolCallId → 证据节点最小信息）。调用点只需一行：
 *  `compactContext(messages, makeEvidenceLookup(session.evidenceStore))`。
 *  只收录带 source.toolCallId 的节点（addEvidence 时贴的桥标签）；describe 缓存回放等未走
 *  addEvidence 的 toolResult 定位不到 → 由 foldTurns 回退原文 slice。 */
export function makeEvidenceLookup(store: EvidenceStore): EvidenceLookup {
  const byCallId = new Map<string, GistEvidence>()
  for (const n of store.allNodes()) {
    const callId = n.source.toolCallId
    if (!callId) continue
    byCallId.set(callId, {
      id: n.id,
      tool: n.source.tool,
      coords: n.source.coords ? { x: n.source.coords.x, y: n.source.coords.y, w: n.source.coords.w, h: n.source.coords.h } : undefined,
      magnification: n.source.magnification,
      claim: n.claim,
    })
  }
  return (toolCallId: string) => byCallId.get(toolCallId)
}

/** 把一组消息折叠成一行「已执行」摘要。首个问题原样保留，只折叠其后的 turn。
 *  toolResult 若能经 lookup（toolCallId → 证据节点）取到归纳句，就用它替代原文 slice(0,80)。 */
function foldTurns(turns: AgentMessage[], prevProblem: string, lookup?: EvidenceLookup): { summary: string; dropped: number } {
  const lines: string[] = []
  let dropped = 0
  for (const m of turns) {
    const role = (m as unknown as NarrowMsg).role
    if (role === 'assistant') {
      const { toolCallNames, argsPreview } = contentOf(m)
      if (toolCallNames.length) lines.push(`→ 执行 ${toolCallNames.join('、')}${argsPreview ? ` [${argsPreview}]` : ''}`)
    } else if (role === 'toolResult') {
      const nm = m as unknown as { toolCallId?: string; toolName?: string; content?: unknown }
      const t = toolResultContent(m).replace(/\s+/g, ' ').trim()
      // 证据感知 gist：从 toolCallId 定位证据节点 → 归纳句。定位不到（缓存回放、非证据工具）才回退原文 slice。
      let gist = ''
      if (lookup && nm.toolCallId) {
        const ev = lookup(nm.toolCallId)
        if (ev) {
          const c = ev.coords
          const loc = c ? ` @(${c.x ?? '?'},${c.y ?? '?'}) ${c.w ?? '?'}×${c.h ?? '?'}` : ''
          const mag = ev.magnification ? ` ${ev.magnification}×` : ''
          const summ = summaryGist(ev.claim)
          if (summ) gist = `[证据库${ev.id ? ` ${ev.id}` : ''}] ${ev.tool}${loc}${mag}: ${summ}`
        }
      }
      lines.push(`   结果: ${gist || t.slice(0, 80)}`)
      dropped++
    }
  }
  const summary = `[历史上下文已压缩（此前 ${dropped} 条工具结果）——以下为已执行动作的要点，避免重跑]\n${lines.join('\n')}`
  return { summary, dropped }
}

/** 把消息列表切成 turn：turn0=首条 user（问题），其后每个 assistant 开新 turn，包含其 toolResult 尾巴。 */
function splitTurns(messages: AgentMessage[]): { lead: AgentMessage[]; turns: AgentMessage[][] } {
  const lead: AgentMessage[] = []
  const turns: AgentMessage[][] = []
  let cur: AgentMessage[] | null = null
  let seenAssistant = false
  for (const m of messages) {
    const role = (m as unknown as NarrowMsg).role
    if (!seenAssistant) {
      // 首个 assistant 之前的 user（问题）归入 lead
      if (role === 'assistant') { seenAssistant = true; cur = [m]; continue }
      lead.push(m)
      continue
    }
    if (role === 'assistant') {
      if (cur && cur.length) turns.push(cur)
      cur = [m]
      continue
    }
    // toolResult / user 归入当前 turn
    if (cur) cur.push(m)
    else lead.push(m)
  }
  if (cur && cur.length) turns.push(cur)
  return { lead, turns }
}

/** transformContext 用：有界压缩（env 门控 + 预算 + 最近 K 轮保留）。
 *  evidenceLookup：toolCallId → 证据节点最小信息；由调用方闭包捕获 session.evidenceStore 构造。
 *  传入后折返 gist 可用归纳句，否则退化为原文 slice。 */
export function compactContext(messages: AgentMessage[], evidenceLookup?: EvidenceLookup): AgentMessage[] {
  if (process.env.PATHASK_CTX_COMPACT !== '1') return messages
  const budget = Number(process.env.PATHASK_CTX_KEEP_TOKENS ?? '12000')
  const keepTurns = Number(process.env.PATHASK_CTX_KEEP_TURNS ?? '8')
  const est = messages.reduce((s, m) => s + estimateTokens(m), 0)
  if (est <= budget) return messages

  const { lead, turns } = splitTurns(messages)
  if (turns.length <= keepTurns) return messages // 未达可折叠轮数

  const kept = turns.slice(-keepTurns)
  const dropped = turns.slice(0, -keepTurns)
  const prevProblem = lead.map((m) => (typeof (m as unknown as NarrowMsg).content === 'string' ? (m as unknown as NarrowMsg).content as string : '')).join('')
  const { summary } = foldTurns(dropped.flat(), prevProblem, evidenceLookup)

  // 折叠摘要以 user 角色插到 lead 之后、首个保留 turn 之前（user,user,assistant(tool_calls),... 合法交替）。
  const out: AgentMessage[] = [...lead, { role: 'user', content: summary } as AgentMessage]
  for (const turn of kept) out.push(...turn)
  return out
}

export default compactContext
