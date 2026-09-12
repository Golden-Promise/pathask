import type { Region } from '../types'
import type { WsiCell } from './wsiTypes'

export interface BaselineOpts {
  /** 候选区数量（默认 5，env PATHASK_ROI_BASELINE_K 覆盖；perceive 可调大覆盖更大票面）。 */
  k: number
  /** 采样打分模式：tissue（裸组织密度=旧行为回退）| nuclear（核密度）| blend（默认 0.6*nuclear+0.4*tissue）。
   *  不传时读 env PATHASK_ROI_SCORE（默认 blend）。tissue_fraction 偏良性结缔组织（纤维/平滑肌/
   *  空白算"组织"、核密癌灶反排名低）→ nuclear 权重更高把采样引向核密癌灶。 */
  score?: 'tissue' | 'nuclear' | 'blend'
}

function resolveScore(opts: BaselineOpts): 'tissue' | 'nuclear' | 'blend' {
  if (opts.score) return opts.score
  const s = process.env.PATHASK_ROI_SCORE
  return s === 'tissue' || s === 'nuclear' || s === 'blend' ? s : 'blend'
}

/** blend 里 nuclear 的权重（0-1；tissue=1−w）。默认 0.6，env PATHASK_ROI_BLEND_W 覆盖（微调扫参用），读 env 使扫参进程可进程级覆盖。 */
function blendW(): number {
  const s = process.env.PATHASK_ROI_BLEND_W
  if (s === undefined) return 0.6
  const w = Number(s)
  return Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : 0.6
}

/** cell 的采样分（tissue_fraction / nuclear_fraction / 二者的 blend）。nuclear 缺失时回退 tissue_fraction。 */
function cellScore(c: WsiCell, mode: 'tissue' | 'nuclear' | 'blend'): number {
  const t = c.tissue_fraction ?? 0
  const n = c.nuclear_fraction ?? t
  switch (mode) {
    case 'tissue':
      return t
    case 'nuclear':
      return n
    default: {
      const w = blendW()
      return w * n + (1 - w) * t
    }
  }
}

/** 由 mask 层组织候选 cell 构建候选 Region 列表（坐标换算到基底）。detect_roi 与导航器基线共用同一构建，
 *  保证两处产出的 region.id / 坐标 / label 完全一致（drift 根：两处各写一份映射 → id/坐标不一致 → region_ref
 *  找不到）。排序键=采样分（默认 blend=核密度加权；PATHASK_ROI_SCORE=tissue 完全回退旧行为）。 */
export function baselineRegionsFromCells(slideId: string, cells: WsiCell[], scale: number, opts: BaselineOpts): Region[] {
  const mode = resolveScore(opts)
  const ranked = [...cells].sort((a, b) => cellScore(b, mode) - cellScore(a, mode)).slice(0, opts.k)
  return ranked.map((c, i) => {
    const sc = cellScore(c, mode)
    const label = mode === 'tissue' ? `组织富集区` : mode === 'nuclear' ? `核密区` : `核密+组织区`
    return {
      id: `${slideId}_r${i + 1}`,
      slide_id: slideId,
      x: Math.round(c.x * scale),
      y: Math.round(c.y * scale),
      w: Math.round(c.w * scale),
      h: Math.round(c.h * scale),
      magnification: 20,
      anomaly_score: Math.round(sc * 100) / 100,
      label: `${label} ${(sc * 100).toFixed(0)}%`,
    }
  })
}
