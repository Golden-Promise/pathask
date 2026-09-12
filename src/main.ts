import { Agent } from '@earendil-works/pi-agent-core'
import { createSession } from './session'
import { createTools } from './tools'
import { buildSystemPrompt } from './loop/protocol'
import { createScriptedStreamFn, FLOW_BREAST_STRONG, MOCK_MODEL } from './mock/mockStreamFn'
import { runQuestion } from './runner'

async function main() {
  const session = createSession('slide_brca_001')
  const agent = new Agent({
    streamFn: createScriptedStreamFn(FLOW_BREAST_STRONG),
    initialState: {
      model: MOCK_MODEL,
      systemPrompt: buildSystemPrompt([]),
      tools: createTools(session),
    },
  })

  // 事件跟踪（主诊断用）
  agent.subscribe((event) => {
    if (event.type === 'tool_execution_start') {
      console.log(`  🛠  ${event.toolName}(${JSON.stringify(event.args)})`)
    }
  })

  console.log('=== PathAsk 全片病理阅片 Agent（mock 闭环） ===')
  console.log('WSI: slide_brca_001 (case TCGA-AB-0001)')
  console.log('\n[Q] 这张乳腺全片是否为 ER 阳性浸润性导管癌？\n')
  const answer = await runQuestion(agent, '这张乳腺全片是否为 ER 阳性浸润性导管癌？')
  console.log('\n[A]\n' + answer)

  console.log('\n[Q] 为什么你认为区域 r1 是浸润？请在高倍下复核。\n')
  const followup = await runQuestion(agent, '为什么你认为区域 r1 是浸润？请在高倍下复核。')
  console.log('\n[A]\n' + followup)

  console.log('\n=== 证据库 ===')
  console.log(session.evidenceStore.summarize())

  const report = session.currentReport
  if (report) {
    console.log(`\n=== 最终报告 ===\n主诊断: ${report.primary_diagnosis}  conf=${report.confidence.toFixed(2)}`)
    console.log(`鉴别诊断: ${report.differential.map((d) => d.diagnosis).join(' | ')}`)
    console.log(`证据图: ${report.evidence_graph.nodes.length} 节点 / ${report.evidence_graph.edges.length} 边`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
