import { Type } from 'typebox'
import type { Static } from '@earendil-works/pi-ai'
import type { Cancer, DifferentialDiagnosis, EvidenceNode } from '../types'
import { spectrumFor, resolveDiagnosis, type SpectrumEntry } from '../data/diagnosisSpectrum'
import { addEvidence, evidenceConfidence, isVoteEvidence, type ToolSpec, type ToolExecuteCtx } from './common'
import type { Capability } from '../types'
import { fetch } from 'undici'
import { QWEN3_8B } from '../loop/siliconflowStreamFn'
import { llmApiKey, llmProxyAgent, llmTimeoutMs, thinkingFields } from '../util/llmEndpoint'
import { resilient } from '../util/resilience'

/** 部位先验：slide 癌种 → 合理诊断候选。VLM 只看形态、不知道标本部位
 *  （卵巢标本的"腺管/浸润"形态会被误判乳腺 IDC）→ 匹配癌种的诊断加分，不匹配扣权。
 *  部位先验是轻量偏置，不绝对（乳腺可转移至卵巢等仍靠形态强证据翻盘）。 */
const SITE_BONUS = 2
const SITE_PENALTY = 4
const CANCER_DIAGNOSIS: Record<string, string[]> = {
  breast: ['浸润性导管癌（IDC）', '浸润性小叶癌（ILC）', '导管原位癌（DCIS）', '腺样囊性癌', '良性/反应性病变'],
  phyllodes: ['叶状肿瘤（Phyllodes）', '良性/反应性病变'],
  ovary: ['卵巢癌（HGSC）', '良性/反应性病变'],
  thyroid: ['甲状腺病变', '良性/反应性病变'],
  lung: ['肺腺癌', '小细胞癌（SCLC）', '良性/反应性病变'],
  prostate: ['前列腺腺癌（腺泡腺癌）', '前列腺增生（良性）', '良性/反应性病变'],
  colon: ['结肠腺癌', '管状腺瘤（良性）', '溃疡性结肠炎（良性）', '良性/反应性病变'],
  stomach: ['胃腺癌', '慢性胃炎（良性）', '良性/反应性病变'],
  brain: ['星形细胞瘤（胶质瘤）', '良性/反应性病变'],
  soft_tissue: ['脂肪肉瘤', '良性/反应性病变'],
  pancreas: ['胰腺导管腺癌', '良性/反应性病变'],
  bladder: ['膀胱尿路上皮癌', '良性/反应性病变'],
  endometrium: ['子宫内膜样腺癌', '良性/反应性病变'],
  lymph: ['淋巴瘤', '良性/反应性病变'],
  skin: ['皮肤癌', '良性/反应性病变'],
  kidney: ['肾细胞癌', '良性/反应性病变'],
  liver: ['肝细胞癌', '良性/反应性病变'],
  esophagus: ['食管癌', '良性/反应性病变'],
  cervix: ['宫颈癌', '良性/反应性病变'],
  testis: ['睾丸生殖细胞肿瘤', '良性/反应性病变'],
  bile_duct: ['胆管癌', '良性/反应性病变'],
  head_neck: ['头颈部癌', '良性/反应性病变'],
  mesothelium: ['间皮瘤', '良性/反应性病变'],
}

/** 诊断 → 部位（确定性）。null=无固有部位（良性/反应性、转移性癌、淋巴瘤、SCLC、腺样囊性癌……），
 *  这类诊断可与任意切片部位共存，鉴别时一律放行。显式表覆盖全部 DIAGNOSIS_RULES 诊断名（权威）；
 *  未命中走 SITE_KEYWORDS 正则兜底（LLM 自由文本诊断名）；仍不命中 → null（宁放行不误杀，保召回）。 */
const DIAGNOSIS_SITE: Record<string, Cancer | null> = {
  '叶状肿瘤（Phyllodes）': 'phyllodes', '小细胞癌（SCLC）': null, '浸润性小叶癌（ILC）': 'breast',
  '浸润性导管癌（IDC）': 'breast', '导管原位癌（DCIS）': 'breast', '卵巢癌（HGSC）': 'ovary',
  '甲状腺病变': 'thyroid', '腺样囊性癌': null, '前列腺腺癌（腺泡腺癌）': 'prostate', '胰腺导管腺癌': 'pancreas',
  '膀胱尿路上皮癌': 'bladder', '子宫内膜样腺癌': 'endometrium', '星形细胞瘤（胶质瘤）': 'brain',
  '脂肪肉瘤': 'soft_tissue', '结肠腺癌': 'colon', '胃腺癌': 'stomach', '肺腺癌': 'lung', '淋巴瘤': null,
  '肾细胞癌': 'kidney', '肝细胞癌': 'liver', '转移性癌': null, '管状腺瘤（良性）': 'colon',
  '慢性胃炎（良性）': 'stomach', '溃疡性结肠炎（良性）': 'colon', '前列腺增生（良性）': 'prostate',
  '良性/反应性病变': null,
}

/** 部位关键词（正则兜底）：只放无歧义的器官专有词。裸「腺瘤/癌/乳头状/背靠背/腺体拥挤」这类跨器官形态词
 *  一律不放——它们正是 DIAGNOSIS_RULES.卵巢癌 规则里串位的来源，绝不能用于部位判定。 */
const SITE_KEYWORDS: Record<Exclude<Cancer, 'unknown'>, RegExp> = {
  breast: /乳腺|breast/, phyllodes: /叶状|phyllodes/, ovary: /卵巢|ovarian|高级别浆液|hgsc/,
  colon: /结肠|结直肠|直肠|colon|colorectal|克罗恩|crohn|溃疡性结肠|缺血性结肠|感染性结肠|锯齿|sessile serrated/,
  stomach: /胃|gastric|stomach|幽门|贲门/, endometrium: /子宫内膜|endometri/, lung: /肺|pulmonary|lung/,
  thyroid: /甲状腺|thyroid/, prostate: /前列腺|prostat/, pancreas: /胰腺|pancreat/, bladder: /膀胱|尿路上皮|urothel/,
  brain: /星形细胞|胶质|astrocytom|oligodendro/, soft_tissue: /肉瘤|脂肪|liposarcom|平滑肌|横纹肌/,
  kidney: /肾|renal/, liver: /肝|hepat|hcc/, esophagus: /食管|esoph/, cervix: /宫颈|子宫颈|cervic/,
  testis: /睾丸|testic|生殖细胞/, bile_duct: /胆管|bile/, head_neck: /头颈|head|口腔|喉|咽/,
  mesothelium: /间皮|mesothel/, skin: /皮肤|skin|黑色素/, lymph: /淋巴|lymphoma|dlbcl/,
}

function siteOfDiagnosis(name: string): Cancer | null {
  const n = name.trim()
  const explicit = DIAGNOSIS_SITE[n]
  if (explicit !== undefined) return explicit              // 权威表命中（含 null=中性）即返回
  for (const [organ, re] of Object.entries(SITE_KEYWORDS) as [Cancer, RegExp][]) if (re.test(n)) return organ
  return null                                              // 无法确定 → 中性放行
}

/** 部位感知软门：仅当「无部位约束(cancer 未知→惰性)」或「该诊断无固有部位」或「部位==切片癌种」时放行；
 *  部位不同则丢弃。 */
function organGated(diagnosis: string, cancer: Cancer | undefined): boolean {
  if (!cancer) return true
  const site = siteOfDiagnosis(diagnosis)
  return site === null || site === cancer
}

/** 该器官的完整疾病谱（宽候选参考）：所有部位匹配该器官、或部位中立（无固有部位）的 DIAGNOSIS_RULES 诊断名。
 *  ≠ CANCER_DIAGNOSIS 的 curated 短名单（2-4 项）。作为 organHint 注入，让决策 LLM 见到器官的广谱可能空间
 *  而非答案小抄，再凭证据收敛到 1-3 项（配合 DECISION_SYSTEM 规则 #4 "只列证据支持项/宁少不凑"）。
 *  顺序 = 部位匹配项在前（DIAGNOSIS_RULES 声明序）、部位中立项垫后，稳定可复现。 */
