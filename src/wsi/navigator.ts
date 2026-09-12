import type { PathAskSession, Region } from '../types'
import { realWsi } from '../tools/common'
import { baselineRegionsFromCells } from './sampling'

/** 导航器：把「往哪看」从 agent 的 ad-hoc 工具调用抽成一层可替换的采样策略。
 *
 *  职责分层（与 loop 收紧讨论一致）：
 *   - **基线 baseline**：与问题无关的密度地板（tissue_fraction top-k），**每 slide 一次、缓存进 roiCache**（多问题复用，摊薄成本）。
 *   - **增量 increment**：与问题相关，**每问题追加**，union 进 ROI 池（不覆盖基线）。→ 替换为「器官+问题」条件导航器。
 *
 *  器官先验（`organ`）只喂给 **增量/导航器策略**（CONCH 语义检索 或 训练导航器），不喂密度基线：
 *  密度 top-k 是问题+器官无关地板，加了也进不了打分。未来 CONCH 语义检索用 organ 生成癌种相关形态查询、
 *  用 question 生成问题查询；训练导航器则把 organ+question 当输入 prompt 特征。
 *
 *  ⚠️ 诚实边界：`incrementRegions` 当前是**薄兜底**（密度 gap 补区，弱问题感知），非真实语义相关性——
 *    真正的「与问题最相关区域」要等 **导航器训练**（[[pathask-navigator-baseline-decision]] 已证单癌种标注集
 *    被弃，须端到端/自监督）。本接口的目的是让多轮结构立起来（基线复用 + 增量累积），训练后只换一个函数。
 */
export interface NavOpts {
  /** 基线候选区数（默认 PATHASK_ROI_BASELINE_K 或 5）。 */
  baselineK?: number
  /** 增量补区达到的总覆盖目标（默认 PATHASK_NAV_COVERAGE 或 baselineK；越大池越大）。 */
  coverage?: number
  /** 器官/癌种先验（organ-level，如 breast/kidney，**非**具体诊断）。无传时从 session.wsiRegistry 取。
   *  消费方=「问题/器官相关」的增量导航器（CONCH 语义检索 / 训练的导航器）：
   *  密度基线 ignore 它（那是问题+器官无关地板），但若给它加参数，它进不了密度打分——只进导航器策略。 */
  organ?: string
  /** 透传的取消信号（agent 中止 / 工具预算）：桥接读图是长调用，不带 signal 就掐不断。 */
  signal?: AbortSignal
}

/** 两区域 bbox 交叠比例（相对 a 面积，0-1）：去重用（杜绝基线+增量把同一块组织重复切块）。 */
function regionOverlap(a: Region, b: Region): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return (ix * iy) / Math.max(1, a.w * a.h)
}

/** 去重合并：existing ∪ added，按 id 精确去重 + 按 bbox 交叠≥0.5 去重（防同一块被基线/增量重复切块）。 */
export function unionRegions(existing: Region[], added: Region[]): Region[] {
  const out: Region[] = []
  for (const r of [...existing, ...added]) {
    const dup = out.some((o) => o.id === r.id || regionOverlap(o, r) >= 0.5)
    if (!dup) out.push(r)
  }
  return out
}

/** 当前 slide 的 ROI 池（基线+已累积增量）。perceive/agent 都从这取 region_ref。 */
export function poolRegions(session: PathAskSession, slideId: string): Region[] {
  return [...(session.roiCache?.get(slideId) ?? [])]
}

/** 对 slide 计算并**缓存**基线（问题无关、密度 top-k）到 roiCache[slideId] 的增补。
 *  幂等：roiCache 已含该 slide 区域则直接复用（不重调 bridge）。
 *  ⚠️ 不写证据节点——基线是「候选区索引」，不是形态观察；真正进证据链的是 describe/verify（perceive 负责）。
 *  返回基线列表。bridge 不可用/失败 → 返回 []（不阻塞，agent 仍可走 detect_roi 的回落）。 */
