import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { PathAskSession } from '../types'
import { makeTool } from './common'
import { scanOverviewSpec } from './scanOverview'
import { detectRoiSpec } from './detectRoi'
// 旧两步感知已并入 perceive（注释保留？如需再单独暴露 inspect_region / describe_patch 给 agent，取消下面两行 import + 工具注册）
// import { inspectRegionSpec } from './inspectRegion'
// import { describePatchSpec } from './describePatch'
// run_mil 已下线（专病模型全覆盖不现实）—— 从 agent 工具集撤下，统一走 perceive + 检索 + 分析路径。
// import { runMilSpec } from './runMil'
import { queryClinicalSpec } from './queryClinical'
import { queryKnowledgeSpec } from './queryKnowledge'
import { verifyRegionSpec } from './verifyRegion'
import { retrieveSimilarCaseSpec } from './retrieveSimilarCase'
import { analyzeEvidenceSpec } from './analyzeEvidence'
import { counterfactualSpec } from './counterfactual'
import { generateReportSpec } from './generateReport'
import { perceiveSpec } from './perceive'

/** 组装 10 个 AgentTool（含 perceive：单次「切块+批量描述」，替代旧的两步 inspect_region→describe_patch，省一次 agent 往返）。
 *  run_mil 已下线（专病模型全覆盖不现实），统一走 perceive + 检索 + 分析路径。
 *  闭包捕获同一 PathAskSession（证据链读写走它）。 */
export function createTools(session: PathAskSession): AgentTool<any>[] {
  const tools: AgentTool<any>[] = [
    makeTool(scanOverviewSpec, session),
    makeTool(detectRoiSpec, session),
    // 旧两步感知（inspect_region + describe_patch）已并入 perceive —— 不再暴露给 agent，强制走 perceive 省一次往返。
    // runner 侧的 F5 热点闭环 / P4 高倍复核仍直接调这两个 spec（不经 agent），不受影响。
    // run_mil 已下线（专病模型全覆盖不现实）—— 不再注册，agent 不会调用。
    makeTool(queryClinicalSpec, session),
    makeTool(queryKnowledgeSpec, session),
    makeTool(verifyRegionSpec, session),
    makeTool(retrieveSimilarCaseSpec, session),
    makeTool(analyzeEvidenceSpec, session),
    makeTool(counterfactualSpec, session),
    makeTool(generateReportSpec, session),
    makeTool(perceiveSpec, session),
  ]
  return tools
}
