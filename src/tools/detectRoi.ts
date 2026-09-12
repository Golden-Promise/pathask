import { Type } from 'typebox'
import type { Static } from '@earendil-works/pi-ai'
import type { Region } from '../types'
import { addEvidence, ensureWsi, realWsi, type ToolSpec } from './common'
import { questionToPlipQueries } from '../wsi/plipQueries'
import { conchRetrieveRois } from '../wsi/ConchRetriever'
import { plipRetrieveRois } from '../wsi/PlipRetriever'
import { baselineRegionsFromCells } from '../wsi/sampling'

/** mock ROI 选区（仅 smoke / 无桥接时用） */
const MOCK_ROIS: Record<string, Region[]> = {
  slide_brca_001: [
    { id: 'r1', slide_id: 'slide_brca_001', x: 1200, y: 3400, w: 1024, h: 1024, magnification: 20, anomaly_score: 0.87, label: '导管上皮异型增生' },
    { id: 'r2', slide_id: 'slide_brca_001', x: 5600, y: 1200, w: 1024, h: 1024, magnification: 20, anomaly_score: 0.72, label: '可疑浸润灶' },
    { id: 'r3', slide_id: 'slide_brca_001', x: 8900, y: 7200, w: 1024, h: 1024, magnification: 20, anomaly_score: 0.31, label: '反应性增生' },
  ],
  slide_lung_001: [
    { id: 'lr1', slide_id: 'slide_lung_001', x: 800, y: 2000, w: 1024, h: 1024, magnification: 20, anomaly_score: 0.8, label: '片状深染小细胞区' },
  ],
  slide_phyllodes_001: [
    { id: 'pr1', slide_id: 'slide_phyllodes_001', x: 1600, y: 2400, w: 1024, h: 1024, magnification: 20, anomaly_score: 0.82, label: '梭形细胞束状排列区' },
    { id: 'pr2', slide_id: 'slide_phyllodes_001', x: 4200, y: 3100, w: 1024, h: 1024, magnification: 20, anomaly_score: 0.66, label: '分叶状结节轮廓' },
  ],
}

/** 候选 ROI 检测：结合问题与全览返回候选区域 + 异常分（降序）。
 *  真实路径：组织掩膜粗网格 → 组织富集度最高的 top-K 网格作候选 ROI（坐标换算到基底层级）。
 *  说明：目前异常分=组织富集度（启发式 baseline）。 */
