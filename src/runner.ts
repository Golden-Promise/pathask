import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { EvidenceNode, EvidenceSource, PathAskSession, Region } from './types'
import { analyzeEvidenceSpec } from './tools/analyzeEvidence'
import { fsSafe, isVoteEvidence, realWsi, runSystemTool } from './tools/common'
import { counterfactualSpec } from './tools/counterfactual'
import { describePatchSpec } from './tools/describePatch'
import { formatClinical, generateReportSpec } from './tools/generateReport'
import { inspectRegionSpec } from './tools/inspectRegion'
import { verifyRegionSpec } from './tools/verifyRegion'
import type { MilPrediction } from './wsi/WsiClient'
import { ensureBaseline } from './wsi/navigator'
import { loopGuardSummary, resetLedger } from './loop/governance'
import { overlapRatio } from './util/geom'

/** 从 assistant 消息里提取纯文本（不依赖 pi-ai contentText 的具体签名） */
export function lastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    const parts = m.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
    if (parts.length > 0) return parts.join('\n')
  }
  return ''
}

/** 证据图里的反事实（leave-one-out）是否「新鲜」——存在且不早于最后一次 analyze_evidence 推断。
 *  反事实跑在 analyze 之前（陈旧，不含最终证据集）→ 报告期应重跑。 */
function hasFreshCounterfactual(session: PathAskSession): boolean {
  const nodes = session.evidenceStore.allNodes()
  const cfNodes = nodes.filter((n) => n.source.tool === 'counterfactual')
  if (cfNodes.length === 0) return false
  const lastCfTs = Math.max(...cfNodes.map((n) => n.timestamp))
  const lastAnalysisTs = Math.max(
    -Infinity,
    ...nodes.filter((n) => n.type === 'inference' && n.source.tool === 'analyze_evidence').map((n) => n.timestamp),
  )
  return lastCfTs >= lastAnalysisTs
}

/** 幂等：重跑反事实前把旧 counterfactual 节点移出图（多次重跑不越积越多；新增节点是独立 inference）。 */
function clearCounterfactuals(session: PathAskSession): void {
  for (const n of session.evidenceStore.allNodes()) {
    if (n.source.tool === 'counterfactual') session.evidenceStore.removeNode(n.id)
  }
}

/** 最后一次 `analyze_evidence` 是否**不早于**最后一条可投票证据（分析新鲜度）。
 *  与 `hasFreshCounterfactual` 对称，补的是同一类缺口的另一半：模型第 4 步 analyze、
 *  第 6 步又 perceive 出新观察时，`ensureStructuredReport` 用的仍是**旧** `currentAnalysis`——
 *  新观察既进不了投票，也进不了证据图里的裁决。反事实早就有这条检查，分析一直没有。
 *  基准取 `isVoteEvidence` 而非「全部节点」：只有会进投票的观察才谈得上让分析过时。
 *  否则一条 `query_knowledge` 背景参考也能触发重跑，而它对票数毫无影响——重跑是贵的。 */
export function hasFreshAnalysis(session: PathAskSession): boolean {
  const nodes = session.evidenceStore.allNodes()
  const lastAnalysisTs = Math.max(
    -Infinity,
    ...nodes.filter((n) => n.type === 'inference' && n.source.tool === 'analyze_evidence').map((n) => n.timestamp),
  )
  if (lastAnalysisTs === -Infinity) return false
  const lastVoteTs = Math.max(-Infinity, ...nodes.filter(isVoteEvidence).map((n) => n.timestamp))
  return lastAnalysisTs >= lastVoteTs
}

/** 重跑 analyze_evidence 前清掉上一轮的分析节点。按 `source.tool` 清，**不是**按 `type==='inference'`
 *  ——`analyzeEvidence` 每次调用落**两个**节点（inference 与 conclusion），
 *  只清 inference 会留下一份再没人关联的旧 conclusion：证据图里出现两个结论，而报告期走读会两个都列。
 *  `removeNode` 连两个方向的关联边一起删（与 `clearCounterfactuals` 同一套），故不留悬空边。
 *  **重跑失败（throw）时调用方直接 `return null`（真 abstain）**，此时已清掉的节点不会污染任何已落盘的东西：
 *  `generateReport` 用 `evidenceStore.getGraph()` 取的是**新数组快照**，
 *  `currentReport` 里那份图不随 store 变化。 */
