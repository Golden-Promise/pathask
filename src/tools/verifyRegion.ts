import { Type } from 'typebox'
import type { Static } from '@earendil-works/pi-ai'
import type { PatchRef } from '../types'
import { RegionSchema } from './schemas'
import { addEvidence, ensureWsi, realWsi, type ToolSpec } from './common'
import { anchorConf } from './anchors'
import { cachePatches } from '../wsi/patchCache'
import { describeWithVLM, specimenHintFor, summarizeVlm, MODEL_LABEL, VLLM_MODEL } from './describePatch'
import { DIAGNOSIS_SPECTRUM } from '../data/diagnosisSpectrum'
import { resilient } from '../util/resilience'
import { isDegenerateOutput } from './degeneracy'

/** 本模块内的旧名（保持既有调用点不变）。 */
const isDegenerateVlm = isDegenerateOutput

/** 从 VLM 复核回复提取结论。
 *  ① 优先解析显式结论标签（prompt 要求「形态判定：支持/不支持/无法判断」开头，Patho-R1 可能用英文
 *     Conclusion: Supported）；`结论`/`判断`/`复核结果` 一并接受（Patho-R1 自变体），双保险。
 *  ② 无显式标签才用关键词启发式：先查否定（"未见浸润"语义是未见，须优先），再查肯定。
 *  Patho-R1 可能输出英文（intact / no evidence of invasion…），双语匹配。
 *  中性语义：`无法判断`/`难以判断`/`证据不足`/`不能判断`/`不确定` 一律落到【不确定】——
 *  与 isDualVerdictConflict 的「不确定视为中性，不算冲突」对齐（看清才判、看不清保持中性，不白给良性/恶性加码）。 */
export function extractVerdict(text: string): '支持' | '质疑' | '不确定' {
  const t = text.toLowerCase()
  // ① 显式结论标签（中文优先，英文兜底）
  const zh = t.match(/(?:结论|形态判定|判断|复核结果)\s*[:：]?\s*[：*_ ]*(支持|不支持|无法判断|难以判断|证据不足|不能判断|不确定|质疑)/)
  if (zh) {
    const v = zh[1]
    if (/不支持|质疑/.test(v)) return '质疑'
    if (/支持/.test(v)) return '支持'
    return '不确定' // 无法判断/难以判断/证据不足/不能判断/不确定 → 中性
  }
  const en = t.match(/conclusion\s*[:：]?\s*[：*_ ]*(supported|not supported|unsupported|inconclusive|cannot determine|not support|no)/)
  if (en) {
    const v = en[1]
    if (/not|un|inconclusive|cannot|no/.test(v)) return '质疑'
    return '支持'
  }
  // ② 关键词启发式
  if (
    /未见|未发现|未观察到|排除|不符合|不支持|矛盾|质疑|不一致|未见浸润|未见异型|未见癌|否定|inconclusive|not support|not consistent|no evidence|no sign|absence|contradict|intact|without|no invasion|no infiltration|no infiltrat|no malignant|no carcinoma/.test(t)
  )
    return '质疑'
  if (
    /支持|一致|证实|确认|符合|可见浸润|可见异型|见浸润|见异型|倾向于|提示.{0,10}(浸润|恶性|癌)|存在.{0,10}(浸润|异型|恶性)|support|consistent|confirm|eviden[ct].{0,15}(invasion|infiltrat)|stromal invasion|(invasion|infiltrat).{0,20}(present|seen|identified|obvious|found)/.test(t)
  )
    return '支持'
  return '不确定'
}

/** VLM 输出退化检测。判据已抽到 `tools/degeneracy.ts`（`describe_patch` 与 `verify_region` 共用一份），
 *  此处保留函数名以维持既有调用点不变。
 *  新版 = 旧骨架签名（原样保留）∪ 词元重复循环——贪心解码钩进循环后吐出的重复串，
 *  而 VLM 描述那条路（`describe_patch`）此前**完全没有检测**。 */
