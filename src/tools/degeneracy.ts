/**
 * VLM 输出退化的统一判据。
 *
 * 背景：病理推理 VLM（Patho-R1）是**贪心解码**（temp=0），一旦在某张图上钩进重复循环就必然吐出
 * 一整段循环文本，不会自愈。实测形态有两类：
 *  ① 步进骨架循环：`**Step 1: Screening** … **Step 6/7/8** …`（撞 max_tokens 停）；
 *  ② 词元循环：`不等样不等样不等样×62`、`3-4 重要举措×58`、`核对称性：细胞对称性.×N`、
 *     `不不不不×300`、`>10/HPF, 10-20% 3-4 重要举措 >20/HPF…`（计数式递增循环）。
 *
 * 这两类输出**不含任何形态信息**，若当证据用，等于往投票里灌噪声。此前的检测只认①的强签名，
 * 且带一个过宽的「含形态词就放行」逃生口——②全部漏网；而 VLM 描述那条路
 * （`describe_patch`）**完全没有检测**。
 *
 * 设计取向：**宁可漏检、不可误伤**。把一条真实形态描述误判成退化 = 静默丢掉真实证据，
 * 比漏掉一条退化更坏（前者不可见，后者只是噪声）。因此两条判据都取高精度侧：
 *  - 判据 A（全局 n-gram 去重率）在实测分布上分离清晰：正常叙述的去重率接近 1，
 *    而肉眼可确认的退化条目全部落在 0.3 以下。阈值取 0.35，落在空档里。
 *  - 判据 B（连续重复游程）只认「同一短单元**紧邻**重复 ≥6 次且覆盖正文 ≥60%」，
 *    正常叙述里不可能出现。
 */

/** 判据 A 的阈值。**改这个数等于移动精度/召回的分界线，必须拿存量 claim 回放复核**。 */
export const REPEAT_RATIO_THRESHOLD = 0.35
/** 判据 A 的 n-gram 长度。太长则长文天然去重率高、太短则自然复读误报。 */
const NGRAM = 8
/** 短于这个长度的正文不做判据 A——样本太短，比率噪声大。 */
const MIN_LEN_FOR_RATIO = 120

/** 判据 A：全局 n-gram 去重率。退化文本由极少数短单元反复拼成 → 去重率塌陷。 */
export function distinctNgramRatio(text: string, k = NGRAM): number {
  const t = text.replace(/\s+/g, '')
  if (t.length < k + 1) return 1
  const grams = new Set<string>()
  let total = 0
  for (let i = 0; i + k <= t.length; i++) {
    grams.add(t.slice(i, i + k))
    total++
  }
  return grams.size / total
}

/** 判据 B：最长「紧邻重复游程」占正文的比重。
 *  对每个单元长度 L∈[2,24] 找 `unit` 使 `unit` 连续重复次数 c 最大，取 `(c-1)*L / len` 的最大值。
 *  只关心**紧邻**重复——正常的段落式复述（`细胞核…细胞质…细胞核…`）不会连着重来。 */
export function maxRepeatRunRatio(text: string): number {
  const t = text.replace(/\s+/g, '')
  const n = t.length
  if (n < 40) return 0
  let best = 0
  for (let L = 2; L <= 24; L++) {
    let i = 0
    while (i + L <= n) {
      const unit = t.slice(i, i + L)
      // 快速排除：单元自身若是单字符/双字符的全重复，交给更短的 L 处理
      let c = 1
      let j = i + L
      while (j + L <= n && t.slice(j, j + L) === unit) {
        c++
        j += L
      }
      if (c >= 6) {
        const cover = ((c - 1) * L) / n
        if (cover > best) best = cover
      }
      i += 1
    }
  }
  return best
}

/** 判据 B 的阈值：紧邻重复覆盖正文 ≥60%。 */
export const REPEAT_RUN_THRESHOLD = 0.6

/** 词元/骨架级重复退化（判据 A + B）。**不**包含标点、长度等形态学判读——只判"这段文本是不是在打转"。 */
export function isRepetitionDegenerate(text: string): boolean {
  const t = text.replace(/\s+/g, '')
  if (t.length < 40) return false
  if (maxRepeatRunRatio(t) >= REPEAT_RUN_THRESHOLD) return true
  if (t.length >= MIN_LEN_FOR_RATIO && distinctNgramRatio(t) < REPEAT_RATIO_THRESHOLD) return true
  return false
}

/** 骨架签名（`verify_region` 的既有判据，**原样保留**）。
 *  ① 强签名：重复的 "Extended Report Output"——退化循环的独特后缀；
 *  ② 弱签名：≥8 个 Step 标签**且**几乎不含形态学词（纯骨架）。
 *  ⚠️ ②的逃生口偏宽：骨架循环里若前几句恰好含 nuclei/gland，就会放行。保留不动是为了**行为不回退**
 *  ——新增的 A/B 判据在它之外叠加，最终 `isDegenerateOutput` 严格严于旧判据。 */
export function isScaffoldDegenerate(text: string): boolean {
  if (!text) return false
  if ((text.match(/Extended Report Output/g) ?? []).length >= 3) return true
  const steps = (text.match(/\*\*Step \d+[^\n]*?\*\*/g) ?? []).length
  if (
    steps >= 8 &&
    !/nuclei|cell|gland|stroma|atypia|invasi|malign|adeno|reactive|benign|necro|mitos|epithel|cytoplasm|hyperchrom|polarity|desmoplas/i.test(text)
  ) {
    return true
  }
  return false
}

/** 是否退化。与 `hasMorphContent` 的关系：这个函数判"输出在打转"，`hasMorphContent` 判"有没有说形态"。
 *  两者独立，调用方按需组合（`describe_patch` 只判退化；`verify_region` 两个都判）。
 *  **严格严于旧版 `isDegenerateVlm`**：旧判据是它的子集，故无行为回退风险。 */
export function isDegenerateOutput(text: string): boolean {
  if (!text) return false
  return isScaffoldDegenerate(text) || isRepetitionDegenerate(text)
}
