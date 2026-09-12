import { Type } from 'typebox'

/** 共享 Region schema：inspect_region / verify_region 复用 */
export const RegionSchema = Type.Object({
  id: Type.String(),
  slide_id: Type.String(),
  x: Type.Number(),
  y: Type.Number(),
  w: Type.Number(),
  h: Type.Number(),
  magnification: Type.Number(),
  anomaly_score: Type.Optional(Type.Number()),
  label: Type.Optional(Type.String()),
})
