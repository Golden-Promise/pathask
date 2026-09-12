import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Type } from 'typebox'
import type { Static } from '@earendil-works/pi-ai'
import type { PatchRef } from '../types'
import { addEvidence, findPatchByRef, realWsi, type ToolExecuteCtx, type ToolSpec } from './common'
import { anchorConf, clampConfidence } from './anchors'
import { mapWithConcurrency } from '../util/concurrency'
import { resilient } from '../util/resilience'
import { softError } from './toolErrors'

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** Patho-R1 vLLM 端点。环境变量可覆盖；默认用回环地址（去私有内网 IP，避免发布泄露）。 */
const VLLM_BASE_URL = process.env.VLLM_BASE_URL ?? 'http://127.0.0.1:8012/v1'
export const VLLM_MODEL = process.env.VLLM_MODEL ?? 'patho-r1-7b'
const VLM_TIMEOUT_MS = Number(process.env.VLM_TIMEOUT_MS ?? 60_000)
/** 描述器批量并发的客户端上限。默认对齐 patho-r1 vLLM `--max-num-seqs 4`——超过会服务端排队，
 *  排队超过 VLM_TIMEOUT_MS 客户端即 abort → 批量降级 mock。 */
const VLM_BATCH_CONCURRENCY = Number(process.env.PATHASK_VLM_CONCURRENCY ?? 4)

/** 是否把 `question` 并入 describe 幂等缓存的 key（**默认关**）。
 *  默认关的理由是成本：`question` 直接进 VLM prompt，同一 patch 的每种新问法都会变成一次**真** VLM 调用
 *  ——在 `verify_region` 一次 2 次 VLM、VLM 已是第二大耗时分项的前提下，这不是个可以默默打开的开关。
 *  默认档（关）不是放任不管：命中旧问法的缓存时，返回文本会**如实标注**「这条描述是为另一个问题生成的」
 *  （见 `describeOne`），而不是把本次的 question 印在别人写好的答案上。 */
function describeCacheByQuestion(): boolean {
  const raw = process.env.PATHASK_DESCRIBE_CACHE_BY_QUESTION
  if (raw === undefined || raw.trim() === '') return false
  return /^(1|true|on|yes)$/i.test(raw.trim())
}

/** describe 幂等缓存的键。**读写必须走同一个函数**——get/set 各写一遍 key 表达式，
 *  两边迟早不一致，而那种不一致表现为「缓存永不命中」（慢）或「命中错条目」（错），都是最难查的一类。
 *  分隔符用 `\u0000` 的**转义写法**（NUL 不可能出现在 patch.id 或 question 里，拼接无歧义）。
 *  ⚠️ 必须写成转义：这里曾是一个**字面 NUL 字节**——JS 语义一模一样，但整个源文件会被
 *  `grep` 判成二进制，此后在这个文件里的每一次搜索都**静默返回空**（`file` 会报 `data`），
 *  看起来就像"那段代码不在文件里"。一个看不见的字节换掉全仓对该文件的可搜索性，不值得。 */
function describeCacheKey(patchId: string, question: string): string {
  return describeCacheByQuestion() ? `${patchId}\u0000${question}` : patchId
}

/** 模型显示名（日志/证据可追溯）：按 VLLM_MODEL 识别，避免换 Qwen3-VL 描述器时证据仍显示 "Patho-R1"。 */
export const MODEL_LABEL = VLLM_MODEL.toLowerCase().includes('qwen') ? 'Qwen3-VL' : 'Patho-R1'

/** 按 region 初判标签生成确定性的形态学描述（vLLM 不可用时的 fallback）。
 *  置信钳在 supportive(0.75) 以内（降级不高于真 VLM 途径；mock 镜像 claim 到不了决定性——那是真 VLM 才能给的上限）。 */
function describeFromLabel(label: string | undefined): { claim: string; confidence: number } {
  switch (label) {
    case '导管上皮异型增生':
      return {
        claim: '导管内见异型上皮，细胞核增大深染、极性紊乱，局部见浸润性生长趋势',
        confidence: anchorConf('supportive'),
      }
    case '可疑浸润灶':
      return { claim: '间质内见异型细胞巢，倾向浸润性生长', confidence: anchorConf('supportive') }
    case '片状深染小细胞区':
      return { claim: '片状深染小细胞，核质比高、胞质少，见镶嵌样/栅栏样排列', confidence: anchorConf('supportive') }
    case '反应性增生':
      return { claim: '上皮反应性增生，细胞温和，未见明确异型', confidence: anchorConf('neutral') }
    default:
      return { claim: '组织形态待进一步评估，未见特异性病变', confidence: anchorConf('weak') }
  }
}

