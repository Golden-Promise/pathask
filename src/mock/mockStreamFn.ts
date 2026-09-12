import { EventStream } from '@earendil-works/pi-ai'
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'

// ============ 复刻 pi-agent 测试里的 mock 流 ============
class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
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

function createUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

export const MOCK_MODEL: Model<'openai-responses'> = {
  id: 'qwen3-8b-mock',
  name: 'Qwen3-8B (mock)',
  api: 'openai-responses',
  provider: 'openai',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768,
  maxTokens: 4096,
}

function createAssistantMessage(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'] = 'stop',
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-responses',
    provider: 'openai',
    model: MOCK_MODEL.id,
    usage: createUsage(),
    stopReason,
    timestamp: Date.now(),
  }
}

let toolCallSeq = 0
function toolUseMessage(name: string, args: Record<string, unknown>): AssistantMessage {
  toolCallSeq += 1
  return createAssistantMessage(
    [{ type: 'toolCall', id: `call_${name}_${toolCallSeq}`, name, arguments: args }],
    'toolUse',
  )
}

function textMessage(text: string): AssistantMessage {
  return createAssistantMessage([{ type: 'text', text }], 'stop')
}

// ============ 脚本化流程 ============
export interface ScriptStep {
  tool: string
  arguments: Record<string, unknown>
}

export interface ScriptFlow {
  primary: ScriptStep[]
  followup?: ScriptStep[]
  primaryFinalText: string
  followupFinalText?: string
}

function firstTextOf(messages: Context['messages']): string {
  const last = messages[messages.length - 1]
  if (!last) return ''
  if (last.role !== 'user') return ''
  const content = last.content
  if (typeof content === 'string') return content
  const first = content[0]
  return first && first.type === 'text' ? first.text : ''
}

/**
 * 脚本化 mock StreamFn：按「最后一条消息」决定下一个动作。
 * - 最后是 user：根据是否追问切到 primary/followup 阶段，发出阶段第一步工具调用
 * - 最后是 toolResult：发出阶段里下一个工具调用，或用完则发最终文本 stop
 * 产物：全链路确定性闭环（工具被真正执行、证据库被写入、报告生成）。
 */
export function createScriptedStreamFn(flow: ScriptFlow): StreamFn {
  const state: { phase: 'primary' | 'followup'; index: number } = { phase: 'primary', index: 0 }

  return (_model, context) => {
    const stream = new MockAssistantStream()
    queueMicrotask(() => {
      const last = context.messages[context.messages.length - 1]

      if (last && last.role === 'user') {
        const text = firstTextOf(context.messages)
        const isFollowUp = /区域|为什么|追问|放大|复查|复核/i.test(text)
        state.phase = isFollowUp && flow.followup ? 'followup' : 'primary'
        state.index = 0
        const seq = flow[state.phase]!
        stream.push({ type: 'done', reason: 'toolUse', message: toolUseMessage(seq[0].tool, seq[0].arguments) })
        return
      }

      // 最后一条是 toolResult → 推进
      state.index += 1
      const seq = flow[state.phase]!
      if (state.index < seq.length) {
        const step = seq[state.index]
        stream.push({ type: 'done', reason: 'toolUse', message: toolUseMessage(step.tool, step.arguments) })
      } else {
        const finalText = state.phase === 'primary' ? flow.primaryFinalText : (flow.followupFinalText ?? flow.primaryFinalText)
        stream.push({ type: 'done', reason: 'stop', message: textMessage(finalText) })
      }
    })
    return stream
  }
}

// ============ 预置场景流程 ============
const R1 = { id: 'r1', slide_id: 'slide_brca_001', x: 1200, y: 3400, w: 1024, h: 1024, magnification: 20, anomaly_score: 0.87, label: '导管上皮异型增生' }
const R2 = { id: 'r2', slide_id: 'slide_brca_001', x: 5600, y: 1200, w: 1024, h: 1024, magnification: 20, anomaly_score: 0.72, label: '可疑浸润灶' }
const R3 = { id: 'r3', slide_id: 'slide_brca_001', x: 8900, y: 7200, w: 1024, h: 1024, magnification: 20, anomaly_score: 0.31, label: '反应性增生' }

