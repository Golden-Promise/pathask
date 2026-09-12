import type { Region } from '../types'
import type { WsiInfo, WsiTissueMask } from './wsiTypes'
import type { WsiClient } from './WsiClient'
import { maxTextSimilarity } from './plipQueries'

export interface RoiCandidate extends Region {
  score: number
}

/**
 * PLIP 检索型 detect_roi：
 * 1. 组织掩膜粗网格给出候选块（组织富集度 > 阈值，取 top-N）
 * 2. 每块真读 512×512 基底像素 → data-uri
 * 3. PLIP 编码 → 与文本查询的余弦相似度（取 max over queries）排序
 * 返回坐标换算到基底层级的 ROI（按 score 降序）。
 *
 * 缓存：同一 slide 的图片编码只算一次（与 question 无关），存 session.plipCache。
 */
export async function plipRetrieveRois(
  client: WsiClient,
  slideId: string,
  info: WsiInfo,
  mask: WsiTissueMask,
  queries: string[],
  opts: { topK?: number; minTissue?: number; patchSize?: number; maxCandidates?: number; signal?: AbortSignal } = {},
): Promise<RoiCandidate[]> {
  const { topK = 5, minTissue = 0.3, patchSize = 512, maxCandidates = 12, signal } = opts
  const scale = mask.scale ?? info.level_downsamples[mask.level] ?? 1
  const cells = mask.cells.filter((c) => c.tissue_fraction > minTissue).slice(0, maxCandidates)
  if (cells.length === 0) return []

  const centers = cells.map((c) => ({ x: Math.round(c.x * scale), y: Math.round(c.y * scale) }))

  // 读图 + 编码（可能命中缓存）
  // 串行循环逐轮查 abort（同 ConchRetriever）：挂起时返回已得部分，不拖满整例预算
  const images: string[] = []
  for (const c of centers) {
    if (signal?.aborted) break
    const reg = await client.readRegion(slideId, c.x, c.y, patchSize, patchSize, 0, signal)
    images.push(`data:image/png;base64,${reg.png_base64}`)
  }
  if (images.length === 0) return []
  const { image_vectors, text_vectors } = await client.embed(images, queries, signal)
  if (!image_vectors || !text_vectors) throw new Error('PLIP embed 返回不完整')
  const sims = maxTextSimilarity(image_vectors, text_vectors)

  const rois: RoiCandidate[] = centers.map((c, i) => ({
    id: `${slideId}_r${i + 1}`,
    slide_id: slideId,
    x: c.x,
    y: c.y,
    w: patchSize,
    h: patchSize,
    magnification: 20,
    anomaly_score: Math.round(sims[i] * 1000) / 1000,
    label: `PLIP 检索命中 ${(sims[i] * 100).toFixed(0)}%`,
    score: sims[i],
  }))
  rois.sort((a, b) => b.score - a.score)
  return rois.slice(0, topK)
}
