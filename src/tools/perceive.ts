import { Type } from 'typebox'
import type { Static } from '@earendil-works/pi-ai'
import type { Region } from '../types'
import { findRegionByRef, type ToolSpec } from './common'
import { inspectRegionSpec } from './inspectRegion'
import { describePatchSpec } from './describePatch'
import { softError } from './toolErrors'
import { poolRegions } from '../wsi/navigator'

/** 一次 perceive 里 describe 的 patch 上限（防一次涌入过多 VLM 调用撑超大 batch / 超并发排队）。
 *  默认 24；perceive 一个 region（baseline 平均~9 patch）绝不超；perceive 全池时防炸。 */
const MAX_PATCHES = Number(process.env.PATHASK_PERCEIVE_MAX_PATCHES ?? 24)

/** 区域感知：把「切块 + 形态描述」编排成一次 agent 调用（免去手动 inspect_region 再批量 describe_patch 的两次往返）。
 *
 *  ⚠️ 只做感知，不含 verify —— verify 是「带具体假设的高倍定向复核」，需要 verification_question + 推理判断，
 *  由 agent 单独（条件触发）调用 verify_region，不与 describe 焊死。
 *
 *  用法（二选一）：
 *   - `perceive(question)`：无 region_ref → 感知**当前 ROI 池全部区域**（一次全片形态读，最省往返）。
 *   - `perceive(region_ref, question)`：感知指定区域（定向 follow-up；region_ref 来自 detect_roi / 本工具返回值里的 id）。
 */
export const perceiveSpec: ToolSpec<typeof PerceiveSchema> = {
  name: 'perceive',
  label: '区域感知（切块+形态描述）',
  description:
    '对候选 ROI 一次完成「切块 + 批量形态描述」：切 patch → 用病理 VLM 批量并行描述细胞形态/核特征/结构排列（回答 question）。' +
    '无 region_ref 时感知当前全部候选 ROI；有 region_ref 时只感知该区域。结果按 patch 幂等缓存，重复调用不重读 VLM。',
  parameters: Type.Object({
    region_ref: Type.Optional(Type.String()),
    question: Type.String(),
  }),
  // nonDeterministic：内含 VLM 描述，同参重复调用会得到**不同**的镜下描述——
  // 重复采样有诊断价值，故治理层只能 hint 不能 block（见 ToolMetadata.nonDeterministic）
  metadata: { category: 'perception', cacheable: true, idempotent: true, nonDeterministic: true, depends_on: ['detect_roi'], timeoutMs: 360_000 },
  execute: async (params, ctx) => {
    const slideId = ctx.session.currentWsiId
    let regions: Region[]
    if (params.region_ref) {
      // 支持逗号分隔的多 region_ref（覆盖约束：agent 可传 top-3/整池多个区，逐个解析 union，一次切块+批量描述）
      const refs = params.region_ref.split(',').map((s) => s.trim()).filter(Boolean)
      const found: Region[] = []
      const missing: string[] = []
      for (const ref of refs) {
        const r = findRegionByRef(ctx.session.roiCache, ref)
        if (r) found.push(r)
        else missing.push(ref)
      }
      if (!found.length) {
        return softError(ctx, 'perceive', 'REGION_NOT_FOUND', {
          detail: `未找到 region_ref: ${params.region_ref}${missing.length ? `（未命中: ${missing.join(', ')}）` : ''}。`,
          alternatives: { label: 'region_ref', values: poolRegions(ctx.session, slideId).map((x) => x.id) },
        })
      }
      regions = found
      if (missing.length) console.warn(`[perceive] 部分 region_ref 未命中（跳过）: ${missing.join(', ')}`)
    } else {
      regions = poolRegions(ctx.session, slideId)
      if (!regions.length) {
        return softError(ctx, 'perceive', 'NO_ROI', { detail: '当前 slide 在会话里没有任何候选 ROI。' })
      }
    }

    const inspTexts: string[] = []
    const allPatchIds: string[] = []
    for (const region of regions) {
      const insp = await inspectRegionSpec.execute({ region }, ctx)
      inspTexts.push(insp.text)
      for (const p of ctx.session.patchCache?.get(region.id) ?? []) allPatchIds.push(p.id)
    }
    if (!allPatchIds.length) {
      return { text: inspTexts.join('\n'), details: { regions: regions.length, patches: 0 } }
    }
    // 批量 describe（并发 fan-out 上限对齐 patho-r1 max-num-seqs；幂等缓存复用已描述 patch）
    const ids = allPatchIds.slice(0, MAX_PATCHES)
    console.log(`[perceive-debug] regionRef=${params.region_ref ?? '(无=整池)'} regions=${regions.length} allPatches=${allPatchIds.length} ids=${ids.length} capped=${allPatchIds.length - ids.length} regionIds=[${regions.map(r => `${r.id}(w${r.w},h${r.h})`).join(', ')}]`)
    const desc = await describePatchSpec.execute({ patch_refs: ids, question: params.question }, ctx)
    return {
      text: [inspTexts.join('\n'), '', desc.text].join('\n'),
      details: {
        regions: regions.length,
        patches: ids.length,
        capped: allPatchIds.length > MAX_PATCHES ? allPatchIds.length - MAX_PATCHES : 0,
        regionIds: regions.map((r) => r.id),
        describe: desc.details,
      },
    }
  },
}

export const PerceiveSchema = Type.Object({
  region_ref: Type.Optional(Type.String()),
  question: Type.String(),
})
export type PerceiveParams = Static<typeof PerceiveSchema>
