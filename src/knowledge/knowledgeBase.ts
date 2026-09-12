import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MOCK_KNOWLEDGE } from '../mock/mockData'
import type { KnowledgeEntry } from '../types'

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const KB_PATH = path.join(PROJECT_ROOT, 'data', 'knowledge_base.json')

let _kb: KnowledgeEntry[] | null = null

/** 加载策划病理知识库（data/knowledge_base.json）；文件缺失/损坏回落 mock（保证 smoke 与无数据环境可用）。 */
export function loadKnowledgeBase(): KnowledgeEntry[] {
  if (_kb) return _kb
  try {
    const raw = JSON.parse(readFileSync(KB_PATH, 'utf8')) as { entries?: KnowledgeEntry[] }
    _kb = raw.entries ?? []
    if (!_kb.length) console.warn('[knowledgeBase] 知识库为空，回落 mock')
  } catch (e) {
    console.warn(`[knowledgeBase] 知识库不可用（${KB_PATH}）：${e instanceof Error ? e.message : e}，回落 mock`)
    _kb = MOCK_KNOWLEDGE
  }
  return _kb
}
