import { Type } from 'typebox'
import type { Static } from '@earendil-works/pi-ai'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SimilarCaseRecord } from '../types'
import { softError } from './toolErrors'
import { addEvidence, findPatchByRef, realWsi, type ToolSpec } from './common'

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const INDEX_PATH = path.join(PROJECT_ROOT, 'data', 'similar_case_index.json')

/**
 * 相似度下限：查询向量与同癌种候选的最大余弦相似度低于该值时，判「无接近相似病例」（诚实空，不 addEvidence，
 * 不制造"最相似(sim=0.2)+偏置句"的强方向噪声）。env 可调。
 */
const SIM_FLOOR = Number(process.env.PATHASK_SIM_FLOOR ?? 0.4)

/** 索引懒加载（slide 级 CONCH 512 维向量） */
let _indexCache: SimilarCaseRecord[] | null = null
async function loadIndex(): Promise<SimilarCaseRecord[]> {
  if (_indexCache) return _indexCache
  try {
    const raw = await readFile(INDEX_PATH, 'utf8')
    _indexCache = (JSON.parse(raw).cases ?? []) as SimilarCaseRecord[]
    if (!_indexCache.length) console.warn('[retrieve_similar_case] 索引为空')
  } catch (e) {
    _indexCache = []
    console.warn(`[retrieve_similar_case] 索引不可用（${INDEX_PATH}）：${e instanceof Error ? e.message : e}，跑 scripts/data-build/build_db_index.py`)
  }
  return _indexCache
}

