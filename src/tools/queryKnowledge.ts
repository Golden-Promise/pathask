import { Type } from 'typebox'
import type { Static } from '@earendil-works/pi-ai'
import type { KnowledgeEntry } from '../types'
import { addEvidence, type ToolSpec } from './common'

/** 关键词加权：标题命中 ×2（该条就是讲这个词的），content 命中 ×1；大小写不敏感。 */
function scoreEntry(entry: KnowledgeEntry, blob: string): number {
  const lower = blob.toLowerCase()
  let score = 0
  for (const kw of entry.keywords) {
    const kwl = kw.toLowerCase()
    if (lower.includes(kwl)) score += entry.topic.toLowerCase().includes(kwl) ? 2 : 1
  }
  return score
}

/** 知识检索：query/context 关键词加权命中策划病理知识库（top-K）。 */
export const queryKnowledgeSpec: ToolSpec<typeof QueryKnowledgeSchema> = {
  name: 'query_knowledge',
  label: '病理知识检索',
  description: '检索策划病理知识库（形态学标准、分型、分级、免疫组化、分子标记），返回最相关 top-K 条目。',
  parameters: Type.Object({
    query: Type.String(),
    context: Type.Optional(Type.String()),
    k: Type.Optional(Type.Number()),
  }),
  metadata: { category: 'knowledge', cacheable: true, idempotent: true },
  execute: async (params, ctx) => {
    const k = params.k ?? 2
    const blob = `${params.query} ${params.context ?? ''}`
    // 癌种过滤：特异性条目必须匹配当前切片癌种，否则丢弃（防乳腺知识误导前列腺等）；
    // generic 条目为通用形态标准，适用于任意癌种。
    const slideCancer = ctx.session.wsiRegistry.get(ctx.session.currentWsiId)?.cancer
    const scored = ctx.session.knowledgeBase
      .map((entry) => ({ entry, score: scoreEntry(entry, blob) }))
      .filter(({ entry, score }) => {
        if (score <= 0) return false
        if (!slideCancer || slideCancer === 'unknown') return true
        if (entry.cancer === 'generic') return true
        return entry.cancer === slideCancer
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k)

    if (scored.length === 0) {
      return {
        text: `[query_knowledge] 该癌种（${slideCancer ?? '?'}）特异性知识缺失，建议依赖形态学/检索证据。`,
        details: { query: params.query, cancer: slideCancer },
      }
    }
    const top = scored[0].entry
    // 若当前切片是特定癌种且匹配条目均为 generic（无该癌种特异性知识）→ 明示
    const genericOnly = slideCancer && slideCancer !== 'unknown' && scored.every((s) => s.entry.cancer === 'generic')
    const suffix = genericOnly ? `（该癌种 ${slideCancer} 无特异性条目，以上为通用形态标准）` : ''
    addEvidence(
      ctx,
      'observation',
      `知识（${scored.map((s) => s.entry.topic).join('、')}）：${top.content}${suffix}`,
      0.7,
      'query_knowledge',
    )
    return {
      text: `[query_knowledge] 命中 ${scored.length} 条（top: ${top.topic}）${suffix}:\n` +
        scored.map((s) => `- 【${s.entry.topic}】${s.entry.content}`).join('\n'),
      details: { entries: scored.map((s) => ({ id: s.entry.id, topic: s.entry.topic, score: s.score, cancer: s.entry.cancer })) },
    }
  },
}

export const QueryKnowledgeSchema = Type.Object({
  query: Type.String(),
  context: Type.Optional(Type.String()),
  k: Type.Optional(Type.Number()),
})
export type QueryKnowledgeParams = Static<typeof QueryKnowledgeSchema>