/** Patho-R1 原始输出摘要。VLM 常输出 `...<think>...</think><answer>结论</answer>`，把完整输出（含 think
 *  推理标签）直接拼进 claim 会让投票规则误匹配思考内容。提取 `<answer>` 正文（无标签时剥 think 标签）；
 *  完整原始文本放 evidence source.raw（JSON 报告可追溯）。
 *
 *  入证据包前先过 sanitizeClaim：剔句尾的「诊断/分级/建议/弱化/推测」句，只留纯形态描述。
 *  sanitizeClaim 按句剔，且只剔"结论/推测/建议"类句，
 *  纯形态句（"The tissue shows…" / "Mitotic figures are present but not abundant." / "No definitive mitotic
 *  figures or necrosis are identified."）不受影响（见下方 BAD_CLAIM_SENTENCE 对照注释）。 */
export function summarizeVlm(raw: string): string {
  const ans = raw.match(/<answer>([\s\S]*?)<\/answer>/)?.[1]
  const body = sanitizeClaim(ans ?? raw.replace(/<\/?think>/g, ''))
  // 保真存储默认不截断；PATHASK_CLAIM_FULL=0 回退 300 字符切片。
  if (process.env.PATHASK_CLAIM_FULL === '0') return body.slice(0, 300)
  return body
}

/** 约束兜底：claim 入证据包前的句级清洗。只保留"纯形态描述句"，剔掉 VLM 在句尾补的「诊断/分类/分级/建议/弱化/推测」句。
 *  背景：新版 PURE prompt 从源头弱化"如实说明不确定性"，但 7B 仍有概率在句尾产尾巴句（"…suggest a neoplastic
 *  process…" / "…nonspecific and could align…" / "…requires immunohistochemical analysis"），决策层读到这类句
 *  会综合出「待进一步评估」（ambiguous_morphology）→ 弃诊。此兜底是第二道保险：从证据包里剔除漏网尾巴句。
 *  设计原则 = "宁可"句读漏、不误伤纯形态句——BAD_CLAIM_SENTENCE 只匹配"对病变下结论/给建议/表推测"的句，
 *  纯形态句（以 The tissue / The cells / Cytoplasm / Mitotic / The stroma / Nuclear pleomorphism / The growth
 *  pattern 开头，只陈述镜下所见）不匹配，故不受影响。 */
export const BAD_CLAIM_SENTENCE: RegExp[] = [
  // 诊断 / 分类 / 疾病断言
  /\b(consistent with|suggestive of|indicative of|compatible with|diagnostic of|in keeping with|in favor(?:u?r)? of)\b/i,
  /\b(different(?:ial\s+)?(?:diagnos\w*|consideration\w*)|diagnos\w+|DIAGNOSIS)\b/i,
  // 诊断名词（含良性梭形/复合词）：老表偏恶性上皮 + 缺良性梭形诊断（leiomyoma/dermatofibroma/fibroma…），
  // 且 \b\w\b 对复合词错配——"leiomyosarcoma"的"癌"是词中(前后都是\w)，\bsarcoma\b 匹配不到；fibroadenoma 同理。
  /\b(carcinoma|adenocarcinoma|sarcoma|lymphoma|melanoma|leiomyoma|leiomyosarcoma|dermatofibroma|fibrous\s+histiocytoma|fibroma|schwannoma|neurofibroma|fibroadenoma|cystadenoma|neuroendocrine|neoplastic\s+process|malignant\s+(?:epithelial\s+)?neoplasm|benign\s+neoplasm|benign\s+epithelial\s+proliferation|glandular\s+proliferation|reactive\s+process|papilloma|adenoma)\b/i,
  // 建议 / 行动 / IHC
  /\b(requires?|recommend\w*|would\s+be\s+(?:required|needed|helpful)|need(?:s|ed|ing)?\s+to|should|critical|crucial|important\s+to|to\s+(?:confirm|exclude|clarify|establish|determine|delineate))\b/i,
  /\b(immunohistochem\w*|immunohistochemistry|IHC)\b/i,
  // 弱化 / 推测 / 尾巴触发词
  /\b(nonspecific|non-specific|complicate\w*|preclude\w*|limits?\s+definitive|prevent\s+precise|prevent\s+precise\b|hesit\w*|uncertain|ambiguous|does\s+not\s+allow)\b/i,
  /^(While|However|Although|But|Yet|Overall|In\s+summary|Thus|Therefore|Differential|Definitive|Further|Additionally|In\s+addition|Nevertheless)\b/i,
  /\b(could\s+align|would\s+align|may\s+(?:align|represent|reflect|be)|might\s+(?:align|represent)|suggest\w*|likely|probable|possibly|perhaps|appears?\s+to|seems?\s+to)\b/i,
  // 提示词首行回显：VLM 偶把送进 prompt 的 specimenHint 原样回显进正文（既非形态描述也非诊断/弱化句，纯噪声），剥除。
  // 实测见 "这是HE染色的组织学切片。" 独立成句；中文句号由 sanitizeClaim 的切分规则一并处理。
  /^(这是\s*HE\s*染色|注意：这是甲状腺|这是\s*HE\s*染色\s*的)/i,
]