export { isDegenerateOutput as isDegenerateVlm } from './degeneracy'

/** 形态学 token 复用（与 isDegenerateVlm 的判定词一致）：用于"剥后剩余必须是有形态内容的正文"防误杀。
 *   VLM 若以诊断名开头（Fibroma. 等），剥掉后剩下的是形态正文；若正文无任何形态词（纯结论/纯空壳），
 *   说明诊断名本身就是全部，不该剥（还原），杜绝把"No evidence of malignancy."整句吞掉、也绝不动
 *   "single atypical cells infiltrating…"这类形态叙述。 */
const VERDICT_MORPH_RE =
  /nuclei|cell|gland|stroma|atypia|invasi|malign|adeno|reactive|benign|necro|mitos|epithel|cytoplasm|hyperchrom|polarity|desmoplas/i

/** 该文本是否含"形态学证据内容"（空形态检测用）。默认复用形态 token 词表；额外补常见中文形态词，
 *   避免把中文形态描述（镜下见异型细胞浸润…）误判为空形态而排除。Patho-R1 空壳输出（HE染色 包装 /
 *   HEPatch）英中文形态词均不含 → 判空，标记"无形态学证据"。 */
const CHINESE_MORPH_RE = /细胞|上皮|核分裂|异型|浸润|坏死|腺体|间质|分化|纤维|癌巢/i
/** "形态观察 token"表：与 VERDICT_MORPH_RE 同源，但**剔除极性/判读词**（malign/benign/reactive/adeno）——
 *  因为"恶性/良性/反应性"是诊断判读，不是镜下形态观察。这样 `No evidence of malignancy.` / `consistent with
 *  benign.` 这类裸判语（无任何形态观察）可判空 → 排除出证据包；而 `uniform small nuclei, no mitotic activity`
 *  有 nuclei/mitotic → 判有，绝不误排除。 */
const MORPH_EVIDENCE_RE =
  /nuclei|cell|gland|stroma|atypia|invasi|necro|mitos|epithel|cytoplasm|hyperchrom|polarity|desmoplas/i
export function hasMorphContent(text: string): boolean {
  return MORPH_EVIDENCE_RE.test(text) || CHINESE_MORPH_RE.test(text)
}

/** 构建"开头诊断名/裸判语"集合（小写）。优先接诊断谱 name/aliases（新增诊断自动覆盖），
 *   再 fallback 补齐谱中偏少、但 VLM 实测爱用为开头的良性名/裸判语。 */
function buildVerdictLeadSet(): Set<string> {
  const set = new Set<string>()
  for (const e of DIAGNOSIS_SPECTRUM) {
    if (e.name) set.add(e.name.toLowerCase())
    for (const a of e.aliases ?? []) set.add(a.toLowerCase())
  }
  for (const v of [
    'no evidence of malignancy', 'no malignant features', 'no lesions detected',
    'no evidence of neoplasia', 'no evidence of structural disruption',
    'no features suggestive of malignancy', 'no evidence of infiltrative growth',
    'benign lesion', 'malignant lesion', 'benign smooth muscle tumor',
    'fibroadenoma', 'fibroma', 'lymphoid hyperplasia', 'inflammatory pseudotumor',
    'leiomyoma', 'reactive lymphoid tissue',
  ]) set.add(v.toLowerCase())
  return set
}
let _verdictLeadSet: Set<string> | null = null
let _verdictLeadMembers: string[] = []
function verdictLeadSet(): Set<string> {
  if (!_verdictLeadSet) {
    _verdictLeadSet = buildVerdictLeadSet()
    _verdictLeadMembers = Array.from(_verdictLeadSet).sort((a, b) => b.length - a.length)
  }
  return _verdictLeadSet
}