export function clearAnalysisNodes(session: PathAskSession): void {
  for (const n of session.evidenceStore.allNodes()) {
    if (n.source.tool === 'analyze_evidence') session.evidenceStore.removeNode(n.id)
  }
}

/** 分析新鲜度重跑开关（**默认关**）。默认关不是保守，是这一项**风险最高**：重跑会改报告置信度
 *  与证据图（乃至翻转主诊断）。与其他开关共用同一套读取约定：只认显式的开启值。 */
export function freshAnalysisEnabled(): boolean {
  const raw = process.env.PATHASK_FRESH_ANALYSIS
  if (raw === undefined || raw.trim() === '') return false
  return /^(1|true|on|yes)$/i.test(raw.trim())
}

type MilHotspot = MilPrediction['attention_hotspots'][number]
type MilHotspotNode = EvidenceNode & { source: EvidenceSource & { attention_hotspots: MilHotspot[] } }

/** 热点闭环候选：证据图中带 attention 热点的最高置信 run_mil 节点 + 构造的热点描述区域。 */
export interface HotspotCandidate {
  nodeId: string
  region: Region
  label?: string
  confidence: number
  capabilityId?: string
}

/** 两区域 bbox 交叠比例（相对 b 的面积），0-1。实现已移到 `util/geom`（指纹层要用同一份，
 *  留在这里会让 runner 与工具层成环）；此处**转出**以保持既有 import 路径与探针不变。 */
export { overlapRatio } from './util/geom'

/** 纯逻辑：选最高置信 run_mil 节点，把 top-1 热点（level0 左上角）扩成 512 基底像素的描述区域，
 *  倍率=原生 objective（level0 真读，最贴近 MIL 输入）。无结构化热点的节点（如 mock 路径）返回 null。 */
export function selectHotspotRegion(nodes: EvidenceNode[], slideId: string, objectivePower: number): HotspotCandidate | null {
  const milNodes = nodes.filter(
    (n): n is MilHotspotNode =>
      n.type === 'inference' && n.source.tool === 'run_mil' && Array.isArray(n.source.attention_hotspots) && n.source.attention_hotspots.length > 0,
  )
  if (milNodes.length === 0) return null
  const best = milNodes.reduce((a, b) => (b.confidence > a.confidence ? b : a))
  const h = best.source.attention_hotspots[0]
  const size = 512
  return {
    nodeId: best.id,
    region: {
      id: `mil_hotspot_${(slideId.split('/').pop() ?? slideId).slice(0, 8)}`,
      slide_id: slideId,
      x: Math.max(0, Math.round(h.x - size / 2)),
      y: Math.max(0, Math.round(h.y - size / 2)),
      w: size,
      h: size,
      magnification: objectivePower,
      label: best.source.label,
    },
    label: best.source.label,
    confidence: best.confidence,
    capabilityId: best.source.capability_id,
  }
}

/** 幂等：已有 describe_patch / verify_region 观察覆盖该热点区域（bbox 重叠 ≥ 50%）则视为已描述。 */
export function hotspotCovered(nodes: EvidenceNode[], region: Region): boolean {
  return nodes.some((n) => {
    if (n.type !== 'observation') return false
    const c = n.source.coords
    if (!c || (n.source.tool !== 'describe_patch' && n.source.tool !== 'verify_region')) return false
    return overlapRatio(c, region) >= 0.5
  })
}

/** MIL 热点闭环确定性层。若 run_mil 带 attention 热点、热点区域尚未被 VLM 描述，则程序化
 *  inspect_region + describe_patch（询问带 MIL 预测，让 VLM 可反驳锚点），把「模型为什么这么判」补进证据链。
 *  幂等（hotspotCovered 命中即跳过）；仅真实会话（mock 无结构化热点坐标）。返回是否新增热点描述证据。 */
