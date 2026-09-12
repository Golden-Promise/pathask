import { Type } from 'typebox'
import type { Static } from '@earendil-works/pi-ai'
import { addEvidence, evidenceConfidence, isVoteEvidence, type ToolSpec } from './common'

/** 14. 反事实分析：证据图 leave-one-out，量化移除某证据对置信度的影响。 */
export const counterfactualSpec: ToolSpec<typeof CounterfactualSchema> = {
  name: 'counterfactual',
  label: '反事实分析',
  description: '在证据图上做 leave-one-out：移除指定证据（或默认最高置信的观察证据，如 describe_patch / run_mil 结果），报告置信度变化，评估该证据的关键性。',
  parameters: Type.Object({ evidence_id: Type.String() }),
  metadata: { category: 'verification', cacheable: false, idempotent: false, depends_on: ['analyze_evidence'] },
  execute: async (params, ctx) => {
    const store = ctx.session.evidenceStore

    // 指定证据优先；未命中则**优先移除「方向相反」的投票证据**（反对主诊断的 VLM/描述/能力语义反向），
    // 展示"如果没有这条反对证据，置信度如何变化"——它最能说明主诊断被 dissenting 证据压到什么程度。
    // 无反向节点时才回退到最高置信的可计数证据。移除 analyze_evidence 聚合 inference 对置信无影响，
    // 故只需针对真正计入投票的 observation / run_mil inference。
    let node = store.getNode(params.evidence_id)
    if (!node) {
      const voteObs = store.allNodes().filter(isVoteEvidence)
      const against = voteObs.find((n) => n.polarity === 'against')
      const top = against ?? voteObs.sort((a, b) => b.confidence - a.confidence)[0]
      if (!top) throw new Error('反事实需要一条可移除的证据：请先调用 describe_patch / run_mil 收集证据')
      node = top
    }
    const targetId = node.id

    const before = evidenceConfidence(ctx.session)
    const { node: removed, edges } = store.removeNode(targetId)
    const after = evidenceConfidence(ctx.session)
    store.restore(removed, edges)

    const delta = before - after
    // 移除某条证据后聚合置信的实际变化：反对性证据移除后置信应**上升**（they were suppressing 主诊断），
    // 支撑性证据移除后置信应下降。以 after−before 为正方向，避免"0.48→0.55"却显示"变化 −0.07"的读写矛盾。
    const impact = after - before
    const isAgainst = node.polarity === 'against'
    const role = isAgainst
      ? impact > 0.05
        ? '关键反对证据（移除后置信显著提升，一直压制主诊断）'
        : '反对证据（轻微压制主诊断）'
      : impact < -0.05
        ? '关键支撑证据（移除后置信显著下降）'
        : impact < 0
          ? '有贡献支撑'
          : '几乎不影响'
    const trend = impact > 0 ? '提升' : impact < 0 ? '下降' : '不变'
    const confNote = `置信 ${before.toFixed(2)} → ${after.toFixed(2)}，移除后${trend} ${Math.abs(impact).toFixed(2)}（${role}）`
    addEvidence(
      ctx,
      'inference',
      `反事实：移除 ${targetId}（${removed.source.tool}，${node.polarity ?? '中性'}）→ ${confNote}`,
      Math.min(1, Math.abs(impact) + 0.5),
      'counterfactual',
    )
    return {
      text: `[counterfactual] 移除 ${targetId}（${removed.source.tool}，${node.polarity ?? '中性'}）→ ${confNote}`,
      details: { before, after, delta, impact, removed: targetId, polarity: node.polarity ?? null },
    }
  },
}

export const CounterfactualSchema = Type.Object({ evidence_id: Type.String() })
export type CounterfactualParams = Static<typeof CounterfactualSchema>