/** 判断某子句是不是"开头诊断名/裸判语"。整句精确命中，或"以某成员开头 + 尾巴是连接词/无形态内容"。
 *   尾巴视为连接词条件=短（≤40）+ 不含形态 token——器官词/连接词（"of breast tissue"/"with typical features"）
 *   都不含形态词 → 允许剥；尾段若含形态词（如 "Adenocarcinoma, moderately differentiated, with glandular
 *   nests" 里的 glandular），说明是形态叙述句而非"诊断名+连接词"，原样保存。 */
function isVerdictLead(clause: string): boolean {
  const c = clause.toLowerCase().trim()
  if (!c) return false
  const set = verdictLeadSet()
  if (set.has(c)) return true
  for (const mem of _verdictLeadMembers) {
    if (c.startsWith(mem)) {
      const tail = c.slice(mem.length).trim()
      if (!tail || (tail.length <= 40 && !VERDICT_MORPH_RE.test(tail))) return true
    }
  }
  return false
}

/** 从 claim 剥离诊断结论前缀。Patho-R1 习惯以诊断判词开头——**Benign lesion** / **Confirmed malignancy**（粗体），
 *  或 **Fibroma.** / **Lymphoid hyperplasia.** / **No lesions detected.** / **Fibroadenoma of breast tissue.**
 *  （非粗体）。这类诊断结论一旦进证据节点，会以「高倍复核 + 诊断命名」的高权威外表，把 describe 里真实恶性
 *  形态信号洗成良性。这里只剥【开头的一个诊断/判读结论】，保留后面纯形态描述与
 *  正/负向形态证据；绝不剥正文形态词、绝不剥形态叙述引导语（The tissue shows / The image shows /
 *  This H&E-stained tissue section shows…），也不影响 extractVerdict（那是在 rawClaim 上提前提取的结论）。 */
const MAX_LEAD_STRIPS = 5 // 循环剥最多次数（链式判词头：**Benign lesion**: Fibroma. …）

/** 剥离一次开头的诊断/判读结论前缀：①粗体标签 ②非粗体诊断名/裸判语。命中且剥后安全才剥，否则原样返回
 *  （同一字符串引用），供外层循环判断是否终止。 */
function stripOneLead(text: string): string {
  // ① 开头粗体诊断/判读标签：剥标签 + 可选冒号
  const bold = text.match(
    /^\s*\*\*{1,3}\s*((?:良性|恶性|未见|无|正常|肿瘤|癌|肉瘤|病变|结论|形态判定|判读|复核结果|benign|confirmed|malignant|tumor|tumour|carcinoma|cancer|sarcoma|normal|lesion|conclusion|diagnosis|impression|correlate)[^\n*]{0,40}?)\s*\*\*{1,3}\s*[：:]?[.。:：,，;；]?\s*/i
  )
  if (bold) {
    const stripped = text.slice(bold[0].length).trim()
    if (stripped.length < 8 || /^[：:，,。.\s]+$/.test(stripped)) return text
    return stripped
  }
  // ② 开头非粗体诊断名/裸判语（到首个句号/冒号为止的子句），命中即剥。
  //   先剥【开头连接词/残渣】（基于镜下所见/考虑/思考中…等，非形态证据，剥了不疼）再判首子句，
  //   否则 "基于镜下所见，Fibroadenoma..." 会把前置吸进首子句 → isVerdictLead 的 startsWith 必失败 → 漏剥。
  //   分隔符仍【不含逗号】——正是它让 "Adenocarcinoma, moderately differentiated, with
  //   glandular nests" 作为一个整子句、尾巴含形态词→守卫拒绝→保护恶性形态描述不被误剥。
  const cleaned = text.replace(/^(?:基于镜下所见|镜下所见|图像显示|结合|综合|考虑|提示|该视野|本次|复核结果|形态判定[:：]?|结论[:：]?|判断[:：]?|印象[:：]?|思考中|thinking|brief analysis|analysis)[\s…·.：:，,、\n]*/i, '')
  const end = cleaned.search(/[。.:：;；\n]/)
  const clause = (end === -1 ? cleaned : cleaned.slice(0, end)).trim()
  if (!isVerdictLead(clause)) return text
  const rest = cleaned.slice(end === -1 ? cleaned.length : end + 1).trim()
  // 剥后剩余必须是有内容的正文，否则还原（防仅诊断名整句被吞）。
  //   注意：不核查形态 token——isVerdictLead 已通过"尾段含形态词则不剥"保护了形态叙述句，
  //   这里只需防"剥成空/纯标点"，避免把含单词碎片（如 "lymphocytes"/"follicular"）误判为无形态而不剥。
  if (rest.length < 8 || /^[：:，,。.\s]+$/.test(rest)) return text
  return rest
}

