import type { EvidenceStore } from './evidence/EvidenceStore'
import type { WsiClient } from './wsi/WsiClient'
import type { WsiEntry } from './wsi/wsiTypes'
import type { SessionMetrics } from './metrics'
import type { LoopLedger } from './loop/governance'

// ============ 基础几何 ============
export type Cancer =
  | 'breast' | 'thyroid' | 'ovary' | 'phyllodes' | 'lung' | 'unknown'
  | 'prostate' | 'colon' | 'stomach' | 'brain' | 'soft_tissue' | 'pancreas'
  | 'bladder' | 'endometrium' | 'lymph' | 'skin' | 'kidney' | 'liver'
  | 'esophagus' | 'cervix' | 'testis' | 'bile_duct' | 'head_neck' | 'mesothelium'
export type Task = string // 'er_status' | 'her2_status' | 'stage' | 'tp53' | 'hrd' | 'tumor_type' | 'benign_malignant' | ...

export interface Region {
  id: string
  slide_id: string
  x: number
  y: number
  w: number
  h: number
  magnification: number
  anomaly_score?: number
  label?: string
}

export interface PatchRef {
  id: string
  region_id: string
  slide_id: string
  x: number
  y: number
  size: number
  magnification: number
  cached_path?: string
  region_label?: string
}

// ============ 证据链 ============
export type EvidenceType = 'observation' | 'inference' | 'conclusion'

export interface EvidenceSource {
  tool: string
  coords?: Region
  magnification?: number
  model?: string
  /** STUB/MOCK 标记：该证据为硬编码/模拟值，不得进入投票/置信聚合。报告中标注"未验证/模拟"。 */
  stub?: boolean
  /** VLM 输出退化检测：Patho-R1 等会钩进记忆中的病理 step-screening 脚手架进入重复循环（只吐
   *  "Step 1: Screening…Step N: Extended Report Output" 空骨架、零诊断内容，直到 token 上限）。
   *  退化证据不得进入投票/置信聚合/反事实（等同无效观察），报告中标注"VLM 输出退化"。 */
  degenerate?: boolean
  /** VLM **不可用**→ 确定性模板降级（describe_patch 的 describeFromLabel 兜底；与上一条区分：
   *  degenerate=模型吐了但输出是垃圾；fallback=模型没吐，内容是按 region_label 查表生成的）。
   *  ⚠️ 该内容不是对这张图的观察，真 WSI 会话下同时带 `stub:true` 被排除出投票（见 describePatch.ts）。 */
  fallback?: boolean
  /** run_mil 溯源：所用能力 id + 预测类别（供投票引擎按能力语义判定方向，而非匹配能力名称文本） */
  capability_id?: string
  label?: string
  /** describe_patch 5-label 结构化标签（malignant/premalignant/benign/normal/N/A），投票引擎按此+形态文本做方向判别。 */
  morph_label?: string
  /** describe_patch VLM 自行给出的 label 置信（0-1，原始值，仅溯源不参与聚合；聚合取 labelBalance 确定性档）。 */
  morph_confidence?: number
  /** VLM（Patho-R1）原始完整输出（含 think/answer 标签），供 JSON 报告追溯；claim 只存摘要。 */
  raw?: string
  /** run_mil attention 热点（level0 左上角，MIL 256×256 patch 网格坐标），报告期热点闭环确定性补描述用。 */
  attention_hotspots?: { x: number; y: number; attn: number }[]
  /** 生成该证据的 pi-agent 工具调用 id：编排层 compactContext 折返时从 toolResult.toolCallId 反向定位
   *  到这个证据节点，用归纳句做 gist（而非把 claim 原文反复重放进消息历史）。 */
  toolCallId?: string
  /** 工具超时/中断：该证据是**部分完成的真观测**——写入它的工具没跑完就被预算或 abort 掐断。
   *  **不做事务回滚**（观测是真的，describeCache 让重发廉价），只打标 + 在错误文本里报 k/n。
   *  ⚠️ 不参与投票排除：partial 证据仍是有效观察（见 isVoteEvidence），打标是给决策层/报告看的诚实性信号。 */
  partial?: boolean
}

export interface EvidenceNode {
  id: string
  type: EvidenceType
  claim: string
  source: EvidenceSource
  confidence: number // 0-1
  timestamp: number
  follow_up_questions?: string[]
  /** 相对主诊断的方向（analyze_evidence 判定）：support=支持主诊断，against=反对（如 verify_region 的质疑）。用于方向化聚合置信度。 */
  polarity?: 'support' | 'against'
}

export type EvidenceRelation = 'supports' | 'contradicts' | 'excludes' | 'refines'

export interface EvidenceEdge {
  from: string
  to: string
  relation: EvidenceRelation
  strength: number // 0-1
}

export interface EvidenceGraph {
  nodes: EvidenceNode[]
  edges: EvidenceEdge[]
}

export interface DifferentialDiagnosis {
  diagnosis: string
  evidence_for: string[]
  evidence_against: string[]
  confidence: number
}