function organSpectrum(cancer: Cancer | undefined): string[] {
  if (!cancer) return []
  const match: string[] = []
  const neutral: string[] = []
  const seenM = new Set<string>()
  const seenN = new Set<string>()
  for (const r of DIAGNOSIS_RULES) {
    const name = r.diagnosis.trim()
    const site = siteOfDiagnosis(name)
    if (site === null) {
      if (!seenN.has(name)) { seenN.add(name); neutral.push(name) }
    } else if (site === cancer) {
      if (!seenM.has(name)) { seenM.add(name); match.push(name) }
    }
  }
  return [...match, ...neutral]
}

/** 部位先验调整：诊断匹配 slide 癌种 → +SITE_BONUS；癌种已知且不匹配 → −SITE_PENALTY。 */
function siteAdjust(diagnosis: string, cancer: Cancer | undefined): number {
  if (!cancer) return 0
  const allowed = CANCER_DIAGNOSIS[cancer]
  if (!allowed) return 0
  return allowed.includes(diagnosis) ? SITE_BONUS : -SITE_PENALTY
}

/** 诊断候选规则：positive 命中加权支持；negative 命中强反对（否定优先，词序排正则前）。
 *  特异性词 weight 更高（"叶状"/"小细胞"比泛词"浸润性生长"特异）。 */
interface DiagnosisRule {
  diagnosis: string
  positive: RegExp[]
  negative: RegExp[]
  weight: number
}

export const DIAGNOSIS_RULES: DiagnosisRule[] = [
  {
    diagnosis: '叶状肿瘤（Phyllodes）',
    positive: [/叶状肿瘤/, /phyllodes/, /梭形细胞肉瘤/, /叶状肿瘤型/],
    negative: [/未见叶状/, /非叶状/, /除外叶状/, /no phyllodes/, /not phyllodes/, /纤维腺瘤/],
    weight: 2,
  },
  {
    diagnosis: '小细胞癌（SCLC）',
    positive: [/小细胞癌/, /小细胞/, /镶嵌样/, /栅栏样/, /核质比高/, /片状深染/, /small cell/, /scnc/, /sclc/],
    negative: [/未见小细胞/, /排除小细胞/],
    weight: 3,
  },
  {
    diagnosis: '浸润性小叶癌（ILC）',
    positive: [/小叶癌/, /条索样/, /单列样/, /靶环/, /印戒/, /invasive lobular/, /lobular carcinoma/, /infiltrating lobular/],
    negative: [/未见小叶癌/, /未见浸润/, /无浸润/],
    weight: 3,
  },
  {
    diagnosis: '浸润性导管癌（IDC）',
    positive: [/浸润性导管/, /导管癌/, /invasive ductal/, /ductal carcinoma/, /ductal adenocarcinoma/, /ductal invasive/, /基底膜局部断裂/],
    negative: [/未见浸润/, /无间质浸润/, /无浸润/, /基底膜完整/, /推挤性边界/, /未见浸润性/, /no invasion/, /intact basal/, /no evidence of invasion/],
    weight: 2,
  },
  {
    diagnosis: '导管原位癌（DCIS）',
    positive: [/原位癌/, /导管内异型/, /导管内/, /粉刺样/, /intraductal/, /dcis/],
    negative: [/浸润性/, /间质浸润/, /invasive/],
    weight: 2,
  },
  {
    diagnosis: '卵巢癌（HGSC）',
    positive: [/卵巢/, /高级别浆液/, /浆液性癌/, /乳头状.{0,6}癌/, /ovarian/, /hgsc/, /子宫内膜/, /endometri/, /背靠背/, /腺体拥挤/],
    negative: [/未见卵巢/, /非卵巢/],
    weight: 2,
  },
  {
    diagnosis: '甲状腺病变',
    positive: [/甲状腺/, /滤泡/, /乳头状癌/, /甲状腺乳头状/, /bethesda/, /thyroid/, /follicular/],
    negative: [/未见甲状腺/, /非甲状腺/],
    weight: 2,
  },
  {
    diagnosis: '腺样囊性癌',
    positive: [/腺样囊性/, /筛孔/, /圆柱/, /adenoid cystic/, /cribriform/],
    negative: [/未见腺样囊性/, /除外腺样囊性/],
    weight: 2,
  },
  {
    diagnosis: '前列腺腺癌（腺泡腺癌）',
    positive: [/前列腺腺癌/, /前列腺癌/, /prostat\w* (carcinoma|adenocarcinoma)/, /prostatic (carcinoma|adenocarcinoma)/, /gleason/, /前列腺/],
    negative: [/未见前列腺癌/, /排除前列腺癌/],
    weight: 3,
  },
  {
    diagnosis: '胰腺导管腺癌',
    positive: [/胰腺导管腺癌/, /胰腺癌/, /pancreat\w* (carcinoma|adenocarcinoma)/, /pancreatic ductal/],
    negative: [/未见胰腺癌/],
    weight: 3,
  },
  {
    diagnosis: '膀胱尿路上皮癌',
    positive: [/尿路上皮癌/, /膀胱癌/, /urothel\w* carcinoma/, /膀胱尿路上皮/],
    negative: [/未见膀胱癌/, /未见尿路上皮癌/],
    weight: 3,
  },
  {
    diagnosis: '子宫内膜样腺癌',
    positive: [/子宫内膜样腺癌/, /子宫内膜癌/, /endometrioid adenocarcinoma/, /子宫内膜/],
    negative: [/未见子宫内膜癌/],
    weight: 3,
  },
  {
    diagnosis: '星形细胞瘤（胶质瘤）',
    positive: [/星形细胞瘤/, /胶质瘤/, /astrocytom/, /胶质/, /oligodendroglioma/],
    negative: [/未见星形细胞瘤/, /非胶质瘤/],
    weight: 3,
  },
  {
    diagnosis: '脂肪肉瘤',
    positive: [/脂肪肉瘤/, /liposarcoma/, /去分化肉瘤/],
    negative: [/未见脂肪肉瘤/],
    weight: 3,
  },
  {
    diagnosis: '结肠腺癌',
    positive: [/结肠腺癌/, /结直肠癌/, /结肠癌/, /colorect\w* (carcinoma|adenocarcinoma)/, /colon\w* (carcinoma|adenocarcinoma)/, /结直肠腺癌/],
    negative: [/未见结肠癌/, /非结肠来源/],
    weight: 3,
  },
  {
    diagnosis: '胃腺癌',
    positive: [/胃腺癌/, /胃癌/, /gastric\w* (carcinoma|adenocarcinoma)/, /stomach\w* (carcinoma|adenocarcinoma)/],
    negative: [/未见胃癌/],
    weight: 3,
  },
  {
    diagnosis: '肺腺癌',
    positive: [/肺腺癌/, /lung (adeno)?carcinoma/, /pulmonary (adeno)?carcinoma/, /lepidic/, /贴壁生长/, /支气管肺泡癌/, /bronchioloalveolar/],
    negative: [/未见肺腺癌/, /非肺腺癌/, /小细胞/, /small cell/],
    weight: 3,
  },
  {
    diagnosis: '淋巴瘤',
    positive: [/淋巴瘤/, /lymphoma/, /弥漫大.?b/, /dlbcl/],
    negative: [/未见淋巴瘤/, /排除淋巴瘤/],
    weight: 3,
  },
  {
    diagnosis: '肾细胞癌',
    positive: [/肾细胞癌/, /肾癌/, /renal cell carcinoma/, /透明细胞癌/],
    negative: [/未见肾癌/],
    weight: 3,
  },
  {
    diagnosis: '肝细胞癌',
    positive: [/肝细胞癌/, /肝癌/, /hepatocellular carcinoma/, /\bhcc\b/],
    negative: [/未见肝癌/],
    weight: 3,
  },
  {
    diagnosis: '转移性癌',
    positive: [/转移性癌/, /转移癌/, /metastatic (carcinoma|tumor|neoplasm)/, /转移/],
    negative: [/无转移/, /未见转移/],
    weight: 2,
  },
  {
    diagnosis: '管状腺瘤（良性）',
    positive: [/管状腺瘤/, /tubular adenoma/, /腺瘤/],
    negative: [/癌/, /恶性/, /浸润性/],
    weight: 2,
  },
  {
    diagnosis: '慢性胃炎（良性）',
    positive: [/慢性胃炎/, /胃炎/, /胃窦炎/, /gastritis/, /胃黏膜/],
    negative: [/癌/, /恶性/, /异型（?多）?/],
    weight: 2,
  },
  {
    diagnosis: '溃疡性结肠炎（良性）',
    positive: [/溃疡性结肠炎/, /ulcerative colitis/],
    negative: [/癌/, /恶性/],
    weight: 2,
  },
  {
    diagnosis: '前列腺增生（良性）',
    positive: [/前列腺增生/, /glandular.?stromal hyperplasia/, /prostatic hyperplasia/, /\bbph\b/],
    negative: [/癌/, /恶性/, /asap/],
    weight: 2,
  },
  {
    diagnosis: '良性/反应性病变',
    positive: [/良性/, /反应性/, /细胞温和/, /未见异型/, /未见异型性/, /基底膜完整/, /推挤性边界/, /无浸润/, /纤维上皮/, /未见癌/, /intact/, /no evidence of/, /benign/, /reactive/, /Benign lesion/, /良性病变/, /纤维腺瘤/, /fibroadenoma/],
    negative: [/恶性/, /癌/, /异型细胞巢/, /间质见异型/, /浸润性生长/, /malignant/, /carcinoma/, /invasion/],
    weight: 3,
  },
]

