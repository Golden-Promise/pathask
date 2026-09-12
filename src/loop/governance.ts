/**
 * 循环治理（B0，2026-09-11）：台账类型 + 汇总读出口。
 *
 * 本文件在 B0 只负责**把数据通道建好**——`loopGuardSummary()` 是报告与评测行两处落盘字段的
 * 唯一数据源。台账（`LoopLedger`）由 B1 起在 `guardedExecute` 逐条追加；在此之前
 * `session.loopLedger` 为 undefined，本函数返回 null，两个落盘字段即为 null/[]。
 *
 * **为什么 B0 就要建**：`EvalCaseResult.tool_sequence` 在 eval_core 里被逐次 push，但
 * `run_eval_v2.ts` 落盘时整块丢掉 → 全部 24 个 `pare_v01_*.json` 里 `"tool_sequence"` 出现 0 次，
 * 「同一工具被反复调用」这类问题**在磁盘上无法证实也无法证伪**。治理字段若同样只活在内存里，
 * 做完了也证明不了有效。故通道先行，且先于检测器落地。
 */

// 加权 token 是**指标**的派生量，故定义在 `metrics.ts`（与 p50/p95 同类），此处只是它的
// 第一个消费者。单一定义：两处各写一份的话，「预算按哪个公式算」会变成一个说不清的问题。
import type { BeforeToolCallContext, BeforeToolCallResult, ShouldStopAfterTurnContext } from '@earendil-works/pi-agent-core'
import { tokensWeighted } from '../metrics'

/** 一次工具调用的台账行。agent 与 programmatic 两种 origin 都记（后者不计重复/停滞，见 B2）。 */
export interface LoopCallRecord {
  /** 全局递增序号（本例内），用于还原调用时序 */
  seq: number
  tool: string
  /** agent=模型发起（走 beforeToolCall 门禁）；programmatic=系统补跑（runSystemTool，永不被拦） */
  origin: 'agent' | 'programmatic'
  /** 规范化参数的 hash32。**只用于分组/展示，判等一律用 `canonical`**——
   *  32 位哈希会碰撞，而碰撞的后果是「把一次合法调用误判成重复」（B4 起会直接拦掉它）。 */
  fingerprint: string
  /** 规范化参数原文（判等的唯一依据）。见 `fingerprint.ts` 的 Fingerprint.canonical。 */
  canonical: string
  /** 人类可读的参数摘要，用于给模型看的重复提示文案（不参与判等） */
  label: string
  /** 该工具的重复策略（策略表推导，见 B1） */
  policy: 'block' | 'hint' | 'exempt'
  /** 同 fingerprint 的第几次调用：0=首次，>0=重复。
   *  ⚠️ 按 `canonical` 数**全部**记录（含被拦的）——「同参数试了 3 次」是真实发生过的事。
   *  而**拦不拦**看的是「同参数**执行过**几次」（被拦的调用模型没拿到结果，理由不能是「你已经有答案了」）。 */
  repeatIndex: number
  /** 是否被 beforeToolCall 拦下（拦下的调用不执行，但确实发生过） */
  blocked?: boolean
  /** 被拦的原因（B4）。三种门禁互斥，取**先命中**的那个（顺序：步数 → 预算 → 重复）。
   *  这既是给分析用的诊断字段，也是探针断言的对象——只看 `blocked` 布尔值分不出「拦错了」与「拦对了」。 */
  blockReason?: 'steps' | 'budget' | 'dedup'
  /** 本次执行带来的**新增**去重证据指纹数（0 = 无进展） */
  newEvidenceKeys: number
  /** 命中幂等缓存（0ms 返回） */
  cacheHit?: boolean
  /** 墙钟耗时 */
  ms?: number
  /** 结果文本摘要（B4）。**唯一用途**：同参数调用被重复门禁拦下时，把「你上次拿到的答案是这句」
   *  附在拦下理由里——被拦 ≠ 信息丢失。这也是本设计不引入新失败路径的关键。 */
  digest?: string
}

/** 病例级台账。放在 `PathAskSession` 上、懒初始化，与 `retryBudget` 同套约定——
 *  hooks 挂在 Agent 上而 Agent 在 `runQuestion` 之外构造，故不能放 `runQuestion` 闭包。
 *
 *  **只存原始记录**：停滞/振荡/重复/缓存命中**全部从 `records` 派生**（见 `loopGuardSummary`）。
 *  存一份计数器就等于埋两个真相——`stalls` 计数器与「按序列重放算出来的次数」迟早不一致，
 *  而那时没人知道该信哪个。**唯一不能派生的只有 `budgetHardReason`**（它是「哪一次门禁先撞的」
 *  这个外部事实，序列里没有），故它是本结构里唯一的非 records 字段。 */
export interface LoopLedger {
  records: LoopCallRecord[]
  /** 撞上的**硬**预算类型；null=未撞。与 `case_timeout`（墙钟 abort）语义正交：
   *  这里是「执行前门禁」，模型可见且能优雅收尾；墙钟是外层硬边界，掐在途工具。 */
  budgetHardReason: 'tools' | 'tokens' | 'vlm' | null
  /** 提示**投递**记录（B4）：已发出过几条第几类 steer。与 `budgetHardReason` 同属
   *  「外部事实、序列里没有」——`countStallTriggers` 只说「该说第 n 次了」，
   *  而「到底送出去没有」是 `opts.steer` 那次投递的事，序列里推不出来，只能记。
   *  可选（懒初始化）：老台账对象与探针里手写的字面量不必带上它。 */
  steerSent?: { stall: number; oscillation: number; budget: number }
}

/** 治理汇总（落进报告 meta 与评测行）。派生量一律从 records 算，避免两处计数打架。 */
export interface LoopGuardSummary {
  attempts: number
  executed: number
  blocked: number
  duplicates: number
  cacheHits: number
  stallSteps: number
  /** 无进展**触发次数**（边沿触发：连续零进展第一次达到 K 时 +1，不是「第 K 步之后每一步 +1」） */
  stalls: number
  /** 触发时的**当前**连续零进展步数（B3 的每轮注入要现况，不是累计） */
  stallStreak: number
  /** 振荡触发次数（同样边沿触发） */
  oscillations: number
  budgetHardReason: 'tools' | 'tokens' | 'vlm' | null
}

