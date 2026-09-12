/**
 * 调用指纹（B1，2026-09-11）：把「同一次工具调用」判定成同一件事。
 *
 * **为什么不是 `JSON.stringify(args)`**：模型对同一个逻辑调用有**多种写法**，直接串化会把它们判成不同调用，
 * 重复检测于是形同虚设。实测过的等价写法（都能落到同一缓存条目）：
 *   - `region_ref="case_X_r1"` / `"histai/HISTAI-mixed/case_X_r1"` / `"case_X_r1"`（路径塌缩）
 *   - `patch_ref` 全路径 vs 展平 basename（`common.ts:246 findPatchByRef` 就是为这个写的）
 *   - 手抄 `region{x,y,w,h,magnification}` 六字段，坐标同一块组织但抖动几十像素
 * 故本模块**先解析引用到缓存身份，再规范化**；解析不到的才退化为数值吸附。
 *
 * **依赖方向**：只依赖 `src/types` 与零依赖的 `util/geom`。查找函数由调用方（`tools/common.ts`，
 * 它已有 `findRegionByRef`/`findPatchByRef`/`resolveWsiId`）以 `RefResolver` 注入——
 * 若这里直接 import 工具层，就会与「工具层要用指纹记台账」成环。**实现仍只有一份，没有副本。**
 */
import type { PatchRef, Region } from '../types'
import { overlapRatio } from '../util/geom'

/** 由调用方注入的引用解析器（`tools/common.ts` 用既有查找函数实现）。 */
export interface RefResolver {
  /** region_ref → 缓存里的规范 Region（容忍 basename / 全路径 / 只给 _rN） */
  region(ref: string): Region | undefined
  /** patch_ref → 缓存里的规范 PatchRef（容忍展平 basename） */
  patch(ref: string): PatchRef | undefined
  /** slide_id → 注册表里的规范 id（容忍去扩展名 / basename 塌缩）；解析不到返回原值 */
  slide(id?: string): string
  /** 本病例的 ROI 候选（手抄坐标的交叠吸附用）；无 roiCache 时为空数组 */
  regions(): Region[]
}

export interface Fingerprint {
  /** 规范化参数的 hash32（台账字段 / 分组用） */
  key: string
  /** 规范化参数原文。**判等用这个，不用 key**——32 位哈希有碰撞，而碰撞的后果是
   *  「把一次合法调用误判成重复」（B4 起会直接拦掉它）。宁可多比几十字节字符串。 */
  canonical: string
  /** 人类可读摘要（给模型看的重复提示文案用，不含哈希） */
  label: string
}

/** 标准倍率档（`magnification` 吸附目标）。 */
export const MAG_STOPS = [1.25, 2.5, 5, 10, 20, 40]
/** 坐标吸附网格（x/y）与尺寸吸附网格（w/h），像素。 */
const GRID_XY = 64
const GRID_WH = 128
/** 判定「手抄坐标就是那块缓存 ROI」的交叠门（双向取大，容忍模型只抄对了一半）。 */
const OVERLAP_HIT = 0.8

/** 折叠空白 / trim / 小写 / 去尾标点（`。．.,;；、`）。句内标点保留——它可能承载语义。
 *  ⚠️ 顺序要紧：**去尾标点后必须再 trim 一次**。`"case_x_r1 。"` 若先 trim 再去标点会剩一个尾空格，
 *  于是 `findRegionByRef`（只归一斜杠、不 trim）匹配不上 → 解析失败 → 同一区域被判成两个调用。 */
function normStr(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/[。．.,;；、]+$/g, '').trim()
}

/** 6 位有效数字（浮点抖动归零；0 与非有限值原样返回）。 */
function sig6(n: number): number {
  if (!Number.isFinite(n) || n === 0) return n
  return Number(n.toPrecision(6))
}

function snapToGrid(v: number, grid: number): number {
  return Math.round(v / grid) * grid
}

function snapMag(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n)) return undefined
  return MAG_STOPS.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a))
}

