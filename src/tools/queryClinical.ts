import { Type } from 'typebox'
import type { Static } from '@earendil-works/pi-ai'
import { addEvidence, type ToolSpec } from './common'
import { softError } from './toolErrors'

function formatRow(row: Record<string, string>): string {
  return Object.entries(row)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')
}

/** 临床数据查询：按病例号读临床表。 */
export const queryClinicalSpec: ToolSpec<typeof QueryClinicalSchema> = {
  name: 'query_clinical',
  label: '临床数据查询',
  description: '按病例号查询临床/分子信息（ER/PR/HER2/分期/TP53/HRD/随访）。',
  parameters: Type.Object({ case_id: Type.String() }),
  metadata: { category: 'knowledge', cacheable: true, idempotent: true },
  execute: async (params, ctx) => {
    const row = ctx.session.clinicalData[params.case_id]
    if (!row) {
      // 把可查的 case_id 列出来（模型常把 slide_id/basename 当 case_id 传）
      return softError(ctx, 'query_clinical', 'CASE_NOT_FOUND', {
        detail: `未找到 ${params.case_id} 的临床记录。`,
        alternatives: { label: 'case_id', values: Object.keys(ctx.session.clinicalData) },
      })
    }
    const text = formatRow(row)
    addEvidence(ctx, 'observation', `临床 ${params.case_id}：${text}`, 0.9, 'query_clinical')
    return { text: `[query_clinical] ${params.case_id}: ${text}`, details: row }
  },
}

export const QueryClinicalSchema = Type.Object({ case_id: Type.String() })
export type QueryClinicalParams = Static<typeof QueryClinicalSchema>