/** 从台账派生汇总。无台账（B0/未接线）→ null，两个落盘字段据此写 null。 */
export function loopGuardSummary(session: { loopLedger?: LoopLedger }): LoopGuardSummary | null {
  const l = session.loopLedger
  if (!l) return null
  const r = l.records
  return {
    attempts: r.length,
    executed: r.filter((x) => !x.blocked).length,
    blocked: r.filter((x) => x.blocked).length,
    duplicates: r.filter((x) => x.repeatIndex > 0).length,
    cacheHits: r.filter((x) => x.cacheHit).length,
    // 「无进展步」只算**真执行了的 agent 调用**：程序化补跑是系统行为，被拦的调用没产生证据也非模型之过
    stallSteps: r.filter((x) => x.origin === 'agent' && !x.blocked && x.newEvidenceKeys === 0).length,
    stalls: countStallTriggers(r),
    stallStreak: noprogressStreak(r),
    oscillations: countOscillationTriggers(r),
    budgetHardReason: l.budgetHardReason,
  }
}

/** 懒初始化台账（B1 起由 guardedExecute / runQuestion 调用）。 */
export function ensureLedger(session: { loopLedger?: LoopLedger }): LoopLedger {
  if (!session.loopLedger) session.loopLedger = { records: [], budgetHardReason: null, steerSent: { stall: 0, oscillation: 0, budget: 0 } }
  return session.loopLedger
}

/** 开新问题前清台账（B4）。**必须清**，否则第二个问题的第一次调用就会因为第一个问题
 *  已经用光步数预算而被门禁拦下——「换个问题」不该继承上一个问题的循环状态。
 *  **原地清空而非新建对象**：钩子/工具层可能已经持有这个引用，换对象会让两处看到不同的台账
 *  （那是「两个真相」的另一种写法）。也正因原地清空，`ensureLedger` 仍是唯一的字面量构造点。 */
export function resetLedger(session: { loopLedger?: LoopLedger }): void {
  const l = ensureLedger(session)
  l.records.length = 0
  l.budgetHardReason = null
  l.steerSent = { stall: 0, oscillation: 0, budget: 0 }
}

// ============ 重复策略（B1）============

/** 同一调用再次出现时怎么办。
 *  - `block`：确定性工具同参必然同果 → 重复纯属浪费（B4 起拦截）
 *  - `hint`：**非确定性**工具（VLM 采样），重复采样有诊断价值 → 永不拦，只提示（B4 起提示）
 *  - `exempt`：程序化补跑 / 新鲜度重跑是设计 → 连提示都不给 */
export type RepeatPolicy = 'block' | 'hint' | 'exempt'

/** 每工具策略表（覆盖全部 10 件注册工具）。**未登记的新工具一律落到 `hint`**——
 *  对一个新工具默认沉默放行，永远不会因为「忘了登记」而掐断一条合法路径。 */
export const REPEAT_POLICY: Record<string, RepeatPolicy> = {
  scan_overview: 'block', // 确定性：同片的概览文本固定
  detect_roi: 'block', // 确定性：密度图算出来的候选区固定
  query_knowledge: 'block', // 确定性：知识库查表
  query_clinical: 'block', // 确定性：临床表查表
  retrieve_similar_case: 'block', // 确定性：CONCH 索引近邻稳定
  perceive: 'hint', // 非确定性：内含 VLM 描述，重复采样有价值
  verify_region: 'hint', // 非确定性：每次真烧 2 次 VLM（20×+40×）
  analyze_evidence: 'exempt', // 程序化补跑 / 新证据后重算是设计
  counterfactual: 'exempt', // F4 新鲜度重跑是设计
  generate_report: 'exempt', // 终态动作，必须永远放行
}

/** 解析某工具的重复策略。**硬规则在运行时强制**：`block` 仅当
 *  `metadata.idempotent === true && metadata.nonDeterministic !== true`。
 *  违反即**降级为 hint**（而非拦下）——「诊断名写错」比「静默拦掉一次合法调用」代价小得多。
 *  `probe_dedup_policy` 会对策略表逐条机械校验，所以降级是兜底而非常态。 */
export function resolveRepeatPolicy(
  name: string,
  meta?: { idempotent?: boolean; nonDeterministic?: boolean; repeatPolicy?: RepeatPolicy },
): RepeatPolicy {
  const want = meta?.repeatPolicy ?? REPEAT_POLICY[name] ?? 'hint'
  if (want === 'block' && !(meta?.idempotent === true && meta.nonDeterministic !== true)) return 'hint'
  return want
}

/** 工具元数据登记簿（B4）。**为什么需要**：`beforeToolCall` 门禁要对一个**还没执行过**的调用
 *  判重复策略，而 `ToolMetadata` 长在 `ToolSpec` 上、tools 层又 import 本层（反向 import 会成环）。
 *  登记簿是这个环的破法：`makeTool` 建工具时登记一次，门禁按名字查。
 *
 *  **仍是可选覆盖**：查不到就退回策略表（未登记一律 `hint` = 永不拦），所以「忘了登记」的后果
 *  是**少拦**而不是误拦。`probe_max_tools_cap` 有一条断言钉住「门禁算出的策略与台账里记的一致」。 */
const TOOL_META = new Map<string, { idempotent?: boolean; nonDeterministic?: boolean; repeatPolicy?: RepeatPolicy }>()

export function registerToolMetadata(
  name: string,
  meta: { idempotent?: boolean; nonDeterministic?: boolean; repeatPolicy?: RepeatPolicy },
): void {
  TOOL_META.set(name, meta)
}

export function toolMetadataOf(name: string): { idempotent?: boolean; nonDeterministic?: boolean; repeatPolicy?: RepeatPolicy } | undefined {
  return TOOL_META.get(name)
}

