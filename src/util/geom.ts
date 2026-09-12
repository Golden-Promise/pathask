/**
 * 几何纯函数。
 *
 * **为什么移**：循环治理的指纹模块要用 `overlapRatio` 做「手抄坐标 ↔ 缓存 ROI」的交叠吸附，
 * 而 `runner.ts` 会 import 工具层、工具层要用指纹 → 若指纹反过来 import runner 就成环。
 * 移到零依赖的 util 层后，runner 与 fingerprint 都从同一处取，**实现仍只有一份**。
 */

/** 两区域 bbox 交叠比例（相对 b 的面积），0-1。 */
export function overlapRatio(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return (ix * iy) / Math.max(1, b.w * b.h)
}