/** 按句拆 body，滤掉命中的"非形态"句，重拼 + 压缩多余空白。
 *
 *  ⚠️ 分隔符必须**留在句尾**。中文支用**零宽** lookbehind：`。！？` 是无歧义的句末符
 *  （不像 `.` 会出现在小数/缩写里），在其后切一刀即可，无需消费任何字符。
 *  英文那支（lookbehind + `\s+`）把 `.` 留在句尾。 */
export function sanitizeClaim(body: string): string {
  const sentences = body
    .split(/(?<=[.!?])\s+|\n+|(?<=[。！？])\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
  const kept = sentences.filter((s) => !BAD_CLAIM_SENTENCE.some((re) => re.test(s)))
  return kept.join(' ').replace(/\s{2,}/g, ' ').trim()
}

/** 标本类型提示段：FNA 是细胞学涂片（非 HE 组织切片），形态特征与组织学完全不同——
 *  Patho-R1 训练于组织切片，若不加提示会把涂片按组织学结构描述（"分叶状细胞团"→误触发叶状规则）。 */
export function specimenHintFor(slideId: string | undefined, cancer: string | undefined): string {
  if (cancer === 'thyroid') {
    return '注意：这是甲状腺 FNA 细胞学涂片（非 HE 组织切片），细胞呈单个或小团分布。请按细胞学形态描述（细胞大小、核质比、染色质粗细、核膜、有无胶质/泡沫细胞等），勿套用组织学结构术语（如浸润、腺管、基底膜）。'
  }
  return '这是 HE 染色的组织学切片。'
}

/** 调 Patho-R1 vLLM（Qwen2.5-VL 多模态）描述 patch。vLLM 不可用时抛错，由调用方降级。
 *  导出给 verify_region 复用（高倍复核同样走 VLM）；长复核 prompt 可传更大 timeoutMs / maxTokens。 */
export async function describeWithVLM(
  patch: PatchRef,
  question: string,
  timeoutMs = VLM_TIMEOUT_MS,
  maxTokens = 512,
  specimenHint?: string,
  promptOverride?: string,
  signal?: AbortSignal,
): Promise<string> {
  const abs = path.resolve(PROJECT_ROOT, patch.cached_path ?? '')
  const b64 = (await readFile(abs)).toString('base64')
  // verifyRegion 需要"完整独立 prompt"直发——它的 prompt 已含「结论支持/不支持/无法判断」
  // 格式 + 「只描述不下具体诊断」约束，不能用下面这段公共模板包裹：模板尾部「先分析后给出结论」会让 7B
  // 前向抓"给出结论"→ 先给诊断结论（与 verify 自身约束相悖）。传 promptOverride
  // 时完全跳过模板（也跳过 specimenHint 拼接，故 verifyRegion 的 specHint 参数静默失效，可接受）。
  const text = promptOverride
    ?? `你是一名病理科医生。请观察这张病理切片 patch，回答：${question}。${specimenHint ?? '这是 HE 染色的组织学切片。'}请客观描述镜下所见形态（细胞核大小/染色/极性、排列方式、异型性、间质情况等），不要下疾病诊断。`
  const resp = await fetch(`${VLLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VLLM_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
            {
              type: 'text',
              text,
            },
          ],
        },
      ],
      max_tokens: maxTokens,
      // 描述器贪心(temp=0)：对齐 Patho-R1 作者自己的推理(HF 默认 do_sample=False 即贪心)+ 去掉 describe 采样漂移
      temperature: 0,
    }),
    // 工具预算/agent 中止 与 单次 VLM 超时 取先到者——否则 agent.abort() 掐不断在途 VLM 请求
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  })
  if (!resp.ok) {
    throw new Error(`Patho-R1 vLLM HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  }
  const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] }
  const content = data.choices?.[0]?.message?.content?.trim()
  if (!content) throw new Error('Patho-R1 返回空内容')
  return content
}

