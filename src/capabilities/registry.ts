import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Capability } from '../types'

/**
 * 能力库注册表加载（Phase 3）：data/capability_registry.json 是 STREAM MIL 能力的单一事实来源，
 * bridge（mil_inference.py）与 TS 侧读同一文件。TS 侧加载后转成 Map 供 session / run_mil 用。
 */
const REGISTRY_PATH = fileURLToPath(new URL('../../data/capability_registry.json', import.meta.url))

export function loadCapabilityRegistry(): Map<string, Capability> {
  const raw = JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8')) as {
    capabilities: Capability[]
  }
  const m = new Map<string, Capability>()
  for (const c of raw.capabilities) m.set(c.id, c)
  return m
}
