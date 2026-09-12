import { Type } from 'typebox'
import type { Static } from '@earendil-works/pi-ai'
import type { EvidenceGraph, EvidenceNode, Report } from '../types'
import { type ToolSpec } from './common'

/** 单个证据节点的坐标/倍率/模型 溯源摘要（coords 可能缺失——知识/检索类证据无坐标）。 */
function sourceAnchor(n: EvidenceNode): string {
  const c = n.source.coords
  const loc = c ? `@(${c.x},${c.y}) ${c.w}×${c.h}` : ''
  const mag = n.source.magnification ? `${n.source.magnification}×` : ''
  const model = n.source.model ? `[${n.source.model}]` : ''
  return [model, mag, loc].filter(Boolean).join(' ')
}

/** 证据链 walkthrough：每条 observation（+ run_mil 推断）如何支持/反对主诊断结论。 */
function evidenceWalkthrough(graph: EvidenceGraph): string[] {
  const rows: string[] = []
  for (const n of graph.nodes) {
    if (n.type === 'conclusion') continue
    if (n.type === 'inference' && n.source.tool === 'analyze_evidence') continue
    const anchor = sourceAnchor(n)
    // STUB/MOCK 工具：标注"未验证/模拟值"，不进投票/置信
    if (n.source.stub) {
      rows.push(`  ⚠️ 未验证/模拟值 ${n.source.tool}（conf=0，${anchor || '无真实计算'}）：${n.claim.slice(0, 140)}${n.claim.length > 140 ? '…' : ''}`)
      continue
    }
    // VLM 不可用 → 确定性模板降级（真 WSI 会话下同时带 stub，上面已拦）。
    // mock 会话里这条不含 stub，必须单独标出来——否则报告读者会把查表模板当成对这张图的观察。
    if (n.source.fallback) {
      rows.push(`  ⚠️ VLM 降级模板（非镜下观察，不参与投票）${n.source.tool}（conf=${n.confidence.toFixed(2)}${anchor ? `，${anchor}` : ''}）：${n.claim.slice(0, 140)}${n.claim.length > 140 ? '…' : ''}`)
      continue
    }
    // 工具被预算/中止掐断前已产生的真观测：保留但标注「部分」
    const partialTag = n.source.partial ? '（⚠️ 部分：生成它的工具被中断）' : ''
    const role = n.polarity === 'against' ? '✗ 反对' : n.polarity === 'support' ? '✓ 支持' : '· 中性'
    rows.push(`  ${role} ${n.source.tool}（conf=${n.confidence.toFixed(2)}${anchor ? `，${anchor}` : ''}）${partialTag}：${n.claim.slice(0, 140)}${n.claim.length > 140 ? '…' : ''}`)
  }
  return rows
}

/** 反事实摘要：counterfactual 生成的 inference 节点（leave-one-out 结论）。 */
function counterfactualSummary(graph: EvidenceGraph): string[] {
  return graph.nodes
    .filter((n) => n.type === 'inference' && n.source.tool === 'counterfactual')
    .map((n) => `  ${n.claim}`)
}

/** 矛盾检测章节：列出方向与主诊断相反的证据（VLM/描述说良性而主诊断恶性等），显式标注而非只给计数。 */
function contradictionSection(report: Report): string[] {
  const against = report.evidence_graph.nodes.filter((n) => n.polarity === 'against')
  if (against.length === 0) return []
  return [
    '矛盾检测:',
    ...against.map((n) => `  ✗ [${n.source.tool}]「${n.claim.slice(0, 100)}」conf=${n.confidence.toFixed(2)} 与主诊断「${report.primary_diagnosis}」方向相反`),
    `  → ${against.length} 条证据（如 VLM/描述为良性、run_mil 类别反向）与主诊断矛盾，构成证据冲突（evidence_conflict）。`,
    `    该反对证据在压低聚合置信度（以 1−conf 计入）；若其为 VLM/描述来源，意味着"VLM 在说反话"，建议 verify_region 复查核实，或转人工复核。`,
  ]
}