/** 5-label 忠实描述器：去角色锚点、先忠实描述形态、再仅凭形态
 *  打 5 类标签，把「该块可疑」记为 evidence（label）而非 verdict，交决策层做 slide-level 判别。 */
const STRUCTURED_LABELS = ['malignant', 'premalignant', 'benign', 'normal', 'N/A'] as const
type MorphLabel = (typeof STRUCTURED_LABELS)[number]

/** label 接线开关：PATHASK_LABEL_WIRE=off 时 describe_patch 只贡献形态文本——
 *  不注入 label 硬词（labelDocToken）、不设 label 极性（labelPolarityOf）、不用 labelBalance 置信（回落 supportive 0.75）。
 *  默认 on。 */
const LABEL_WIRE = process.env.PATHASK_LABEL_WIRE !== 'off'

/** 形态描述器 prompt 模式：pure（默认，纯形态描述，不要求分类）| label5（回退档，含 5-label 分类）。
 *  label5 强制 5-label 分类会诱发 VLM 合理化/顺着锚点走（多形即恶性 → 良性 FP 洪灾），
 *  纯形态描述是生产配置。PATHASK_MORPH_PROMPT=label5 可显式回退。 */
const MORPH_PROMPT = process.env.PATHASK_MORPH_PROMPT ?? 'pure'
const MORPH_PURE = MORPH_PROMPT === 'pure'

function buildMorphPrompt(question: string, specimenHint: string): string {
  return [
    '你正在分析人类组织标本中的一张 H&E 病理 patch。',
    '',
    '【一、形态学描述】',
    specimenHint,
    '请只用 2-4 句话描述你实际看到的镜下特征：细胞核（大小/染色质/核仁/多形性/极性）、胞质、细胞排列方式（巢状/腺样/条索/片状/单列/实性）、间质（纤维化/水肿/炎症/坏死）、有无核分裂象与浸润性生长。',
    '- 只描述形态学，不要下疾病诊断，不要提分级、预后或治疗。',
    question ? `- 重点关注：${question}` : '',
    '',
    '【二、分类标签】',
    '然后，仅根据你上面描述的形态学，用下面五个标签里最贴合的一个标注该区域：',
    '- "malignant"：明确恶性（细胞显著异型 + 浸润/破坏性生长）',
    '- "premalignant"：癌前/异常增生/原位，但未见明确浸润（异型增生、原位癌、交界性）',
    '- "benign"：明确良性（良性肿瘤，或反应性/炎症性病变）',
    '- "normal"：正常/无不典型性组织',
    '- "N/A"：无决定性形态（坏死、伪影、取材差、仅个别细胞、难以判定）→ 诚实标 N/A，不要硬选良恶',
    '',
    '【三、置信度】',
    'confidence（0.0~1.0）= 你对 label 判断的把握。',
    '',
    '只输出如下 JSON，不要输出别的：',
    '{"morphology": "...", "label": "malignant|premalignant|benign|normal|N/A", "confidence": 0.0}',
  ].join('\n')
}

/** 纯形态描述器 prompt：只描述形态、不做良恶性/癌前分类。可观察项拆成 bullet 逐项，
 *  并把「无法确定就如实说明不确定性」改为「没有把握的特征直接省略，不要给建议」——前者会诱使 Patho-R1
 *  在句尾产弱化尾巴（"…nonspecific / could align… / requires IHC"），决策层读到 → 判「待进一步评估」
 *  （ambiguous_morphology）→ 弃诊；从源头不产尾巴，配合 summarizeVlm 的兜底剔句双保险。
 *  「分类标签要求」会诱发 VLM 合理化（见上方 buildMorphPrompt 注释）；去掉分类改成纯描述，
 *  让 VLM 不再被迫从 5-label 里选一个，减少「多形性即恶性」的过判与「没看到浸润即良性」的漏判。 */
