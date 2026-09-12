import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { WsiEntry } from './wsiTypes'

const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url))

interface WsiRegistryFile {
  registry_version?: number
  slides: WsiEntry[]
}

/**
 * 读 data/wsilist.json → Map<slide_id, WsiEntry>。
 * path 为相对 data/ 的路径，解析为 absPath（同一张片只能登记一次）。
 */
export function loadWsiRegistry(
  registryPath = process.env.PATHASK_WSI_REGISTRY ?? path.join(DATA_DIR, 'wsilist.json'),
): Map<string, WsiEntry> {
  let raw: WsiRegistryFile
  try {
    raw = JSON.parse(readFileSync(registryPath, 'utf-8')) as WsiRegistryFile
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`wsilist.json 读取失败（${registryPath}）: ${msg}`)
  }
  const base = path.dirname(registryPath)
  const m = new Map<string, WsiEntry>()
  for (const s of raw.slides ?? []) {
    if (m.has(s.id)) throw new Error(`wsilist.json 重复 slide id: ${s.id}`)
    m.set(s.id, { ...s, absPath: path.resolve(base, s.path) })
  }
  return m
}