export const detectRoiSpec: ToolSpec<typeof DetectRoiSchema> = {
  name: 'detect_roi',
  label: '候选区域检测',
  description: '根据问题与低倍全览返回候选 ROI（含坐标、倍率、异常分、初判标签）。问题问得越具体，选区越聚焦。',
  parameters: Type.Object({
    slide_id: Type.String(),
    question: Type.String(),
  }),
  metadata: { category: 'perception', cacheable: true, idempotent: true },
  execute: async (params, ctx) => {
    const id = ensureWsi(ctx, params.slide_id)

    // ===== 真实路径：PLIP 检索（回落组织掩膜 baseline）=====
    const rw = realWsi(ctx, id)
    if (rw) {
      try {
        // 感知模式：导航器已在打开 slide 时预置基线（roiCache 有该 slide 区域）→ 直接复用（不重读 mask/info、
        // 不二次采样），多问题下基线只算一次。
        if (ctx.session.roiCache?.has(id) && (ctx.session.roiCache.get(id)?.length ?? 0) > 0) {
          const cached = ctx.session.roiCache.get(id)!
          addEvidence(
            ctx,
            'observation',
            `在 "${params.question}" 引导下（复用导航器基线）检测到 ${cached.length} 个候选 ROI：${cached
              .map((r) => `${r.id}(${r.label}, score=${r.anomaly_score})`)
              .join('、')}`,
            0.65,
            'detect_roi',
          )
          return {
            text: `[detect_roi] 候选区域 ${cached.length} 个（复用导航器基线）:\n` +
              cached.map((r) => `- ${r.id}: ${r.label} @(${r.x},${r.y}) ${r.w}x${r.h} ${r.magnification}× score=${r.anomaly_score}`).join('\n'),
            // `cached: true`：这是一次真短路——省掉下面的 `tissueMask`+`info` 两次桥调用。
            // 不标的话 `loopGuardSummary().cacheHits` 会漏掉成本最高的一类命中。
            details: { rois: cached, mode: '导航器基线复用', cached: true },
          }
        }
        const [mask, info] = await Promise.all([rw.client.tissueMask(id, undefined, ctx.signal), rw.client.info(id, ctx.signal)])
        const scale = mask.scale ?? info.level_downsamples[mask.level] ?? 1 // mask 层坐标 → 基底坐标

        // ① baseline（候选 ROI 地基）：「密度 top-k」（tissue_fraction 排序）。
        //    坐标换算到基底层级（scale），id/坐标/label 由 sampling.ts 统一构建（与导航器基线一致）。
        const baseline = baselineRegionsFromCells(id, mask.cells, scale, {
          k: Number(process.env.PATHASK_ROI_BASELINE_K ?? 5),
        })

        // ② 排序模式：默认「密度优先」——按 tissue_fraction 排序返回最密的 top-5。
        //    PATHASK_ROI_MODE=conch 时切到 CONCH/PLIP 语义检索。
        const roiMode = process.env.PATHASK_ROI_MODE ?? 'density'
        let rois: Region[] = baseline
        let mode = `组织密度 baseline（tissue_fraction top-5）`
        if (roiMode === 'conch') {
          try {
            const queries = questionToPlipQueries(params.question)
            const conchRetrieved = await conchRetrieveRois(rw.client, id, info, mask, queries, { signal: ctx.signal })
            if (conchRetrieved.length > 0) {
              rois = conchRetrieved
              mode = `CONCH 检索（queries: ${queries.join(' | ')}）`
            } else {
              const plipRetrieved = await plipRetrieveRois(rw.client, id, info, mask, queries, { signal: ctx.signal })
              if (plipRetrieved.length > 0) {
                rois = plipRetrieved
                mode = `PLIP 检索（queries: ${queries.join(' | ')}）`
              }
            }
          } catch (retrievalErr) {
            console.warn(`[detect_roi] CONCH/PLIP 检索失败，回落组织掩膜 baseline: ${retrievalErr instanceof Error ? retrievalErr.message : retrievalErr}`)
          }
        }

        // 缓存候选 ROI，供 inspect_region 以 region_ref 确定性取坐标（不让 LLM 手抄六字段）
        ;(ctx.session.roiCache ??= new Map()).set(id, rois)

        addEvidence(
          ctx,
          'observation',
          `在 "${params.question}" 引导下（${mode}）检测到 ${rois.length} 个候选 ROI：${rois
            .map((r) => `${r.id}(${r.label}, score=${r.anomaly_score})`)
            .join('、')}`,
          0.65,
          'detect_roi',
        )
        return {
          text: `[detect_roi] 候选区域 ${rois.length} 个（${mode}）:\n` +
            rois.map((r) => `- ${r.id}: ${r.label} @(${r.x},${r.y}) ${r.w}x${r.h} ${r.magnification}× score=${r.anomaly_score}`).join('\n'),
          details: { rois, mode },
        }
      } catch (e) {
        if (!ctx.session.wsiCache.has(id)) {
          throw new Error(`WSI 桥接不可用（${e instanceof Error ? e.message : e}）且无 mock 数据。`)
        }
        // 回落 mock
      }
    }

    // ===== mock 路径 =====
    const rois = [...(MOCK_ROIS[id] ?? [])].sort((a, b) => (b.anomaly_score ?? 0) - (a.anomaly_score ?? 0))
    ;(ctx.session.roiCache ??= new Map()).set(id, rois)
    addEvidence(
      ctx,
      'observation',
      `在 "${params.question}" 引导下检测到 ${rois.length} 个候选 ROI，按异常分降序：${rois
        .map((r) => `${r.id}(${r.label}, score=${r.anomaly_score})`)
        .join('、')}`,
      0.65,
      'detect_roi',
    )
    return {
      text: `[detect_roi] 候选区域 ${rois.length} 个（按异常分降序）:\n` + rois.map((r) => `- ${r.id}: ${r.label} @(${r.x},${r.y}) ${r.w}x${r.h} ${r.magnification}× score=${r.anomaly_score}`).join('\n'),
      details: { rois },
    }
  },
}

export const DetectRoiSchema = Type.Object({
  slide_id: Type.String(),
  question: Type.String(),
})
export type DetectRoiParams = Static<typeof DetectRoiSchema>