/** FNV-1a 32 位，十六进制。不引依赖（只有几十行才需要它，且必须是确定性的）。 */
export function hash32(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 引用类参数各自的**规范键名**。同一个 ROI 会被模型写成 `region_ref:"x_r1"`（引用）
 *  或 `region:{x,y,w,h}`（六字段手抄）——两者解析后是同一块组织，必须收敛到**同一个键**，
 *  否则「引用写法」与「手抄写法」在指纹层面永远是两次不同调用，重复检测对最典型的
 *  「抄一遍再引用一遍」形态完全失效。 */
const REF_KEY = { region: 'region_ref', patch: 'patch_ref', slide: 'slide_id' } as const

/** 给 resolver 用的清洗：trim / 折叠空白 / 去尾标点，但**绝不 lowercase**。
 *  缓存 id 是大小写敏感的（`histai/HISTAI-mixed/case_X_r1`），小写化会让一个**合法**的
 *  `region_ref` 解析失败 → 退化成「未解析」→ 同一块组织被判成两次不同调用，重复检测在最典型的
 *  路径上静默失效。**查找用原样，判等才归一**——两件事不能共用一次清洗。 */
function cleanRef(s: string): string {
  return s.replace(/\s+/g, ' ').trim().replace(/[。．.,;；、]+$/g, '').trim()
}

/** 把引用类参数解析成**缓存身份**：先用 `cleanRef` 洗一遍再交给 resolver——`findRegionByRef`
 *  只归一 `/` 与 `\`，不去空白也不去标点，直接用原串找必然落空。解析不到退化为规范化字符串
 *  （前缀 `?` 标记未解析，便于分析时区分「真不同」与「没认出来」）。 */
function canonRef(kind: 'region' | 'patch' | 'slide', raw: string, r: RefResolver): string {
  const cleaned = cleanRef(raw)
  if (kind === 'region') {
    const hit = r.region(cleaned) ?? r.region(raw.trim())
    return hit ? `region:${normStr(hit.id)}` : `region?:${normStr(cleaned)}`
  }
  if (kind === 'patch') {
    const hit = r.patch(cleaned) ?? r.patch(raw.trim())
    return hit ? `patch:${normStr(hit.id)}` : `patch?:${normStr(cleaned)}`
  }
  return `slide:${normStr(r.slide(cleaned))}`
}

/** 手抄坐标 → ① 与缓存 ROI 双向交叠 ≥80% 取**最小**者（最贴合的那块）→ 直接用它的 id；
 *  ② 否则网格吸附（x/y 64px、w/h 128px、倍率到标准档），让几十像素的抖动归到同一格。 */
function canonRegionObj(o: Record<string, unknown>, r: RefResolver): string {
  const num = (k: string): number | undefined => {
    const v = o[k]
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
    return Number.isFinite(n) ? n : undefined
  }
  const x = num('x'), y = num('y'), w = num('w'), h = num('h')
  if (x === undefined || y === undefined || w === undefined || h === undefined) {
    return `region:(${x ?? '?'},${y ?? '?'},${w ?? '?'},${h ?? '?'},mag=${snapMag(o.magnification) ?? '?'})`
  }
  const box = { x, y, w, h }
  const hits = r.regions().filter((reg) => Math.max(overlapRatio(box, reg), overlapRatio(reg, box)) >= OVERLAP_HIT)
  if (hits.length) {
    const best = hits.reduce((a, b) => (a.w * a.h <= b.w * b.h ? a : b))
    return `region:${normStr(best.id)}`
  }
  const mag = snapMag(o.magnification)
  return `region:${snapToGrid(x, GRID_XY)},${snapToGrid(y, GRID_XY)},${snapToGrid(w, GRID_WH)},${snapToGrid(h, GRID_WH)}@${mag ?? '?'}`
}

/** 按 key 名分派，输出 `[规范键, 规范值]`。
 *
 *  **键也要规范化**：区域/切片/patch 的三种写法（引用串、六字段对象、塌缩路径）解析后是同一身份，
 *  必须落到同一个键上（`REF_KEY`），否则「换个写法再问一遍」永远不会被认成重复。
 *
 *  `question` 类**保留全文**（换问题 = 换语义，绝不能判成同一调用）；数字一律 6 位有效数字；
 *  对象键排序；undefined 剔除（`{a:1}` 与 `{a:1,b:undefined}` 是同一调用）。 */
function canonEntry(key: string, v: unknown, r: RefResolver): [string, unknown] {
  if (v === null || v === undefined) return [key, null]
  const k = key.toLowerCase()
  if (typeof v === 'string') {
    if (k === 'region_ref' || k === 'region_id' || k === 'roi_ref') return [REF_KEY.region, canonRef('region', v, r)]
    if (k === 'patch_ref' || k === 'patch_id') return [REF_KEY.patch, canonRef('patch', v, r)]
    if (k === 'slide_id' || k === 'case_id' || k === 'slide') return [REF_KEY.slide, canonRef('slide', v, r)]
    if (k === 'magnification' || k === 'mag') return ['magnification', snapMag(v) ?? normStr(v)]
    // question / query / prompt / 其他自由文本：规范化但**不截断**
    return [key, normStr(v)]
  }
  if (typeof v === 'number') {
    if (k === 'magnification' || k === 'mag') return ['magnification', snapMag(v) ?? v]
    return [key, sig6(v)]
  }
  if (typeof v === 'boolean') return [key, v]
  if (Array.isArray(v)) return [key, v.map((it) => canonEntry(key, it, r)[1])]
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    // 六字段 region 对象 → 与 region_ref **同键**
    if (k === 'region' && o && typeof o === 'object') return [REF_KEY.region, canonRegionObj(o, r)]
    const out: Record<string, unknown> = {}
    for (const kk of Object.keys(o).sort()) {
      if (o[kk] === undefined) continue
      const [nk, nv] = canonEntry(kk, o[kk], r)
      out[nk] = nv
    }
    return [key, out]
  }
  return [key, String(v)]
}

