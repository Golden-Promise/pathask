import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { PathAskSession } from '../types'
import { makeTool } from './common'
import { scanOverviewSpec } from './scanOverview'
import { detectRoiSpec } from './detectRoi'
import { queryClinicalSpec } from './queryClinical'
import { queryKnowledgeSpec } from './queryKnowledge'
import { verifyRegionSpec } from './verifyRegion'
import { retrieveSimilarCaseSpec } from './retrieveSimilarCase'
import { analyzeEvidenceSpec } from './analyzeEvidence'
import { counterfactualSpec } from './counterfactual'
import { generateReportSpec } from './generateReport'
import { perceiveSpec } from './perceive'

/** 组装 10 个 AgentTool（含 perceive：单次「切块+批量描述」，省一次 agent 往返）。
 *  闭包捕获同一 PathAskSession（证据链读写走它）。 */
export function createTools(session: PathAskSession): AgentTool<any>[] {
  const tools: AgentTool<any>[] = [
    makeTool(scanOverviewSpec, session),
    makeTool(detectRoiSpec, session),
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
