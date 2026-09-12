import { EvidenceStore } from './evidence/EvidenceStore'
import { MOCK_CAPABILITIES, MOCK_CLINICAL, MOCK_SIMILAR, MOCK_WSI } from './mock/mockData'
import { loadKnowledgeBase } from './knowledge/knowledgeBase'
import { WsiClient } from './wsi/WsiClient'
import { loadWsiRegistry } from './wsi/registry'
import { SessionMetrics } from './metrics'
import { loadCapabilityRegistry } from './capabilities/registry'
import type { Cancer, Capability, PathAskSession } from './types'

/** mock slide → 标本癌种（真实会话读 wsilist.json；smoke 走同一投票引擎，部位先验需要 cancer 字段） */
const MOCK_SLIDE_CANCER: Record<string, Cancer> = {
  slide_brca_001: 'breast',
  slide_lung_001: 'lung',
  slide_phyllodes_001: 'phyllodes',
}

/** mock 会话：smoke / 无真实 WSI 时用 */
export function createSession(slideId = 'slide_brca_001'): PathAskSession {
  const capabilityRegistry = new Map<string, Capability>()
  for (const c of MOCK_CAPABILITIES) capabilityRegistry.set(c.id, c)

  const wsiCache = new Map<string, PathAskSession['wsiCache'] extends Map<string, infer V> ? V : never>()
  const entry = MOCK_WSI[slideId]
  if (entry) wsiCache.set(slideId, entry)

  return {
    currentWsiId: slideId,
    evidenceStore: new EvidenceStore(),
    wsiCache,
    patchCache: new Map(),
    describeCache: new Map(),
    roiCache: new Map(),
    metrics: new SessionMetrics(),
    capabilityRegistry,
    clinicalData: MOCK_CLINICAL,
    knowledgeBase: loadKnowledgeBase(),
    similarCaseIndex: MOCK_SIMILAR,
    // mock 也注册癌种（AnalyzeEvidence 的部位先验/部位默认依赖 registry）
    wsiRegistry: new Map(
      Object.entries(MOCK_WSI).map(([id]) => [
        id,
        { id, path: '', absPath: '', cancer: MOCK_SLIDE_CANCER[id] ?? 'unknown' },
      ]),
    ),
    wsiClient: null,
    toolErrors: [],
  }
}

/** 真实会话：读 data/wsilist.json 注册表 + 连 WSI 桥接。无真实 WSI 时抛错提示先转数据。 */
export function createRealSession(slideId?: string): PathAskSession {
  const registry = loadWsiRegistry()
  if (registry.size === 0) throw new Error('wsilist.json 未登记任何真实 WSI，先转数据（见 data/README.md）')

  const firstId = slideId ?? [...registry.keys()][0]
  const metrics = new SessionMetrics()
  return {
    currentWsiId: firstId,
    evidenceStore: new EvidenceStore(),
    wsiCache: new Map(),
    patchCache: new Map(),
    describeCache: new Map(),
    roiCache: new Map(),
    metrics,
    capabilityRegistry: loadCapabilityRegistry(), // STREAM 真注册表（data/capability_registry.json）
    clinicalData: MOCK_CLINICAL,
    knowledgeBase: loadKnowledgeBase(), // 策划病理知识库（data/knowledge_base.json）
    similarCaseIndex: MOCK_SIMILAR,
    wsiRegistry: registry,
    // 桥接每次 HTTP 都记一笔分端点耗时——桥在最内层，只有它自己知道是哪条路径慢
    wsiClient: new WsiClient(undefined, metrics),
    toolErrors: [],
  }
}
