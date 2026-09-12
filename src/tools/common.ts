import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { Static, TSchema } from '@earendil-works/pi-ai'
import type { WsiClient } from '../wsi/WsiClient'
import type { WsiEntry } from '../wsi/wsiTypes'
import type { EvidenceNode, EvidenceSource, EvidenceType, PathAskSession, PatchRef, Region, ToolMetadata } from '../types'
import { classifyToolError, consumeTransientBudget, markPartialEvidence, recordToolError, resolveToolBudgetMs, semanticRepeatState } from './toolErrors'
import type { RefResolver } from '../loop/fingerprint'
import { fingerprintToolCall } from '../loop/fingerprint'
import { countsAsProgress, evidenceKey, loopGuardEnforce, recordToolCall, registerToolMetadata, resolveRepeatPolicy } from '../loop/governance'
import type { LoopCallRecord } from '../loop/governance'

export interface ToolExecuteCtx {
  session: PathAskSession
  toolCallId: string
  /** 本工具的墙钟预算 signal（`AbortSignal.any([agent 中止, 工具预算超时])`）。
   *  ⚠️ 可能为 undefined：runner.ts / 探针的**系统调用**直接构造 ctx 时没有框架 signal。下游一律写
   *  `ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(x)]) : AbortSignal.timeout(x)`。
   *  子工具自动继承（perceive 原样把同一个 ctx 转发给 inspect_region/describe_patch），无需逐处传参。 */
  signal?: AbortSignal
  /** 进度上报（工具 → 包装层）。包装层**只用来记 partial 的 k/n，不转发给框架**（避免引入框架新事件类型）。 */
  onUpdate?: (progress: { done: number; total?: number }) => void
  /** 调用来源（B1）：`makeTool` 传 agent、`runSystemTool` 传 programmatic。
   *  可选——探针与测试直接构造 ctx 时不传，视为 programmatic（**默认绝不让未标注的调用触发拦截**）。 */
  origin?: 'agent' | 'programmatic'
}

/** 供指纹层解析引用用的只读视图（B1）。**故意不 import 指纹层**——把三个既有查找函数
 *  以接口注入，避免「工具层要用指纹记台账 / 指纹要用工具层的查找」成环，实现仍只有一份。
 *  B4 起**导出**：`beforeToolCall` 门禁算指纹时也必须走这同一套解析，否则「门禁算出的 canonical」
 *  与「台账里记的 canonical」会分叉——而门禁的全部判据就是那个 canonical。
 *  ⚠️ `makeRefResolver` 是只读快照视图（`regions()` 每次现取），但 `region()/patch()` 内部查的是
 *  session 上的 Map 引用，故**每次判调用前现建一个**（`agentFactory` 就是这么用的），不要跨轮缓存。 */
export function makeRefResolver(session: PathAskSession): RefResolver {
  return {
    region: (ref) => findRegionByRef(session.roiCache, ref),
    patch: (ref) => findPatchByRef(session.patchCache, ref),
    // resolveWsiId 的签名要 ctx 且**会 throw**（把可用 id 列表写进 message）；这里只要「尽力解析」，
    // 解析不到就返回原值——指纹不该因为一个 id 拼错而抛错。
    slide: (id) => {
      const want = id ?? session.currentWsiId
      try {
        return resolveWsiId({ session, toolCallId: 'fingerprint' }, want)
      } catch {
        return want
      }
    },
    regions: () => [...(session.roiCache?.values() ?? [])].flat(),
  }
}

export interface ToolSpec<T extends TSchema> {
  name: string
  label: string
  description: string
  parameters: T
  metadata: ToolMetadata
  execute: (params: Static<T>, ctx: ToolExecuteCtx) => Promise<{ text: string; details?: unknown }>
}

/**
 * 统一包装为 pi AgentTool。三条职责：
 *  1. **补 4 参数**：框架的 `execute(toolCallId, params, signal?, onUpdate?)` 此前只被声明 2 个参数，
 *     `signal`/`onUpdate` 被静默丢弃 → `agent.abort()` 打断不了在途工具。现在把 signal 透进 ctx。
 *  2. **逐工具预算**：`AbortSignal.any([agentSignal, 自己的 timeout])`；到点即中断下游 fetch/VLM。
 *  3. **错误分类 + 账本**：catch → `classifyToolError` → 结构化文本 re-throw（框架把它原样当 tool-result
 *     文本回给模型，isError=true）+ 写 `session.toolErrors` + `metrics.toolFail`。**刻意不自动重试**
 *     （用户决策）：重试与否由模型读到「可否重试」后自行决定。
 *
 * ⚠️ 不要给框架接 `afterToolCall`：`agent-loop.ts:747-750` 里它一旦 throw 会**丢掉真实 tool result**。
 *    错误处理全部在本层完成，不依赖任何 pi-agent 钩子（probe_tool_errors.ts 有断言守住）。
 */