// ============ 进展信号（B2 的判据，B1 起就要记对）============

/** 证据的可比身份：`tool|type|规范化 claim|坐标锚点`。
 *  **不是节点 id，也不是节点数**——`query_knowledge` 每次调用都新加节点却是同一 claim（0 进展），
 *  `describe_patch` 一次扇出 N 条（N 个新 key 但只推进一步）。 */
export function evidenceKey(n: { type: string; claim: string; source: { tool: string; coords?: { x: number; y: number } | null; stub?: boolean; degenerate?: boolean } }): string {
  const claim = n.claim.trim().replace(/\s+/g, ' ').toLowerCase().replace(/[。．.,;；、]+$/g, '')
  const c = n.source.coords
  const anchor = c ? `${c.x},${c.y}` : ''
  return `${n.source.tool}|${n.type}|${claim}|${anchor}`
}

/** 该证据是否计入进展。与 `common.ts isVoteEvidence` 对齐地排除 stub/degenerate——
 *  「模板化良性描述」「骨架重复无内容」不构成任何进展，把它们算成进展会掩盖空转。 */
export function countsAsProgress(n: { source: { stub?: boolean; degenerate?: boolean } }): boolean {
  return !n.source.stub && !n.source.degenerate
}

// ============ 无进展 / 振荡检测（B2：只记录，不干预）============
//
// 两者**必须独立实现，不是彼此的特例**（这是最容易做错、也最容易看不出来的地方）：
//  - 振荡的两次调用**各自都可能带来新证据**（perceive r1 / verify_region r1 各有观察），
//    step delta 恒 > 0 → 无进展检测**永远不触发**；而它恰是最典型的烧钱形态。
//  - 无进展也可能由「三个**不同**调用全被幂等缓存命中」造成 → 序列里没有任何周期 → 不是振荡。
// 所以：共用同一本台账、同一套 env 门控，但判据各算各的。

/** env 读整数阈值。**每次调用时读**（不在模块顶层冻结）：同一进程内的探针要能改 env 生效。
 *  非法值（非数字 / 小于下界）一律回落默认——env 写错不该改变治理行为，更不该让它变成 0 而狂触发。 */
function envInt(name: string, dflt: number, min = 1): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return dflt
  const n = Number(raw)
  return Number.isFinite(n) && n >= min ? Math.floor(n) : dflt
}

/** 连续多少步零新增证据算停滞。基线均 6.89 步、p50 6 步，连续 4 步零新增是强离群。 */
export function noprogressK(): number {
  return envInt('PATHASK_NOPROGRESS_K', 4)
}
/** 停滞判定的**最少已执行步数**：防开局 setup 阶段（scan/detect 尚未回证据）被误判。 */
export function stallMinSteps(): number {
  return envInt('PATHASK_STALL_MIN_STEPS', 3)
}
/** 振荡周期数（末尾连续几个周期逐元素相等才算）。 */
export function oscillationCycles(): number {
  return envInt('PATHASK_OSCILLATION_CYCLES', 3)
}
/** 振荡周期长度。`p=3` 默认关——3×3=9 步已超基线 p99=11 的一半，回报递减。 */
export function oscillationPeriod(): number {
  return envInt('PATHASK_OSCILLATION_PERIOD', 2)
}

/** 该调用是否参与循环信号（无进展 / 振荡）。
 *  **程序化补跑与被拦的调用都不参与**：前者是系统行为（`analyze_evidence` 每例 ≥2 次是设计），
 *  后者没执行过、没产生证据也非模型之过。`exempt` 工具同理（终态动作、F4 新鲜度重跑）。 */
export function participatesInLoopSignal(r: LoopCallRecord): boolean {
  return r.origin === 'agent' && !r.blocked && r.policy !== 'exempt'
}

/** 参与信号的调用序列（按 canonical，供振荡判据用）。 */
function signalSeq(records: LoopCallRecord[]): string[] {
  return records.filter(participatesInLoopSignal).map((r) => r.canonical)
}

/** 末尾连续零进展步数。**从后往前扫**：无关记录**跳过而不打断**——
 *  一次程序化补跑插在中间，不该让模型前面已经空转的 3 步突然「清零重新开始」。 */
export function noprogressStreak(records: LoopCallRecord[]): number {
  let n = 0
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (!participatesInLoopSignal(r)) continue
    if (r.newEvidenceKeys === 0) n++
    else break
  }
  return n
}

/** 末尾是否构成振荡：末尾 `cycles × period` 个调用里，`cycles` 个周期逐元素相等。
 *  **周期内必须有区分度**（`new Set(period).size >= 2`）：`A A A A` 是「重复」不是「振荡」——
 *  把它算成振荡会让「重复率」与「振荡率」两个指标互相污染，且 B4 的提示文案会说错话。 */
export function oscillates(records: LoopCallRecord[], cycles: number, period: number): boolean {
  const seq = signalSeq(records)
  const need = cycles * period
  if (seq.length < need) return false
  const tail = seq.slice(-need)
  const first = tail.slice(0, period)
  if (new Set(first).size < 2) return false
  for (let c = 1; c < cycles; c++) {
    for (let i = 0; i < period; i++) {
      if (tail[c * period + i] !== first[i]) return false
    }
  }
  return true
}

/** 停滞**触发次数**：按序列重放做**边沿触发**计数。
 *  为什么不是「streak >= K 的步数」：那样一个长空转会被计成 7、8 次，而 B4 每一次触发都要
 *  投递一条 steer——计数即投递次数，语义必须是「这段空转**开始**了」。
 *
 *  ⚠️ 边沿条件是 `cur >= K && agentSteps >= minSteps` **且本段尚未触发过**，不是 `cur === K`。
 *  （实测踩过）`cur === K` 只在「恰好越过 K 的那一步」为真：若那一步被 `minSteps` 挡下
 *  （K=2 而 minSteps=5 时必然发生），此后 cur 一路 3、4、5… 永远不再等于 K → **触发被永久丢失**，
 *  模型明明早已越过两个阈值，治理层却当它没空转。`fired` 标志在**有进展时**重置，
 *  使「一段空转只算一次开始」与「两段独立空转各算一次」同时成立。 */