/** 顶层遍历：把 `canonEntry` 的规范键收集成对象（同键冲突时保留先出现的，键已排序故确定）。 */
function canonArgs(args: unknown, r: RefResolver): unknown {
  if (args === null || args === undefined) return null
  if (typeof args !== 'object' || Array.isArray(args)) return canonEntry('', args, r)[1]
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(args as Record<string, unknown>).sort()) {
    const v = (args as Record<string, unknown>)[k]
    if (v === undefined) continue
    const [nk, nv] = canonEntry(k, v, r)
    if (!(nk in out)) out[nk] = nv
  }
  return out
}

/** 稳定序列化：键已排序，故 `JSON.stringify` 的输出确定。 */
function stable(o: unknown): string {
  return JSON.stringify(o)
}

/** 给模型看的摘要：取规范化后的顶层标量，过长才截断（**只影响文案，不影响判等**）。 */
function buildLabel(tool: string, canon: unknown): string {
  if (canon === null || typeof canon !== 'object' || Array.isArray(canon)) return tool
  const parts: string[] = []
  for (const [k, v] of Object.entries(canon as Record<string, unknown>)) {
    if (v === null) continue
    const s = typeof v === 'string' ? v : stable(v)
    parts.push(`${k}=${s.length > 60 ? `${s.slice(0, 60)}…` : s}`)
  }
  return `${tool}(${parts.join(', ')})`
}

/** 主入口：工具名 + 已校验参数 → 指纹。纯函数（唯一的外部影响来自只读的 `RefResolver`）。 */
export function fingerprintToolCall(tool: string, args: unknown, r: RefResolver): Fingerprint {
  const canon = canonArgs(args, r)
  const canonical = `${tool}|${stable(canon)}`
  return { key: hash32(canonical), canonical, label: buildLabel(tool, canon) }
}