function buildMorphPromptPure(question: string, specimenHint: string): string {
  return [
    specimenHint,
    '',
    '请只用 2-4 句话描述你实际看到的镜下特征：',
    '- 细胞核（大小/染色质/核仁/多形性/极性）',
    '- 细胞质（染色、丰度）',
    '- 细胞排列方式（巢状/腺样/条索/片状/单列/实性/乳头状）',
    '- 间质（纤维化/水肿/炎症/坏死/玻璃样变）',
    '- 核分裂象（有/无/大致数量）',
    '- 浸润性生长（有/无，描述你看到的边界情况）',
    '规则：',
    '- 不要下疾病诊断，不要做良恶性或癌前分类，不要提分级、预后或治疗',
    '- 没有把握的特征直接省略，不要编造，不要给建议',
    question ? `- 重点关注：${question}` : '',
    '',
    '直接输出形态描述正文（纯文字），不要输出 JSON、列表或其它格式。',
  ].join('\n')
}

/** 平衡括号提取 JSON 对象 span（跳过字符串内的大括号），避免贪心/惰性正则被 morphology 里的 "{3×}"、嵌套叙述误截。 */
function extractBalancedJson(raw: string): string | null {
  const start = raw.indexOf('{')
  if (start < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return raw.slice(start, i + 1) }
  }
  return null
}

/** Patho-R1 输出的 JSON 常不合法：morphology 字符串内带真实换行、省逗号（值各占一行）、且把 confidence 键写成
 *  " confidence"（前导空格）；Qwen3-VL 则规范。→ ① 平衡括号 + 修换行/尾逗号后尽可能 JSON.parse（规范输出走这条）；
 *  ② 字段正则直抽兜底（容忍无逗号 + 前导空格键；morphology 为无内嵌双引号的散文）。
 *  解析失败返回 null（调用方降级为诚实 N/A，不崩溃、不硬选良恶）。 */
function parseStructuredVlm(raw: string): { claim: string; label: MorphLabel; confidence: number } | null {
  let obj: Record<string, unknown> | null = null
  const span = extractBalancedJson(raw)
  if (span) {
    const sanitized = span.replace(/\r?\n/g, ' ').replace(/,\s*([}\]])/g, '$1')
    try {
      const parsed = JSON.parse(sanitized)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>
    } catch { obj = null }
  }
  if (!obj) {
    const label = /"label"\s*:\s*"([^"]+)"/.exec(raw)?.[1]?.toLowerCase() ?? ''
    const confStr = /"\s*confidence"\s*:\s*([0-9.]+)/.exec(raw)?.[1]
    const morph = /"morphology"\s*:\s*"([\s\S]*?)"\s*,?\s*"label"\s*:/.exec(raw)?.[1]
      ?.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() ?? ''
    if (!label || !morph) return null
    obj = { label, confidence: confStr ? Number(confStr) : 0.5, morphology: morph }
  }
  const claim = typeof obj.morphology === 'string' ? obj.morphology.trim() : ''
  let label: MorphLabel = 'N/A'
  const rawLabel = typeof obj.label === 'string' ? obj.label.toLowerCase() : ''
  if ((STRUCTURED_LABELS as readonly string[]).includes(rawLabel)) label = rawLabel as MorphLabel
  // 部分模型把 confidence 键写成 " confidence"（前导空格）→ JSON.parse 后是独立键，兜底取
  let confidence = typeof obj.confidence === 'number' ? obj.confidence : 0.5
  if (typeof obj[' confidence'] === 'number') confidence = obj[' confidence'] as number
  confidence = Math.max(0, Math.min(1, confidence))
  if (!claim) return null
  return { claim, label, confidence }
}

/** label → 聚合置信档（确定性、对齐规范锚点 CONF_ANCHORS）。N/A=诚实弃权（weak）、normal 中等（neutral）、
 *  斩钉截铁标签=支持性档（supportive，0.75；单 patch 到不了决定性 0.90）。
 *  （VLM 自报 confidence 只作 morph_confidence 溯源；聚合不直接信它，避免模型对置信度哄抬/贬低。） */
function labelBalance(label: MorphLabel): number {
  switch (label) {
    case 'N/A': return anchorConf('weak') // 0.35 诚实弃权，不投任何一侧
    case 'normal': return anchorConf('neutral') // 0.55
    default: return anchorConf('supportive') // 0.75（malignant/benign/premalignant）
  }
}