/** 通用恶性信号池：剥离自各癌种规则的"通用浸润癌形态词"（任何恶性上皮肿瘤都会出现，
 *  "stromal invasion/infiltrative/异型细胞巢"不能单独指向 IDC）→ 作为共享分加给所有恶性候选。
 *  癌种间排序由【特异词 + 部位先验】决定，通用信号只抬升"恶性 vs 非恶性"的门槛、不偏向具体癌种。
 *  良性/反应性规则不加（良性靠"无恶性特征"的特异否定信号，见 ruleMatch 的 negative 分支）。 */
const GENERIC_MALIGNANT: RegExp[] = [
  /浸润性生长/, /浸润性癌/, /浸润癌/, /间质见异型细胞巢/, /异型细胞巢/, /异型性/, /恶性/,
  /malignant/, /malignancy/, /carcinoma/, /neoplastic/, /atypia/, /atypical cells/,
  /invasive growth/, /invasive carcinoma/, /stromal invasion/, /infiltrat/, /desmoplastic/, /tumor cell/,
]
function genericScore(blob: string): number {
  const lower = blob.toLowerCase()
  let score = 0
  for (const re of GENERIC_MALIGNANT) {
    for (const m of lower.matchAll(new RegExp(re.source, 'g'))) {
      if (m.index !== undefined && !isNegated(lower, m.index)) score += 1
    }
  }
  return score
}

/** 部位默认：部位已知 + 有通用恶性信号 → 该部位最常见恶性诊断额外加分。
 *  临床逻辑：病理医生见到乳腺浸润癌默认先考虑 IDC、卵巢默认 HGSC，特异形态再细分亚型。 */
const DEFAULT_MALIGNANT_BONUS = 4

/** 主诊断是肿瘤性诊断、而某条证据强命中「良性/反应性病变」正向（如"Benign lesion: Fibrous histiocytoma"）
 *  → 该证据反对主诊断。阈值 2。 */
const BENIGN_AGAINST_THRESHOLD = 2

/** run_mil 预测类别 → 主诊断方向（能力语义）。
 *  - 分子分类器（tp53/hrd，labels 无良性/恶性/交界语义）→ 无诊断方向；
 *  - 肿瘤分型分类器（phyllodes-tumor）：良性类 → 支持良性主诊断 / 反对肿瘤性主诊断；
 *    肿瘤性类（malignant/borderline 等）→ 支持该癌种肿瘤性主诊断 / 反对良性主诊断。 */
function milPolarityOf(
  node: EvidenceNode,
  primary: string,
  cancer: Cancer | undefined,
  cap: Capability | undefined,
): 'support' | 'against' | undefined {
  if (!cap || cap.cancer !== cancer) return undefined // 分类器必须匹配当前 slide 癌种，否则标签无该癌种诊断语义
  const isTumorType = cap.labels.some((l) => /benign|malignant|borderline|tumor/i.test(l))
  if (!isTumorType) return undefined
  const label = (node.source.label ?? '').toLowerCase()
  if (!label) return undefined
  if (label.includes('benign')) return primary === '良性/反应性病变' ? 'support' : 'against'
  return primary === '良性/反应性病变' ? 'against' : 'support'
}

/** describe_patch 5-label → 注入投票 blob 的文档 token（让现有 DIAGNOSIS_RULES 直接对该 label 投票）。
 *  只认 describe_patch 的 morph_label（与 run_mil 的 source.label 用 capability_id 区分，互不串）。 */
function labelDocToken(label: string | undefined): string {
  switch (label) {
    case 'malignant': return '恶性 浸润癌 异型细胞巢'
    case 'premalignant': return '原位癌 导管内异型 异型增生'
    case 'benign': return '良性 反应性 细胞温和 无浸润'
    case 'normal': return '正常组织 无异常'
    default: return '' // N/A = 诚实弃权，不投任何一侧
  }
}

/** describe_patch 5-label → 相对主诊断方向（用于 contradicts 边 + morphAgainst 保守压置信）。
 *  只处理斩钉截铁的良/恶；premalignant / normal / N/A 返回 undefined（不强判，交给投票 blob 的
 *  DCIS/良性 token 与形态文本，避免"原位癌/正常"被误当成反对主诊断的强信号）。 */
function labelPolarityOf(label: string | undefined, primary: string): 'support' | 'against' | undefined {
  switch (label) {
    case 'malignant': return primary === '良性/反应性病变' ? 'against' : 'support'
    case 'benign': return primary === '良性/反应性病变' ? 'support' : 'against'
    default: return undefined
  }
}

/** 剥离 claim 中的下划线连接 id token（slide/region/patch id，如 phyllodes_int_benign_c5、
 *  patch_phyllodes_int_benign_c5_0、verify_..._40）。id 常以癌种名命名，会污染诊断规则匹配
 * （/phyllodes/ 命中 slide id "phyllodes_int_benign_c5"）→ 匹配前先清除，避免伪阳性。 */
const ID_TOKEN_RE = /[a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+/g
function stripIdTokens(text: string): string {
  return text.replace(ID_TOKEN_RE, ' ')
}

/**
 * 鉴别假设子句——形态模型在描述里列的「需鉴别于 X / 鉴别诊断：X / differential includes X / should be
 * considered X」是【排除候选/考虑项】，不是已确认发现。若把这些病名当作该癌的证据去投票/喂给决策 LLM，
 * 就形成「描述器只说一句要排除 X → 引擎把 X 认证成发现」的自证回环。
 *
 * 本函数在证据进入【决策/投票读眼】前一律先中性化：把这类假设子句替换为占位符，使其不再触发任何诊断规则。
 * 只中性化【列鉴别】标记（需鉴别/鉴别诊断/differential/considered），不碰「rule out/已排除」这类
 * 已完成的排除结论（那是真实的反-某癌信号，不应被抹掉）。
 * 子句终点口径（中文）：候选表用「、」连接，到下一个 ，；。 / 换行 即止（保住其后的真实形态；
 *  （英文）：到下个 . ; / 换行 或 转折连接词为止（differential includes A, B, and C 整段换掉）。
 * 占位符不含任何诊断规则词或否定词，ruleMatch/isNegated/genericScore 均不受影响。 */
const HYPOTHESIS_CN = /需鉴别于|需与[^，。；\n]{0,14}(?:鉴别|区分)|鉴别诊断[：: ]?|建议鉴别[：: ]?/g
const HYPOTHESIS_EN = /differential\s*(?:diagnosis|includes?|considerations?)?|\bin the differential\b|\bshould be (?:considered|distinguished|excluded)\b|\bto differentiate\b/gi
const HYPOTHESIS_CN_END = /，|；|。|\n/
const HYPOTHESIS_EN_END = /;|\.|\n|\bbut\b|\bhowever\b|\boverall\b|\bwhile\b|\bin summary\b|\band\b(?=[^,;.\n]{0,10}\b(?:overall|but)\b)/

function clinicalClaim(claim: string): string {
  const stripped = stripIdTokens(claim)
  const lower = stripped.toLowerCase()
  const spans: Array<[number, number]> = []
  const pushSpan = (m: RegExpMatchArray, endRe: RegExp): void => {
    if (m.index === undefined) return
    const start = m.index
    const seg = lower.slice(start)
    const endM = endRe.exec(seg)
    const end = endM && endM.index !== undefined ? start + endM.index : lower.length
    if (end > start && !spans.some(([s, e]) => s <= start && start < e)) spans.push([start, end])
  }
  for (const m of lower.matchAll(HYPOTHESIS_CN)) pushSpan(m, HYPOTHESIS_CN_END)
  for (const m of lower.matchAll(HYPOTHESIS_EN)) pushSpan(m, HYPOTHESIS_EN_END)
  // 从后往前替换占位，索引不漂移。占位符必须【不含】任何否定词(排除/未见/无…)或诊断规则词，
  // 否则会污染其后真词的 isNegated 判定 / 规则命中。
  let out = stripped
  for (const [s, e] of [...spans].sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, s) + ' 〔所列鉴别〕 ' + out.slice(e)
  }
  return out
}