export function countStallTriggers(records: LoopCallRecord[]): number {
  const K = noprogressK()
  const minSteps = stallMinSteps()
  let triggers = 0
  let prev = 0
  let agentSteps = 0
  let firedThisEpisode = false
  for (const r of records) {
    if (!participatesInLoopSignal(r)) continue
    agentSteps++
    if (r.newEvidenceKeys !== 0) {
      // 有进展 = 本段空转结束：streak 归零，并**重新武装**触发标志
      prev = 0
      firedThisEpisode = false
      continue
    }
    const cur = prev + 1
    if (!firedThisEpisode && cur >= K && agentSteps >= minSteps) {
      triggers++
      firedThisEpisode = true
    }
    prev = cur
  }
  return triggers
}

/** 振荡触发次数：同样边沿触发（`A B A B` 长跑只算**一次开始**，不是每多一个周期加一次）。 */
export function countOscillationTriggers(records: LoopCallRecord[]): number {
  const cycles = oscillationCycles()
  const period = oscillationPeriod()
  const seen: LoopCallRecord[] = []
  let triggers = 0
  let prev = false
  for (const r of records) {
    seen.push(r)
    const cur = oscillates(seen, cycles, period)
    if (cur && !prev) triggers++
    prev = cur
  }
  return triggers
}

// ============ 成本预算（B3：先只做「算出来 + 报给模型」，B4 才做门禁）============
//
// 为什么要有：`metrics` 从第一天就在统计 token（`metrics.ts:82-86`），但**从来没有被比较过**——
// 本次是它的第一个真实消费者。没有预算的循环治理只治「重复」，治不了「一步一步把上下文撑爆」。
//
// 权重 `input + 4×output` 的理由：output 是逐字生成的、贵；input 虽大却可被 prompt cache 命中。
// 实测（101 例基线）：input p50 29.8k / max 189.7k，output p50 1.0k / max 5.3k
// → **加权 max = 193,930**。默认 250k ≈ 实测 max 的 **1.29×**：对今天的正常病例**永不触发**，
// 只抓真正的失控。`probe_budget_tokens` 有一条回归断言钉住「250k 在观测 max 上不触发」。

/** 加权 token 预算（默认 250k，≈实测 max 的 1.29×）。 */
export function tokenBudget(): number {
  return envInt('PATHASK_TOKEN_BUDGET', 250_000, 1000)
}
/** VLM 调用数预算（默认 40；观测 max 34、p99 32）。VLM 占分端点耗时第二大头，且成本与 token 无关，故单列。 */
export function vlmCallBudget(): number {
  return envInt('PATHASK_VLM_CALL_BUDGET', 40, 1)
}
/** 软阈比例（默认 0.8）：到预算的 80% 就开始**提示**模型收尾，但**不拦任何调用**。 */
export function budgetSoftRatio(): number {
  const raw = process.env.PATHASK_BUDGET_SOFT_RATIO
  if (raw === undefined || raw.trim() === '') return 0.8
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.8
}

export interface BudgetStatus {
  tokensUsed: number
  tokensBudget: number
  tokenRatio: number
  vlmUsed: number
  vlmBudget: number
  vlmRatio: number
  /** 是否已越过软阈（B3 只用它决定「要不要往 prompt 里加一行」） */
  soft: boolean
  /** 越界的维度名；空数组 = 都在预算内 */
  over: ('tokens' | 'vlm')[]
}

/** 预算只需要 session 上这两样东西。抽成具名接口是因为它现在有两个消费者
 *  （B3 的状态行、B4 的门禁），两处各写一遍结构类型就会各漂各的。 */
export interface BudgetSession {
  metrics?: { summary(): { llmInputTokens: number; llmOutputTokens: number; llmReasoningTokens: number; vlmCalls: number } }
  loopLedger?: LoopLedger
}

/** 算出当前预算状态。**纯读**，不改任何状态、不做任何拦截——B4 才据此设门禁。 */
export function budgetStatus(
  session: BudgetSession,
  override?: { tokensUsed?: number; vlmUsed?: number },
): BudgetStatus {
  const s = session.metrics?.summary()
  const tokensUsed = override?.tokensUsed ?? (s ? tokensWeighted(s) : 0)
  const vlmUsed = override?.vlmUsed ?? s?.vlmCalls ?? 0
  const tb = tokenBudget(), vb = vlmCallBudget()
  const over: ('tokens' | 'vlm')[] = []
  if (tokensUsed > tb) over.push('tokens')
  if (vlmUsed > vb) over.push('vlm')
  const tokenRatio = tb ? tokensUsed / tb : 0
  const vlmRatio = vb ? vlmUsed / vb : 0
  return {
    tokensUsed, tokensBudget: tb, tokenRatio, vlmUsed, vlmBudget: vb, vlmRatio,
    soft: tokenRatio >= budgetSoftRatio() || vlmRatio >= budgetSoftRatio(), over,
  }
}

/** 给模型看的**软阈状态行**（B3 唯一的模型可见改动）。
 *
 *  三条设计约束：
 *  ① **未过软阈时返回 null**——多数病例（p50 用量远低于阈值）的 prompt **逐字不变**，
 *     把「不改」当成默认，A/B 才有意义；
 *  ② 只给数字与出口，**不给禁止**（「不要调用 X」是 B4 硬阈的事）——软阈的价值是让模型
 *     自己决定收尾，而不是被剥夺工具；
 *  ③ **不注入「你还剩 N 步」这类会诱发抢跑的话**：预算不是步数，措辞必须与机制一致。 */