export async function ensureBaseline(session: PathAskSession, slideId: string, opts: NavOpts = {}): Promise<Region[]> {
  const k = opts.baselineK ?? Number(process.env.PATHASK_ROI_BASELINE_K ?? 5)
  const existing = session.roiCache?.get(slideId)
  if (existing && existing.length > 0) return existing
  const rw = realWsi({ session, toolCallId: 'sys-baseline' }, slideId)
  if (!rw) return []
  try {
    const [mask, info] = await Promise.all([rw.client.tissueMask(slideId, undefined, opts.signal), rw.client.info(slideId, opts.signal)])
    const scale = mask.scale ?? info.level_downsamples[mask.level] ?? 1
    const baseline = baselineRegionsFromCells(slideId, mask.cells, scale, { k })
    const merged = unionRegions(existing ?? [], baseline)
    ;(session.roiCache ??= new Map()).set(slideId, merged)
    return baseline
  } catch (e) {
    console.warn(`[navigator] 基线缓存失败（不阻塞）: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
}

/** 每问题增量：在基线上追加区域，union 进池。
 *  ⚠️ **当前是兜底（coverage-fill，弱问题感知）**——把池从 baseK 扩到 coverage 目标、且不与已选区重叠，
 *    不依赖模型/CONCH，可离线测。它**不是**「与问题最相关」；真实相关性要等 [[导航器训练]]（本函数接口不变）。
 *    返回本次新增（非全池）；无真实 WSI / 已到 coverage / 失败 → []。 */
export async function incrementRegions(session: PathAskSession, slideId: string, question: string, opts: NavOpts = {}): Promise<Region[]> {
  // 「问题/器官相关」层的输入：organ=器官先验（organ-level，非诊断），question=问题文本。
  // 二者是未来 CONCH 语义检索 / 训练导航器的输入 prompt；当前 coverage-fill 只用密度、感知不到它们。
  // TODO(导航器): 替换这里为 ① CONCH 语义检索（organ→癌种形态词、question→查询向量）或 ② 训练导航器（organ+question+slide 特征→采样区）。
  const organ = opts.organ ?? session.wsiRegistry.get(slideId)?.cancer
  const baseK = opts.baselineK ?? Number(process.env.PATHASK_ROI_BASELINE_K ?? 5)
  const cov = opts.coverage ?? Number(process.env.PATHASK_NAV_COVERAGE ?? baseK)
  if (cov <= baseK) return []
  const pool = poolRegions(session, slideId)
  if (pool.length >= cov) return []
  const rw = realWsi({ session, toolCallId: 'sys-increment' }, slideId)
  if (!rw) return []
  try {
    const [mask, info] = await Promise.all([rw.client.tissueMask(slideId, undefined, opts.signal), rw.client.info(slideId, opts.signal)])
    const scale = mask.scale ?? info.level_downsamples[mask.level] ?? 1
    // 取一个更大的密度候选集，剔除与当前池重叠的，剩下的补位到 coverage
    const all = baselineRegionsFromCells(slideId, mask.cells, scale, { k: Math.max(cov, baseK) })
    const fresh = all.filter((r) => !pool.some((p) => p.id === r.id || regionOverlap(p, r) >= 0.5))
    // 保持确定性：按 id 排序（密度已是确定序）
    return fresh.slice(0, Math.max(0, cov - pool.length))
  } catch (e) {
    console.warn(`[navigator] 增量补区失败（不阻塞）: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
}

/** 导航器入口：基线（缓存）+ 增量（追加），union 成该 slide 的当前 ROI 池。
 *  多问题下每次提问都调它：基线复用不重算，只有增量随问题累积。 */
export async function navigatorPool(session: PathAskSession, slideId: string, question: string, opts: NavOpts = {}): Promise<Region[]> {
  await ensureBaseline(session, slideId, opts)
  const inc = await incrementRegions(session, slideId, question, opts)
  if (inc.length > 0) {
    const merged = unionRegions(poolRegions(session, slideId), inc)
    ;(session.roiCache ??= new Map()).set(slideId, merged)
  }
  return poolRegions(session, slideId)
}