/** 否定上下文前缀：出现在 positive 命中前（同一句内）则把该命中当作"反对"信号。
 *  病理英语常见 "lack of … invasion" / "absence of A, B, and C" / "non-infiltrative"；中文"未见/无…"。 */
const NEG_PREFIX = /(?:lack of|absence of|no |not |non-|without|未见|未发现|未显示|无|缺乏|排除|absent|denied|no evidence|free of|devoid of|exclude|excluded|excluding|rules out|rule out)/i

/** 判断 positive 命中是否被否定修饰：取命中前到最近句界（. 或换行）的片段，片段内出现否定词则被否定。
 *  用句界分隔避免长句前段无关否定（如 "No further testing is required. The intact basement…" 的 no 不误伤 intact）。 */
function isNegated(lower: string, index: number): boolean {
  const start = Math.max(0, lower.lastIndexOf('.', index), lower.lastIndexOf('\n', index))
  return NEG_PREFIX.test(lower.slice(start, index))
}

/** 对一条证据 claim 做规则判定：返回支持/反对计数（否定感知，否定之否定=支持）。
 *  positive 命中：被否定修饰（"lack of invasion"）→ 反对；否则支持。
 *  negative 命中：被否定修饰（"no invasion" = 无浸润，实为良性特征）→ 支持；否则反对。 */
export function ruleMatch(rule: DiagnosisRule, claim: string): { support: number; against: number } {
  // clinicalClaim：先中性化「需鉴别于 X / differential includes X」子句，防把假设当发现认证
  const lower = clinicalClaim(claim).toLowerCase()
  let support = 0
  let against = 0
  for (const re of rule.positive) {
    for (const m of lower.matchAll(new RegExp(re.source, 'g'))) {
      if (m.index !== undefined && isNegated(lower, m.index)) against += rule.weight * 2
      else support += rule.weight
    }
  }
  for (const re of rule.negative) {
    for (const m of lower.matchAll(new RegExp(re.source, 'g'))) {
      if (m.index !== undefined && isNegated(lower, m.index)) support += rule.weight
      else against += rule.weight * 2
    }
  }
  return { support, against }
}

/** 规则净分（投票用）：support − against。 */
function ruleScore(rule: DiagnosisRule, claim: string): number {
  const { support, against } = ruleMatch(rule, claim)
  return support - against
}

/** 鉴别证据精确摘录——取规则实际命中的短语（±短上下文），替代把整段证据文本挂到鉴别诊断
 *  （"Benign lesion: Fibrous histiocytoma"整段当 DCIS 支持证据会误导）。完整 claim 保留在证据图节点，
 *  只改 differential 的呈现字段。方向判定与 ruleMatch 同构（否定感知）。 */
function evidenceExcerpt(rule: DiagnosisRule, claim: string, ctxChars = 12, max = 3): { for: string[]; against: string[] } {
  // clinicalClaim：摘录同样先中性化假设子句，避免「需鉴别于 X」被当成对该鉴别的支持摘录
  const stripped = clinicalClaim(claim)
  const lower = stripped.toLowerCase()
  const hits: { span: string; support: boolean }[] = []
  // 命中短语回取原文（未 strip、未小写）上下文：lower 的短语通常原样存在于 claim（自然语言片段，
  // 不跨 id token），大小写不敏感检索即可；找不到时退化为短语本身。
  // 否定命中的上下文要往左多取——"no evidence of invasive" 的否定词常在 12 字窗外，
  // 只显示 "evidence of invasive" 会丢失关键语义（无浸润/无癌才是要点）。
  const pushHit = (m: RegExpMatchArray, rawPositive: boolean): void => {
    if (m.index === undefined) return
    const phrase = m[0]
    const negated = isNegated(lower, m.index)
    // 方向与 ruleMatch 同构：positive 命中未否定 → 支持；negative 命中未否定 → 反对（否定之否定=支持）
    const support = rawPositive ? !negated : negated
    const idx = claim.toLocaleLowerCase().indexOf(phrase)
    let span: string
    if (idx >= 0) {
      const left = negated ? ctxChars * 2 : ctxChars
      const start = Math.max(0, idx - left)
      const end = Math.min(claim.length, idx + phrase.length + ctxChars)
      span = claim.slice(start, end).replace(/\s+/g, ' ').trim()
    } else {
      span = phrase
    }
    hits.push({ span, support })
  }
  for (const re of rule.positive) {
    for (const m of lower.matchAll(new RegExp(re.source, 'g'))) {
      if (m.index !== undefined) pushHit(m, true)
    }
  }
  for (const re of rule.negative) {
    for (const m of lower.matchAll(new RegExp(re.source, 'g'))) {
      if (m.index !== undefined) pushHit(m, false)
    }
  }
  return {
    for: [...new Set(hits.filter((h) => h.support).map((h) => h.span))].slice(0, max),
    against: [...new Set(hits.filter((h) => !h.support).map((h) => h.span))].slice(0, max),
  }
}

/** 证据门形态证据来源工具（GATE_TOOLS）：鉴别诊断的每项必须有【真正看片】得到的形态证据支持才放行，
 *  防回答泄露（LLM 凭空列的诊断名不被当成发现认证）。
 *  - describe_patch / verify_region / run_mil = 实际观察切片的形态证据；
 *  - query_knowledge / retrieve_similar_case = 知识/检索背景（含诊断名、是二次注入源）→ 天然排除，
 *    它们的「知识」代表"这个病该怎么鉴别的标准"而非"当前切片有这个形态"。
 *  - scan_overview / detect_roi / inspect_region = 导航/选样，不含形态学诊断判断 → 排除（避免"覆盖率"当证据）。 */
const GATE_TOOLS = new Set(['describe_patch', 'verify_region', 'run_mil'])

/** 诊断谱条目的正性形态证据签名命中：claim 经 clinicalClaim 中性化「需鉴别于X」后，
 *  evToken 在子句内命中且未被否定修饰 → 支持。刻意不豁免「cannot exclude invasive carcinoma」
 *  （那正是要拦的自证，靠 isNegated 的 NEG_PREFIX 覆盖 cannot exclude）。 */
export function spectrumSupport(entry: SpectrumEntry, claims: string[]): { ok: boolean; excerpts: string[] } {
  const excerpts: string[] = []
  let ok = false
  for (const c of claims) {
    const raw = clinicalClaim(c)
    const lower = raw.toLowerCase()
    for (const tok of entry.evTokens) {
      const t = tok.toLowerCase()
      let idx = lower.indexOf(t)
      while (idx >= 0) {
        if (!isNegated(lower, idx)) {
          ok = true
          const start = Math.max(0, idx - 12)
          const end = Math.min(raw.length, idx + t.length + 12)
          excerpts.push(raw.slice(start, end).replace(/\s+/g, ' ').trim())
          break
        }
        idx = lower.indexOf(t, idx + 1)
      }
    }
  }
  return { ok, excerpts: [...new Set(excerpts)].slice(0, 3) }
}

interface DiagnosisCandidate {
  rule: DiagnosisRule
  diagnosis: string
  score: number
  evidenceFor: string[]
  evidenceAgainst: string[]
}

/** 聚合所有 observation/inference 证据，投票出主诊断 + 鉴别诊断候选 + 每条证据对主诊断的方向。
 *  知识条目（query_knowledge）是"背景参考"而非"病例观察"——其文本（如"恶性叶状还可见…/有无异源性"）
 *  是鉴别标准的举例，不构成当前病例的诊断信号，故不参与投票（但保留在证据图作参考）。 */