export function budgetStatusLine(st: BudgetStatus): string | null {
  if (!st.soft) return null
  const pct = (r: number) => `${Math.round(r * 100)}%`
  const bits: string[] = []
  if (st.tokenRatio >= budgetSoftRatio()) bits.push(`上下文用量 ${pct(st.tokenRatio)}（${st.tokensUsed}/${st.tokensBudget} 加权 token）`)
  if (st.vlmRatio >= budgetSoftRatio()) bits.push(`镜下复核调用 ${pct(st.vlmRatio)}（${st.vlmUsed}/${st.vlmBudget} 次）`)
  return `【预算】${bits.join('；')}。请优先把已有证据收敛成结论；若证据已足够，直接 analyze_evidence → generate_report。`
}

/** 记一条台账。seq / repeatIndex **在此统一分配，调用方不要自己算**——
 *  台账是整个批次里唯一的全局序列，两处各自计数必然对不上。
 *  `repeatIndex` 按 `canonical` 数（不用 hash，见字段注释）；只数**已落地**的记录，
 *  故同一批次内并行的两个同参调用会拿到 0 与 1（先记的拿 0），序列确定。 */
export function recordToolCall(
  session: { loopLedger?: LoopLedger },
  rec: Omit<LoopCallRecord, 'seq' | 'repeatIndex'>,
): LoopCallRecord {
  const ledger = ensureLedger(session)
  const repeatIndex = ledger.records.filter((r) => r.canonical === rec.canonical).length
  const full: LoopCallRecord = { ...rec, seq: ledger.records.length + 1, repeatIndex }
  ledger.records.push(full)
  return full
}

// ============ 拦截（B4，2026-09-11）============
//
// **唯一的执行前门禁是 `beforeToolCall`**，它在框架里只有 1 个调用点
// （`agent-loop.ts:619`，在 `prepareToolCall` 内部、**参数校验之后**）。这一条位置事实带来三个结论，
// 每一条都直接决定下面的写法：
//  ① **程序化调用（`runSystemTool`）永远不会被拦**——它根本不走框架。陷阱「analyze_evidence 每例 ≥2 次
//     是设计」由此自动消解，不需要在门禁里判 origin。
//  ② **参数没通过校验的调用到不了这里**，所以 `ctx.args` 一定是已解析的静态类型——指纹可以直接算。
//  ③ 被拦的调用**仍然会 emit `tool_execution_start`**（`:501` 在 `prepareToolCall` 之前），
//     所以「拦下」不会改变 `tool_count` 的口径，A/B 两臂的工具数仍然可比。
//
// **批处理顺序**（`:507` 与 `:540`）：整批调用先**顺序**过门禁，执行 thunk 直到 `Promise.all` 才跑。
// 于是门禁里数「已放行」时必须把**本批次已放行的**算进去，否则一个 N 调用批次能超发 N-1 个。
// 批次身份用 `ctx.assistantMessage` 的**引用相等**判定（同一批的所有调用共享同一个 assistant 消息对象）。
//
// **`terminate` 的语义是「整批」**：`shouldTerminateToolBatch` 要求本批**每一个**结果都 `terminate===true`
// 才结束循环。所以单点 `terminate` 不会立刻终止——要等到某一整批全是非终态的调用时才会。
// 这恰好是想要的：模型还有机会在被拦后改走收尾路径。

/** 工具调用总数的**默认**硬上限（步数）。与旧评测侧 `MAX_TOOLS` 同值——底线不变，只是搬进了产品层。
 *  基线 101 例实测最大 13，**没有一例撞到 15**：这是防御性上限，对今天的正常病例永不触发。 */
export const DEFAULT_MAX_TOOLS = 15

/** 干预总开关。`PATHASK_LOOP_GUARD_ENFORCE=0` 是 A/B 的**对照臂**：一键回到治理层落地前的行为
 *  （连软阈状态行也一起关——B3 的状态行本身就是干预，"精确复现今日"必须两个都关）。
 *
 *  默认**开**。只认显式的关闭值（`0`/`false`/`off`/`no`），其余一律视为开——门禁是安全网，
 *  「env 写错了一个字」不该静默把它摘掉。 */
export function loopGuardEnforce(): boolean {
  const raw = process.env.PATHASK_LOOP_GUARD_ENFORCE
  if (raw === undefined || raw.trim() === '') return true
  return !/^(0|false|off|no)$/i.test(raw.trim())
}

/** 步数硬上限。`PATHASK_MAX_TOOLS` 优先，**回落兼容旧 `MAX_TOOLS`**（既有评测 env 快照里是后者）。
 *  非法值一律回落默认而非 0：上限为 0 意味着一句话都问不出来，那不是一个可用的治理状态。
 *  注意 `PATHASK_MAX_TOOLS` 一旦被显式设置（哪怕值非法）就不再去看 `MAX_TOOLS`——否则
 *  「我改了新变量却没生效，原来是旧变量在起作用」会变成一类查不出来的问题。 */
export function resolveMaxTools(): number {
  const n = (raw: string | undefined): number | null => {
    if (raw === undefined || raw.trim() === '') return null
    const v = Number(raw)
    return Number.isFinite(v) && v >= 1 ? Math.floor(v) : null
  }
  if (process.env.PATHASK_MAX_TOOLS !== undefined && process.env.PATHASK_MAX_TOOLS.trim() !== '') {
    return n(process.env.PATHASK_MAX_TOOLS) ?? DEFAULT_MAX_TOOLS
  }
  return n(process.env.MAX_TOOLS) ?? DEFAULT_MAX_TOOLS
}

/** 到顶之后额外放行的调用数（默认 2）。给的是**收尾所需的余量**：一次 `analyze_evidence`
 *  + 一次 `generate_report`。没有它，模型会在「探索刚好用光预算」的那一步被直接掐断，
 *  连把已有证据收敛成结论的机会都没有。下限允许 0（= 到顶即全拦），上界不设但别写大。 */
export function maxToolsGrace(): number {
  return envInt('PATHASK_MAX_TOOLS_GRACE', 2, 0)
}