/** region 初判标签 → 5-label（vLLM 降级时用）。 */
function labelFromRegion(regionLabel: string | undefined): MorphLabel {
  switch (regionLabel) {
    case '导管上皮异型增生': return 'premalignant'
    case '可疑浸润灶':
    case '片状深染小细胞区': return 'malignant'
    case '反应性增生': return 'benign'
    default: return 'normal'
  }
}

/** 调 Patho-R1 vLLM 用 5-label 忠实描述器。返回 {claim=纯形态, label, confidence, raw}。
 *  解析失败时降级为诚实 N/A（claim=摘要，label=N/A，conf 0.5），绝不硬选良恶、绝不抛错中止链路。 */
export async function describeWithVLMS(
  patch: PatchRef,
  question: string,
  timeoutMs = VLM_TIMEOUT_MS,
  maxTokens = 768,
  specimenHint?: string,
  signal?: AbortSignal,
): Promise<{ claim: string; label: MorphLabel; confidence: number; raw: string }> {
  const abs = path.resolve(PROJECT_ROOT, patch.cached_path ?? '')
  const b64 = (await readFile(abs)).toString('base64')
  const hint = specimenHint ?? '这是 HE 染色的组织学切片。'
  const prompt = MORPH_PURE ? buildMorphPromptPure(question, hint) : buildMorphPrompt(question, hint)
  const resp = await fetch(`${VLLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VLLM_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
            { type: 'text', text: prompt },
          ],
        },
      ],
      max_tokens: maxTokens,
      // 描述器贪心(temp=0)：对齐 Patho-R1 作者自己的推理(HF 默认 do_sample=False 即贪心)+ 去掉 describe 采样漂移
      temperature: 0,
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  })
  if (!resp.ok) {
    throw new Error(`${MODEL_LABEL} vLLM HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  }
  const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] }
  const content = data.choices?.[0]?.message?.content?.trim()
  if (!content) throw new Error(`${MODEL_LABEL} 返回空内容`)
  // 纯形态模式：VLM 只输出正文，不要求结构化 label/confidence，跨过 parseStructuredVlm 直接摘录。
  if (MORPH_PURE) return { claim: summarizeVlm(content), label: 'N/A', confidence: 0.5, raw: content }
  const parsed = parseStructuredVlm(content)
  if (!parsed) return { claim: summarizeVlm(content), label: 'N/A', confidence: 0.5, raw: content }
  return { claim: parsed.claim, label: parsed.label, confidence: parsed.confidence, raw: content }
}

/** Patch 形态描述：接 Patho-R1 VLM（真 vLLM），返回细胞/结构形态证据。
 *  可传 patch_refs（数组）一次描述多个 patch，工具内并发 fan-out。幂等缓存逐 patch 复用。 */
export const describePatchSpec: ToolSpec<typeof DescribePatchSchema> = {
  name: 'describe_patch',
  label: 'Patch 形态描述',
  description: '对单个或一批（patch_refs）patch 用病理 VLM 描述细胞形态、核特征、结构排列（回答 question）。结果按 patch 缓存。',
  parameters: Type.Object({
    patch_ref: Type.Optional(Type.String()),
    patch_refs: Type.Optional(Type.Array(Type.String())),
    question: Type.String(),
  }),
  metadata: { category: 'perception', cacheable: true, idempotent: true, depends_on: ['inspect_region'] },
  execute: async (params, ctx) => {
    // 解析有效 patch 列表：patch_refs（批量）优先，否则回退单 patch_ref。容忍斜杠 id / 展平 basename 表示。
    const refs = (params.patch_refs?.length ? params.patch_refs : params.patch_ref ? [params.patch_ref] : []).filter(Boolean)
    const resolved: PatchRef[] = []
    const missing: string[] = []
    for (const r of refs) {
      const p = findPatchByRef(ctx.session.patchCache, r)
      if (p) resolved.push(p)
      else missing.push(r)
    }
    if (resolved.length === 0) {
      const avail = [...ctx.session.patchCache.values()].flat().map((p) => p.id).slice(0, 20)
      // 不抛错：把可用 ref 列表给模型，让它一次自纠
      return softError(ctx, 'describe_patch', 'PATCH_NOT_FOUND', {
        detail: `未找到 patch_ref: ${refs.join(', ') || '(空)'}。`,
        alternatives: { label: 'patch_ref', values: avail },
        extra: { missing },
      })
    }
    // 批量：并发 fan-out，但客户端并发上限对齐 vLLM 排队容量（防整批排队超时降级 mock）；单个失败不杀整批（Settled 隔离）
    let doneN = 0
    const results = await mapWithConcurrency(resolved, VLM_BATCH_CONCURRENCY, (p) =>
      describeOne(ctx, p, params.question).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason) => ({ status: 'rejected' as const, reason }),
      ).finally(() => ctx.onUpdate?.({ done: ++doneN, total: resolved.length })),
    )
    const texts: string[] = []
    const details: { patch: PatchRef; claim: string; confidence: number; vlm: boolean; label: string; seq: number; ok: boolean; error?: string }[] = []
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        texts.push(r.value.text)
        details.push({ ...r.value.details, seq: i, ok: true })
      } else {
        texts.push(`[describe_patch] ${resolved[i].id} 描述失败：${(r.reason as Error).message}`)
        details.push({ patch: resolved[i], claim: '', confidence: 0, vlm: false, label: 'N/A', seq: i, ok: false, error: (r.reason as Error).message })
      }
    })
    return { text: texts.join('\n'), details: { batch: details, n: resolved.length, missing: missing.length ? missing : undefined } }
  },
}