function voteDiagnoses(
  obs: EvidenceNode[],
  cancer: Cancer | undefined,
  capabilityRegistry: Map<string, Capability>,
): {
  primary: string
  candidates: DiagnosisCandidate[]
  polarityOf: (node: EvidenceNode) => 'support' | 'against' | undefined
} {
  // 只投「可投票证据」（observation + run_mil inference）。剔除 analyze_evidence / counterfactual 生成的
  // 聚合推理节点（上一轮"综合推断/诊断"文本自引用 → 诊断被自锁），也剔除 query_knowledge / retrieve_similar_case
  // 背景参考（相似病例文本里含诊断名如"叶状肿瘤-Borderline"，会被规则误当成当前病例形态证据）。
  const caseObs = obs.filter(isVoteEvidence)
  // describe_patch 的 5-label 注入 blob（现有规则直接投票）。claim 仍是纯形态文本（GT 合规、作摘录），
  // label 是独立的结构化方向信号——二者分工：claim 提供"为什么/哪句"的可追溯摘录，label 提供"该块属于哪类"的判断。
  const blob = caseObs
    .map((n) => {
      const base = clinicalClaim(n.claim)
      const tok = n.source.tool === 'describe_patch' ? labelDocToken(n.source.morph_label) : ''
      return tok ? `${base}\n${tok}` : base
    })
    .join('\n')
  const g = genericScore(blob)
  const scores = DIAGNOSIS_RULES.map((rule) => {
    // 部位先验：形态票 + 癌种偏置（卵巢标本的 IDC 形态票被扣权，需形态强证据才翻盘）
    const adj = siteAdjust(rule.diagnosis, cancer)
    // 通用恶性信号：恶性候选共享（不偏向癌种）；良性规则不加（良性靠"无恶性特征"的否定信号）
    const generic = rule.diagnosis === '良性/反应性病变' ? 0 : g
    // 部位默认：部位已知 + 恶性信号 → 该部位首选癌种加分（乳腺→IDC、卵巢→HGSC）
    const siteDefault = generic > 0 && cancer && CANCER_DIAGNOSIS[cancer]?.[0] === rule.diagnosis ? DEFAULT_MALIGNANT_BONUS : 0
    return { rule, score: ruleScore(rule, blob) + generic + adj + siteDefault }
  })

  const candidates: DiagnosisCandidate[] = scores
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ rule, score }) => {
      // 只挂实际命中的短语（±上下文），不挂整段证据文本（否则整段良性文本会被当成恶性候选的"支持"）
      const { for: forHits, against: againstHits } = caseObs.reduce(
        (acc, n) => {
          const e = evidenceExcerpt(rule, n.claim)
          acc.for.push(...e.for)
          acc.against.push(...e.against)
          return acc
        },
        { for: [] as string[], against: [] as string[] },
      )
      return { rule, diagnosis: rule.diagnosis, score, evidenceFor: forHits, evidenceAgainst: againstHits }
    })

  const primaryRule = candidates[0]
  const primary = primaryRule ? primaryRule.diagnosis : '待进一步评估（证据不足）'

  // 每条证据相对主诊断的方向：run_mil 按能力语义（预测类别）；其余命中主诊断 positive → support、
  // 命中主诊断 negative → against；强良性信号 → 反对肿瘤性主诊断。
  const polarityOf = (node: EvidenceNode): 'support' | 'against' | undefined => {
    if (!primaryRule) return undefined
    // run_mil 预测类别 → 诊断方向
    if (node.source.tool === 'run_mil' && node.source.capability_id) {
      const cap = capabilityRegistry.get(node.source.capability_id)
      const milPol = milPolarityOf(node, primary, cancer, cap)
      if (milPol) return milPol
    }
    // describe_patch 5-label 明确方向——形态学文本未必含规则关键词（"核多形性/巢状"不含 IDC 特异词），
    // 斩钉截铁的良/恶 label 直接裁定方向（优先于文本匹配），premalignant/normal/N/A 交回文本匹配。
    if (node.source.tool === 'describe_patch' && node.source.morph_label) {
      const lab = labelPolarityOf(node.source.morph_label, primary)
      if (lab) return lab
    }
    const { support, against } = ruleMatch(primaryRule.rule, node.claim)
    if (against > 0) return 'against' // 否定优先：被否定的 positive 或显式 negative 都是反对主诊断的信号
    if (support > 0) return 'support'
    // 主诊断是肿瘤性诊断，但该证据强命中「良性/反应性病变」正向（"Benign lesion: …"）→ 反对主诊断。
    // 这让 VLM 的良性描述以 1−conf 计入聚合、形成 contradicts 边，而不是中性全置信计入 + supports 边。
    if (primary !== '良性/反应性病变') {
      const benignRule = DIAGNOSIS_RULES.find((r) => r.diagnosis === '良性/反应性病变')!
      if (ruleMatch(benignRule, node.claim).support >= BENIGN_AGAINST_THRESHOLD) return 'against'
    }
    return undefined
  }

  return { primary, candidates, polarityOf }
}

/** 证据驱动鉴别 = 投票候选（已由 voteDiagnoses 按 ruleScore+genericScore+部位先验打分、并按节点命中短语
 *  生成 evidenceFor/Against）经【部位门】+【证据门】过滤后的投影。
 *  - 部位门：organGated——掉落如胃切片列卵巢癌(HGSC)的跨器官诊断。
 *  - 证据门：evidenceFor 为空 = 无任何证据明确支持该诊断为"可能" → 掉，宁少不凑
 *    （只有证据反对 = 已被排除，不属于"需排除"清单）。纯通用信号垫底候选也被此门挡住。
 *  置信 = 主诊断置信 +0.15 且 ≤0.85（避免鉴别 > 主诊断的刻度别扭）。 */
function organGateCandidates(
  candidates: DiagnosisCandidate[],
  cancer: Cancer | undefined,
  primary: string,
  primaryConf: number,
  max = 3,
): DifferentialDiagnosis[] {
  const cap = Math.min(0.85, primaryConf + 0.15)
  const dds: DifferentialDiagnosis[] = []
  const seen = new Set<string>([primary])
  for (const c of candidates) {
    if (c.diagnosis === primary || seen.has(c.diagnosis) || dds.length >= max) continue
    if (!organGated(c.diagnosis, cancer)) continue              // 部位门
    if (c.evidenceFor.length === 0) continue                    // 证据门（活的可能鉴别）
    seen.add(c.diagnosis)
    dds.push({
      diagnosis: c.diagnosis,
      evidence_for: c.evidenceFor,
      evidence_against: c.evidenceAgainst,
      confidence: Math.min(cap, 0.4 + 0.15 * Math.max(0, Math.log2(1 + c.score))),
    })
  }
  return dds
}

// ============================================================================
// ⚠️ 决策层面板：PATHASK_DECISION=rule（关键词投票）| llm（LLM 诊断决策，默认）
// ============================================================================
const DECISION_MODE = (process.env.PATHASK_DECISION ?? 'llm') as 'rule' | 'llm'

/** LLM 决策的诊断输出。主诊断、聚合置信、鉴别、每条证据方向。
 *  note = LLM 的 rationale（用于报告/调试呈现，不参与结构化契约）。 */
interface LlmDecision {
  primary: string
  confidence: number
  differential: DifferentialDiagnosis[]
  polarityOf: (n: EvidenceNode) => 'support' | 'against' | undefined
  note?: string
}

/** 决策 LLM 输出（非流式 JSON）。端点默认仍是硅基流动的 `Qwen/Qwen3-8B`，可用
 *  `PATHASK_LLM_BASE_URL` 切到本地 vLLM（QWEN3_8B.baseUrl 即解析结果，两处共用一份）。
 *  必须用 undici fetch + ProxyAgent（Node 全局 fetch 不走 dispatcher，见 streamFn 注释）；
 *  但内网端点由 util/llmEndpoint 判为**不挂代理**——undici 的 ProxyAgent 不读 NO_PROXY。
 *  key 只从 env 取，不硬编码（发布去内网 IP 泄密）。 */
