/**
 * 用户中文问题 → PLIP 英文文本查询（CLIP 式零样本检索）。
 * PLIP 的文本塔以英文生物医学文本训练，中文问题不能直接喂，需先映射成病理术语提示。
 */

const LEXICON: Array<[RegExp, string[]]> = [
  [/浸润|癌|恶性|肿瘤/, ['invasive carcinoma', 'carcinoma', 'malignant tumor', 'cancer tissue']],
  [/有丝分裂|核分裂|分裂象/, ['mitotic figures', 'mitosis', 'mitotic activity']],
  [/异型|不典型|非典型|异形/, ['atypical cells', 'cellular atypia', 'dysplastic cells']],
  [/导管/, ['ductal carcinoma in situ', 'ductal epithelium']],
  [/小叶/, ['lobular carcinoma', 'lobular structures']],
  [/核深染|深染/, ['hyperchromatic nuclei']],
  [/坏死/, ['tumor necrosis', 'necrotic tissue']],
  [/炎症|炎性|淋巴/, ['lymphocytic infiltration', 'inflammation']],
  [/间质|浸润性生长/, ['tumor stroma', 'stromal invasion']],
  [/良性|增生/, ['benign hyperplasia', 'reactive changes']],
  [/小细胞/, ['small cell carcinoma', 'small round blue cells']],
  [/肺/, ['lung tissue', 'pulmonary carcinoma']],
  [/乳腺|乳房/, ['breast tissue', 'mammary carcinoma']],
  [/甲状腺/, ['thyroid tissue', 'papillary thyroid carcinoma']],
  [/卵巢/, ['ovarian tissue', 'serous carcinoma']],
  [/鳞状/, ['squamous cell carcinoma']],
  [/腺癌|腺体/, ['adenocarcinoma', 'glandular structures']],
  [/黏液|粘液/, ['mucinous carcinoma']],
]

// 默认（开放问题"这是什么病变"无特定词命中）查询词用**中性**表述，避免"一上来就找癌"的确认偏误；
// 让模型自己判断良恶性方向。specific 查询词仍由 LEXICON 命中（用户明确问某癌种时才恶性化）。
const DEFAULT_QUERIES = ['lesion', 'abnormal tissue', 'tissue architecture']

/** 问题 → PLIP 文本查询列表（命中词典项就并进去，否则用默认泛癌提示）。 */
export function questionToPlipQueries(question: string): string[] {
  const hits = new Set<string>()
  for (const [re, queries] of LEXICON) {
    if (re.test(question)) for (const q of queries) hits.add(q)
  }
  if (hits.size === 0) return [...DEFAULT_QUERIES]
  return [...hits]
}

/** 图片×文本余弦相似度矩阵 → 每张图对全部查询的最大相似度（0-1）。 */
export function maxTextSimilarity(imageVectors: number[][], textVectors: number[][]): number[] {
  return imageVectors.map((img) => {
    let best = -1
    for (const txt of textVectors) {
      let dot = 0
      for (let i = 0; i < img.length; i++) dot += img[i] * txt[i]
      if (dot > best) best = dot
    }
    return best
  })
}
