import { Type } from 'typebox'
import type { Static } from '@earendil-works/pi-ai'
import type { PatchRef } from '../types'
import { RegionSchema } from './schemas'
import { softError } from './toolErrors'
import { addEvidence, ensureWsi, findRegionByRef, fsSafe, realWsi, type ToolSpec } from './common'
import { cachePatches } from '../wsi/patchCache'

/** 退化 region 阈值：w/h 低于此值的 inspect 请求视为 agent 自造（如 1×1/0×0），拒绝并引导用 region_ref。
 *  真实 detect_roi ROI（放大到基底像素）远大于此值，不会误伤。 */
const MIN_REGION_DIM = 64

/** 区域切块：在指定倍率切取 patch_refs，写入会话 patchCache。
 *  真实路径：按目标倍率选 OpenSlide 层级 → 网格切块 → patch 真读并写盘（data/.cache/patch/）。
 *  mock 路径：预置 4 个 patch（smoke 用）。 */
export const inspectRegionSpec: ToolSpec<typeof InspectRegionSchema> = {
  name: 'inspect_region',
  label: '区域切块',
  description: '对候选 ROI 在给定倍率下切块，返回 patch_ref 列表（后续 describe_patch 使用）。',
  parameters: Type.Object({
    region: Type.Optional(RegionSchema),
    region_ref: Type.Optional(Type.String()),
  }),
  metadata: { category: 'acquisition', cacheable: true, idempotent: true, depends_on: ['detect_roi'] },
  execute: async (params, ctx) => {
    // ⭐ 解析 region：优先显式 region{}，否则用 region_ref 从 detect_roi 缓存确定性取坐标
    //   （LLM 手抄 x/y/w/h/magnification 六字段是采错区的根因，把坐标解析交给代码）。
    let region = params.region
    if (!region && params.region_ref) {
      region = findRegionByRef(ctx.session.roiCache, params.region_ref)
      if (!region) {
        const avail = [...(ctx.session.roiCache?.values() ?? [])].flat().map((r) => r.id)
        return softError(ctx, 'inspect_region', 'REGION_NOT_FOUND', {
          detail: `未找到 region_ref: ${params.region_ref}。`,
          alternatives: { label: 'region_ref', values: avail },
        })
      }
    }
    if (!region) {
      return softError(ctx, 'inspect_region', 'REGION_REQUIRED', {
        detail: '既没给 region 也没给 region_ref。',
        alternatives: { label: 'region_ref', values: [...(ctx.session.roiCache?.values() ?? [])].flat().map((r) => r.id) },
      })
    }
    // 护栏：拒绝退化 region（w/h 过小/非正——agent 自造 1×1/0×0 时命中），引导用 region_ref
    if (!(region.w >= MIN_REGION_DIM && region.h >= MIN_REGION_DIM)) {
      return softError(ctx, 'inspect_region', 'DEGENERATE_REGION', {
        detail: `区域尺寸 ${region.w}×${region.h} 低于 ${MIN_REGION_DIM}×${MIN_REGION_DIM}。`,
        extra: { region, min: MIN_REGION_DIM },
      })
    }
    ensureWsi(ctx, region.slide_id)

    // ===== 真实路径 =====
    const rw = realWsi(ctx, region.slide_id)
    if (rw) {
      // 循环护栏：同一区域 + 同一倍率已切块 → 直接复用缓存（幂等），不重读 WSI、不重叠证据，
      // 避免 model 在 describe 失败后反复 inspect 同一 region 烧预算、堆证据。
      const existing = ctx.session.patchCache.get(region.id)
      if (existing?.length && existing[0].magnification === region.magnification) {
        return {
          text: `[inspect_region] ${region.id} 已缓存(幂等): ${existing.length} 个 patch @${region.magnification}×（复用，未重读）`,
          details: { region, patches: existing, cached: true },
        }
      }
      try {
        const info = await rw.client.info(region.slide_id, ctx.signal)
        const objective = info.objective_power ?? 40
        const level = rw.client.levelForMagnification(info, objective, region.magnification)
        const ds = info.level_downsamples[level]
        const patchSize = 1024
        // 用 patchSize*ds 基底像素的步长覆盖 region.w/h 网格
        const cols = Math.max(1, Math.ceil(region.w / (patchSize * ds)))
        const rows = Math.max(1, Math.ceil(region.h / (patchSize * ds)))
        const patches: PatchRef[] = []
        let idx = 0
        const maxX = region.x + region.w - patchSize * ds
        const maxY = region.y + region.h - patchSize * ds
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const px = Math.max(region.x, Math.min(region.x + c * patchSize * ds, maxX))
            const py = Math.max(region.y, Math.min(region.y + r * patchSize * ds, maxY))
            patches.push({
              id: `patch_${fsSafe(region.id)}_${idx}`,
              region_id: region.id,
              slide_id: region.slide_id,
              x: Math.round(px),
              y: Math.round(py),
              size: patchSize,
              magnification: region.magnification,
              region_label: region.label,
            })
            idx += 1
          }
        }
        const cachedPaths = await cachePatches(rw.client, region.slide_id, patches, level, ctx.signal)
        patches.forEach((p, i) => (p.cached_path = cachedPaths[i]))

        ctx.session.patchCache.set(region.id, patches)
        addEvidence(
          ctx,
          'observation',
          `区域 ${region.id} 在 ${region.magnification}×（level ${level}）下真读切取 ${patches.length} 个 patch（首块 ${patches[0].id}）`,
          0.65,
          'inspect_region',
          { coords: region, magnification: region.magnification },
        )
        return {
          text: `[inspect_region] ${region.id}: ${patches.length} 个 patch @${region.magnification}× (level ${level}, 真实 OpenSlide)\n` +
            patches.map((p) => `- ${p.id} @(${p.x},${p.y}) → ${p.cached_path}`).join('\n'),
          details: { region, level, patches },
        }
      } catch (e) {
        if (!ctx.session.wsiCache.has(region.slide_id)) {
          throw new Error(`WSI 桥接不可用（${e instanceof Error ? e.message : e}）且无 mock 数据。`)
        }
        // 回落 mock
      }
    }

    // ===== mock 路径 =====
    const patches: PatchRef[] = []
    for (let i = 0; i < 4; i++) {
      patches.push({
        id: `patch_${fsSafe(region.id)}_${i}`,
        region_id: region.id,
        slide_id: region.slide_id,
        x: region.x + i * 256,
        y: region.y,
        size: 1024,
        magnification: region.magnification,
        region_label: region.label,
      })
    }
    ctx.session.patchCache.set(region.id, patches)
    addEvidence(ctx, 'observation', `区域 ${region.id} 在 ${region.magnification}× 下切取 ${patches.length} 个 patch（首块 ${patches[0].id}）`, 0.65, 'inspect_region', {
      coords: region,
      magnification: region.magnification,
    })
    return {
      text: `[inspect_region] ${region.id}: ${patches.length} 个 patch @${region.magnification}×\n${patches.map((p) => `- ${p.id} @(${p.x},${p.y})`).join('\n')}`,
      details: { region, patches },
    }
  },
}

export const InspectRegionSchema = Type.Object({
  region: Type.Optional(RegionSchema),
  region_ref: Type.Optional(Type.String()),
})
export type InspectRegionParams = Static<typeof InspectRegionSchema>
