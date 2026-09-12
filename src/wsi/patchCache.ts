import { access, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { PatchRef } from '../types'
import type { WsiClient } from './WsiClient'
import { fsSafe } from '../tools/common'
import { FANOUT_CONCURRENCY, mapWithConcurrency } from '../util/concurrency'

/** 项目根的 data/.cache/patch/<level>/<slideId>/<patchId>.png（level 进路径：不同倍率同 patchId 不冲突） */
const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url))
export const PATCH_CACHE_ROOT = path.join(DATA_DIR, '.cache', 'patch')

/** 把 patch 真读出来写盘，供 describe_patch（VLM）消费；返回缓存相对路径。
 *  幂等：目标文件已存在则跳过真读 WSI（重复 inspect 同一 region 直接命中），
 *  命中率对重复阅片/多轮评测是直接收益（同一 slide 二次 read 免全分辨率读盘）。
 *  扇出**有界** + 逐路透传 signal（agent 中止能掐断读图）。 */
export async function cachePatches(
  client: WsiClient,
  slideId: string,
  patches: PatchRef[],
  level: number,
  signal?: AbortSignal,
): Promise<string[]> {
  // 目录/文件名都用 fsSafe：slide_id 与 patch.id 含 `/`（如 histai/HISTAI-mixed/case_00001 →
  // patch_histai/HISTAI-mixed/..._r0_0），直接拼路径会把中间段当目录 → EISDIR。fsSafe 只影响落盘，
  // cached_path 用它生成、describe_patch/retrieveSimilarCase 也读它，写入与读取全端一致。
  const safeSlideId = fsSafe(slideId)
  const dir = path.join(PATCH_CACHE_ROOT, String(level), safeSlideId)
  await mkdir(dir, { recursive: true })
  return mapWithConcurrency(patches, FANOUT_CONCURRENCY, async (p) => {
    const rel = path.join('data', '.cache', 'patch', String(level), safeSlideId, `${fsSafe(p.id)}.png`)
    const abs = path.join(PATCH_CACHE_ROOT, String(level), safeSlideId, `${fsSafe(p.id)}.png`)
    try {
      await access(abs) // 命中：跳过真读
    } catch {
      const region = await client.readRegion(slideId, p.x, p.y, p.size, p.size, level, signal)
      await writeFile(abs, Buffer.from(region.png_base64, 'base64'))
    }
    return rel
  })
}
