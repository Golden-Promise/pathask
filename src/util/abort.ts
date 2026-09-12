/** 中止 / 超时信号的公共件。
 *  收口动机：全仓反复出现 `ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(x)]) : AbortSignal.timeout(x)`
 *  这一模式（describePatch / analyzeEvidence / verifyRegion …）。**漏一处 = 留下一条能挂死的路径**，
 *  所以统一成「合成结果必定是 AbortSignal，永不为 undefined」。
 *  ⚠️ Node 的 `AbortSignal.timeout` 内部计时器是 unref 的（不吊住事件循环），`AbortSignal.any` 亦然。 */

/** 读 env 数值（仅认 >0 的有限数；缺失/非法 → fallback）。**调用时读**，探针可临时改 env 生效。 */
export function envMs(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

export interface TimeoutGuard {
  /** 调用方 signal 与本层超时的合成结果（谁先触发谁生效）。**永不为 undefined**。 */
  signal: AbortSignal
  /** 本层超时计时器是否已触发。用途是**认领**超时：下层要把裸 `TimeoutError` 重写成带层信息的
   *  错误（如 `WSI 桥接超时 …` → BRIDGE_TIMEOUT）时，必须先确认「这个超时是我加的」，
   *  否则可能把调用方的中止、或别层刚认领过的超时又改写一遍。 */
  timedOut: () => boolean
}

/** 把可选的外部 signal 与一个墙钟上限合成。
 *  ⚠️ 返回值里的 `signal` **永不为 undefined**——「不传 signal 就不设超时」正是「工具跑一半挂了只能干等」的入口。 */
export function withTimeout(signal: AbortSignal | undefined, ms: number): TimeoutGuard {
  const timer = AbortSignal.timeout(ms)
  return { signal: signal ? AbortSignal.any([signal, timer]) : timer, timedOut: () => timer.aborted }
}