export function makeTool<T extends TSchema>(spec: ToolSpec<T>, session: PathAskSession): AgentTool<T> {
  // B4：登记元数据。`beforeToolCall` 门禁要对**还没执行过**的调用判重复策略，
  // 而 metadata 长在 spec 上、governance 层又够不着它（反向 import 成环）——登记簿是这个环的破法。
  // 放在 makeTool 里而不是各工具模块的顶层：登记点是「工具被真正包装成 AgentTool」这个动作本身，
  // 与执行路径同源，不会出现「工具在跑但没登记」。
  registerToolMetadata(spec.name, spec.metadata)
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    executionMode: 'parallel',
    execute: async (toolCallId: string, params: Static<T>, signal?: AbortSignal) => {
      const { text, details } = await guardedExecute(spec, session, toolCallId, params, signal, 'agent')
      return { content: [{ type: 'text', text }], details: details ?? {} }
    },
  }
}

/** 重复调用的**提示行**（B4）：`hint` 策略工具（perceive / verify_region）的重复**永不拦**
 *  ——非确定性采样重复一次是有诊断价值的——但也不该让模型意识不到自己在重复。
 *
 *  **改的是 tool result 文本，所以边界必须干净**：只在 `loopGuardEnforce()` 打开、策略是 `hint`、
 *  且 `repeatIndex > 0`（确实重复过）时才加前缀；`block` 策略轮不到这里（门禁已拦），
 *  `exempt` 是程序化补跑/F4 重跑，加提示纯属噪音。前缀**另起一行并以 `【` 开头**，
 *  与工具自身的观测正文一眼可分——正文本身一个字都不动。
 *
 *  ⚠️ 这里**只动模型可见的文本**，不动 `digest`（台账里存的是原文本）：`digest` 会被拼进「你上次
 *  拿到的是这句」，若它自己带着提示行，提示行就会被再引用一次、越滚越长。 */
function withRepeatHint(text: string, rec: LoopCallRecord, tool: string): string {
  if (!loopGuardEnforce() || rec.policy !== 'hint' || rec.repeatIndex === 0) return text
  const last = rec.digest ? ` 上次同类采样的结果：${rec.digest}` : ''
  return `【重复采样】这是本病例第 ${rec.repeatIndex + 1} 次以相同参数调用 ${tool}（非确定性工具，已放行）。`
    + `若本次结果与上次无实质差异，请换一个没看过的 region_ref 或改变倍率，而不是继续重复。${last}\n\n${text}`
}

/** 预算 + 失败分类 + 账本 的**公共执行体**（`makeTool` 与 `runSystemTool` 共用，语义只此一份）。
 *  返回 spec 自己的 `{text, details}`；失败时抛结构化文本（调用方决定怎么接）。
 *
 *  `origin`（B1，2026-09-11）区分「模型发起」与「系统补跑」：只有 agent-origin 的调用才进重复/停滞统计
 *  ——`analyze_evidence` 每例 ≥2 次是 `ensureStructuredReport` 的设计，把它算成重复就是在惩罚正确行为。 */
