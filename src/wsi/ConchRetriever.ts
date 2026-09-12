import type { WsiInfo, WsiTissueMask } from './wsiTypes'
import type { WsiClient } from './WsiClient'
import { maxTextSimilarity } from './plipQueries'
import type { RoiCandidate } from './PlipRetriever'

/**
 * CONCH 检索型 detect_roi（病理专用双塔，比 PLIP 更贴合组织形态语义）：
 * 1. 组织掩膜粗网格给出候选块（组织富集度 > 阈值，取 top-N）
 * 2. 每块真读 512×512 基底像素 → data-uri
 * 3. CONCH 编码 → 与文本查询的余弦相似度（max over queries）排序
 * 返回坐标换算到基底层级的 ROI（按 score 降序）。检索管线与 PlipRetriever 相同，
 * 仅编码器不同（/conch-embed vs /embed）；CONCH 失败时上层回落 PLIP。
 */
export async function conchRetrieveRois(
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

  // 读图 + CONCH 编码。串行循环逐轮查 abort：agent 中止/工具预算到点时**返回已得部分**（由调用方兜底），
  // 不把整条读图循环跑完（此前无 signal、无 break，一次挂起能拖满整例预算）。
  const images: string[] = []
  for (const c of centers) {
    if (signal?.aborted) break
    const reg = await client.readRegion(slideId, c.x, c.y, patchSize, patchSize, 0, signal)
    images.push(`data:image/png;base64,${reg.png_base64}`)
  }
  if (images.length === 0) return []
  const { image_vectors, text_vectors } = await client.conchEmbed(images, queries, signal)
  if (!image_vectors || !text_vectors) throw new Error('CONCH embed 返回不完整')
  const sims = maxTextSimilarity(image_vectors, text_vectors)

  const rois: RoiCandidate[] = centers.map((c, i) => ({
    id: `${slideId}_c${i + 1}`,
    slide_id: slideId,
    x: c.x,
    y: c.y,
    w: patchSize,
    h: patchSize,
    magnification: 20,
    anomaly_score: Math.round(sims[i] * 1000) / 1000,
    label: `CONCH 检索命中 ${(sims[i] * 100).toFixed(0)}%`,
    score: sims[i],
  }))
  rois.sort((a, b) => b.score - a.score)
  return rois.slice(0, topK)
}
