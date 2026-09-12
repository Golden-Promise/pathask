import { Type } from 'typebox'
import type { Static } from '@earendil-works/pi-ai'
import { addEvidence, ensureWsi, realWsi, type ToolSpec } from './common'
import type { MilPrediction } from '../wsi/WsiClient'

/** mock 预测表（仅 mock 会话用：smoke 无真实 bridge）。真实会话一律走 bridge /mil。 */
const MOCK_PREDICTIONS: Record<string, { label: string; confidence: number }> = {
  'tcga-brca-er': { label: 'positive', confidence: 0.9 },
  'tcga-brca-tp53': { label: 'wildtype', confidence: 0.72 },
  'zjch-oc-hrd': { label: 'hrd_positive', confidence: 0.81 },
  'phyllodes-tumor': { label: 'benign', confidence: 0.66 },
}

/** 5. MIL 分类器：registry-gated，仅能力库匹配时可用（强证据路径核心）。
 *  真实会话：在线抽 STREAM 规格特征（CONCH raw）→ RRTMIL 权重 → slide 级预测，网络失败抛错不回落 mock。 */
export const runMilSpec: ToolSpec<typeof RunMilSchema> = {
  name: 'run_mil',
  label: 'MIL 分类器推理',
  description: '调用能力库中匹配的 MIL 分类器做 slide 级预测：在线对全片抽组织 patch 特征（CONCH）→ RRTMIL 权重 → 返回标签、置信度与 attention 热点区域。能力库无匹配或 bridge 不可用时拒绝执行（应走 fallback 路径）。',
  parameters: Type.Object({
    capability_id: Type.Optional(Type.String()),
    slide_id: Type.Optional(Type.String()),
  }),
  metadata: { category: 'reasoning', cacheable: true, idempotent: true, depends_on: ['detect_roi'] },
  execute: async (params, ctx) => {
    const slideId = ensureWsi(ctx, params.slide_id)
    const entry = ctx.session.wsiRegistry.get(slideId)
    // 能力解析：显式 capability_id 优先；未传或传错时按当前 WSI 癌种自动匹配
    // （LLM 常编造 id（如 phyllodes_mil），自动匹配消除该失败点——注册表本就是「癌种→能力」设计）
    let cap = params.capability_id ? ctx.session.capabilityRegistry.get(params.capability_id) : undefined
    if (!cap) {
      const cancer = entry?.cancer
      if (cancer) {
        cap = [...ctx.session.capabilityRegistry.values()].find((c) => c.cancer === cancer)
        if (cap && params.capability_id && params.capability_id !== cap.id) {
          console.warn(`[run_mil] 显式 id=${params.capability_id} 未知，按癌种 ${cancer} 自动匹配 → ${cap.id}`)
        }
      }
    }
    if (!cap) {
      throw new Error(
        `当前 WSI（${slideId}${entry ? `，${entry.cancer ?? '未知癌种'}` : ''}）无匹配 MIL 能力：本问题应走 fallback 路径（describe_patch + query_knowledge + retrieve_similar_case）。`,
      )
    }

    const real = realWsi(ctx, slideId)
    if (!real) {
      // mock 会话（无 WSI 桥接）：保留 mock 预测供 smoke。真实会话有 bridge 时不会走到这里。
      const pred = MOCK_PREDICTIONS[cap.id]
      if (!pred) throw new Error(`mock 会话且 ${cap.id} 无 mock 预测（真实评测需 WSI 桥接）`)
      if (!cap.labels.includes(pred.label)) throw new Error(`预测标签 ${pred.label} 不在能力 ${cap.id} 的 labels 中`)
      addEvidence(
        ctx,
        'inference',
        `MIL(${cap.model_arch}) 预测 = ${pred.label}（conf=${pred.confidence} —— mock 预测，未验证，不参与投票）`,
        0,
        'run_mil',
        // F8：capability id 不进 claim（连字符 id 会命中诊断规则 → 名称泄露成假证据），存 source 供能力语义判定
        { model: cap.model_arch, capability_id: cap.id, label: pred.label, stub: true },
      )
      return {
        text: `[run_mil] ${cap.id}（${cap.cancer}/${cap.task}, ${cap.model_arch}）→ ${pred.label}, conf=${pred.confidence}`,
        details: { capability: cap, prediction: pred, attention_hotspot: 'r1' },
      }
    }

    // 真实路径：bridge /mil（在线抽特征 + RRTMIL 推理），网络失败直接抛错，不回落 mock。
    let pred: MilPrediction
    try {
      pred = await real.client.milInference(slideId, cap.id, undefined, ctx.signal)
    } catch (e) {
      throw new Error(`bridge 不可用，run_mil 无法执行 ${cap.id} 于 ${slideId}: ${(e as Error).message}`)
    }
    if (!cap.labels.includes(pred.label)) {
      throw new Error(`预测标签 ${pred.label} 不在能力 ${cap.id} 的 labels 中（${cap.labels.join('/')}）`)
    }
    const hotspots = pred.attention_hotspots
      .map((p) => `(${p.x},${p.y},${p.attn.toFixed(2)})`)
      .join(' ')

    addEvidence(
      ctx,
      'inference',
      `MIL(${cap.model_arch}) 预测 = ${pred.label}（conf=${pred.confidence.toFixed(3)}，${pred.num_patches} patch），attention 热点：${hotspots}`,
      pred.confidence,
      'run_mil',
      // F8：capability id 不进 claim（连字符 id 会命中诊断规则 → 名称泄露成假证据），存 source 供能力语义判定
      // F5：结构化 attention 热点进 source（报告期热点闭环用 level0 坐标对 top-1 热点补 describe）
      { model: cap.model_arch, capability_id: cap.id, label: pred.label, attention_hotspots: pred.attention_hotspots },
    )
    return {
      text: `[run_mil] ${cap.id}（${cap.cancer}/${cap.task}, ${cap.model_arch}）→ ${pred.label}, conf=${pred.confidence.toFixed(3)}, patches=${pred.num_patches}, elapsed=${pred.elapsed_ms ?? '?'}ms`,
      details: { capability: cap, prediction: pred },
    }
  },
}

export const RunMilSchema = Type.Object({
  capability_id: Type.Optional(Type.String()),
  slide_id: Type.Optional(Type.String()),
})
export type RunMilParams = Static<typeof RunMilSchema>