function dot(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** 诊断良恶性判定（相似病例的 diagnosis 字段）：恶性词命中→malignant，良性/炎症词命中→benign。
 * 良性词须含英文条目（HISTAI/TCGA 的 benign diagnosis 是英文：hyperplasia/adenoma/leiomyoma/cyst…）。 */
function diagDirection(dx: string): 'benign' | 'malignant' | 'unknown' {
  if (!dx) return 'unknown'
  // 先查恶性（"no evidence of carcinoma" 会命中良性，故恶性词必须优先于否定式——否定式在良性正则里）
  if (/癌|腺癌|肉瘤|淋巴瘤|黑色素瘤|恶性肿瘤|invasive|malignant|carcinoma|adenocarcinoma|sarcoma|lymphoma|melanoma/i.test(dx)) return 'malignant'
  // 良性/炎症/非浸润：中文术语 + 英文良性病理词（hyperplasia/adenoma/fibroadenoma/leiomyoma/myoma/cyst/polyp/teratoma）+ 否定式。
  // 注意：不加 in situ（原位癌含 carcinoma 已被上面抓走；纯 in situ 是癌前非良性，防误判）。
  if (/良性|反应性|腺瘤|炎|增生|息肉|intact|benign|reactive|hyperplasia|adenoma|fibroadenoma|leiomyoma|myoma|cyst|polyp|teratoma|no evidence of malig|no residual|free of/i.test(dx)) return 'benign'
  return 'unknown'
}

export interface SelectSimilarResult {
  top: SimilarCaseRecord[]
  /** true=同癌种候选全存在但最高相似度低于下限（即「无接近相似病例」）——仅真实路径（有查询向量）可能出现 */
  floor: boolean
  maxSim?: number
  hasBenignControl: boolean
}

/**
 * 相似病例选择（mock/real 共用）。
 *
 * @param index    相似病例库（mock 传会话索引，real 传 similar_case_index.json）
 * @param queryVec 查询 patch 的 CONCH 向量；undefined= mock 路径（无向量，无法按余弦排序，按索引序取）
 * @param opts.cancer      当前切片癌种（同癌种过滤，防跨癌种污染；'unknown'/缺省=不按癌种过滤）
 * @param opts.queryCaseId 当前病例 case_id（排除自身——查询 patch 与该 slide 的均值必然最相似，保留=「检索到当前病例」）
 * @param opts.benignHint  本会话已见良性形态（describe_patch）→ 优先检索良性对照
 * @param opts.k           取多少个
 */
export function selectSimilar(
  index: SimilarCaseRecord[],
  queryVec: number[] | undefined,
  opts: { cancer?: string; queryCaseId?: string; benignHint: boolean; k: number },
): SelectSimilarResult {
  const { cancer, queryCaseId, benignHint, k } = opts
  // 排除当前病例自身（同一 case_id 的索引条目）——查询 patch 与该 slide 的均值必然最相似，保留=「检索到当前病例」而非「相似病例」。
  const pool = queryCaseId ? index.filter((c) => c.case_id !== queryCaseId) : index
  // 癌种过滤：只保留与当前切片同癌种的相似病例（防乳腺病例污染前列腺等）；无同癌种则空。
  const cancerPool = (!cancer || cancer === 'unknown') ? pool : pool.filter((c) => c.cancer === cancer)
  if (cancerPool.length === 0) return { top: [], floor: false, hasBenignControl: false }

  const kk = Math.max(1, k)
  const hasBenignControl = cancerPool.some((c) => diagDirection(c.diagnosis ?? '') === 'benign')

  // mock 路径（无查询向量）：无法按余弦排序，按索引序取；benignHint 时良性在前（仅顺序，无 sim 可排）。
  if (!queryVec) {
    let sel = cancerPool
    if (benignHint) {
      sel = [...cancerPool].sort((a, b) =>
        (diagDirection(b.diagnosis ?? '') === 'benign' ? 1 : 0) - (diagDirection(a.diagnosis ?? '') === 'benign' ? 1 : 0))
    }
    return { top: sel.slice(0, kk), floor: false, hasBenignControl }
  }

  // 真实路径：按查询向量与索引的余弦相似度排序（索引 embedding 已 L2 归一，余弦=点积）。
  const ranked = cancerPool
    .map((c) => ({ ...c, similarity: Math.round(dot(queryVec, c.embedding) * 1000) / 1000 }))
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
  const maxSim = ranked[0]?.similarity ?? 0
  // 上限：所有同癌种候选中最高相似度仍低于下限 → 无接近相似病例（诚实空，不 addEvidence）。
  if (maxSim < SIM_FLOOR) return { top: [], floor: true, maxSim, hasBenignControl }

  let top = ranked.slice(0, kk)
  // 良性对照：benignHint 且库内良恶都有且 k>1 时，保良恶混合（方向对照），不整组塌成良性。
  // 混合后仍按 sim 降序展示。
  if (benignHint && hasBenignControl && kk > 1) {
    const benign = ranked.filter((c) => diagDirection(c.diagnosis ?? '') === 'benign')
    const nonBenign = ranked.filter((c) => diagDirection(c.diagnosis ?? '') !== 'benign')
    if (benign.length > 0 && nonBenign.length > 0) {
      const nBenign = Math.min(benign.length, Math.max(1, Math.floor(kk / 2)))
      top = [...benign.slice(0, nBenign), ...nonBenign.slice(0, kk - nBenign)]
        .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
        .slice(0, kk)
    }
  }
  return { top, floor: false, maxSim, hasBenignControl }
}

/** 相似病例检索：按当前 patch 形态用 CONCH 检索最相似历史病例（slide 级索引，余弦 top-K）。 */
export const retrieveSimilarCaseSpec: ToolSpec<typeof RetrieveSimilarCaseSchema> = {
  name: 'retrieve_similar_case',
  label: '相似病例检索',
  description: '按当前 patch 的形态特征（CONCH 编码）检索最相似的历史病例（含诊断/亚型/相似度）。',
  parameters: Type.Object({
    patch_ref: Type.String(),
    k: Type.Optional(Type.Number()),
  }),
  metadata: { category: 'knowledge', cacheable: true, idempotent: true },
  execute: async (params, ctx) => {
    const k = params.k ?? 1

    // 在 patchCache 中定位当前 patch（跨区域查找）。容忍模型把含斜杠 id 规范化成展平 basename 的表示，
    // 避免精确匹配失败抛「未知 patch_ref」→ 模型误判 patch 未采集 → 触发非必要重inspect/检索循环。
    const patch = findPatchByRef(ctx.session.patchCache, params.patch_ref)
    if (!patch) {
      return softError(ctx, 'retrieve_similar_case', 'PATCH_NOT_FOUND', {
        detail: `未找到 patch_ref: ${params.patch_ref}。`,
        alternatives: { label: 'patch_ref', values: [...ctx.session.patchCache.values()].flat().map((p) => p.id) },
      })
    }

    const rw = realWsi(ctx, ctx.session.currentWsiId)
    const slideCancer = ctx.session.wsiRegistry.get(ctx.session.currentWsiId)?.cancer
    const benignHint = ctx.session.evidenceStore.allNodes().some((n) =>
      n.source.tool === 'describe_patch' && !n.source.stub &&
      /benign|良性|no evidence of malign|intact|reactive|favor benign/i.test(n.claim))

    // ===== 真实路径：CONCH 编码当前 patch → 调共享 selectSimilar（与索引比对） =====
    if (rw) {
      try {
        const abs = path.resolve(PROJECT_ROOT, patch.cached_path ?? '')
        const b64 = (await readFile(abs)).toString('base64')
        const { image_vectors } = await rw.client.conchEmbed([`data:image/png;base64,${b64}`], [], ctx.signal)
        const index = await loadIndex()
        const queryCaseId = ctx.session.wsiRegistry.get(ctx.session.currentWsiId)?.case_id
        if (image_vectors?.[0] && index.length > 0) {
          const { top, floor, maxSim, hasBenignControl } = selectSimilar(index, image_vectors[0],
            { cancer: slideCancer, queryCaseId, benignHint, k })

          // 相似度下限（诚实空）：最高相似仍低于阈值 → 不制造"最相似+偏置句"噪声。
          if (floor) {
            return {
              text: `[retrieve_similar_case] 无接近相似病例（同癌种候选最高 sim=${maxSim ?? '?'}，低于阈值 ${SIM_FLOOR}）——不做跨癌种填充。`,
              details: { similar: [], floor: true, max_sim: maxSim, query_patch: params.patch_ref, cancer: slideCancer, embedder: 'conch_ViT-B-16', benign_hint: benignHint, benign_control_avail: hasBenignControl },
            }
          }
          if (top.length === 0) {
            return {
              text: `[retrieve_similar_case] 无同癌种（${slideCancer ?? '?'}）相似病例，不做跨癌种填充（索引可查癌种 ${index.length} 例，均非本癌种）。`,
              details: { similar: [], query_patch: params.patch_ref, cancer: slideCancer },
            }
          }
          // 支持性谓词：方向感知（防确认偏误）——只在能作对照时才倾向"支持"，无良性对照则明示"均为恶性，慎作对照"。
          const supportTerm = benignHint && !hasBenignControl
            ? '（注：该癌种库无良性对照，检索到的均为恶性病例——不足以支持良性判断，慎作对照）'
            : benignHint ? '（已优先检索良性对照）' : ''
          const supportVerb = benignHint && !hasBenignControl ? '形态相似（注意：均为恶性，非良性对照）' : '支持当前形态判断'
          addEvidence(
            ctx,
            'observation',
            `CONCH 检索到最相似病例 ${top.map((t) => `${t.case_id}(${t.diagnosis}${t.subtype ? `, ${t.subtype}` : ''}, sim=${t.similarity})`).join('、')} → ${supportVerb}${supportTerm}`,
            0.5,
            'retrieve_similar_case',
            { model: 'conch_ViT-B-16' },
          )
          return {
            text: `[retrieve_similar_case] 相似病例 ${top.length} 个（CONCH 检索，${slideCancer ?? '?'}癌种${supportTerm}）:\n` +
              top
                .map((t) => `- ${t.case_id}: ${t.diagnosis}${t.subtype ? `（${t.subtype}）` : ''} sim=${t.similarity}`)
                .join('\n'),
            details: { similar: top, query_patch: params.patch_ref, embedder: 'conch_ViT-B-16', cancer: slideCancer, benign_hint: benignHint, benign_control_avail: hasBenignControl },
          }
        }
      } catch (e) {
        console.warn(`[retrieve_similar_case] CONCH 检索失败，回落 mock: ${e instanceof Error ? e.message : e}`)
      }
    }

    // ===== mock 路径（无真实 WSI / 编码或索引不可用）=====
    // 与真实路径对齐：同癌种过滤 + 排除自身 case_id + 方向感知谓词，不做跨癌种填充。
    // mock 索引是手工编的占位（非当前 slide 的库），不排除自身 case_id——排除是真实路径的关切
    // （真实索引含当前 slide 自己的 CONCH 均值向量，「检索到当前病例」无意义）。
    const mockCaseId = ctx.session.wsiCache.get(ctx.session.currentWsiId)?.case_id
    const { top, hasBenignControl } = selectSimilar(ctx.session.similarCaseIndex, undefined,
      { cancer: slideCancer, queryCaseId: undefined, benignHint, k })
    if (top.length === 0) {
      return {
        text: `[retrieve_similar_case] 无同癌种（${slideCancer ?? '?'}）相似病例，不做跨癌种填充（mock 索引 ${ctx.session.similarCaseIndex.length} 例，均非本癌种）。`,
        details: { similar: [], query_patch: params.patch_ref, cancer: slideCancer },
      }
    }
    // 支持性谓词：方向感知（同真实路径）——只在能作对照时才倾向"支持"，无良性对照则明示"均为恶性，慎作对照"，不误导。
    let supportVerb: string
    let supportTerm: string
    if (!slideCancer || slideCancer === 'unknown') {
      supportVerb = '形态相似（癌种未知，作形态参考）'
      supportTerm = ''
    } else if (benignHint && !hasBenignControl) {
      supportVerb = '形态相似（注意：均为恶性，非良性对照）'
      supportTerm = '（注：该癌种库无良性对照，检索到的均为恶性病例——不足以支持良性判断，慎作对照）'
    } else if (benignHint) {
      supportVerb = '支持当前形态判断'
      supportTerm = '（已优先检索良性对照）'
    } else {
      supportVerb = '支持当前形态判断'
      supportTerm = ''
    }

    addEvidence(
      ctx,
      'observation',
      `最相似病例 ${top.map((t) => `${t.case_id}(${t.diagnosis})`).join('、')} → ${supportVerb}${supportTerm}`,
      0.5,
      'retrieve_similar_case',
    )
    return {
      text: `[retrieve_similar_case] 相似病例 ${top.length} 个:\n` + top.map((t) => `- ${t.case_id}: ${t.diagnosis}${t.subtype ? `（${t.subtype}）` : ''}`).join('\n'),
      details: { similar: top, query_case: mockCaseId, cancer: slideCancer },
    }
  },
}

export const RetrieveSimilarCaseSchema = Type.Object({
  patch_ref: Type.String(),
  k: Type.Optional(Type.Number()),
})
export type RetrieveSimilarCaseParams = Static<typeof RetrieveSimilarCaseSchema>