async function ensureHotspotClosed(session: PathAskSession): Promise<boolean> {
  const slideId = session.currentWsiId
  if (!slideId) return false
  const nodes = session.evidenceStore.allNodes()
  // 系统调用的 toolCallId 前缀 sys-：既标识「非 LLM 发起」，也让账本/部分证据标记能按 id 配对
  const SYS = 'sys-mil-hotspot'
  const real = realWsi({ session, toolCallId: SYS }, slideId)
  if (!real) return false // mock 会话（无真实 patch 读取）跳过
  try {
    const info = await real.client.info(slideId)
    const cand = selectHotspotRegion(nodes, slideId, info.objective_power ?? 40)
    if (!cand) return false
    if (hotspotCovered(nodes, cand.region)) return false
    await runSystemTool(inspectRegionSpec, session, SYS, { region: cand.region })
    const patches = session.patchCache.get(cand.region.id)
    if (!patches || patches.length === 0) return false
    await runSystemTool(describePatchSpec, session, SYS, {
      patch_ref: patches[0].id,
      question: `这是 MIL 分类器（${cand.capabilityId ?? '能力库'}）的 attention 热点区域——模型预测该全片为「${cand.label ?? '未知'}」（conf=${cand.confidence.toFixed(2)}）时最关键的 patch。请客观描述此 patch 的形态学特征（细胞核大小/异型性/排列/间质等），并判断镜下形态与这一预测是否一致，还是支持其他诊断。`,
    })
    console.warn(`[runner] 热点闭环：对 top-1 热点 ${cand.region.id}@(${cand.region.x},${cand.region.y}) 补 describe_patch 证据（conf=${cand.confidence.toFixed(2)}）`)
    return true
  } catch (e) {
    console.error(`[runner] 热点描述失败（不阻塞报告）: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

/** 兜底收尾：保证每个会话以结构化报告收尾（报告契约不交给 LLM 临场发挥）。
 *  三阶段兜底：
 *   1. LLM 未调 analyze_evidence 就文本收尾（"证据不足"式放弃）→ 程序化补跑 analyze_evidence，
 *      用已收集证据投票出诊断——LLM 可偷懒，投票引擎不偷懒。证据库空（真无证据）才返回 null。
 *   2. 证据图缺反事实或反事实陈旧（跑在最后一次 analyze 之前）→ 程序化重跑 counterfactual
 *      （默认移除最高置信可投票证据；重跑前清旧节点保证幂等）
 *   3. 报告未生成（或反事实补跑后快照需刷新）→ 程序化 generate_report（clinical 格式）
 *  返回补跑生成的报告文本；无需兜底（LLM 已完整收尾）或失败返回 null。
 *  设计分工：创造性探索（看哪、看什么、信多少）是 LLM 的；报告契约是系统的、确定性的。
 *  ⚠️ 契约判定的唯一标准是证据库内容，不是 LLM 的"信心声明"——LLM 说证据不足 ≠ 系统判定不足。 */
/** evidence_conflict 未解决 → 系统层**强制** verify_region（而非仅给 LLM 建议）。
 *  找一个 against 观察（优先 describe_patch）的坐标去高倍复核；复核成功则新证据进投票重跑 analyze+report。
 *  无复核坐标或 VLM 不可用 → 置信压到 0.3 并标"证据矛盾未解决，建议人工复核"。 */
async function forceResolveConflict(session: PathAskSession): Promise<{ text: string } | null> {
  const report = session.currentReport
  if (!report || report.uncertainty?.type !== 'evidence_conflict') return null
  const target = session.evidenceStore
    .allNodes()
    .filter((n) => n.polarity === 'against' && !n.source.stub && n.source.coords)
    .sort((a, b) => (a.source.tool === 'describe_patch' ? -1 : 1) - (b.source.tool === 'describe_patch' ? -1 : 1))[0]
  const markUnresolved = (why: string) => {
    report.confidence = Math.min(report.confidence, 0.3)
    report.uncertainty = { type: 'evidence_conflict', recommended_action: 'request_human' }
    return { text: `${formatClinical(report)}\n\n⚠️ 证据矛盾未解决（${why}），建议人工复核。` }
  }
  if (!target?.source.coords) return markUnresolved('无复核坐标')
  try {
    await runSystemTool(verifyRegionSpec, session, 'sys-verify-conflict', {
      region: target.source.coords,
      previous_judgment: report.primary_diagnosis,
      verification_question: '请在高倍镜下客观复核该区域的恶性浸润性形态特征：有无间质内单个或小簇异型细胞浸润、破坏性浸润性生长、腺体/基底结构破坏、异常核分裂、明显核异型。重点判断镜下形态是否支持【恶性浸润性生长】（而非问良性还是恶性——那是诊断判断）。请只描述实际看到的形态，不要命名具体诊断。',
    })
    await runSystemTool(analyzeEvidenceSpec, session, 'sys-analyze-conflict', {})
    const res = await runSystemTool(generateReportSpec, session, 'sys-generate-conflict', { format: 'clinical' })
    return { text: res.text }
  } catch (e) {
    console.warn(`[runner] 矛盾强制验证失败（VLM 不可用）→ 降置信+人工复核: ${e instanceof Error ? e.message : String(e)}`)
    return markUnresolved('复核不可用')
  }
}

/** 兜底阶段 0.5（describe 下限）：LLM 若 0（或 < PATHASK_MIN_DESCRIBE 条）真实 describe 就收尾——
 *  采错区/跳过形态证据时，系统用 detect_roi 的 top ROI 确定性补 describe，
 *  保证"弃诊前至少看过镜下形态"。幂等：该区域已被 describe/verify 覆盖则跳过。返回是否新增证据。 */
async function ensureDescribeFloor(session: PathAskSession): Promise<boolean> {
  const minDescribe = Number(process.env.PATHASK_MIN_DESCRIBE ?? 1)
  const describeCount = session.evidenceStore
    .allNodes()
    .filter((n) => n.source.tool === 'describe_patch' && !n.source.stub && !n.source.degenerate).length
  if (describeCount >= minDescribe) return false
  const rois = [...(session.roiCache?.values() ?? [])].flat()
  if (rois.length === 0) return false
  const SYS = 'sys-desc-floor'
  if (!realWsi({ session, toolCallId: SYS }, session.currentWsiId)) return false // mock 跳过
  let added = 0
  for (const region of rois.slice(0, 3)) {
    if (hotspotCovered(session.evidenceStore.allNodes(), region)) continue
    try {
      await runSystemTool(inspectRegionSpec, session, SYS, { region })
      const patches = session.patchCache.get(region.id)
      if (!patches || patches.length === 0) continue
      await runSystemTool(describePatchSpec, session, SYS, {
        patch_ref: patches[0].id,
        question: '客观描述此 patch 的镜下形态（细胞核大小/异型性/排列/间质），并判断良恶性方向，不要给诊断名称。',
      })
      added += 1
      if (describeCount + added >= minDescribe) break
    } catch (e) {
      console.warn(`[runner] describe 下限补描述失败（不阻塞报告）: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (added > 0) console.warn(`[runner] describe 下限兜底：LLM 仅 ${describeCount} 条真实 describe 即收尾 → 程序化补 ${added} 条（top ROI ${rois[0]?.id}）`)
  return added > 0
}

export async function ensureStructuredReport(session: PathAskSession): Promise<string | null> {
  // 阶段 0：MIL 热点闭环——run_mil 带 attention 热点且热点区域未被描述过 → 程序化补一条
  // 热点 describe_patch 观察证据（进投票）。新证据出现且已有 analyze → 重跑投票（热点观察参与裁决）。
  // 增强项：失败不阻塞报告。mock 会话自动跳过（无结构化热点坐标）。
  let rerunAnalysis = false
  try {
    const added = await ensureHotspotClosed(session)
    if (added && session.currentAnalysis) rerunAnalysis = true
  } catch (e) {
    console.error(`[runner] 热点闭环失败（不阻塞报告）: ${e instanceof Error ? e.message : String(e)}`)
  }
  // 阶段 0.5：describe 下限——0 条真实形态描述就收尾 → 程序化补，避免"弃诊前没看过镜下形态"
  try {
    const addedFloor = await ensureDescribeFloor(session)
    if (addedFloor && session.currentAnalysis) rerunAnalysis = true
  } catch (e) {
    console.error(`[runner] describe 下限兜底失败（不阻塞报告）: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 阶段 1：analyze_evidence 缺失（LLM analyze 前放弃）、新增热点证据、或分析陈旧
  // → 程序化（重）跑投票。
  // 陈旧这一条要**先清旧节点再重跑**（`analyzeEvidence` 是追加而非覆盖），否则每重跑一次
  // 图上就多一份 inference+conclusion。清空后重跑产出的那份就是图里唯一的分析。
  const staleAnalysis = freshAnalysisEnabled() && !hasFreshAnalysis(session)
  if (staleAnalysis) clearAnalysisNodes(session)
  if (!session.currentAnalysis || rerunAnalysis || staleAnalysis) {
    const obs = session.evidenceStore.allNodes().filter((n) => n.type !== 'conclusion')
    if (obs.length === 0) return null // 真无证据（连 scan_overview 都没跑）→ 无法投票，真 abstain
    try {
      await runSystemTool(analyzeEvidenceSpec, session, 'sys-analyze-evidence', {})
      if (staleAnalysis) console.warn(`[runner] 分析陈旧（analyze 之后又采到可投票的新证据）→ 清旧节点并重跑 analyze_evidence`)
      else if (rerunAnalysis) console.warn(`[runner] 热点证据新增 → 重跑 analyze_evidence（热点观察进投票）`)
      else console.warn(`[runner] LLM 未调 analyze_evidence 即收尾，系统程序化补跑投票（基于 ${obs.length} 条证据）`)
    } catch (e) {
      console.error(`[runner] analyze_evidence 兜底失败（真 abstain）: ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }
  let rerunReport = false
  // 反事实必须「新鲜」——LLM 可能先跑反事实再跑 analyze（陈旧，不含最终证据集），
  // 此时重跑（默认挑最高置信可投票证据，如 run_mil）；多次重跑前先清旧节点（幂等）。
  if (!hasFreshCounterfactual(session)) {
    try {
      clearCounterfactuals(session)
      await runSystemTool(counterfactualSpec, session, 'sys-counterfactual', { evidence_id: '' })
      rerunReport = true // 补跑了反事实 → 既有报告快照不含它，需刷新
    } catch (e) {
      // 反事实是增强项，失败不阻塞报告生成
      console.error(`[runner] counterfactual 兜底失败（不阻塞报告）: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // LLM 已出报告但带未解决证据矛盾 → 仍强制走验证，不直接返回
  if (session.currentReport && !rerunReport && session.currentReport.uncertainty?.type !== 'evidence_conflict') return null
  let res
  try {
    res = await runSystemTool(generateReportSpec, session, 'sys-generate-report', { format: 'clinical' })
  } catch (e) {
    console.error(`[runner] generate_report 兜底失败: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
  // 阶段 2：evidence_conflict → 系统层强制 verify_region（而非仅建议）；失败降置信+人工复核
  const resolved = await forceResolveConflict(session)
  return resolved ? resolved.text : res.text
}

/** 报告落盘：`data/reports/<slide>_<时间戳>.json`（结构化 Report + meta 溯源）+ `.md`（临床格式文本）。
 *  每次阅片一个产物，文件名含 slide_id 便于查找。 */
export async function persistReport(
  session: PathAskSession,
  opts: { outDir?: string; question?: string } = {},
): Promise<{ json: string; md: string }> {
  const report = session.currentReport
  if (!report) throw new Error('无报告可落盘：请先 analyze_evidence → generate_report（或走 ensureStructuredReport）')
  const outDir = opts.outDir ?? join(process.cwd(), 'data', 'reports')
  await mkdir(outDir, { recursive: true })
  const slideId = session.currentWsiId
  const cancer = session.wsiRegistry.get(slideId)?.cancer
  const now = new Date()
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  // 文件名做 fs 安全化（slideId 含 `/` 时直接拼会把中间段当目录 → ENOENT）；meta.slide_id 仍存原 id 便于溯源
  const base = `${fsSafe(slideId)}_${stamp}`
  const jsonPath = join(outDir, `${base}.json`)
  const mdPath = join(outDir, `${base}.md`)
  const payload = {
    meta: {
      slide_id: slideId,
      cancer,
      question: opts.question ?? null,
      generated_at: now.toISOString(),
      metrics: session.metrics.summary(), // 单次阅片成本随报告落盘
      loop_guard: loopGuardSummary(session),
    },
    report,
  }
  await writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8')
  await writeFile(mdPath, formatClinical(report), 'utf8')
  return { json: jsonPath, md: mdPath }
}

/** 单轮提问：prompt → 等待闭环结束 → 返回最后一条 assistant 文本。
 *  传入 session 时启用兜底收尾：LLM 若跳过 generate_report，系统补跑保证结构化报告。
 *  opts.persist=true 时报告落盘 data/reports/（json + md），路径附在返回文本末尾。 */
export async function runQuestion(
  agent: Agent,
  question: string,
  session?: PathAskSession,
  opts: { persist?: boolean; outDir?: string } = {},
): Promise<string> {
  // 指标：工具执行计时（toolCallId 配对，防并发串线）+ LLM 每轮 token usage
  if (session) {
    // 开新问题前清循环台账。**不清就是真 bug**：同一 session 问第二个问题时，
    // 第一个问题用掉的步数会让门禁从第一次调用起就拦下所有探索类工具（步数上限是**每问题**的）。
    resetLedger(session)
    // 清空 steering 队列。上一题的治理提示若还没被 drain 就留在了 Agent 队列里——
    // 只在**轮末**drain，而退出路径（`shouldStopAfterTurn` 为真、或 abort）
    // 会跳过那一步。不清的话，上一题「已经停滞 4 步，请换 region」会作为**新题的第一条输入**
    // 出现，模型会拿它当本题的上下文——串题，而且极难从结果里反查出来。
    agent.clearSteeringQueue()
    session.currentQuestion = question // 决策层（LLM 诊断）/反事实需要病例上下文
    agent.subscribe((event) => {
      if (event.type === 'tool_execution_start') session.metrics.toolStart(event.toolCallId, event.toolName)
      else if (event.type === 'tool_execution_end') session.metrics.toolEnd(event.toolCallId)
      else if (event.type === 'message_start') {
        const usage = (event as { message?: { usage?: { input?: number; output?: number; reasoning?: number } } }).message?.usage
        if (usage) session.metrics.recordLlm(usage)
      }
    })
  }
  // 感知模式：打开 slide 时预置导航器基线（问题无关密度采样）进 roiCache，多问题复用、agent 直连 perceive 免二次 detect。
  if (session) {
    try {
      await ensureBaseline(session, session.currentWsiId)
    } catch (e) {
      console.warn(`[runner] 导航器基线预置失败（不阻塞）: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // **per-case 墙钟截止**。工具数上限管不住「步数不多但每步都慢」——没有时间上限时整例会无限拖。
  // 到点 abort → 在途工具被 ctx.signal 掐断（其已产生的观测保留并标 partial）→ 走下面的兜底收尾。
  const caseBudgetMs = Number(process.env.PATHASK_CASE_TIMEOUT_MS ?? 900_000)
  const deadline = setTimeout(() => {
    console.warn(`[runner] 单例墙钟截止 ${caseBudgetMs}ms，abort 当前会话: ${session?.currentWsiId ?? '(无会话)'}`)
    try {
      agent.abort()
    } catch (e) {
      console.warn(`[runner] abort 失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, caseBudgetMs)
  ;(deadline as unknown as { unref?: () => void }).unref?.()
  try {
    await agent.prompt(question)
  } finally {
    clearTimeout(deadline)
  }
  let text = lastAssistantText(agent.state.messages)
  if (session) {
    const reportText = await ensureStructuredReport(session)
    if (reportText) text = [text, '', '=== 结构化病理报告（系统收尾生成） ===', reportText].filter(Boolean).join('\n')
    if (opts.persist) {
      try {
        const paths = await persistReport(session, { question, outDir: opts.outDir })
        text = `${text}\n\n[报告已落盘]\n  ${paths.md}\n  ${paths.json}`
      } catch (e) {
        console.error(`[runner] 报告落盘失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  if (text) return text
  return `（无文本回复，最后消息 role=${agent.state.messages[agent.state.messages.length - 1]?.role}）`
}