async function callDecisionLlm(system: string, user: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const baseUrl = QWEN3_8B.baseUrl
  const apiKey = llmApiKey(baseUrl)
  // 本分支对**内网端点不可达**（llmApiKey 对内网缺 key 返回占位 'EMPTY'），故文案保持硅基措辞：
  // toolErrors.ts 的 `/缺少 SILICONFLOW_API_KEY/` 按字面量匹配，改了会静默错分类。
  if (!apiKey) throw new Error('缺少 SILICONFLOW_API_KEY')
  const proxyAgent = llmProxyAgent(baseUrl)
  // 单次上限**随端点**（硅基 240s 是为「抽签端点」给的余量；本地 120s 已是 6.5× 余量）。
  // 与工具预算/agent 中止合成（取先到者）。仍**不自动重试**——超时即回落规则投票，行为不变。
  const llmTimeout = AbortSignal.timeout(llmTimeoutMs(baseUrl))
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: QWEN3_8B.id,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      stream: false,
      max_tokens: 4096,
      temperature: 0,
      // 与编排器同一份分派：硅基 → 顶层 enable_thinking；vLLM → chat_template_kwargs
      // （顶层对 vLLM 是空操作，会让每次决策白跑一遍思考）。
      ...thinkingFields(baseUrl, false),
    }),
    dispatcher: proxyAgent,
    signal: signal ? AbortSignal.any([signal, llmTimeout]) : llmTimeout,
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`决策 LLM HTTP ${res.status}: ${err.slice(0, 300)}`)
  }
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  const content = body.choices?.[0]?.message?.content
  if (!content) throw new Error('决策 LLM 空响应')
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`决策 LLM 非 JSON 输出: ${content.slice(0, 200)}`)
  try {
    return JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>
  } catch (e) {
    throw new Error(`决策 LLM JSON 解析失败: ${content.slice(0, 200)}`)
  }
}

function clamp01(v: unknown, d = 0.5): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : d
}

/** 把证据打包成决策 LLM 可读的病例视图（每条带 id/tool/位置/倍率/置信/形态描述）。 */
function buildEvidencePack(obs: EvidenceNode[]): string {
  const toolLabel: Record<string, string> = {
    describe_patch: '形态描述', verify_region: '高倍复核', run_mil: 'MIL热点', inspect_region: '区域观察',
  }
  return obs
    .map((n) => {
      const loc = n.source.coords ? ` [${n.source.coords.x},${n.source.coords.y},${n.source.coords.w}×${n.source.coords.h}]` : ''
      const mag = n.source.magnification ? ` @${n.source.magnification}×` : ''
      const model = n.source.model ? `/${n.source.model}` : ''
      const label = toolLabel[n.source.tool] ?? n.source.tool
      // clinicalClaim：决策 LLM 证据包同样中性化「需鉴别于X」子句——VLM 列的鉴别是推测非发现，
      // 避免 LLM 也被"一句要排除 X"认证成 X（自证回环的 LLM 侧版本）。
      return `- [${n.id}]（${label}${loc}${mag}${model}）conf=${n.confidence.toFixed(2)}：${clinicalClaim(n.claim)}`
    })
    .join('\n')
}

export const DECISION_SYSTEM = `你是病理阅片决策助手。你收到同一切片多个视野的镜下形态描述，整合后给出诊断。

【决策优先级：从上到下执行，先满足的先执行】

1. 恶性信号门（最高优先级）
   【强信号 = 结构破坏证据】浸润性生长、间质内单个/小簇异型细胞、破坏性浸润边缘、腺体/基底结构破坏、desmoplastic 间质反应、实性巢状。
   出现任一强信号 → 主诊断禁止选「良性/反应性病变」，必须从诊断谱中选一个恶性或癌前诊断；不要因"定不了具体亚型"就回退「待进一步评估」（那是逃避——强信号已锁定恶性方向，报谱内最贴的高级别/未分化/癌即可）。
   【弱信号 = 细胞学异型】核多形性、核深染、核分裂象、不规则核轮廓。
   只有弱信号、无强信号时 → 不要立即待评估：把弱信号**跨视野叠加**，若多个视野一致指向某一类病变，按第 4 条报谱内最贴诊断（方向可为良性/反应性，只要所有视野都无结构破坏、形态一致指向良性）；仅当弱信号既不足以定恶性方向、也不足以定良性方向、且无法对应到任何谱内诊断时，才按第 3 条。

2. 梭形细胞警示
   梭形细胞病变在卵巢/结肠/膀胱/软组织部位，即使被描述为"温和/无坏死/少核分裂"，也要先怀疑恶性。只有看到特异性良性特征（如成熟脂肪+毛细血管→血管脂肪瘤）才可判良性。

3. 何时才"待进一步评估"（最后手段，勿滥用）
   只有确实无法给出任何谱内诊断时才输出「待进一步评估」，置信度≤0.5：
   - 所有视野只见坏死/伪影/取材差，无有效形态
   - 弱信号不足、无法区分良性 vs 恶性 vs 癌前（跨视野判断互斥，或形态过模糊）
   不要因"有形态但怕下错"就待评估——宁可报谱内最贴的诊断（方向保守亦可），也不要空置；有结构破坏/浸润性证据时必须按第 1 条报恶性/癌前。此时 uncertainty=insufficient_evidence。

4. 从诊断谱中选主诊断
   诊断谱按常见→少见排列。优先考虑排前的常见诊断。不要照抄诊断谱，要用形态证据判断。

5. 鉴别诊断规则
   只列有明确形态证据支持、且需排除的该部位诊断（通常 1-3 项）。跨器官诊断禁止列（无固有部位的转移性癌/淋巴瘤/小细胞癌/良性反应性病变除外）。没有证据宁可不列。若主诊断是良性，鉴别中列恶性必须基于明确的恶性形态结构证据（如破坏性浸润、间质内单个异型细胞、desmoplastic 间质）。

6. 需鉴别于 X / consistent with X / differential includes X 是形态模型的推测，不是确诊证据，只能作为鉴别候选。

7. 【置信报值规范】confidence 不是你对诊断的"感觉"，而是支持该诊断的镜下形态证据强度：
   - 只有出现第 1 条强信号（浸润性生长/结构破坏/间质内单个异型细胞/desmoplastic 间质）时，confidence 才可 >0.7，且最高 0.85。
   - 仅有弱信号（核多形性/核深染/核分裂象，无结构破坏证据）时，confidence 必须 ≤0.5。
   - 不同视野描述互相矛盾、反复出现"无法确定/难以评估"、或缺乏支持当前诊断的形态证据时，confidence 必须 ≤0.5（宁可负向，勿虚报）。
   - 判「良性/反应性病变」时，若没有支持"排除恶性"的形态证据（如明确良性特征：成熟脂肪+毛细血管、完整基底膜、无浸润性边缘），confidence 不得 >0.7。
   - 任何情况 confidence 不得 >0.85——镜下形态 + 单次整合到不了"十分确定"，绝不许报 1.0 或 ≥0.9；若你确实无法确定，按第 3 条输出「待进一步评估」并给 ≤0.5。

【输出格式】严格 JSON，无包裹文本：
{"primary_diagnosis":"规范中文病种名","confidence":0到1,"uncertainty":"none|insufficient_evidence|evidence_conflict|model_limitation","differential":[{"diagnosis":"…","confidence":0到1,"note":"一句理由"}],"evidence_verdicts":[{"id":"证据id","direction":"support|against","note":"一句理由"}],"rationale":"一两句整体判断，引用具体证据"}`

/** 把决策 LLM 的原始输出（ai）加工成最终主诊断 + 证据门控的鉴别诊断（纯函数，不调 LLM）。
 *  - 主诊断：resolveDiagnosis 规范化到谱的 accept 对齐名；不在谱且部位不符 → 兜底"待进一步评估"。
 *  - 鉴别：先规范化（谱名），再【部位门 organGated】+【证据门 polarity-parity】双门；良恶性同向信任 LLM、跨向（良性主→恶性鉴）需正性形态证据，否则 drop（防回答泄露）。
 *  - candidate 兜底：organGateCandidates（已自做双门）追加 LLM 未列的确定性候选。
 *  返回 drop 计数供 note 可溯。 */