/** 终态白名单：把证据收敛成结论的动作。撞硬阈后**只**放行这三件。
 *  名单是**显式白名单**而非「排除探索类」的反面——新工具默认落在白名单外（= 当探索类拦），
 *  这是刻意的：这与 `REPEAT_POLICY` 未登记工具默认 `hint`（= 放行）方向相反，因为两件事的
 *  代价不对称。少拦一次重复调用只是浪费；预算耗尽时放行一个**未知成本**的新工具，
 *  正是预算想要防住的那件事。 */
export const TERMINAL_TOOLS: ReadonlySet<string> = new Set(['analyze_evidence', 'counterfactual', 'generate_report'])

export function isTerminalTool(name: string): boolean {
  return TERMINAL_TOOLS.has(name)
}

/** 撞硬阈后停用的工具（= 白名单之外的一切）。 */
export function isExplorationTool(name: string): boolean {
  return !TERMINAL_TOOLS.has(name)
}

/** 已**执行**的 agent 调用数（被拦的不算）。步数上限按这个口径，不是「尝试数」——
 *  若按尝试数，被拦的调用会把自己越推越高，模型重试几次就把上限吃光，门禁变成自激的。 */
export function executedAgentCalls(records: LoopCallRecord[]): number {
  return records.filter((r) => r.origin === 'agent' && !r.blocked).length
}

/** digest 摘要：折叠空白 + 截断。**只影响给模型看的文案长度**，不影响任何判等。 */
function digestOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 240 ? `${flat.slice(0, 240)}…` : flat
}

/** 重复调用被拦下的理由。**四行结构与 `toolErrors.ts` 同构**（为什么/影响/怎么改/可否重试），
 *  因为模型的解读习惯是为那套结构建立的。附上 `digest` 是这条设计的要点：
 *  「拦下」的代价必须是**零信息损失**，否则门禁就从「省一次调用」变成「制造一次失败」。 */
export function dedupBlockReason(label: string, repeatIndex: number, digest?: string): string {
  const lines = [
    `[${label}] 已拦下（重复调用 · 同参数第 ${repeatIndex + 1} 次）`,
    '  为什么：这一组参数本病例已经执行过，确定性工具同参数必然同结果。',
    '  影响：本次未执行——你没有得到新信息，也没有消耗步数预算。',
    '  怎么改：直接用上次的结果（见下）；若想换角度，请换一个没看过的 region_ref，或直接 analyze_evidence → generate_report。',
    '  可否重试：不必——同参数再调用仍会被拦下；换参数即可。',
  ]
  if (digest) lines.push(`  上次结果：${digest}`)
  else lines.push('  上次结果：本批次里已有一个完全相同的调用，它的结果就在接下来的 tool 消息里，直接读即可。')
  return lines.join('\n')
}

/** 步数用尽的理由。**给出唯一合法的出口**，而不是只说「不许再调」——
 *  模型被剥夺工具却不知道该做什么时，会退化成用文本凑答案（历史教训：决策收紧 → 待评估 → 方向错）。 */
export function stepsBlockReason(tool: string, maxTools: number, grace: number): string {
  return [
    `[${tool}] 已拦下（步数预算用尽 · 硬门禁）`,
    `  为什么：本病例的工具调用已达上限 ${maxTools} 次（可再放行 ${grace} 次收尾动作，用尽即全部拦下）。`,
    '  影响：本次未执行——你没有得到新信息，也没有消耗预算。',
    '  怎么改：现在只剩收尾这一条路：analyze_evidence → [counterfactual] → generate_report。'
      + '即使你认为证据不足也请照走——报告可以带 uncertainty=insufficient_evidence，兜底逻辑会接管，'
      + '但**不要**用同样的参数再试一次。',
    '  可否重试：不必——探索类工具在本病例已停用，同参数再调用仍会被拦下。',
  ].join('\n')
}

/** 成本预算用尽的理由。tokens/vlm 两个维度都报出来（只报越界的那个会掩盖另一个已接近的事实）。 */
export function budgetBlockReason(tool: string, st: BudgetStatus): string {
  const pct = (r: number) => `${Math.round(r * 100)}%`
  const over = st.over.map((k) => (k === 'tokens'
    ? `上下文加权 token ${st.tokensUsed}/${st.tokensBudget}（${pct(st.tokenRatio)}）`
    : `镜下复核调用 ${st.vlmUsed}/${st.vlmBudget} 次（${pct(st.vlmRatio)}）`)).join('；')
  return [
    `[${tool}] 已拦下（成本预算用尽 · 硬门禁 · ${over}）`,
    '  为什么：探索类工具（导航/感知/检索/查表）已经停用，避免预算继续被撑大。',
    '  影响：本次未执行——你没有得到新信息。',
    '  怎么改：把已有证据收敛成结论：analyze_evidence → generate_report。'
      + '收尾动作不受预算门禁限制，即使证据不足也请走这条路（报告可带 insufficient_evidence）。',
    '  可否重试：不必——探索类工具在本病例已停用；同参数或换参数都不会放行。',
  ].join('\n')
}

/** 停滞后投给模型的提示（一次性，由门禁 `steer` 投递）。
 *  两条**具体**出口是重点：「想办法继续」这类话对模型等于没说。 */
export function stallSteerText(streak: number, triggers: number): string {
  return `【停滞】最近 ${streak} 步没有新增任何证据（本病例已出现第 ${triggers} 次）。`
    + '继续用同样的方式采样不会带来新信息。请在两条路里选一条：'
    + '① 换一个**没看过**的 region_ref（或调大倍率）再采一次；'
    + '② 若已有证据足以表态，直接 analyze_evidence → generate_report。'
}

/** 振荡提示：与停滞**分开措辞**（`A B A B` 的两次调用各自都可能有新证据，说成「没有新增证据」是假话）。 */
export function oscillationSteerText(cycles: number, period: number, triggers: number): string {
  return `【来回振荡】最近的调用在同样的 ${period} 组参数之间来回 ${cycles} 轮（本病例已出现第 ${triggers} 次）。`
    + '这两条路径的信息已经拿过了。请在两条路里选一条：'
    + '① 换一个**没看过**的 region_ref 或改变倍率，拿到真正不同的观察；'
    + '② 直接 analyze_evidence → generate_report 收敛结论。'
}

