/** 证据置信度规范范围（见 docs/evidence-confidence-spec.md）。
 *
 *  P0 病灶：describe/verify 的 confidence 是被当成概率读的"手工档"（0.35/0.55/0.7/0.75/0.78/0.8/0.9），
 *  在决策 LLM prompt（conf=…）与 evidenceConfidence 聚合里当权重用，编码的是 verdict 方向 + 档位而非校准确定度。
 *  本模块把该档位钉成具名锚点：**方向由 polarity 承重，confidence 只作权重/量级 cue，不决定良恶**。
 *
 *  范围 [0.10, 0.90]：单张 patch（256–512px 视野）的形态观察其确定性上限 0.90（不到 1.0）；
 *  下限不落到 0（总有观察；无形态证据走"排除"而非"低置信"，见 degenerate/stub 处理）。
 *
 *  ⚠️ 与决策层隔离：本锚点只约束 VLM 形态/复核的【观察证据节点】；主诊断置信
 *  （analyzeEvidence.ts:806 clamp01(ai.confidence)，决策 LLM 自报）是另一套，归 P0 决策层校准，
 *  不在此钳制范围内、也勿用本锚点。run_mil（模型级、聚合权重×2）同理不受本上限约束。 */
export const CONF_ANCHORS = {
  /** 几乎无形态信息 → 应排除（degenerate/emptyMorph）而非赋低置信 */
  none: 0.10,
  /** 弱/含糊：证据不足以支撑任何方向（describe label=N/A 诚实弃权） */
  weak: 0.35,
  /** 中性/观察性：描述有价值但方向不明（verify 无法判断） */
  neutral: 0.55,
  /** 质疑性但非决定性（verify 质疑，反对主诊断） */
  uncertain: 0.70,
  /** 支持性形态：特征符合，但非单一致命证据（describe 良/恶类 label、verify 支持） */
  supportive: 0.75,
  /** 决定性形态证据（明确浸润/破坏性生长/显著异型）——单节点上限 */
  decisive: 0.90,
} as const

export type ConfAnchor = keyof typeof CONF_ANCHORS

export const CONF_MIN = CONF_ANCHORS.none
export const CONF_MAX = CONF_ANCHORS.decisive

/** 取锚点值。 */
export function anchorConf(a: ConfAnchor): number {
  return CONF_ANCHORS[a]
}

/** 单节点置信钳制到规范范围 [CONF_MIN, CONF_MAX]（描述/复核观察节点在工具位调用，不用于决策层主置信）。 */
export function clampConfidence(c: number): number {
  if (!Number.isFinite(c)) return CONF_ANCHORS.neutral
  return Math.min(CONF_MAX, Math.max(CONF_MIN, c))
}