export function formatClinical(report: Report): string {
  const level = report.confidence >= 0.7 ? '高' : report.confidence >= 0.5 ? '中' : '低'
  const u = report.uncertainty
  const lines = [
    '病理诊断报告',
    '==========',
    `主诊断: ${report.primary_diagnosis}`,
    `置信度: ${report.confidence.toFixed(2)}（${level}）`,
    '',
    '鉴别诊断:',
    ...report.differential.map((d) => `  - ${d.diagnosis}（conf=${d.confidence.toFixed(2)}）\n      支持: ${d.evidence_for.join('; ') || '—'}\n      反对: ${d.evidence_against.join('; ') || '—'}`),
    '',
    `证据链（${report.evidence_graph.nodes.length} 节点 / ${report.evidence_graph.edges.length} 边）:`,
    ...evidenceWalkthrough(report.evidence_graph),
  ]
  const cfs = counterfactualSummary(report.evidence_graph)
  if (cfs.length) lines.push('', '反事实分析:', ...cfs)
  // 矛盾检测放在反事实之后、不确定性之前——用户读报告时能先看到"有证据在说反话"
  const cs = contradictionSection(report)
  if (cs.length) lines.push('', ...cs)
  lines.push('', `不确定性: ${u ? `${u.type} → 建议 ${u.recommended_action}` : '无'}`)
  return lines.join('\n')
}

/** 报告生成：由证据图 + 综合推断产出结构化报告（含证据链溯源 + 反事实），置信度不足时标注不确定性。 */
export const generateReportSpec: ToolSpec<typeof GenerateReportSchema> = {
  name: 'generate_report',
  label: '生成病理报告',
  description: '基于证据图与综合推断生成结构化病理报告（含每条证据的坐标/倍率/模型溯源与反事实分析）；置信度过低时设置不确定性。',
  parameters: Type.Object({ format: Type.Optional(Type.String()) }),
  metadata: { category: 'output', cacheable: false, idempotent: false, depends_on: ['analyze_evidence'] },
  execute: async (params, ctx) => {
    const analysis = ctx.session.currentAnalysis
    if (!analysis) throw new Error('请先调用 analyze_evidence 生成综合推断，再生成报告')

    const graph = ctx.session.evidenceStore.getGraph()
    let uncertainty: Report['uncertainty']
    // ambiguous_morphology 置信门槛：只有当决策层"确信"形态模棱两可（conf≥门限）才归为
    // ambiguous_morphology（inspect_more）；若它自己也底气不足（[0.5,门限)），降级为更诚实的
    // insufficient_evidence（request_human）。PATHASK_AMBIG_CONF 默认 0.6。
    const AMBIG_CONF = Number(process.env.PATHASK_AMBIG_CONF ?? 0.6)
    if (analysis.confidence < 0.5) {
      uncertainty = { type: 'insufficient_evidence', recommended_action: 'request_human' }
    } else if (analysis.diagnosis.includes('待进一步评估')) {
      uncertainty = analysis.confidence >= AMBIG_CONF
        ? { type: 'ambiguous_morphology', recommended_action: 'inspect_more' }
        : { type: 'insufficient_evidence', recommended_action: 'request_human' }
    } else if ((analysis.againstCount ?? 0) > 0) {
      // 存在反对主诊断的证据（良性描述/质疑性 VLM/能力语义反向）→ 证据矛盾，优先于 model_limitation
      uncertainty = { type: 'evidence_conflict', recommended_action: 'verify_region' }
    } else if (analysis.diagnosis.includes('SCLC') || analysis.diagnosis.includes('癌')) {
      uncertainty = { type: 'model_limitation', recommended_action: 'request_human' }
    }

    const report: Report = {
      primary_diagnosis: analysis.diagnosis,
      confidence: analysis.confidence,
      differential: analysis.differential,
      evidence_graph: graph,
      uncertainty,
    }
    ctx.session.currentReport = report

    const text = params.format === 'clinical' ? formatClinical(report) : JSON.stringify(report, null, 2)
    return { text, details: report }
  },
}

export const GenerateReportSchema = Type.Object({ format: Type.Optional(Type.String()) })
export type GenerateReportParams = Static<typeof GenerateReportSchema>