/** 硬预算提示（一次性）。与软阈状态行（每轮刷新、只给数字）分工不同：
 *  这条只说「现在该做什么」，因为当它出现时门禁已经在拦探索类工具了。 */
export function budgetSteerText(st: BudgetStatus): string {
  const pct = (r: number) => `${Math.round(r * 100)}%`
  return `【预算已用尽】${st.over.map((k) => (k === 'tokens' ? `上下文 ${pct(st.tokenRatio)}` : `镜下复核 ${pct(st.vlmRatio)}`)).join('；')}。`
    + '探索类工具已停用（导航/感知/检索/查表都会被拦下），只有收尾动作可以继续。'
    + '请立刻 analyze_evidence → generate_report；证据不足也照走，报告可带 insufficient_evidence。'
}

/** 一次 steer 的投递账（B4）：哪些类别的提示**已经发出去过**。 */
export interface SteerSent {
  stall: number
  oscillation: number
  budget: number
}

export interface LoopGuardOpts {
  session: BudgetSession
  /** 步数硬上限（由调用方从 `resolveMaxTools()` 或显式 opts 得到） */
  maxTools: number
  /** 指纹函数。**由调用方注入**而不是本模块 import `fingerprint.ts` + 一个 resolver：
   *  「用哪套解析」是工具层的知识（`findRegionByRef` 等），在这里重写一遍就是两份真相。 */
  fingerprintOf: (tool: string, args: unknown) => { key: string; canonical: string; label: string }
  /** 一次性提示的投递口。**为什么不直接返回一个 `getSteeringMessages` 钩子**：
   *  `AgentOptions`（`agent.ts:98-121`）里**根本没有**这个字段——框架把 steering 封成了
   *  `agent.steer()`，`getSteeringMessages` 只存在于更底层的 `AgentLoopConfig`（且被 Agent 写死成
   *  「drain 自己的队列」）。所以治理层只能投递，**投递时机由框架的 drain 决定**：
   *  `agent-loop.ts:259` 在每轮 turn_end 之后 drain，于是「本轮门禁里投的提示」正好在下一轮生效。 */
  steer: (text: string) => void
}

