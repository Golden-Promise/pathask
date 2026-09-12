/** 并发原语（2026-09-10 从 tools/describePatch.ts 抽出，供 patchCache / 其他无界扇出复用）。
 *  抽出动机：describe_patch 的批量 VLM 调用一直有并发上限（对齐 patho-r1 `--max-num-seqs 4`），
 *  但同类的 `Promise.all` 扇出（切块等）是无界的——抽成公共件后统一收口。 */

/** 带并发上限的 map（保序；fn 收 index）：保证同刻在途 ≤ limit。单个项异常直接向上抛（由调用方 Settled 化）。 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!items.length) return []
  const out = new Array<R>(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()))
  return out
}

/** 会话级扇出并发上限（切块 / 缓存预热等非 VLM 路径）。VLM 路径另有 VLM_BATCH_CONCURRENCY（对齐 vLLM 队列）。 */
export const FANOUT_CONCURRENCY = Number(process.env.PATHASK_FANOUT_CONCURRENCY ?? 4)
