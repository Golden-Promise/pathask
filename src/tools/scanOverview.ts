import { Type } from 'typebox'
import type { Static } from '@earendil-works/pi-ai'
import type { OverviewCache } from '../types'
import { addEvidence, ensureWsi, realWsi, type ToolSpec } from './common'

/** 缓存读路径开关（B5，2026-09-11，**默认开**）。
 *  只认显式的关闭值——与 `loopGuardEnforce` 同一套约定：写错一个字不该静默把缓存摘掉。
 *  A/B 用得上：这条路径省的是桥端墙钟，但「省」的前提是模型看到的东西一模一样。 */
function scanCacheRead(): boolean {
  const raw = process.env.PATHASK_SCAN_CACHE_READ
  if (raw === undefined || raw.trim() === '') return true
  return !/^(0|false|off|no)$/i.test(raw.trim())
}

/** 1. 全片低倍扫描：组织覆盖 + 缩略图 + 全局描述。结果按 slide 缓存。
 *  真实路径：wsi-bridge（OpenSlide）读缩略图 + 组织掩膜 → 启发式全局描述（VLM 全览在 Patho-R1 就绪后替换）。
 *  mock 路径：会话 wsiCache 的预置数据（smoke 用）。
 *
 *  **B5 之前这里的缓存是装饰性的**：`wsiCache.set` 只在写，读只发生在桥失败后的 mock 兜底分支——
 *  也就是说"缓存"从未省下一次桥调用（`info`+`thumbnail`+`tissueMask` 三连每次都真发）。
 *  现在读路径放在 `realWsi(...)` **之前**，命中即直返；这正是探针 `probe_idempotent_meta`
 *  判定 `metadata.cacheable` 从"欠账"变成"机制"的依据（它比对的就是 get 与 realWsi 的先后）。 */
export const scanOverviewSpec: ToolSpec<typeof ScanOverviewSchema> = {
  name: 'scan_overview',
  label: '全片低倍扫描',
  description: '对整张 WSI 做低倍全览，返回组织覆盖比例、缩略图与全局形态描述。同一 slide 结果缓存，幂等。',
  parameters: Type.Object({ slide_id: Type.String() }),
  metadata: { category: 'acquisition', cacheable: true, idempotent: true, timeoutMs: 360_000 },
  execute: async (params, ctx) => {
    const id = ensureWsi(ctx, params.slide_id)

    // ===== 缓存读路径（B5）：命中即直返，一次桥调用都不发 =====
    // 位置是这段的全部要点：写在 `realWsi` 之后就成了 mock 兜底读，桥该走还得走（那正是旧样子）。
    // ① 先断言 `metadata.cacheable === true`：读缓存返回**必须**由声明授权。
    //    声明与实现分居两处，靠这条把二者绑在一起——哪天有人拿掉声明，读路径自动关门，而不是
    //    继续偷偷吃缓存。探针 `probe_idempotent_meta` 按源码正是查这一处消费。
    // ② 返回**首次那份完整文本**（`result_text`），不在读路径重新拼一遍：拼一次就是第二套渲染，
    //    两处迟早不一致，而模型看到的文本恰恰是评测所依赖的东西。
    // ③ `addEvidence` 照做：节点数与"没有读路径"时**逐字一致**。省的是桥端墙钟，不是证据。
    //    （同一 claim 重复入库在进展统计里 delta=0，见 `evidenceKey`。）
    if (scanCacheRead() && scanOverviewSpec.metadata.cacheable === true) {
      const hit = ctx.session.wsiCache.get(id)
      if (hit?.result_text && hit.overview_text) {
        addEvidence(ctx, 'observation', `全览：${hit.overview_text}`, 0.6, 'scan_overview', { magnification: 1.25 })
        const { result_text, ...rest } = hit
        return { text: result_text, details: { ...rest, cached: true } }
      }
    }

    // ===== 真实路径：OpenSlide 桥接 =====
    const rw = realWsi(ctx, id)
    if (rw) {
      try {
        const [, thumb, mask] = await Promise.all([
          rw.client.info(id, ctx.signal),
          rw.client.thumbnail(id, undefined, ctx.signal),
          rw.client.tissueMask(id, undefined, ctx.signal),
        ])
        const coverage = mask.coverage
        const bbox = mask.bbox ? `(${mask.bbox.join(',')})` : '—'
        const overviewText =
          `组织覆盖率 ${(coverage * 100).toFixed(1)}%，检出 ${mask.cell_count} 个组织候选区，` +
          `主组织块 @${bbox}（组织掩膜 baseline，形态学待 VLM 描述）`
        const text =
          `[scan_overview] slide=${id} case=${rw.entry.case_id ?? id} tissue_coverage=${(coverage * 100).toFixed(1)}% (真实 OpenSlide)\n${overviewText}`
        const cache: OverviewCache = {
          slide_id: id,
          case_id: rw.entry.case_id ?? id,
          thumbnail: `data:image/png;base64,${thumb.png_base64}`,
          tissue_coverage: coverage,
          overview_text: overviewText,
          wsi_path: rw.entry.absPath,
          // 存**返回给模型的那份文本**（含来源前缀）——读路径原样吐回，保证两次调用逐字相同。
          result_text: text,
        }
        ctx.session.wsiCache.set(id, cache)
        addEvidence(ctx, 'observation', `全览：${overviewText}`, 0.6, 'scan_overview', { magnification: 1.25 })
        const { result_text: _t, ...rest } = cache
        return { text, details: { ...rest, wsi_path: rw.entry.absPath } }
      } catch (e) {
        if (!ctx.session.wsiCache.has(id)) {
          throw new Error(`WSI 桥接不可用（${e instanceof Error ? e.message : e}）且无 mock 数据。请先启动 wsi-bridge：python wsi-bridge/server.py`)
        }
        // 回落 mock
      }
    }

    // ===== mock 路径（smoke / 无桥接） =====
    const entry = ctx.session.wsiCache.get(id)!
    addEvidence(ctx, 'observation', `全览：${entry.overview_text}`, 0.6, 'scan_overview', { magnification: 1.25 })
    const text = `[scan_overview] slide=${id} case=${entry.case_id} tissue_coverage=${entry.tissue_coverage}\n${entry.overview_text}`
    // 首次走 mock 也把文本存回去：否则"预置数据的会话"永远命中不了读路径（`result_text` 一直是空的）。
    entry.result_text ??= text
    const { result_text: _t, ...rest } = entry
    return { text, details: rest }
  },
}

// 供 index.ts 组装时取 schema（避免 Type.Object 重复构造）
export const ScanOverviewSchema = Type.Object({ slide_id: Type.String() })
export type ScanOverviewParams = Static<typeof ScanOverviewSchema>