export function finalizeLlmDiagnosis(
  ai: Record<string, unknown>,
  gateClaims: string[],
  cancer: Cancer | undefined,
  candidates: DiagnosisCandidate[] = [],
): {
  primary: string
  confidence: number
  differential: DifferentialDiagnosis[]
  note?: string
  droppedOrganMismatch: number
  droppedNoEvidence: number
} {
  const primaryRaw = typeof ai.primary_diagnosis === 'string' ? ai.primary_diagnosis.trim() : ''
  const primary = primaryRaw
    ? (resolveDiagnosis(primaryRaw)?.name ?? (organGated(primaryRaw, cancer) ? primaryRaw : '待进一步评估（证据不足）'))
    : '待进一步评估（证据不足）'
  // 此处只压置信、不改诊断词。
  // 0.85 是普适上限（镜下形态+单次整合到不了"十分确定"，禁 1.0/≥0.9 极端）。
  const confidence = Math.min(0.85, clamp01(ai.confidence))
  const merged: DifferentialDiagnosis[] = []
  const seen = new Set<string>([primary])
  let droppedOrganMismatch = 0
  let droppedNoEvidence = 0
  const diffs = Array.isArray(ai.differential) ? (ai.differential as Record<string, unknown>[]) : []
  for (const d of diffs) {
    const name = typeof d?.diagnosis === 'string' ? d.diagnosis.trim() : ''
    if (!name) continue
    const e = resolveDiagnosis(name)
    const cdx = e?.name ?? name
    if (!cdx || cdx === primary || seen.has(cdx)) continue
    if (!organGated(cdx, cancer)) { droppedOrganMismatch++; continue }   // 部位门
    // 证据门（防回答泄露，polarity-parity）：【只】在「良性主诊断 + 恶性鉴别候选」这一危险方向上设硬地板——
    // 必须有过谱正性形态证据（破坏性浸润等）否则 drop（词面已清洗，
    // 结肠癌 evTokens=['adenocarcinoma','carcinoma'] 不会误命中良性炎症措辞）。其余方向【一律信任决策 LLM 的
    // 鉴别判断】直接保留、只摘录证据——LLM 已见完整证据包，它既列了就认为值得排除。
    let evidenceFor: string[] = []
    if (e) {
      const s = spectrumSupport(e, gateClaims)
      const primaryPol = resolveDiagnosis(primary)?.polarity
      const leakDirection = primaryPol === 'benign' && e.polarity === 'malignant'
      if (leakDirection && !s.ok) { droppedNoEvidence++; continue }
      evidenceFor = s.excerpts
    } else {
      // 不在谱里的旧规则名（向后兼容）：走规则命中，同样要求有形态证据
      const rule = DIAGNOSIS_RULES.find((r) => r.diagnosis === name)
      if (!rule) { droppedNoEvidence++; continue }
      for (const c of gateClaims) evidenceFor.push(...evidenceExcerpt(rule, c).for)
      evidenceFor = [...new Set(evidenceFor)].slice(0, 3)
      if (evidenceFor.length === 0) { droppedNoEvidence++; continue }
    }
    seen.add(cdx)
    // evidence_for 只放【形态证据】（gate 摘录），绝不回落 LLM 的 note（rationale 是推理非形态支持，
    // 用 note 会把良性叙述包装成恶性鉴别的"支持"）。
    merged.push({ diagnosis: cdx, confidence: clamp01(d?.confidence), evidence_for: evidenceFor, evidence_against: [] })
  }
  for (const dd of organGateCandidates(candidates, cancer, primary, confidence)) {
    if (seen.has(dd.diagnosis)) continue
    // 证据门：确定性 backstop 与 LLM 项同等对待——必须有正性形态证据支持才放行。
    const be = resolveDiagnosis(dd.diagnosis)
    const ok = be ? spectrumSupport(be, gateClaims).ok : dd.evidence_for.length > 0
    if (!ok) { droppedNoEvidence++; continue }
    seen.add(dd.diagnosis)
    merged.push(dd)
  }
  return {
    primary,
    confidence,
    differential: merged.slice(0, 4),
    note: [
      typeof ai.rationale === 'string' ? ai.rationale : '',
      droppedOrganMismatch > 0 ? `（已过滤 ${droppedOrganMismatch} 个与本部位器官不符的鉴别诊断）` : '',
      droppedNoEvidence > 0 ? `（证据门剔除 ${droppedNoEvidence} 项无形态证据支持的鉴别）` : '',
    ].filter(Boolean).join(' ') || undefined,
    droppedOrganMismatch,
    droppedNoEvidence,
  }
}

async function llmDiagnose(
  voteObs: EvidenceNode[],
  cancer: Cancer | undefined,
  ctx: ToolExecuteCtx,
  v: ReturnType<typeof voteDiagnoses>,
): Promise<LlmDecision> {
  const organHint = cancer
    ? `；本部位（${cancer}）诊断谱（可能疾病空间参考，非答案，凭证据判断）：${spectrumFor(cancer).map((e) => e.name).join(' / ') || '（无）'}`
    : ''
  const question = ctx.session.currentQuestion
  const siteHint = organGateCandidates(v.candidates, cancer, '待进一步评估（证据不足）', 0, 3)
    .map((d) => d.diagnosis).join(' / ') || '（无）'
  const user = `[病例] 标本部位: ${cancer ?? '未知'}${organHint}\n${question ? `临床问题：${question}\n` : ''}
[部位约束] 本切片部位为 ${cancer ?? '未知'}。确定性引擎基于证据鉴别出的、经部位过滤的候选（供参考，非权威）：${siteHint}
[采样说明] 以下是病理 VLM 对该全片多个候选区域（按组织密度选样，非全片扫描）的形态描述，不同条目代表同一张切片的不同部位。

[证据]
${buildEvidencePack(voteObs)}

请整合上述证据，给出综合诊断决策（严格 JSON）。`
  // 分端点计时 + 熔断。scope=当前 slide：决策 LLM 超时既可能是服务端排队（服务级），
  // 也可能是本病例上下文特别长（病例级）——按片子分片后，只有跨病例同时超时才升级为服务级熔断。
  const ai = await resilient(
    { endpoint: 'llm', op: 'decide', scope: ctx.session.currentWsiId, sink: ctx.session.metrics },
    () => callDecisionLlm(DECISION_SYSTEM, user, ctx.signal),
  )
  const verdictMap = new Map<string, string>()
  const verdicts = Array.isArray(ai.evidence_verdicts) ? (ai.evidence_verdicts as Record<string, unknown>[]) : []
  for (const v of verdicts) {
    const id = typeof v?.id === 'string' ? v.id : ''
    const dir = v?.direction === 'against' ? 'against' : v?.direction === 'support' ? 'support' : ''
    if (id && dir) verdictMap.set(id, dir)
  }
  const polarityOf = (n: EvidenceNode): 'support' | 'against' | undefined => {
    if (!isVoteEvidence(n)) return undefined
    const d = verdictMap.get(n.id)
    return d === 'against' ? 'against' : d === 'support' ? 'support' : undefined
  }
  // 主诊断规范化 + 鉴别双重门控（部位门 + 证据门）抽到纯函数
  const gateClaims = voteObs
    .filter((n) => isVoteEvidence(n) && GATE_TOOLS.has(n.source.tool))
    .map((n) => clinicalClaim(n.claim))
  const fin = finalizeLlmDiagnosis(ai, gateClaims, cancer, v.candidates)
  return {
    primary: fin.primary,
    confidence: fin.confidence,
    differential: fin.differential,
    polarityOf,
    note: fin.note,
  }
}

/** 证据综合分析：观察/推理 → 证据图（含 contradicts 边）+ 主诊断 + 鉴别诊断 + 聚合置信度。
 *  verify_region 的质疑自动形成 contradicts 边。 */