export type UncertaintyType =
  | 'distribution_shift'
  | 'insufficient_evidence'
  | 'model_limitation'
  | 'ambiguous_morphology'
  | 'evidence_conflict'
export type RecommendedAction = 'request_human' | 'inspect_more' | 'query_database' | 'verify_region'

export interface Uncertainty {
  type: UncertaintyType
  recommended_action: RecommendedAction
}

export interface Report {
  primary_diagnosis: string
  confidence: number
  differential: DifferentialDiagnosis[]
  evidence_graph: EvidenceGraph
  uncertainty?: Uncertainty
}

/** analyze_evidence 的中间产物，供 counterfactual / generate_report 复用 */
export interface Analysis {
  diagnosis: string
  confidence: number
  differential: DifferentialDiagnosis[]
  primaryNodeId: string
  /** 反对主诊断的可投票证据数（generate_report 据此触发 evidence_conflict 不确定性） */
  againstCount: number
  /** 矛盾检测：是否有证据方向与主诊断相反；contradiction_nodes 供报告显式标注"VLM/描述与主诊断矛盾" */
  contradiction: boolean
  contradiction_nodes?: { id: string; tool: string; claim: string; confidence: number }[]
  /** 形态学金标准反向：真实 describe_patch 判断与主诊断相反（应保守处理，不强行断言主诊断） */
  morphology_against?: boolean
}

// ============ 能力库 ============
/** 特征规格：定义该能力模型吃的 patch/特征协议。注册表驱动——换提取器/规格只加条目。 */
export interface FeatureSpec {
  extractor: string // 'conch_ViT-B-16' 等；桥端按此选编码器
  patch_size: number // 256（level0 直切边长）
  magnification: number // 标称倍率 20（STREAM 训练规格）
  dim: number // 特征维（512）
  normalize: string // 'ln_contrast_raw' = encode_image(normalize=False, proj_contrast=False)
  max_patches: number // 全片组织 patch 采样上限（性能控制）
}

export interface Capability {
  id: string
  cancer: Cancer
  task: Task
  source: 'local' | 'public' | 'remote'
  model_arch: string
  model_path: string
  metadata_path: string
  feature_dim: number
  num_classes: number
  labels: string[]
  /** 该能力的特征抽取规格（决定在线如何把任意 WSI 转特征喂给权重）。mock 条目可缺省（不调 bridge）。 */
  feature_spec?: FeatureSpec
}

// ============ 工具元数据 ============
export type ToolCategory = 'acquisition' | 'perception' | 'reasoning' | 'knowledge' | 'verification' | 'output'

export interface ToolMetadata {
  category: ToolCategory
  cacheable: boolean
  idempotent: boolean
  /** 同参不同果：VLM 采样类工具即使 `idempotent:true`（多次调用不改变世界状态），
   *  重复**采样**仍有诊断价值，故不得被重复检测拦截。`governance.ts` 的策略硬规则据此把
   *  `block` 降级为 `hint`——这是「幂等」与「可重复」不是一回事的落点。 */
  nonDeterministic?: boolean
  /** 覆写重复策略（缺省按 `governance.ts` 的 REPEAT_POLICY 表推导，未登记工具一律 hint）。 */
  repeatPolicy?: 'block' | 'hint' | 'exempt'
  depends_on?: string[]
  /** 单次工具调用墙钟预算（ms）；缺省取 PATHASK_TOOL_TIMEOUT_MS 或 300_000。
   *  **超时是「抓死锁」而非「压性能」**（合法慢路径真实存在）。 */
  timeoutMs?: number
}

// ============ 工具错误分类 ============
/** 工具失败的**统一 code 空间**。这里一处定义，供 classifyToolError 分类 + softError 生成 + 账本/指标统计。 */
export type ToolErrorCode =
  // —— 参数/引用类（模型可自我纠正）——
  | 'SLIDE_NOT_FOUND'
  | 'REGION_NOT_FOUND'
  | 'REGION_REQUIRED'
  | 'DEGENERATE_REGION'
  | 'PATCH_NOT_FOUND'
  | 'CASE_NOT_FOUND'
  | 'NO_ROI'
  // —— 前置未满足（模型应先调别的工具）——
  | 'NO_EVIDENCE'
  | 'NO_PRIOR_ANALYSIS'
  // —— WSI 桥接（基础设施）——
  | 'BRIDGE_UNAVAILABLE'
  | 'BRIDGE_TIMEOUT'
  | 'BRIDGE_HTTP'
  // —— 病理 VLM ——
  | 'VLM_TIMEOUT'
  | 'VLM_UNREACHABLE'
  | 'VLM_HTTP'
  | 'VLM_EMPTY'
  | 'VLM_DEGENERATE'
  // —— 决策 LLM ——
  | 'LLM_MISSING_KEY'
  | 'LLM_TIMEOUT'
  | 'LLM_UNREACHABLE'
  | 'LLM_HTTP'
  | 'LLM_EMPTY'
  | 'LLM_BAD_JSON'
  // —— 流程/能力配置 ——
  | 'CAPABILITY_INVALID'
  // —— 工具预算与中止 ——
  | 'TOOL_TIMEOUT'
  | 'ABORTED'
  | 'UNKNOWN'

