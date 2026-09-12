import type { Cancer } from '../types'

/** wsilist.json 里登记的一条真实 WSI */
export interface WsiEntry {
  id: string
  path: string // 相对 data/ 的路径，如 wsi/breast/BRS-0001.svs
  absPath: string // 解析后的绝对路径（loadWsiRegistry 填充）
  cancer: Cancer
  case_id?: string
  diagnosis?: string
  biomarkers?: Record<string, string>
}

/** OpenSlide /slides/{id}/info 返回 */
export interface WsiInfo {
  width: number
  height: number
  levels: number
  level_dimensions: number[][]
  level_downsamples: number[]
  objective_power?: number | null
  vendor?: string
}

export interface WsiThumbnail {
  png_base64: string
  level: number
  size: [number, number]
}

/** 组织掩膜粗网格的一个候选细胞（mask 层级坐标） */
export interface WsiCell {
  x: number
  y: number
  w: number
  h: number
  /** 任何染色组织占该 cell 比例（密度 baseline；偏良性间质） */
  tissue_fraction: number
  /** 深紫核占该 cell 比例（核密度，治密度偏良性间质；桥端 npz 计算，旧缓存回退 tissue_fraction） */
  nuclear_fraction?: number
}

export interface WsiTissueMask {
  level: number
  size: [number, number]
  /** mask 层坐标 → 原生 level-0 坐标缩放（native 宽 / mask 宽）。单层 slide 无 ≤max_dim 层级，桥端用
   *  get_thumbnail 概览（非真金字塔层），level_downsamples[level] 对其不成立 → 优先用此 scale。 */
  scale?: number
  coverage: number
  bbox: [number, number, number, number] | null
  cells: WsiCell[]
  cell_count: number
}

export interface WsiRegion {
  png_base64: string
  level: number
  size: [number, number]
}