/** 对单个 patch 执行 describe（缓存复用 → VLM/降级 → label 接线置信 → 写缓存 → addEvidence）。
 *  返回与单 patch 时一致的 text + details。故意不 throw（VLM 失败内部降级；确定性路径保冒烟稳定）。 */
async function describeOne(ctx: ToolExecuteCtx, patch: PatchRef, question: string): Promise<{ text: string; details: { patch: PatchRef; claim: string; confidence: number; vlm: boolean; label: string; cached?: boolean; questionMismatch?: boolean } }> {
  // 幂等缓存——同一 patch 已描述过则直接复用（不重调 VLM、不叠证据），防 agent 反复 describe 烧成本。
  const cached = ctx.session.describeCache?.get(describeCacheKey(patch.id, question))
  if (cached) {
    // 默认 key 只有 `patch.id`，**不含 question**——换问法重读同一 patch 会拿到上一个问题的答案。
    // 这不是假想：`question` 是直接进 VLM prompt 的（见下方 describeWithVLMS 调用），同一张图问
    // 「是否为浸润癌」与问「有无坏死」得到的是**不同**的 claim。
    // 处理分两档：① 真修（question 并入 key）由 `PATHASK_DESCRIBE_CACHE_BY_QUESTION=1` 门控，默认关
    //   ——它把一次缓存命中变成一次真 VLM 调用（成本上升）；
    // ② 默认档**如实标注**：复用照旧，但文案点明这条描述是为另一个问题生成的。
    const staleQuestion = cached.question !== undefined && question !== undefined && cached.question !== question
    const tag = staleQuestion ? '[幂等复用·问题不同，未重读 VLM]' : '[幂等复用，未重读 VLM]'
    const caution = staleQuestion
      ? `\n（注意：这条描述是为「${cached.question}」生成的，未必回答当前的「${question}」；`
        + '若需要针对当前问题重新观察，请换一个 patch_ref 或提高倍率再读。）'
      : ''
    return {
      text: `[describe_patch] ${patch.id}（${patch.magnification}×，问题: ${question}）${tag}\n${cached.claim}\n（标签=${cached.label}, conf=${cached.confidence}）${caution}`,
      details: {
        patch, claim: cached.claim, confidence: cached.confidence, vlm: cached.vlm, label: cached.label,
        ...(staleQuestion ? { questionMismatch: true } : {}),
        cached: true,
      },
    }
  }

  // 真 VLM 主路径；vLLM 不可用时降级确定性描述（保冒烟稳定）
  let vlm = true
  let rawClaim = ''
  let claim: string
  let morphLabel: MorphLabel = 'N/A'
  let morphConf = 0.5
  try {
    const cancer = ctx.session.wsiRegistry.get(patch.slide_id)?.cancer
    const specimenHint = specimenHintFor(patch.slide_id, cancer)
    // 传 ctx.signal：agent 中止 / 工具预算到点 能掐断在途 VLM 请求
    // 分端点计时 + 熔断。scope=当前 slide——VLM 超时可能是这张片的图有问题，
    // 不该让一张片的连续超时把整个 VLM 服务判死（连接类失败才直接记服务级）。
    const st = await resilient(
      { endpoint: 'vlm', op: 'describe', scope: ctx.session.currentWsiId, sink: ctx.session.metrics },
      () => describeWithVLMS(patch, question, undefined, undefined, specimenHint, ctx.signal),
    )
    rawClaim = st.raw
    claim = st.claim // claim=纯形态学（GT 证据合规：只描述、不含诊断名/分级/预后）
    morphLabel = st.label
    morphConf = st.confidence
    ctx.session.metrics.recordVlm() // VLM 调用计数
  } catch (err) {
    // ⚠️ 降级路径不能伪装成真实观测：describeFromLabel 是「按 region_label 查表」的
    //   确定性模板，不是对这张图的观察。不带 stub 就会**照样参与投票**，
    //   正是「良性模板洗白」的入口（VLM 一挂，全片 patch 全变温和模板 → 决策层被洗成良性）。
    vlm = false
    const fb = describeFromLabel(patch.region_label)
    claim = fb.claim
    morphLabel = labelFromRegion(patch.region_label)
    morphConf = fb.confidence
    console.warn(`[describe_patch] ${MODEL_LABEL} 不可用，降级模板：${(err as Error).message}`)
  }
  // label 接线。on=按 label 定聚合置信 + 存 morph_label（投票引擎据此注入硬词/设极性）；
  //      off（PATHASK_LABEL_WIRE=off）只留形态文本——不存 label、置信回落 supportive 锚点。
  const confidence = vlm
    ? (LABEL_WIRE ? labelBalance(morphLabel) : anchorConf('supportive'))
    : clampConfidence(describeFromLabel(patch.region_label).confidence) // 降级 mock：钳到规范范围（≤0.90），不符"降级更高"虚高
  // 写幂等缓存（最终置信一并存，供同 patch 再次 describe 精确复用）
  // 连 `question` 一起存——它是 claim 的**生成条件**，不存就无法判断一次命中是否"答非所问"。
  ctx.session.describeCache?.set(describeCacheKey(patch.id, question),
    { claim, label: morphLabel, confidence, vlm, raw: rawClaim, question })

  // 降级模板的投票资格。
  //   真 WSI 会话 → `stub: true`（isVoteEvidence 排除出投票/置信聚合，addEvidence 同时强制 confidence=0）
  //   mock 会话   → 保持可投票：纯 mock 环境里**所有** describe 都走这条降级路径，
  //                 若一刀切 stub 会把 smoke 的置信度断言全线打红。
  //   两种情形都记 `fallback: true`（区别于 verify_region 的 `degenerate`=VLM 输出退化），供报告/评测观测。
  const degradedReal = !vlm && realWsi(ctx, patch.slide_id) !== null
  addEvidence(ctx, 'observation', `patch ${patch.id} 形态（${MODEL_LABEL}）：${claim}`, confidence, 'describe_patch', {
    coords: { id: patch.region_id, slide_id: patch.slide_id, x: patch.x, y: patch.y, w: patch.size, h: patch.size, magnification: patch.magnification },
    magnification: patch.magnification,
    model: VLLM_MODEL,
    // 结构化 5-label + VLM 自报置信（溯源），投票引擎按 label 做方向判别；label 接线关闭时不存（干净单变量）
    ...(LABEL_WIRE ? { morph_label: morphLabel, morph_confidence: morphConf } : {}),
    // 完整原始 VLM 输出（含 think/answer 标签）存 source.raw，JSON 报告可追溯
    ...(vlm ? { raw: rawClaim } : {}),
    ...(vlm ? {} : { fallback: true, ...(degradedReal ? { stub: true } : {}) }),
  })
  return {
    text: `[describe_patch] ${patch.id}（${patch.magnification}×，问题: ${question}）\n${claim}\n（标签=${morphLabel}, conf=${confidence}${vlm ? '' : '，⚠️ vLLM 不可用降级'}）`,
    details: { patch, claim, confidence, vlm, label: morphLabel },
  }
}

export const DescribePatchSchema = Type.Object({
  patch_ref: Type.Optional(Type.String()),
  patch_refs: Type.Optional(Type.Array(Type.String())),
  question: Type.String(),
})
export type DescribePatchParams = Static<typeof DescribePatchSchema>