/** 工具失败账本条目（session.toolErrors） */
export interface ToolErrorRecord {
  toolCallId: string
  tool: string
  code: ToolErrorCode
  /** 原始异常 message（诊断用；模型看到的是结构化文本，不是这个） */
  message: string
  atMs: number
  elapsedMs?: number
  /** 工具中断时已保留/已完成的进度（k/n），n 由工具经 ctx.onUpdate 上报（缺省只报 k） */
  partial?: { done: number; total?: number }
}

// ============ 会话 ============
export interface KnowledgeEntry {
  id: string
  topic: string
  content: string
  keywords: string[]
  /** 条目所属癌种；'generic' = 通用形态标准（适用于任意癌种）。query_knowledge 据此做癌种过滤。 */
  cancer?: Cancer | 'generic'
}

export interface SimilarCaseRecord {
  id: string
  case_id: string
  diagnosis: string
  subtype?: string
  embedding: number[]
  /** 检索时计算：查询 embedding 与索引的余弦相似度 */
  similarity?: number
  /** 该相似病例所属癌种（retrieve_similar_case 按当前切片癌种过滤，防跨癌种污染） */
  cancer?: string
  /** 案例库来源（private / public_tcga / tum_uterus / bracs_breast / histai_benign 等） */
  source?: string
}

export interface OverviewCache {
  slide_id: string
  case_id: string
  thumbnail: string // data-uri 占位
  tissue_coverage: number
  overview_text: string
  wsi_path?: string
  /** `scan_overview` **首次返回给模型的完整文本**（含 `(真实 OpenSlide)` 之类的来源前缀）。
   *  缓存读路径原样吐回它，而不是照着上面几个字段重新拼一遍——重新拼就是第二套渲染逻辑，
   *  两处迟早不一致。 */
  result_text?: string
}

/** describe_patch 会话级结果缓存（幂等：同一 patch 已描述则跳过 VLM，防反复 describe 烧成本/叠证据）。 */
export interface DescribeCacheEntry {
  claim: string
  label: string
  confidence: number
  vlm: boolean
  raw?: string
  /** 生成这条 claim 时用的 `question`（它直接进 VLM prompt，是 claim 的生成条件）。
   *  不存就无法在命中时判断「这条描述是否答非所问」——旧条目没有它，缺省按"同问"处理（即复用）。 */
  question?: string
}

export interface PathAskSession {
  currentWsiId: string
  evidenceStore: EvidenceStore
  wsiCache: Map<string, OverviewCache>
  patchCache: Map<string, PatchRef[]>
  /** describe_patch 幂等缓存：key=patch.id（已归一化），命中则直接复用结果、不再调 VLM。 */
  describeCache?: Map<string, DescribeCacheEntry>
  /** detect_roi 的候选 ROI 缓存（key=已解析 slide_id）。inspect_region 用 region_ref 从这里确定性取坐标，
   *  勿让 LLM 手抄 x/y/w/h/magnification 六字段。 */
  roiCache?: Map<string, Region[]>
  /** 会话级性能/成本指标（runner 工具事件 + streamFn usage 写入） */
  metrics: SessionMetrics
  capabilityRegistry: Map<string, Capability>
  clinicalData: Record<string, Record<string, string>>
  knowledgeBase: KnowledgeEntry[]
  similarCaseIndex: SimilarCaseRecord[]
  /** 真实 WSI 注册表（wsilist.json）；mock 会话为空 Map */
  wsiRegistry: Map<string, WsiEntry>
  /** WSI 桥接客户端；无真实 WSI 时可为 null */
  wsiClient: WsiClient | null
  currentReport?: Report
  currentAnalysis?: Analysis
  /** 当前病例的阅片问题（决策层/反事实需要病例上下文；runQuestion 写入） */
  currentQuestion?: string
  /** 工具失败账本：makeTool 的 catch 与 softError 逐条追加。 */
  toolErrors: ToolErrorRecord[]
  /** 瞬时故障重试预算：病例级令牌桶，只被「超时/连不上」类失败消耗
   *  （语义类错误如 PATCH_NOT_FOUND **不设上界**，见 TRANSIENT_CODES 的注释）。懒初始化。 */
  retryBudget?: RetryBudget
  /** 循环治理台账：逐调用的指纹/重复序/证据增量。懒初始化——
   *  钩子挂在 Agent 上而 Agent 在 runQuestion 之外构造，故不能放 runQuestion 闭包。 */
  loopLedger?: LoopLedger
}

/** 瞬时故障令牌桶状态。`spent` 是观测值，`remaining` 是给模型看的数。 */
export interface RetryBudget {
  remaining: number
  spent: number
  byCode: Record<string, number>
}