export const analyzeEvidenceSpec: ToolSpec<typeof AnalyzeEvidenceSchema> = {
  name: 'analyze_evidence',
  label: '证据综合分析',
  description: '把已收集的观察/推理证据整合为证据图，投票出主诊断、鉴别诊断与聚合置信度；反对主诊断的证据标记为 contradicts 边。',
  parameters: Type.Object({}),
  metadata: { category: 'reasoning', cacheable: false, idempotent: false, timeoutMs: 420_000 },
  execute: async (_params, ctx) => {
    const store = ctx.session.evidenceStore
    const obs = store.allNodes().filter((n) => n.type !== 'conclusion')
    if (obs.length === 0) throw new Error('证据库为空：请先调用 scan_overview / perceive / verify_region 等收集证据')

    // 部位先验：从 wsiRegistry 取 slide 癌种（mock 会话无注册表 → undefined，不做先验调整）
    const cancer = ctx.session.wsiRegistry.get(ctx.session.currentWsiId)?.cancer
    const voteObs = obs.filter(isVoteEvidence)

    // ===== 决策层：PATHASK_DECISION=rule(关键词投票,默认) | llm(LLM 诊断决策) =====
    // 两种模式都产出同构 { primary, confidence, differential, polarityOf }，下游（证据图/报告/评测）契约不变。
    let primary: string = '待进一步评估（证据不足）'
    let confidence = 0
    let differential: DifferentialDiagnosis[] = []
    // 确定性投票只算一次：rule 用它定位主诊断；llm 用它做「证据驱动鉴别」候选源 + 失败时兜底。
    const v = voteDiagnoses(obs, cancer, ctx.session.capabilityRegistry)
    let candidates: DiagnosisCandidate[] = v.candidates
    let polarityOf: (n: EvidenceNode) => 'support' | 'against' | undefined = () => undefined
    let decisionNote: string | undefined
    let useRuleConfidence = DECISION_MODE === 'rule' // rule 置信靠 direction-化证据聚合；llm 置信由模型给出
    let zeroVoteEvidence = false
    if (voteObs.length === 0) {
      // 零可投票证据的兜底。库存里**可能有节点**，但没有一条能投票的观察：
      // 全是知识/检索背景、聚合节点，或观察被降级/退化标记后由 isVoteEvidence 排除掉。
      // 注意修在这里而不是抛错：抛 NO_EVIDENCE 后 runner 的「程序化补跑投票」兜底会再进来一次，
      // 良性诊断原样长回来——病在**结果**，不在调用。
      zeroVoteEvidence = true
      primary = '待进一步评估（证据不足）'
      confidence = 0
      differential = []
      useRuleConfidence = false
      decisionNote = `（零可投票证据：库存 ${obs.length} 条节点均为知识/检索背景或降级/退化观察，不足以形成诊断）`
      console.warn(`[analyze_evidence] 零可投票证据（库存 ${obs.length} 条节点）→ 不以良性收尾，需先补形态观察`)
    } else if (DECISION_MODE === 'llm') {
      try {
        const o = await llmDiagnose(voteObs, cancer, ctx, v)
        primary = o.primary; confidence = o.confidence; differential = o.differential
        polarityOf = o.polarityOf; decisionNote = o.note
      } catch (e) {
        // 决策 LLM 失败 → 兜底回落规则投票，保评测不崩（不静默，留 note 可溯）
        console.warn(`[analyze_evidence] 决策 LLM 失败，回落规则投票: ${e instanceof Error ? e.message : e}`)
        primary = v.primary; polarityOf = v.polarityOf; candidates = v.candidates
        decisionNote = `（决策 LLM 失败，回落规则投票：${e instanceof Error ? e.message : String(e)}）`
        useRuleConfidence = true
      }
    } else {
      primary = v.primary; polarityOf = v.polarityOf; candidates = v.candidates
    }
    // 统一写回每条证据方向（rule：polarityOf 文本匹配；llm：LLM 按证据 id 裁决）。
    // 主诊断置信 = 方向化证据聚合（against 证据以 1−conf 计入）。只对可投票证据赋方向；
    // 非可投票节点（analyze/counterfactual 聚合、知识/检索背景）清掉残留方向，避免陈旧 polarity 进入边/走读。
    for (const n of obs) {
      const p = isVoteEvidence(n) ? polarityOf(n) : undefined
      n.polarity = p ?? undefined
    }
    if (useRuleConfidence) {
      // 形态学金标准反向：真实 describe_patch 形态学判断与主诊断方向相反 → 不强行断言主诊断，
      // 置信压到"不确定"区间（≤0.5），交由 generate_report 触发 evidence_conflict / 人工复核（保守倾向）。
      confidence = evidenceConfidence(ctx.session)
      const ma = voteObs.some((n) => n.source.tool === 'describe_patch' && n.polarity === 'against')
      if (ma && confidence > 0.5) confidence = 0.5
      differential = organGateCandidates(candidates, cancer, primary, confidence)
    }
    // 形态学金标准反向：describe_patch 方向与主诊断相反。⚠️ 【llm 成功路径并不以此为置信压低】
    // （最终置信来自 finalizeLlmDiagnosis 的 clamp01(ai.confidence)+0.85上限，冲突时只靠 prompt 第7条诱导报 ≤0.5，
    //  代码层未强制）。此处 morphAgainst 仅用于下方 evidence_conflict / 保守处理信号，不横向改写 llm 置信。
    const morphAgainst = voteObs.some((n) => n.source.tool === 'describe_patch' && n.polarity === 'against')

    // 综合推断（inference）节点
    // 零证据时不能写成「基于 0 条证据（LLM 决策）」——那既读不通，也谎称问过 LLM
    const inferenceClaim = zeroVoteEvidence
      ? `综合推断：${primary}（零可投票证据：库存 ${obs.length} 条节点均不可投票）`
      : `综合推断：${primary}（基于 ${voteObs.length} 条证据${DECISION_MODE === 'llm' ? '（LLM 决策）' : '投票'}）`
    const inference = addEvidence(ctx, 'inference', inferenceClaim, confidence, 'analyze_evidence')
    // 每条可投票观察 → 推断 的边：contradicts（反对主诊断）/ supports（支持或中性）
    for (const n of voteObs) {
      if (n.id === inference.id) continue
      const rel = n.polarity === 'against' ? 'contradicts' : 'supports'
      const strength = n.polarity === 'against' ? n.confidence : Math.min(n.confidence, 0.6)
      store.addEdge(n.id, inference.id, rel, strength)
    }
    // 结论节点 + 推断 → 结论 边
    const conclusion = addEvidence(ctx, 'conclusion', `诊断：${primary}`, confidence, 'analyze_evidence')
    store.addEdge(inference.id, conclusion.id, 'supports', 1)

    const againstCount = voteObs.filter((n) => n.polarity === 'against').length
    // 矛盾检测：列出方向与主诊断相反的证据（VLM/描述说良性而主诊断恶性等）。显式输出而非只给计数，
    // 让 agent/报告都能看到"哪条证据在说反话"，从而触发 verify_region 复查而非静默忽略。
    const againstNodes = voteObs.filter((n) => n.polarity === 'against').map((n) => ({
      id: n.id, tool: n.source.tool, claim: n.claim.slice(0, 120), confidence: n.confidence,
    }))
    const contradictionBlock = againstNodes.length
      ? `\n========== ⚠️ 矛盾检测 ==========\n` +
        againstNodes.map((n) => `  ✗ [${n.tool}]「${n.claim}」conf=${n.confidence.toFixed(2)} 与主诊断「${primary}」方向相反`).join('\n') +
        `\n  → ${againstNodes.length} 条反向证据（如 VLM/描述为良性、run_mil 能力语义反向）与主诊断矛盾，构成 evidence_conflict —— 建议 verify_region 复查，或重新审视该证据来源。`
      : ''
    ctx.session.currentAnalysis = {
      diagnosis: primary,
      confidence,
      differential,
      primaryNodeId: conclusion.id,
      // 矛盾检测输入——generate_report 据此决定是否标 evidence_conflict（优先级在 model_limitation 之前）
      againstCount,
      contradiction: againstCount > 0,
      contradiction_nodes: againstNodes,
      // 形态学金标准反向：describe_patch 对真实 patch 的形态学判断与主诊断相反 → 报告标"形态学反向"，保守处理
      morphology_against: morphAgainst,
    }

    return {
      text:
        `${morphAgainst ? `⚠️ 形态学金标准(describe_patch)与主诊断「${primary}」方向相反 → 置信压至不确定、建议 verify_region/人工复核\n` : ''}` +
        `[analyze_evidence] 诊断=${primary} conf=${confidence.toFixed(2)}；证据 ${obs.length} 条（反对 ${againstCount}）→ 证据图 ${store.getGraph().edges.length} 条边（${DECISION_MODE === 'llm' ? 'LLM 决策' : '规则投票'}）\n` +
        (decisionNote ? `[决策依据] ${decisionNote}\n` : '') +
        `鉴别诊断 ${differential.length} 个:\n` +
        differential.map((d) => `- ${d.diagnosis}（conf=${d.confidence.toFixed(2)}，支持 ${d.evidence_for.length} / 反对 ${d.evidence_against.length}）`).join('\n') +
        contradictionBlock,
      details: {
        analysis: ctx.session.currentAnalysis, evidence_nodes: obs.length,
        against_count: againstCount, contradiction: againstCount > 0,
        contradiction_nodes: againstNodes, edges: store.getGraph().edges.length,
      },
    }
  },
}

export const AnalyzeEvidenceSchema = Type.Object({})
export type AnalyzeEvidenceParams = Static<typeof AnalyzeEvidenceSchema>