export interface LoopGuardHooks {
  beforeToolCall: (context: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined>
  shouldStopAfterTurn: (context: ShouldStopAfterTurnContext) => boolean
}

/** 造一组治理钩子（B4）。三条钩子共享同一本台账、同一套阈值，**判据只算一份**。
 *
 *  钩子不是各自独立的小功能：`beforeToolCall` 写台账（被拦的行），`guardedExecute` 也写台账（执行过的行），
 *  提示的置位从同一本台账派生停滞/振荡，`shouldStopAfterTurn` 再读同一个 `budgetHardReason`。
 *  把它们拆开各算各的，就会出现「steer 说已停滞而落盘数据说没有」这类自相矛盾。 */
export function createLoopGuard(opts: LoopGuardOpts): LoopGuardHooks {
  const { session, maxTools } = opts
  // 批次身份 + 本批**已放行**的 canonical。引用相等即同一批（见本节顶部的顺序说明）。
  let batchOwner: unknown = null
  let batchAdmitted: string[] = []
  // 待投递的一次性提示。置位即「该说」，`flushSteer` 发出即清空（框架 drain 只取一次，天然一次性）。
  const pending = { stall: false, oscillation: false, budget: false }

  const ledger = () => ensureLedger(session)
  const sent = (): SteerSent => {
    const l = ledger()
    if (!l.steerSent) l.steerSent = { stall: 0, oscillation: 0, budget: 0 }
    return l.steerSent
  }

  /** 从台账**派生**的触发对照「已投递」——边沿计数天然就是「该说第 n 次了」，
   *  与 `steerSent` 比一下就得到「这次是不是刚触发」。无需额外的边沿状态机。 */
  const refreshSteer = (): void => {
    const l = ledger()
    const s = sent()
    // **只置位、不记账**：置位是「该说」，记账是「说过了」。置位时就把计数推上去的话，
    // 万一 flush 没走到（异常/提前 return），`steerSent` 会说一条从没发出去过的提示已经发了——
    // 而这本账存在的唯一理由就是回答「到底送出去没有」。
    if (countStallTriggers(l.records) > s.stall) pending.stall = true
    if (countOscillationTriggers(l.records) > s.oscillation) pending.oscillation = true
    // 预算的「边沿」与停滞/振荡**不是一回事**：一个问题的用量只增不减，撞上就是撞上了，
    // 不会有第二个边沿 → 判据是「这一题第一次撞上」（`budgetHardReason` 由 null 变非 null，
    // 与 `s.budget` 比较即得）。**必须只发一次**：硬阈本来就是在拦上下文增长，
    // 每轮补一条同样的话，正好是把要防的东西加回去。`resetLedger` 两边一起归零 → 下一题重新可发。
    if (l.budgetHardReason !== null && s.budget === 0) pending.budget = true
  }

  /** 把待投递的提示合成**一条**消息交给框架。
   *  合成一条而不是三条：它们说的是同一件事（「别再用现在的方式采样了」），
   *  拆成三条既挤占上下文，又会让模型把三个提示当成三件独立的事去处理。 */
  const flushSteer = (): void => {
    const l = ledger()
    const bits: string[] = []
    if (pending.budget) bits.push(budgetSteerText(budgetStatus(session)))
    // 「本病例已出现第 n 次」取**派生计数**而非已投递数：后者在首次发送前是 0，会出现「第 0 次」。
    if (pending.stall) bits.push(stallSteerText(noprogressStreak(l.records), countStallTriggers(l.records)))
    if (pending.oscillation) bits.push(oscillationSteerText(oscillationCycles(), oscillationPeriod(), countOscillationTriggers(l.records)))
    if (!bits.length) return
    // 投递成功后才记账（见 refreshSteer）。记的是派生计数的**最新值**而非 +1：
    // 「该说第 n 次」由 records 推出，两边取同一个 n 才不会漂。
    if (pending.budget) sent().budget += 1
    if (pending.stall) sent().stall = countStallTriggers(l.records)
    if (pending.oscillation) sent().oscillation = countOscillationTriggers(l.records)
    pending.budget = pending.stall = pending.oscillation = false
    opts.steer(bits.join('\n\n'))
  }

  return {
    async beforeToolCall(ctx): Promise<BeforeToolCallResult | undefined> {
      // 每批第一件事：认批次（引用相等），并清空本批放行计数。
      if (ctx.assistantMessage !== batchOwner) {
        batchOwner = ctx.assistantMessage
        batchAdmitted = []
      }
      const l = ledger()
      const name = ctx.toolCall.name
      const fp = opts.fingerprintOf(name, ctx.args)
      const executed = executedAgentCalls(l.records) + batchAdmitted.length
      const grace = maxToolsGrace()
      // 提示的**唯一投递点**：门禁每轮至少被调用一次（模型要调工具才走到这里），而此刻台账里
      // 已有上一轮执行完的全部记录 → 正好是判停滞/振荡的最新数据；投出去的消息由框架在**本轮
      // turn_end 之后** drain（`agent-loop.ts:259`），下一轮生效。
      // 不放在 `shouldStopAfterTurn` 里还有一层原因：那条路径一旦返回 true，框架会**先**退出、
      // **不**再 drain——投了也白投，还会把消息留在队列里跨问题泄漏。
      refreshSteer()
      flushSteer()

      // 重复策略**先算一次**，`block()` 与 ③ 共用同一个值。分头算的后果很隐蔽：
      // 台账里被拦那行会记成「按 hint 处理」（因为 block() 当时只查得到静态表），
      // 而门禁实际是按 block 拦下的 —— 落盘数据与真实行为对不上，正是最难看的一类不一致。
      // 取值顺序：**那一条先前记录**（工具层 `guardedExecute` 写它时用的就是权威 metadata）
      // → 登记簿（同批内重复时没有先前记录）→ 静态表 → hint 兜底（永不静默拦新工具）。
      const prior = l.records.find((r) => r.canonical === fp.canonical && !r.blocked)
      const policy = prior?.policy ?? resolveRepeatPolicy(name, toolMetadataOf(name))

      const block = (reason: string, kind: 'steps' | 'budget' | 'dedup', terminate: boolean): BeforeToolCallResult => {
        // 被拦的调用**入台账**：它确实发生过（框架也 emit 了 start），不入账就等于
        // 「模型试图调用 N 次」这件事在落盘数据里不存在——而这正是治理要看的东西。
        recordToolCall(session, {
          tool: name, origin: 'agent', fingerprint: fp.key, canonical: fp.canonical, label: fp.label,
          policy, newEvidenceKeys: 0, blocked: true, blockReason: kind,
        })
        return { block: true, reason, terminate }
      }

      // ① 步数硬上限。**按已执行数**（见 executedAgentCalls 的理由）；终态白名单在 grace 内放行。
      if (executed >= maxTools + grace || (executed >= maxTools && isExplorationTool(name) )) {
        if (!l.budgetHardReason) l.budgetHardReason = 'tools'
        return block(stepsBlockReason(name, maxTools, grace), 'steps', true)
      }

      // ② 成本硬阈：只拦探索类，终态白名单照常放行（那是唯一的出口，拦掉它等于不给出口）。
      const st = budgetStatus(session)
      if (st.over.length > 0 && isExplorationTool(name)) {
        if (!l.budgetHardReason) l.budgetHardReason = st.over.includes('tokens') ? 'tokens' : 'vlm'
        // 首次撞硬阈**当场投递**（不等下一次门禁）：此刻模型正处在"还想继续探索"的当口，
        // 拦下理由它马上能看到，但那条是 tool error；这条是明确的"现在该收尾了"。
        // 置位由 `refreshSteer` 统一负责（它读刚写好的 `budgetHardReason`），这里不自己设 pending。
        refreshSteer()
        flushSteer()
        return block(budgetBlockReason(name, st), 'budget', true)
      }

      // ③ 重复检测。**看「同参数执行过几次」而不是「尝试过几次」**：模型被拦一次后重试，
      //    若按尝试数就会一直拦，而理由（「你已经有答案了」）在它根本没拿到结果时是假话。
      //    `batchAdmitted` 是另一半：同一批里第二次出现同参（批内并行时才可能）时 `prior` 还
      //    没入账，只看 records 会漏拦——这就是批次必须按 admitted 口径计数的原因。
      if (policy === 'block' && (prior || batchAdmitted.includes(fp.canonical))) {
        const idx = l.records.filter((r) => r.canonical === fp.canonical).length
        refreshSteer()
        return block(dedupBlockReason(fp.label, idx, prior?.digest), 'dedup', false)
      }

      batchAdmitted.push(fp.canonical)
      refreshSteer()
      return undefined
    },

    shouldStopAfterTurn({ toolResults }): boolean {
      if (!loopGuardEnforce()) return false
      const l = ledger()
      const hard = l.budgetHardReason !== null
      if (!hard && executedAgentCalls(l.records) < maxTools + maxToolsGrace()) return false
      // 本轮**成功执行过**终态动作 → 让模型自己走完收尾，别抢它的方向盘。
      // 只看成功的结果：被拦下的终态调用（isError）不算「已收尾」。
      if (toolResults.some((r) => !r.isError && TERMINAL_TOOLS.has(r.toolName))) return false
      // 保险丝：撞了硬阈、本轮又没有走到收尾 → 优雅收场。由 `ensureStructuredReport` 兜底出报告
      // （既有能力，不是新增重试）。它覆盖的是「模型无视被拦、继续空转」这条路径。
      return true
    },
  }
}