/** 循环剥离链式诊断结论前缀：Patho-R1 可能【粗体+非粗体】叠着写——
 *  `**Benign lesion**: Fibroma. The HE section…` / `**Conclusion: <长判词>**` 之后又跟一个非粗体诊断名，
 *  只剥第一层（粗体标签）会留下 `Fibroma.` / 二级判词头**继续当洗白头**（证据节点仍以高权威
 *  诊断名开头→二次洗白）。这里循环剥，直到开头不再是判词头（非命中返回原引用 → 终止）或剥满
 *  MAX_LEAD_STRIPS（防御性上限，真实链式最多 2-3 层）。每轮仍走同一套 isVerdictLead 尾巴形态守卫 +
 *  长度/纯标点还原守卫 → 形态叙述句依旧不误杀。 */
export function stripVerdictLead(text: string): string {
  let cur = text
  for (let i = 0; i < MAX_LEAD_STRIPS; i++) {
    const next = stripOneLead(cur)
    if (next === cur) break // 无判词头可剥 → 终止
    cur = next
  }
  return cur
}

/** verify 的完整独立 prompt（直发，跳过 describeWithVLM 公共模板）。纯形态问法——
 *  无"基于形态给出结论"（会把 7B 拽向诊断结论）、结论用三选一、明说非诊断、不命名具体诊断。
 *  双倍率（20×/40×）共用同一句，只把倍率数字代入。 */
export function verifyPrompt(question: string, mag: number): string {
  const q = question.trim()
  const sep = /[。！？!?.]$/.test(q) ? '' : '。' // 验证问题常以「？」结尾，模板再补「。」会出「？。」粘连，故有终标点则不补
  return `你在${mag}×下独立复核这张 HE 病理 patch，回答验证问题：${q}${sep}请客观描述镜下所见（细胞核大小/染色/极性、排列方式、异型性、间质、有无坏死/核分裂/浸润等形态学特征）。描述结束后，用「形态判定：支持 / 形态判定：不支持 / 形态判定：无法判断」开头（这里的"支持/不支持"指镜下形态是否支持验证问题所问的形态学特征，不是指某个诊断），随后简述理由。请只描述你实际看到的形态，不要猜测或命名具体诊断。`
}

/** 双倍率冲突判定：20× 与 40× 的 verdict 相反（支持 vs 质疑）时为真，仅在证据节点加轻量
 *  "两倍率结论不一致" 注记，不折叠成单一 verdict（决策 LLM 自整合）。不确定视为中性，不算冲突。 */
export function isDualVerdictConflict(
  v20: '支持' | '质疑' | '不确定',
  v40: '支持' | '质疑' | '不确定',
): boolean {
  return (v20 === '支持' && v40 === '质疑') || (v20 === '质疑' && v40 === '支持')
}

/** 区域复核：换高倍率（40×）重读 patch，用 Patho-R1 VLM 定向回答验证问题，判定支持/质疑原判断。
 *  真实路径：高倍 patch 真读写盘 → VLM 复核（复用 describeWithVLM）→ verdict 提取。
 *  降级：vLLM 不可用 → 规则匹配。 */