async function guardedExecute<T extends TSchema>(
  spec: ToolSpec<T>,
  session: PathAskSession,
  toolCallId: string,
  params: Static<T>,
  signal: AbortSignal | undefined,
  origin: 'agent' | 'programmatic',
): Promise<{ text: string; details?: unknown }> {
  const budgetMs = resolveToolBudgetMs(spec.metadata)
  // own 只由预算计时器 abort → 据此区分「预算到点」(TOOL_TIMEOUT) 与「agent 中止」(ABORTED)
  const own = new AbortController()
  const timer = setTimeout(() => own.abort(new DOMException(`工具预算 ${budgetMs}ms 用尽`, 'TimeoutError')), budgetMs)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  const ctxSignal = signal ? AbortSignal.any([signal, own.signal]) : own.signal
  const startedAt = Date.now()
  let lastProgress: { done: number; total?: number } | undefined
  // 账本（B1）：指纹在**执行前**算（此时参数已是校验后的静态类型），证据增量在执行后比。
  const fp = fingerprintToolCall(spec.name, params, makeRefResolver(session))
  const priorKeys = new Set(session.evidenceStore.allNodes().filter(countsAsProgress).map(evidenceKey))
  // 证据增量：只数**本次 toolCallId 产生的**节点——批次是并行的，全局集合差会把别的工具的
  // 证据算到这次头上。perceive 的子调用原样转发同一个 toolCallId，故整次扇出正确地算作一步。
  const freshCount = () =>
    new Set(
      session.evidenceStore
        .allNodes()
        .filter((n) => n.source.toolCallId === toolCallId && countsAsProgress(n))
        .map(evidenceKey)
        .filter((k) => !priorKeys.has(k)),
    ).size
  const note = (cacheHit: boolean, ms: number, digest?: string) =>
    recordToolCall(session, {
      tool: spec.name, origin, fingerprint: fp.key, canonical: fp.canonical, label: fp.label,
      policy: resolveRepeatPolicy(spec.name, spec.metadata),
      newEvidenceKeys: freshCount(), cacheHit, ms,
      // digest（B4）：同参数被重复门禁拦下时，拦下理由要能说「你上次拿到的是这句」。
      // 只截长度、不改内容——它是给模型看的**原始结果**，任何加工都会让「被拦 ≠ 信息丢失」打折。
      digest: digest ? digest.replace(/\s+/g, ' ').trim().slice(0, 240) : undefined,
    })
  try {
    const out = await spec.execute(params, {
      session,
      toolCallId,
      signal: ctxSignal,
      origin,
      onUpdate: (p) => {
        lastProgress = p
      },
    })
    const rec = note((out.details as { cached?: boolean } | undefined)?.cached === true, Date.now() - startedAt, out.text)
    return { text: withRepeatHint(out.text, rec, spec.name), details: out.details }
  } catch (err) {
    const elapsedMs = Date.now() - startedAt
    // 失败也要记：只有成功才记的话，「反复失败重试」这条最典型的空转形态在台账里完全看不见。
    // 失败前的已产生观测同样算进展（partial 证据是真的），故这里也走 freshCount()。
    note(false, elapsedMs)
    const timedOut = own.signal.aborted
    const aborted = signal?.aborted === true
    // 中断类错误：把本次已产生的观测标 partial（不回滚——观测是真的，describeCache 让重发廉价）
    let partial = lastProgress
    if (timedOut || aborted) {
      const k = markPartialEvidence(session, toolCallId)
      if (k > 0) partial = { done: k, total: partial?.total }
    }
    const info = classifyToolError(err, {
      tool: spec.name,
      timedOut,
      aborted,
      budgetMs: timedOut ? budgetMs : undefined,
      elapsedMs: timedOut ? elapsedMs : undefined,
      partial,
      // Step 2：瞬时故障预算的**唯一扣减点**（工具 throw 路径）。语义类 code 不扣（见 TRANSIENT_CODES）。
      transientFor: (code) => consumeTransientBudget(session, code),
      // B6：语义重复计数的**唯一读取点**（工具 throw 路径）。只读不写、不消费令牌——
      // 它改的是文案（「可否重试」→「别再原样重放同一个 id」），不是可用工具集。
      semanticRepeatFor: (code) => semanticRepeatState(session, spec.name, code),
    })
    recordToolError(session, {
      toolCallId,
      tool: spec.name,
      code: info.code,
      message: info.message,
      atMs: Date.now(),
      elapsedMs,
      partial,
    })
    // re-throw 结构化文本：框架 createErrorToolResult 把它当 tool-result 文本（details 会丢，故账本在本层写）
    throw new Error(info.text)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * **系统调用**执行器（runner.ts 的确定性兜底层，2026-09-11）：走与 `makeTool` 同一套
 * 「预算 + 分类 + 账本」，只是**不接框架**——直接把 spec 的 `{text, details}` 返回来。
 *
 * 之前这些调用（`sys-*`）是裸 `spec.execute(params, {session, toolCallId})`：
 *  - **无预算**：只有 VLM/LLM fetch 自己的内部超时兜底，桥接调用（无 signal）连超时都没有；
 *  - **无账本**：失败只留一句 `console.warn`，评测里完全看不到 `sys-*` 出过事；
 *  - **无分类**：`e.message` 原样打印，没有人知道该怎么改。
 *
 * 抛错语义与 `makeTool` 一致（结构化文本 re-throw）是**刻意的**：runner 的 8 处调用点**都**已包在
 * try/catch 里，且各自的 catch 本就是「失败即降级」分支（不阻塞报告 / markUnresolved / continue）——
 * 保持 throw 就不引入新的失败路径，只是让失败变得有预算、有分类、有账本。
 * 传 `signal` 的情形（要让 agent abort 掐断系统调用）由调用方自行 `AbortSignal.any` 后传入。
 */
export async function runSystemTool<T extends TSchema>(
  spec: ToolSpec<T>,
  session: PathAskSession,
  toolCallId: string,
  params: Static<T>,
  signal?: AbortSignal,
): Promise<{ text: string; details?: unknown }> {
  return guardedExecute(spec, session, toolCallId, params, signal, 'programmatic')
}

let evCounter = 0
/** 写证据节点到会话证据库（闭包 Session，不走 ExtensionContext）。 */
export function addEvidence(
  ctx: ToolExecuteCtx,
  type: EvidenceType,
  claim: string,
  confidence: number,
  tool: string,
  extra: Partial<EvidenceSource> = {},
) {
  evCounter += 1
  // STUB/MOCK 证据：强制置信 0（它无真实计算，不能携带真实置信度）
  const isStub = extra.stub === true
  const node = {
    id: `ev-${evCounter}`,
    type,
    claim,
    source: { tool, toolCallId: ctx.toolCallId, ...extra },
    confidence: isStub ? 0 : confidence,
    timestamp: Date.now(),
  }
  ctx.session.evidenceStore.addNode(node)
  return node
}

/** 归一化 slide_id：优先精确匹配注册表/缓存；LLM 常剥掉文件扩展名（slide_00001_01.tiff → slide_00001_01），
 *  查不到时按「去扩展名」回退匹配，返回注册表中的真实 id（下游 bridge / realWsi 都靠它精确定位）。 */
function stripWsExt(id: string): string {
  const i = id.lastIndexOf('.')
  return i > id.lastIndexOf('/') ? id.slice(0, i) : id // 只剥最后一层点的后缀，路径中段点不剥
}

/** 剥目录前缀取 basename（含 `/` 的 id 如 `histai/HISTAI-mixed/case_X` → `case_X`）。
 *  fix-D：agent 常把带目录前缀的 slide_id 塌缩成 basename（case_00001/20091 弃诊根因之一），
 *  桥端 _resolve 与 WsiClient.normalizeSlideId 已容忍，TS 侧 resolveWsiId/realWsi/findRegionByRef 一直缺失。 */
function baseId(id: string): string {
  const i = id.lastIndexOf('/')
  return i >= 0 ? id.slice(i + 1) : id
}

export function resolveWsiId(ctx: ToolExecuteCtx, slideId?: string): string {
  const id = slideId ?? ctx.session.currentWsiId
  if (ctx.session.wsiCache.has(id) || ctx.session.wsiRegistry.has(id)) return id
  // agent 剥掉扩展名 → strip 后回退查注册表/缓存（返回注册表真实 id）
  const stripped = stripWsExt(id)
  if (ctx.session.wsiRegistry.has(stripped)) return stripped
  if (ctx.session.wsiCache.has(stripped)) return stripped
  // fix-D：agent 把 `histai/HISTAI-mixed/case_X` 塌缩成 basename `case_X`（无斜杠）——按 basename 在
  //  注册表/缓存里找**完整键**返回（下游 wsiRegistry.get(id)/realWsi 依赖完整键；直接返回 basename 会让 cancer 丢失）。
  //  注意：必须对「无斜杠的 basename id」也跑（这才是塌缩形态），不能以 id.includes('/') 为门槛（那是完整 id 形态）。
  const base = baseId(id)
  for (const key of ctx.session.wsiRegistry.keys()) {
    if (baseId(key) === base) return key
  }
  for (const key of ctx.session.wsiCache.keys()) {
    if (baseId(key) === base) return key
  }
  // B2：把**合法备选**直接写进 message——throw 路径经 classifyToolError 归类为 SLIDE_NOT_FOUND，
  // 但分类器不知道本会话有哪些 slide；把列表塞进原文，模型才能自我纠正而不是瞎猜 id。
  const avail = [...new Set([...ctx.session.wsiRegistry.keys(), ...ctx.session.wsiCache.keys()])]
  const shown = avail.slice(0, 20)
  const more = avail.length > shown.length ? ` …（共 ${avail.length} 个）` : ''
  throw new Error(
    `未知 slide: ${id}。可用 slide_id: ${shown.join(', ') || '（本会话未登记任何真实 WSI）'}${more}`,
  )
}

export function ensureWsi(ctx: ToolExecuteCtx, slideId?: string): string {
  return resolveWsiId(ctx, slideId)
}

/** 该 slide 是否有真实 WSI 路径（注册表 + 桥接客户端都就绪）→ 走真实 OpenSlide；否则回落 mock。
 *  同样做 strip 归一化：agent 传入剥后缀的 id 也能取到真实 entry。 */
export function realWsi(ctx: ToolExecuteCtx, slideId: string): { client: WsiClient; entry: WsiEntry } | null {
  const client = ctx.session.wsiClient
  const registry = ctx.session.wsiRegistry
  let entry = registry.get(slideId)
  if (!entry) {
    const stripped = stripWsExt(slideId)
    entry = registry.get(stripped)
  }
  if (!entry) {
    // fix-D：basename 兜底（agent 塌缩 id → 用 basename 匹配注册表完整键条目）
    const base = baseId(slideId)
    for (const k of registry.keys()) {
      if (baseId(k) === base) { entry = registry.get(k); break }
    }
  }
  if (client && entry) return { client, entry }
  return null
}

/** 文件系统安全化 id：把 `/` 等非法路径字符替换成 `_`，仅供「落盘路径」用（patch cache 目录、报告文件名）。
 *  注意：id 语义（消息/JSON/registry 查询）保持原样含 `/` —— Registry 键与 GT 用斜杠 id
 *  （如 histai/HISTAI-mixed/case_00001），runner.ts 靠 `wsiRegistry.get(slideId)` 取 cancer；
 *  全局改 basename 会让该查询失效。只在 mkdir/writeFile 拼路径处替换，保证 id 不被改写。 */
export function fsSafe(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '_')
}

/** 在 patchCache 里定位 patch：容忍两种表示。inspect_region 生成的 id 含 `/`（如
 *  `patch_histai/HISTAI-mixed/case_X_r0_0`），但模型常据 inspect 输出里的**展平文件路径**，把
 *  patch_ref 规范化成展平 basename（`patch_histai_HISTAI-mixed_...`）。旧实现 `p.id === patch_ref`
 *  **精确匹配失败**→抛「未知 patch_ref」→agent 误判 patch 未生成→重复 inspect+describe 直到预算耗尽。
 *  这里把 `/`、`\` 归一到 `_` 后比较，任一表示命中即返回；无命中返回 undefined（调用方自行兜底）。 */
export function findPatchByRef(patchCache: Map<string, PatchRef[]>, patch_ref: string): PatchRef | undefined {
  const norm = (s: string) => s.replace(/[/\\]/g, '_')
  const refNorm = norm(patch_ref)
  for (const arr of patchCache.values()) {
    const patch = arr.find((p) => {
      if (p.id === patch_ref) return true
      const base = p.cached_path
        ? p.cached_path.replace(/\\/g, '/').split('/').pop()!.replace(/\.[^.]+$/, '')
        : ''
      return norm(p.id) === refNorm || norm(base) === refNorm
    })
    if (patch) return patch
  }
  return undefined
}

/** 从 detect_roi 缓存里按 region_ref 找 Region（容忍匹配，同 findPatchByRef 思路）。
 *  region_ref 可能是 `case_00001_r1`(basename) / `histai/HISTAI-mixed/case_00001_r1`(全路径) /
 *  `case_00001`(只给 slide) / 末段 `r1`。把坐标解析交给确定性代码，别让 LLM 手抄六字段。 */
export function findRegionByRef(roiCache: Map<string, Region[]> | undefined, region_ref: string): Region | undefined {
  if (!roiCache || !region_ref) return undefined
  const norm = (s: string) => s.replace(/[/\\]/g, '_')
  const baseN = (s: string) => norm(s.split(/[/\\]/).pop()!) // basename 归一化（case_X）
  const refN = norm(region_ref)
  const refR = refN.match(/_r\d+$/)
  const refRPart = refR ? refR[0] : '' // '_r1' 等
  const refSlide = refN.replace(/_r\d+$/, '')
  const all: Region[] = [...roiCache.values()].flat()
  // 1) 精确 / 归一化匹配 region.id
  const exact = all.find((r) => norm(r.id) === refN)
  if (exact) return exact
  if (refRPart) {
    // 2) 带 _rN：先按「同 slide + 同 _rN」匹配，退而求其次按 _rN 匹配（id 内嵌 slide，跨 slide 碰撞风险低）
    const sameSlide = all.find((r) => norm(r.id).endsWith(refRPart) && norm(r.id).replace(/_r\d+$/, '') === refSlide)
    if (sameSlide) return sameSlide
    const anyR = all.find((r) => norm(r.id).endsWith(refRPart))
    if (anyR) return anyR
  }
  // 3) 纯 slide（无 _rN）：取该 slide 的组织富集度最高区（detect_roi 已按密度降序，[0] 即最密）。
  //    fix-E：id 含目录前缀时（histai/HISTAI-mixed/case_X vs agent 传的 basename case_X）按 basename 匹配。
  const bySlide = all.find(
    (r) =>
      norm(r.slide_id) === refSlide ||
      norm(r.id).replace(/_r\d+$/, '') === refSlide ||
      baseN(r.slide_id) === baseN(region_ref) ||
      baseN(r.id.replace(/_r\d+$/, '')) === baseN(region_ref),
  )
  if (bySlide) return bySlide
  // 4) 末段 rN（refN='r1' 裸）
  const bareR = all.find((r) => norm(r.id).endsWith(`_${refN}`) && /^r\d+$/.test(refN))
  return bareR
}

/** 该证据是否参与诊断投票/置信聚合（统一判定，一处定义多处复用）：
 *  只认 observation + run_mil 的 inference；排除 analyze_evidence / counterfactual 生成的聚合推理节点
 *  （避免上一轮结论自引用投票），也排除 query_knowledge / retrieve_similar_case（背景参考：知识条目是
 *  鉴别标准举例、相似病例文本含诊断名，都不是当前病例的形态观察信号）。 */
export function isVoteEvidence(n: EvidenceNode): boolean {
  if (n.source.tool === 'query_knowledge' || n.source.tool === 'retrieve_similar_case') return false
  if (n.source.stub) return false // STUB/MOCK 硬编码值无真实计算，不得进投票/置信聚合（但仍留存报告标注）
  if (n.source.degenerate) return false // VLM 输出退化（骨架重复无内容），无效观察，不得进投票/置信聚合/反事实
  return n.type === 'observation' || (n.type === 'inference' && n.source.tool === 'run_mil')
}

/** 证据聚合置信度（方向化）：只统计可投票证据（isVoteEvidence）。polarity='against' 的证据以 1−conf 计入
 *  → verify_region 的质疑会正确拉低主诊断置信。run_mil 模型证据权重×2。 */
export function evidenceConfidence(session: PathAskSession): number {
  const obs = session.evidenceStore.allNodes().filter(isVoteEvidence)
  if (obs.length === 0) return 0
  let sum = 0
  let weight = 0
  for (const n of obs) {
    // ⚠️ 权重校准（2026-08-28 第二轮验证）：Patho-R1 VLM 良恶性不可靠（同一形态它在真癌上也报 "Benign lesion"），
    // 若把 describe_patch 权重抬到 3，会放大 VLM 误判 → 真癌被叫良性（第二轮 15 例 overconfident_wrong 即此）。
    // 正确做法：describe_patch 与其他观察证据同权（1），让集体投票裁决；"反向时压置信保守"由 analyze_evidence
    // 的 morphAgainst 处理（形态与主诊断冲突 → 置信压 ≤0.5 + evidence_conflict，而非放大单一 VLM 信号）。
    const w = n.source.tool === 'run_mil' ? 2 : 1
    const c = n.polarity === 'against' ? 1 - n.confidence : n.confidence
    sum += c * w
    weight += w
  }
  return weight === 0 ? 0 : sum / weight
}