/** 场景 A：乳腺强证据路径（感知 → 临床 + 证据链 + 报告）
 *  ⚠️ 流程必须只用**当前注册的工具集**（createTools 的 10 件）驱动：脚本里写未注册的工具
 *  （inspect_region / describe_patch / run_mil）只会拿到一条 "tool not found" 结果，
 *  静默什么都不产出。 */
export const FLOW_BREAST_STRONG: ScriptFlow = {
  primary: [
    { tool: 'scan_overview', arguments: { slide_id: 'slide_brca_001' } },
    { tool: 'detect_roi', arguments: { slide_id: 'slide_brca_001', question: '寻找导管异型增生与可疑浸润灶' } },
    // perceive 取代旧的两步 inspect_region → describe_patch（切块+批量描述一次往返）；不传 region_ref = 全 ROI 池
    { tool: 'perceive', arguments: { question: '描述细胞形态与有丝分裂' } },
    { tool: 'query_clinical', arguments: { case_id: 'TCGA-AB-0001' } },
    { tool: 'analyze_evidence', arguments: {} },
    { tool: 'generate_report', arguments: { format: 'clinical' } },
  ],
  followup: [
    { tool: 'verify_region', arguments: { region: R1, previous_judgment: '导管上皮异型增生，疑似恶性', verification_question: '在高倍镜下，基底膜是否完整、有无间质浸润？' } },
    { tool: 'analyze_evidence', arguments: {} },
    { tool: 'generate_report', arguments: { format: 'clinical' } },
  ],
  primaryFinalText:
    '结论：浸润性导管癌（IDC），置信 0.87。ER+ / PR+ / HER2-（Luminal A），建议结合免疫组化进一步确认。可追问任何证据。',
  followupFinalText:
    '区域 r1 在 40× 下复核：导管上皮异型增生，基底膜局部断裂、间质见异型细胞巢 → 支持浸润性导管癌判断。',
}

/** 场景 B：肺 fallback 路径（无能力匹配 → perceive + 知识 + 相似病例 + 报告） */
export const FLOW_LUNG_FALLBACK: ScriptFlow = {
  primary: [
    { tool: 'scan_overview', arguments: { slide_id: 'slide_lung_001' } },
    { tool: 'detect_roi', arguments: { slide_id: 'slide_lung_001', question: '寻找小细胞癌特征区域' } },
    { tool: 'perceive', arguments: { question: '细胞形态特征' } },
    { tool: 'query_knowledge', arguments: { query: '小细胞癌形态学诊断标准', context: '肺穿刺，片状深染小细胞区域' } },
    { tool: 'retrieve_similar_case', arguments: { patch_ref: 'patch_lr1_0' } },
    { tool: 'analyze_evidence', arguments: {} },
    { tool: 'generate_report', arguments: { format: 'clinical' } },
  ],
  primaryFinalText:
    '结论：高度怀疑小细胞癌（SCLC），置信 0.62。能力库无肺分类器，走 fallback 路径，建议免疫组化（CD56/突触素/TTF-1）或转人工确认。',
}

/** 场景 C：反事实分析（单独驱动 counterfactual 工具） */
export const FLOW_COUNTERFACTUAL: ScriptFlow = {
  primary: [
    { tool: 'scan_overview', arguments: { slide_id: 'slide_brca_001' } },
    { tool: 'detect_roi', arguments: { slide_id: 'slide_brca_001', question: '寻找可疑浸润灶' } },
    { tool: 'perceive', arguments: { question: '描述细胞形态' } },
    { tool: 'analyze_evidence', arguments: {} },
    // evidence_id 传空 = 让工具自选（优先「方向相反」的投票证据，无则最高置信）
    { tool: 'counterfactual', arguments: { evidence_id: '' } },
    { tool: 'generate_report', arguments: {} },
  ],
  primaryFinalText: '反事实分析完成：移除关键证据后置信变化已在报告中体现。',
}
