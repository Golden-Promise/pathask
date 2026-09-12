/**
 * claim → 归纳句 gist 提取（2026-09-08，上下文压缩的数据来源）。
 *
 * 用途：compactContext 折返旧 turn 时，把已入库的证据节点压缩成一行 gist
 *   `[ev-N] describe_patch @(x,y) 20×: <归纳句>`。
 *
 * 为什么不 slice(0,80)（旧 compactContext.ts:74）：VLM claim 固定结构 =
 *   形态描述主体 + 末尾归纳句 + IHC 套话尾巴。归纳句（"These features suggest a neoplastic
 *   process…"）——ruleMatch/genericScore 赖以打票的通用倾向信号——**永远在末尾**，旧 slice 从
 *   头取 80 字恰好把它切掉。而"but definitive classification requires IHC…"这类套话是训化模板，
 *   零形态信息，只白占 token。
 *
 * 方法：定位末尾归纳句（SUMMARY_RE 锚定），剥其后的 IHC 建议尾巴，取这一句作为 gist。
 *
 * 语义边界（重要）：只做「提取+去套话」，不做「倾向修正」。归纳句里的 benign/malignant 是 VLM 读出的
 * 形态印象，**不是确诊**；下游 ruleMatch/negation/polarity/决策 LLM 仍须校验。gist 只服务编排历史
 * 让 agent 别重跑，不向决策层注入任何"已判定"表象 —— 因此这里**不产 conf、不产 polarity**。
 */

/** 末尾归纳句定位词：VLM 对整体形态的倾向总结（信息价值最高）。 */
const SUMMARY_RE = /these\s+(?:features|findings|cells|changes)|the\s+combination|suggest[s]?\s+a|consistent\s+with\s+a|raises?\s+suspicion|favor[s]?\s+a|impression\s*[:：]/i

/**
 * 从单条 VLM claim 提取末尾归纳句。找不到归纳句（非标准模板）时返回空串——
 * 调用方（compactContext）按"无法定位归纳句"走旧 slice 兜底，而不是硬造一句。
 */
export function summaryGist(claim: string): string {
  const m = claim.match(SUMMARY_RE)
  if (!m || m.index === undefined) return ''
  let tail = claim.slice(m.index)
  // 1) 先到句末（. ）截断：归纳句总在某句结尾。
  const end = tail.search(/[.!?]\s/)
  const frag = end >= 0 ? tail.slice(0, end) : tail
  // 2) 弱化/转折截断：归纳句走到倾向句核心后，剥掉后续拖带（"but/though + IHC 建议" 或 ", the absence of / which …"）。
  //    Patho-R1 模板常把倾向句写成 "suggests a neoplastic process, THE ABSENCE OF overtly infiltrative growth
  //    limits definitive classification" —— 后者是弱化从句（信息零/反向），会在片外把倾向稀释掉，必须剥到
  //    "suggests a neoplastic process"（倾向信号主体）。实测 24 个真实 describe：未剥时此句塞进 gist 12 次。
  const cut = frag.search(/,\s*(?:the\s+absence\s+of|which\s)|\s+(?:but|however|though|although)\b/i)
  const out = cut >= 0 ? frag.slice(0, cut) : frag
  // 去尾句号/逗号/多余空白
  return out.replace(/\.+$/, '').replace(/,\s*$/, '').replace(/\s+/g, ' ').trim()
}

/** 完整 gist 行：`[id] tool 溯源: 归纳句`。id/tool/溯源由调用方（compactContext）拼，此处只给归纳句。 */
export function matchSummarySentence(claim: string): boolean {
  return SUMMARY_RE.test(claim)
}