export const verifyRegionSpec: ToolSpec<typeof VerifyRegionSchema> = {
  name: 'verify_region',
  label: '区域高倍复核',
  description: '对 ROI 在更高倍率（40×）用病理 VLM 复核之前的判断，回答指定验证问题（如基底膜是否完整、有无间质浸润），输出支持/质疑结论。',
  parameters: Type.Object({
    region: RegionSchema,
    previous_judgment: Type.String(),
    verification_question: Type.String(),
  }),
  // nonDeterministic：一次调用真烧 2 次 VLM（20×+40×），且采样本身有诊断价值
  // （「换一个倍率再看一眼」是合法回路）→ 治理层只能 hint 不能 block。
  metadata: { category: 'verification', cacheable: false, idempotent: true, nonDeterministic: true, depends_on: ['inspect_region'], timeoutMs: 300_000 },
  execute: async (params, ctx) => {
    const { region } = params
    ensureWsi(ctx, region.slide_id)

    // ===== 真实路径：40× 真切高倍 patch + VLM 复核 =====
    const rw = realWsi(ctx, region.slide_id)
    if (rw) {
      try {
        const info = await rw.client.info(region.slide_id, ctx.signal)
        const objective = info.objective_power ?? 40
        const level20 = rw.client.levelForMagnification(info, objective, 20)
        const level40 = rw.client.levelForMagnification(info, objective, 40)
        // 同一物理中心，读 512×512。20× 窗口天然覆盖更大物理面积（组织结构/浸润模式背景），40× 给核细节。
        const size = 512
        const cx = Math.round(region.x + region.w / 2 - size / 2)
        const cy = Math.round(region.y + region.h / 2 - size / 2)
        const rvCancer = ctx.session.wsiRegistry.get(region.slide_id)?.cancer
        const specHint = specimenHintFor(region.slide_id, rvCancer)

        // 双倍率复核：同一 verification_question 在 20× 和 40× 各跑一遍，产出两条独立证据节点
        // （@20×/@40×），都进决策 LLM。只读 40× 会丢组织背景（VLM 易把反应性异型/良性梭形
        // 误读成良性诊断名）；20× 补组织模式（破坏性浸润/腺体结构），40× 补核细节，不折叠成一个 verdict。
        const runMag = async (mag: number, level: number) => {
          const patch: PatchRef = { id: `verify_${region.id}_${mag}`, region_id: region.id, slide_id: region.slide_id, x: cx, y: cy, size, magnification: mag }
          const [rel] = await cachePatches(rw.client, region.slide_id, [patch], level, ctx.signal)
          patch.cached_path = rel
          const prompt = verifyPrompt(params.verification_question, mag)
          let claim = ''
          let rawClaim = ''
          let verdict: '支持' | '质疑' | '不确定' = '不确定'
          let degenerateVlm = false
          let emptyMorph = false
          let vlm = true
          let degradedReal = false // VLM 不可用→规则模板（此分支必然是真 WSI，见 if (rw)）
          try {
            // 直发完整 prompt（第6参 promptOverride），跳过 describeWithVLM 公共模板（尾部"先分析后给出结论"诱导）
            // 第7参 ctx.signal：agent 中止/工具预算能掐断在途 VLM
            // 分端点计时 + 熔断（scope=当前 slide，超时类按片子分片）
            rawClaim = await resilient(
              { endpoint: 'vlm', op: 'verify', scope: ctx.session.currentWsiId, sink: ctx.session.metrics },
              () => describeWithVLM(patch, prompt, 90_000, 2048, specHint, prompt, ctx.signal),
            )
            ctx.session.metrics.recordVlm() // VLM 调用计数
            // VLM 退化：骨架重复循环。重试一次；仍退化则 degenerate（排除出投票/反事实）。
            if (isDegenerateVlm(rawClaim)) {
              console.warn(`[verify_region] VLM 输出退化（骨架重复），${mag}× 重试一次: ${region.id}`)
              rawClaim = await resilient(
                { endpoint: 'vlm', op: 'verify-retry', scope: ctx.session.currentWsiId, sink: ctx.session.metrics },
                () => describeWithVLM(patch, prompt, 90_000, 2048, specHint, prompt, ctx.signal),
              )
              ctx.session.metrics.recordVlm() // VLM 调用计数
              if (isDegenerateVlm(rawClaim)) {
                degenerateVlm = true
                verdict = '不确定'
                claim = 'VLM 输出退化（重复骨架、无诊断内容），无法作为验证证据，请换区域重读。'
              }
            }
            if (!degenerateVlm) {
              verdict = extractVerdict(rawClaim) // verdict 在摘要前从完整原始文本提取
              claim = stripVerdictLead(summarizeVlm(rawClaim)) // 剥开头诊断名/判语，防洗白
              if (!hasMorphContent(claim)) { // 空壳形态 → 无形态学证据，与退化同路排除出证据包
                emptyMorph = true
                verdict = '不确定'
                claim = '该视野无形态学证据（输出为空壳/仅核对信息），无法作为验证证据。'
              }
            }
          } catch (err) {
            vlm = false
            claim = fallbackClaim(params.verification_question, params.previous_judgment)
            verdict = claim.includes('支持') ? '支持' : claim.includes('质疑') ? '质疑' : '不确定'
            console.warn(`[verify_region] ${MODEL_LABEL} 不可用，${mag}× 降级规则复核：${err instanceof Error ? err.message : err}`)
            // ⚠️ fallbackClaim 是**按提问关键词查表**产出的模板（问"间质/浸润"就答"支持浸润性生长"），
            //    不是对这张高倍视野的观察。真 WSI 会话下必须出局投票——否则 VLM 一挂，全片复核统一变
            //    "支持浸润"，以 anchorConf('supportive')=0.75 灌进投票（确认偏置 + 良性模板洗白）。
            degradedReal = true
          }
          const invalid = degenerateVlm || emptyMorph
          // 规范锚点（anchors.ts）：支持→supportive(0.75)、质疑→uncertain(0.70)、无法判断→neutral(0.55)。
          // 规则降级（vlm=false）走同一锚点 +「不高于真 VLM 途径」。
          const confidence =
            verdict === '支持' ? anchorConf('supportive') : verdict === '质疑' ? anchorConf('uncertain') : anchorConf('neutral')
          return { patch, claim, rawClaim, verdict, confidence, vlm, invalid, degenerateVlm, emptyMorph, degradedReal }
        }

        const r20 = await runMag(20, level20)
        const r40 = await runMag(40, level40)
        // 轻量 conflict 注记：两倍率 verdict 相反（支持 vs 质疑）时标记，但不折叠成一个 verdict —— 决策 LLM 自整合。
        const conflict = isDualVerdictConflict(r20.verdict, r40.verdict)
        const conflictNote = conflict ? '，两倍率结论不一致' : ''

        const emit = (magResult: typeof r20, mag: number) => {
          const invLabel = magResult.degenerateVlm ? '，VLM 退化' : magResult.emptyMorph ? '，无形态学证据' : ''
          addEvidence(ctx, 'observation', `复核 ${region.id} @${mag}×：${magResult.claim}（${magResult.verdict}，${magResult.vlm ? MODEL_LABEL : '规则降级'}${invLabel}${conflictNote}）`, magResult.confidence, 'verify_region', {
            coords: region,
            magnification: mag,
            model: magResult.vlm ? VLLM_MODEL : 'rule',
            ...(magResult.vlm && magResult.rawClaim ? { raw: magResult.rawClaim } : {}),
            ...(magResult.invalid ? { degenerate: true } : {}),
            // 规则模板降级 → 出投票（此分支必然真 WSI，故无需 mock 豁免）+ 打 fallback 标供观测
            ...(magResult.degradedReal ? { fallback: true, stub: true } : {}),
          })
        }
        emit(r20, 20)
        emit(r40, 40)

        // details 兼容旧字段（脚本读 verdict/claim/vlm/confidence），映射到 40×（原始主倍率）；另加双倍率字段
        const bothInvalid = r20.invalid && r40.invalid
        return {
          text: `[verify_region] ${region.id} 双倍率复核（20×+40×）：\n  • 20× → ${r20.verdict}（conf=${r20.confidence}）: ${r20.claim}${r20.vlm ? '' : '（⚠️ vLLM 不可用降级）'}${r20.degenerateVlm ? '（⚠️ 退化）' : r20.emptyMorph ? '（⚠️ 无形态学证据）' : ''}\n  • 40× → ${r40.verdict}（conf=${r40.confidence}）: ${r40.claim}${r40.vlm ? '' : '（⚠️ vLLM 不可用降级）'}${r40.degenerateVlm ? '（⚠️ 退化）' : r40.emptyMorph ? '（⚠️ 无形态学证据）' : ''}${conflict ? '\n  ⚠️ 两倍率结论不一致（20× 与 40× 相反），建议结合组织背景综合判断。' : ''}`,
          details: { region, claim: r40.claim, verdict: r40.verdict, confidence: r40.confidence, vlm: r40.vlm, degenerate: bothInvalid, verdict20: r20.verdict, verdict40: r40.verdict, confidence20: r20.confidence, confidence40: r40.confidence, claim20: r20.claim, claim40: r40.claim, vlm20: r20.vlm, vlm40: r40.vlm, conflict, isDualMag: true },
        }
      } catch (e) {
        if (!ctx.session.wsiCache.has(region.slide_id)) {
          throw new Error(`WSI 桥接不可用（${e instanceof Error ? e.message : e}）且无 mock 数据。`)
        }
        // 桥接异常 → 回落 mock 规则路径
      }
    }

    // ===== mock/规则路径（无真实 WSI 或 VLM 不可用）=====
    const q = params.verification_question
    const claim = fallbackClaim(q, params.previous_judgment)
    // mock 路径（无真 WSI）置信不得高于真 VLM 途径：统一 supportive 上限（0.75）。
    const confidence = anchorConf('supportive')
    // 与 runMag 内的规则降级、describe_patch 的降级模板一致：`fallbackClaim` 是按提问关键词查表的
    // 模板，**不是对这张图的观察**。本分支有两条来路：① 纯 mock 会话（realWsi=null）；② 真 WSI 会话但桥接异常
    // → 上面那个 catch 里没再抛（slide 在 wsiCache 里）就落到这里。真片 + 桥挂 → 全片复核
    // 统一变模板且照常投票。故真 WSI 时标 stub 出局；纯 mock 会话保持可投票（smoke 回归门，同 describe_patch）。
    const degradedReal = realWsi(ctx, region.slide_id) !== null
    addEvidence(ctx, 'observation', `复核 ${region.id} @40×：${claim}`, confidence, 'verify_region', {
      coords: region,
      magnification: 40,
      model: 'rule',
      ...(degradedReal ? { fallback: true, stub: true } : { fallback: true }),
    })
    return {
      text: `[verify_region] ${region.id} @40×: ${claim}（conf=${confidence}）`,
      details: { region, claim, confidence },
    }
  },
}

/** 规则复核（vLLM 不可用 / 无真实 WSI 时）。不带 previousJudgment 诊断名（防 ruleMatch 捕获 → 误判），
 *  只返回验证问题所问的具体形态观察结果。 */
function fallbackClaim(verificationQuestion: string, _previousJudgment: string): string {
  if (/基底膜|浸润|间质/.test(verificationQuestion)) return '基底膜局部断裂，间质见异型细胞巢 → 支持浸润性生长'
  if (/核分裂|有丝分裂/.test(verificationQuestion)) return '异型细胞核分裂象易见（约 7-8/10 HPF）'
  return '高倍镜下未见明确异型细胞浸润，形态支持良性/反应性改变'
}

export const VerifyRegionSchema = Type.Object({
  region: RegionSchema,
  previous_judgment: Type.String(),
  verification_question: Type.String(),
})
export type VerifyRegionParams = Static<typeof VerifyRegionSchema>
