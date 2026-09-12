import type { Cancer } from '../types'

// ============================================================================
// 诊断谱（DIAGNOSIS_SPECTRUM）：每个器官的"完整可能诊断空间"（宽候选）
// ============================================================================
// 目的：决策 LLM 的 organHint 从"窄候选短名单(2-4项)"放宽到"该器官完整诊断谱"，
//   让 LLM 凭形态证据在这个空间里收敛主诊断/鉴别，而非窄名单"小抄"式先验。
//
// 关键约束：
//  1. name 必须对齐 gold.diagnosis_accept 的规范中文名。
//     括号后缀（如 浸润性导管癌（IDC））仅当底术语存活为子串时安全。
//  2. aliases = 同病异写 + 中英 + 缩写 + differential_gold 英文(toZh 对齐)。
//  3. evTokens = 正性形态学/组织学 token（VLM 输出偏英文形态学），否定感知证据门用它。
//  4. siteNeutral = 无固有部位诊断（小细胞癌/淋巴瘤/转移性癌/腺样囊性癌/良性反应性），
//     可与任意器官共存，spectrumFor(organ) 恒包含。
//  5. rule 路径（DIAGNOSIS_RULES/DIAGNOSIS_SITE/CANCER_DIAGNOSIS）字节不变；
//     本谱只被 llm 决策路径消费。

export type Polarity = 'malignant' | 'benign' | 'premalignant' | 'neutral'

export interface SpectrumEntry {
  /** 有固有部位的诊断 → 该器官键；无固有部位 → 省略 + siteNeutral。 */
  organ?: Cancer
  /** 可与任意器官共存的诊断（小细胞癌/淋巴瘤/转移性癌/腺样囊性癌/良性反应性等）。 */
  siteNeutral?: true
  /** 规范中文诊断名（对齐 gold.diagnosis_accept），作为主诊断/鉴别展示名。 */
  name: string
  /** 别名：同病异写 + 中英 + 缩写 + GT 各写法（含 toZh 英文形式）。 */
  aliases: string[]
  /** 良恶性极性（审计用；运行时经诊断名判，不落 Report 契约）。 */
  polarity: Polarity
  /** 正性形态学/组织学特征 token（VLM 形态输出多为英文）。证据门命中即算支持。 */
  evTokens: string[]
  /** 所属「抽象家族」根（family root）的规范名——siteNeutral 泛名（淋巴瘤/小细胞癌/浸润性癌等）指向其具体亚型。
      仅用于分层评分（full vs family），非展示/证据门逻辑。 */
  familyOf?: string
}

export const DIAGNOSIS_SPECTRUM: SpectrumEntry[] = [
  // ─────────────────────────── 无固有部位（site-neutral）────────────────────
  // name 用「小细胞癌」；「小细胞肺癌」单列为 lung 入口，避免与 siteNeutral 共用名导致 index 覆盖。
  // 分层评分：siteNeutral「小细胞癌」是 family root，具体亚型「小细胞肺癌」familyOf 指向它 → 泛答算 family 层。
  {
    siteNeutral: true, name: '小细胞癌', polarity: 'malignant',
    aliases: ['小细胞癌（SCLC）', '小细胞瘤', 'small cell carcinoma', 'small cell lung carcinoma', 'sclc', 'small cell', '燕麦细胞癌', 'oat cell carcinoma'],
    evTokens: ['small cell', 'sclc', 'oat cell', '核质比高', '小细胞', '栅栏样', '铸型', 'pile up', 'diffuse hyperchromatic'],
  },
  {
    siteNeutral: true, name: '淋巴瘤', polarity: 'malignant',
    aliases: ['恶性淋巴瘤', 'lymphoma', 'malignant lymphoma'],
    evTokens: ['lymphoma', '淋巴瘤', 'lymphoid', 'abnormal lymphoid', 'atypical lymphocytes', '克隆性'],
  },
  {
    siteNeutral: true, name: '转移性癌', polarity: 'malignant',
    aliases: ['转移癌', 'metastatic carcinoma', 'metastatic tumor', 'metastatic neoplasm', 'metastasis', '癌转移', '转移性肿瘤', '乳腺癌转移', '卵巢转移性乳腺癌', 'metastasis of breast carcinoma', '乳腺癌卵巢转移', '卵巢癌转移'],
    evTokens: ['metastas', '转移', '继发', 'secondary deposit', 'colorectal metastasis', 'breast metastasis'],
  },
  {
    siteNeutral: true, name: '腺样囊性癌', polarity: 'malignant',
    aliases: ['adenoid cystic carcinoma', 'adenoid cystic', 'acc'],
    evTokens: ['adenoid cystic', '筛孔', '圆柱瘤', 'cribriform', 'cylindroma', 'cut-glass', 'pseudocystic'],
  },
  {
    siteNeutral: true, name: '良性/反应性病变', polarity: 'benign',
    aliases: ['良性病变', '反应性病变', '良性', '反应性', 'benign lesion', 'reactive change', 'reactive', 'benign'],
    evTokens: ['benign', 'reactive', '良性', '反应性', '未见异型', '未见异型性', 'intact', 'base membrane intact', 'no evidence of invasion', '细胞温和', '纤维上皮', '未见癌', 'benign lesion'],
  },

  // ─────────────────────────── breast ─────────────────────────────
  { organ: 'breast', name: '浸润性导管癌（IDC）', polarity: 'malignant', familyOf: '浸润性癌',
    aliases: ['浸润性导管癌', 'invasive ductal carcinoma', 'idc', 'invasive ductal', 'ductal carcinoma', 'infiltrating ductal carcinoma', '浸润性浸润导管癌'],
    evTokens: ['invasive ductal', 'ductal carcinoma', 'glandular crowding', 'infiltrative', '基底膜断裂', 'invasive', 'pleomorphic cells'] },
  { organ: 'breast', name: '浸润性小叶癌（ILC）', polarity: 'malignant', familyOf: '浸润性癌',
    aliases: ['浸润性小叶癌', 'invasive lobular carcinoma', 'lobular carcinoma', 'infiltrating lobular', 'ilc'],
    evTokens: ['invasive lobular', 'lobular carcinoma', 'single filing', '单列样', 'indian file', '靶环', 'signet ring cells', 'cohesive cells'] },
  { organ: 'breast', name: '导管原位癌', polarity: 'premalignant',
    aliases: ['导管原位癌', 'dcis', 'ductal carcinoma in situ', 'intraductal carcinoma', '导管内癌', 'intraductal'],
    evTokens: ['dcis', 'ductal carcinoma in situ', 'intraductal', 'clinging carcinoma', '粉刺样', 'comedo', 'cribriform'] },
  { organ: 'breast', name: '非典型导管增生', polarity: 'premalignant',
    aliases: ['不典型导管增生', 'atypical ductal hyperplasia', 'adh', '非典型增生'],
    evTokens: ['atypical ductal hyperplasia', 'adh', 'atypia', 'ductal hyperplasia with atypia', 'clonal ductal proliferation'] },
  { organ: 'breast', name: '纤维腺瘤', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['纤维腺瘤', 'fibroadenoma', 'fibroepithelial', 'fibroepithelial lesion'],
    evTokens: ['fibroadenoma', '纤维腺瘤', 'fibroepithelial', 'biphasic', 'stroma', 'cohesive', 'well-circumscribed'] },
  { organ: 'breast', name: '浸润性癌', polarity: 'malignant',
    aliases: ['invasive carcinoma', '浸润癌', 'invasive breast carcinoma', 'invasive cancer (nos)'],
    evTokens: ['invasive carcinoma', 'infiltrating', 'invasive cancer', 'glandular crowding', 'pleomorphic', 'invasive'] },
  { organ: 'breast', name: '保守性乳腺病变', polarity: 'neutral',
    aliases: ['乳腺增生', 'fibrocystic', '乳腺纤维囊性变', 'fibrocystic change', '良性乳腺病变', 'adenosis', '硬化性腺病'],
    evTokens: ['fibrocystic', '腺病', 'adenosis', 'sclerosing adenosis', 'cystic', '导管扩张', 'duct ectasia'] },

  // ─────────────────────────── thyroid（预留粗覆盖）────────────────────────
  { organ: 'thyroid', name: '甲状腺乳头状癌', polarity: 'malignant',
    aliases: ['papillary thyroid carcinoma', 'ptc', '乳头状癌', '甲状腺乳头状', 'papillary carcinoma'],
    evTokens: ['papillary thyroid', 'papillary carcinoma', 'orphan annie', 'nuclear grooves', 'papillary', 'psammoma'] },
  { organ: 'thyroid', name: '甲状腺滤泡性病变', polarity: 'neutral',
    aliases: ['甲状腺滤泡性癌', '滤泡性癌', 'follicular carcinoma', 'follicular neoplasm', '滤泡性腺瘤', 'follicular adenoma', '甲状腺结节'],
    evTokens: ['follicular', 'thyroid', '滤泡', 'colloid'] },
  { organ: 'thyroid', name: '桥本甲状腺炎', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['hashimoto', 'hashimoto thyroiditis', '桥本', '淋巴细胞性甲状腺炎', 'lymphocytic thyroiditis'],
    evTokens: ['hashimoto', 'lymphocytic thyroiditis', 'hurthle', 'hurthle cells', 'lymphocytic infiltrate'] },

  // ─────────────────────────── ovary ───────────────────────────────
  // HGSC/高级别浆液/ovarian serous 各写法全部收为别名，LLM 无论怎么输出都归一到「卵巢浆液性癌」。
  { organ: 'ovary', name: '卵巢浆液性癌', polarity: 'malignant',
    aliases: [
      '卵巢浆液性腺癌', '卵巢癌（HGSC）', '卵巢高级别浆液性癌', '卵巢高级别浆液性腺癌', '高级别浆液性卵巢癌',
      'serous carcinoma', 'serous adenocarcinoma', 'ovarian serous', 'ovarian serous carcinoma',
      'high grade serous carcinoma', 'high-grade serous carcinoma', 'hgsc', '高浆液性卵巢癌', '浆液性癌', '高级别浆液性癌',
    ],
    evTokens: ['serous', '浆液', 'psammoma', 'papillary', 'granular', 'hgsc', 'hobnail', 'high grade serous'] },
  { organ: 'ovary', name: '未成熟畸胎瘤', polarity: 'malignant',
    aliases: ['immature teratoma', '未成熟畸胎瘤', 'teratoma'],
    evTokens: ['immature teratoma', 'teratoma', '畸胎', '神经管', 'neurotubules', 'embryonal'] },
  { organ: 'ovary', name: '成熟囊性畸胎瘤', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['成熟畸胎瘤', 'mature teratoma', 'dermoid', 'dermoid cyst', '成熟囊性畸胎瘤'],
    evTokens: ['mature teratoma', 'dermoid', 'endodermal', 'sebaceous', 'mature somatic'] },
  { organ: 'ovary', name: '卵巢子宫内膜样腺癌', polarity: 'malignant',
    aliases: ['endometrioid carcinoma', '卵巢子宫内膜样癌', 'endometrioid adenocarcinoma', 'ovarian endometrioid'],
    evTokens: ['endometrioid', '子宫内膜样', 'squamous metaplasia'] },
  { organ: 'ovary', name: '卵巢纤维瘤', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['ovarian fibrothecoma', 'fibrothecoma', 'thecoma', '卵巢纤维瘤', '性索间质肿瘤'],
    evTokens: ['fibrothecoma', 'thecoma', 'spindle cells', 'fibroma', 'whorled'] },
  { organ: 'ovary', name: '卵巢子宫内膜异位囊肿', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['endometriotic cyst', 'endometrioma', '子宫内膜异位囊肿', '巧克力囊肿', 'ovarian endometriosis', 'corpus luteum cyst'],
    evTokens: ['endometrioma', 'endometriotic', 'chocolate cyst', 'corpus luteum', '子宫内膜间质', 'hemosiderin'] },

  // ─────────────────────────── stomach ─────────────────────────────
  // 「胃癌」与「胃腺癌」非子串关系，且独立 gold → 须单独成 entry。
  { organ: 'stomach', name: '胃腺癌', polarity: 'malignant',
    aliases: ['胃低分化腺癌', 'gastric carcinoma', 'gastric adenocarcinoma', 'stomach adenocarcinoma', 'stomach cancer', 'low-grade gastric adenocarcinoma', '低分化胃腺癌', '弥漫型胃癌', '弥漫性胃癌', '弥漫型胃腺癌', 'diffuse gastric adenocarcinoma', 'poorly differentiated gastric adenocarcinoma'],
    evTokens: ['gastric', 'gastric carcinoma', '腺癌', 'adenocarcinoma', 'signet', '印戒', 'intestinal metaplasia', 'mucin', 'poorly differentiated', 'single cells'] },
  { organ: 'stomach', name: '胃癌', polarity: 'malignant',
    aliases: ['gastric carcinoma', 'gastric cancer', 'stomach cancer', 'stomach carcinoma'],
    evTokens: ['gastric', 'stomach', '腺癌', 'adenocarcinoma', 'signet', '印戒'] },
  { organ: 'stomach', name: '慢性胃炎', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['慢性萎缩性胃炎', 'gastritis', 'chronic gastritis', '胃炎', '慢性炎性性胃炎'],
    evTokens: ['gastritis', '胃炎', 'chronic inflammation', 'lymphoplasmacytic', 'atrophic', 'metaplasia', '慢性炎症细胞浸润'] },
  { organ: 'stomach', name: '管状腺瘤', polarity: 'premalignant',
    aliases: ['tubular adenoma', '胃管状腺瘤', '腺瘤'],
    evTokens: ['tubular adenoma', '腺瘤', 'adenoma', 'dysplastic', 'dysplasia', '背靠背', 'adenomatous'] },
  { organ: 'stomach', name: '息肉样小凹增生', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['胃息肉样增生', '胃息肉', 'polypoid foveolar hyperplasia', 'foveolar hyperplasia', 'hyperplastic polyp', 'hyperplastic polyp', '小凹增生', '增生性息肉'],
    evTokens: ['foveolar', 'hyperplastic polyp', '小凹', 'hyperplasia', 'polypoid', 'foveolar hyperplasia'] },
  { organ: 'stomach', name: '多原发癌', polarity: 'malignant',
    aliases: ['多原发癌', 'multiple primary carcinoma', 'multiple malignancies', 'double primary'],
    evTokens: ['multifocal', 'multiple primary', 'multicentric', 'multiple lesions', '多原发'] },
  { organ: 'stomach', name: '胃肠间质瘤（GIST）', polarity: 'malignant',
    aliases: ['胃肠道间质瘤', 'gist', 'gastrointestinal stromal tumor'],
    evTokens: ['gist', 'spindle cells', 'gastrointestinal stromal', 'cd117', 'kitt'] },

  // ─────────────────────────── colon ────────────────────────────────
  { organ: 'colon', name: '结直肠癌', polarity: 'malignant',
    aliases: ['结直肠腺癌', 'colorectal carcinoma', 'colorectal adenocarcinoma', 'colorectal cancer', '直肠癌', 'colon adenocarcinoma', 'colorectal cancer metastasis', '肝转移性结直肠癌', '结直肠癌肝转移', '转移性结直肠癌', '同步性结直肠癌', 'synchronous colorectal', 'liver metastasis of colorectal cancer', 'colorectal adenocarcinoma metastasis'],
    evTokens: ['colonic adenocarcinoma', 'adenocarcinoma', 'mucin', 'carcinoma', '神经内分泌', 'nuclear atypia'] },
  { organ: 'colon', name: '结肠癌', polarity: 'malignant',
    aliases: ['colon carcinoma', 'colon cancer', '结肠腺癌', 'colon adenocarcinoma', '结肠腺癌'],
    evTokens: ['adenocarcinoma', 'carcinoma'] },
  { organ: 'colon', name: '管状腺瘤', polarity: 'premalignant',
    aliases: ['管状腺瘤（良性）', 'tubular adenoma', '结肠管状腺瘤', '腺瘤', '结肠腺瘤'],
    evTokens: ['tubular adenoma', '管状腺瘤', 'adenoma', 'dysplasia', '背靠背', '腺瘤', 'adenomatous'] },
  { organ: 'colon', name: '慢性结肠炎', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['慢性结肠炎', 'chronic colitis', '溃疡性结肠炎', 'ulcerative colitis', '慢性炎症性结肠炎', '缺血性结肠炎'],
    evTokens: ['colitis', '结肠炎', 'chronic inflammation', '溃疡', 'cryptitis', 'crypt abscess', 'goblet cell loss', 'lymphoplasmacytic'] },
  { organ: 'colon', name: '绒毛状腺瘤', polarity: 'premalignant',
    aliases: ['villous adenoma', '绒毛状腺瘤', 'tubulovillous adenoma', '管状绒毛状腺瘤'],
    evTokens: ['villous', '绒毛状', 'tubulovillous', 'frond', 'dysplasia'] },
  { organ: 'colon', name: '无蒂锯齿状病变', polarity: 'premalignant',
    aliases: ['sessile serrated lesion', 'ssl', '无蒂锯齿状腺瘤', 'sessile serrated adenoma', '锯齿状病变'],
    evTokens: ['serrated', '锯齿', 'sessile serrated', 'sel', 'crypt'] },

  // ─────────────────────────── soft_tissue ──────────────────────────
  { organ: 'soft_tissue', name: '平滑肌肉瘤', polarity: 'malignant',
    aliases: ['leiomyosarcoma', '子宫平滑肌肉瘤', '平滑肌', '原发平滑肌肉瘤'],
    evTokens: ['leiomyosarcoma', '平滑肌', 'spindle cells', '梭形', 'eosinophilic cells', 'pleomorphic spindle', 'fascicles'] },
  { organ: 'soft_tissue', name: '梭形细胞肉瘤', polarity: 'malignant',
    aliases: ['腹膜后梭形细胞肉瘤', 'spindle cell sarcoma', 'retroperitoneal spindle cell sarcoma', '未分类梭形细胞肉瘤'],
    evTokens: ['spindle cell', 'spindle cells', '梭形', 'fascicles', 'pleomorphic spindle', '梭形细胞'] },
  { organ: 'soft_tissue', name: '黏液纤维肉瘤', polarity: 'malignant',
    aliases: ['myxofibrosarcoma', 'myxoid fibrosarcoma', '黏液纤维肉瘤', '黏液性纤维肉瘤'],
    evTokens: ['myxofibrosarcoma', 'myxoid', '黏液', 'mucin', 'pleomorphic', 'curvilinear', 'myxoid stroma'] },
  { organ: 'soft_tissue', name: '恶性周围神经鞘瘤', polarity: 'malignant',
    aliases: ['malignant peripheral nerve sheath tumor', 'mpnst', '恶性神经鞘瘤', '神经纤维肉瘤'],
    evTokens: ['mpnst', 'peripheral nerve sheath', '神经鞘', 'schwannoma-like', 'perineural', 'wavy nuclei'] },
  { organ: 'soft_tissue', name: '未分化软组织肿瘤', polarity: 'malignant',
    aliases: ['undifferentiated non-epithelial tumor', '未分化肉瘤', 'undifferentiated sarcoma', '未分化非上皮性软组织肿瘤', 'undifferentiated soft tissue sarcoma', '多形性肉瘤', 'pleomorphic sarcoma', '未分化多形性肉瘤', 'undifferentiated pleomorphic sarcoma', '恶性间叶肿瘤'],
    evTokens: ['undifferentiated', '未分化', 'pleomorphic', 'sarcomatoid', 'anaplastic', 'pleomorphic undifferentiated'] },
  { organ: 'soft_tissue', name: '血管脂肪瘤', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['angiolipoma', '脂瘤', 'lipoma', '脂肪瘤', '血管平滑肌脂肪瘤'],
    evTokens: ['angiolipoma', 'lipoma', '脂肪瘤', 'mature adipose', 'capillary', '血管', 'fat'] },
  { organ: 'soft_tissue', name: '脂肪肉瘤', polarity: 'malignant',
    aliases: ['liposarcoma', '去分化肉瘤', 'dedifferentiated liposarcoma', '黏液样脂肪肉瘤'],
    evTokens: ['liposarcoma', '脂肪肉瘤', 'lipoblast', 'lipid', 'myxoid liposarcoma', 'adipose'] },
  { organ: 'soft_tissue', name: '神经鞘瘤', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['schwannoma', '神经鞘瘤', 'neurilemmoma', '恶性神经鞘瘤'],
    evTokens: ['schwannoma', '神经鞘', 'verocay', 'antoni', 'spindle', 'palisad'] },
  { organ: 'soft_tissue', name: '纤维瘤病（硬纤维瘤）', polarity: 'neutral',
    aliases: ['desmoid', '硬纤维瘤', '纤维瘤病', 'fibromatosis', 'desmoid tumor'],
    evTokens: ['desmoid', 'fibromatosis', '长束状', 'long fascicles', 'spindle', 'collagen'] },

  // ─────────────────────────── prostate ──────────────────────────────
  { organ: 'prostate', name: '前列腺腺癌', polarity: 'malignant',
    aliases: ['前列腺癌', 'prostatic adenocarcinoma', 'prostate adenocarcinoma', 'prostate cancer', 'prostatic carcinoma', '前列腺腺癌（腺泡腺癌）', '前列腺腺泡腺癌'],
    evTokens: ['prostatic', 'prostate', '前列腺', 'gleason', 'cribriform', 'perineural', 'nuclear atypia', 'fused glands'] },
  { organ: 'prostate', name: '前列腺增生', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['良性前列腺增生', 'bph', 'benign prostatic hyperplasia', 'prostatic hyperplasia', '前列腺良性增生'],
    evTokens: ['bph', 'hyperplasia', '增生', 'glandular hyperplasia', 'prostate hyperplasia', 'fibromuscular'] },
  { organ: 'prostate', name: '无肿瘤', polarity: 'neutral',
    aliases: ['无肿瘤', '未见肿瘤', '阴性', '无异常', 'no tumor', 'normal', '未见癌', '良性前列腺组织'],
    evTokens: ['no tumor', 'no malignancy', 'benign prostatic tissue', 'unremarkable', '未见肿瘤', '正常前列腺'] },
  { organ: 'prostate', name: '前列腺上皮内瘤变', polarity: 'premalignant',
    aliases: ['pin', 'prostatic intraepithelial neoplasia', '高级别前列腺上皮内瘤变', 'hgpin'],
    evTokens: ['pin', 'intraepithelial neoplasia', 'hgpin', 'high grade pin', 'atypical ductal'] },

  // ─────────────────────────── pancreas ─────────────────────────────
  { organ: 'pancreas', name: '胰腺导管腺癌', polarity: 'malignant',
    aliases: ['pancreatic ductal adenocarcinoma', 'pancreatic adenocarcinoma', 'pda', '胰腺癌', 'pdac', 'pancreatic cancer', '胰腺导管癌'],
    evTokens: ['pancreatic ductal', 'pancreatic adenocarcinoma', 'pda', '胰腺', 'ductal', 'mucin', 'nuclear atypia'] },
  { organ: 'pancreas', name: '胰腺腺泡细胞癌', polarity: 'malignant',
    aliases: ['acinar cell carcinoma', '胰腺腺泡癌', 'acinar cell neoplasm', '胰腺泡状癌'],
    evTokens: ['acinar', '腺泡', 'acinar cell', 'zymogen', 'basophilic', 'acinar architecture'] },
  { organ: 'pancreas', name: '胰腺神经内分泌肿瘤', polarity: 'malignant',
    aliases: ['neuroendocrine tumor', 'pnet', '神经内分泌肿瘤', 'pancreatic neuroendocrine', 'insulinoma'],
    evTokens: ['neuroendocrine', '神经内分泌', 'nucleoli', 'synaptophysin', 'organoid', 'ribbon', 'insular'] },
  { organ: 'pancreas', name: '胰腺黏液性囊性肿瘤', polarity: 'premalignant',
    aliases: ['mucinous cystic neoplasm', 'mcn', '黏液性囊性肿瘤', '浆液性囊腺瘤', 'serous cystadenoma'],
    evTokens: ['mucinous', '黏液性', 'mcn', 'cystic', 'ovarian type stroma', 'serous cystadenoma'] },
  { organ: 'pancreas', name: '导管内乳头状黏液瘤', polarity: 'premalignant',
    aliases: ['ipmn', 'intraductal papillary mucinous neoplasm', '囊性乳头状', '导管内乳头状黏液性肿瘤'],
    evTokens: ['ipmn', 'intraductal papillary', 'mucinous', 'papillary', '导管内'] },
  { organ: 'pancreas', name: '胰腺炎', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['chronic pancreatitis', '胰腺炎', '慢性胰腺炎', '炎症'],
    evTokens: ['pancreatitis', '胰腺炎', 'chronic inflammation', 'fibrosis', 'lymphoplasmacytic', '石头'] },

  // ─────────────────────────── lung ─────────────────────────────────
  { organ: 'lung', name: '肺腺癌', polarity: 'malignant',
    aliases: ['lung adenocarcinoma', 'pulmonary adenocarcinoma', 'lung adeno', 'alveolar carcinoma', '低分化肺腺癌', 'poorly differentiated lung adenocarcinoma', 'adenocarcinoma of the lung', 'lung cancer'],
    evTokens: ['adenocarcinoma', '肺腺', 'lepidic', '贴壁生长', 'bronchioloalveolar', 'bronchioloalveolar carcinoma', 'papillary', 'mucinous', 'acinar'] },
  { organ: 'lung', name: '小细胞肺癌', polarity: 'malignant', familyOf: '小细胞癌',
    aliases: ['small cell lung carcinoma', 'sclc', '小细胞癌', 'oat cell carcinoma'],
    evTokens: ['small cell', 'sclc', 'oat cell', '核质比高', '小细胞', 'crush artifact', 'azurophilic'] },
  { organ: 'lung', name: '大细胞癌', polarity: 'malignant',
    aliases: ['large cell carcinoma', 'large cell lung carcinoma', '大细胞肺癌'],
    evTokens: ['large cell', '大细胞', 'large polygonal', 'prominent nucleoli', 'undifferentiated'] },
  { organ: 'lung', name: '鳞状细胞癌', polarity: 'malignant',
    aliases: ['squamous cell carcinoma', '鳞癌', '肺鳞状细胞癌', 'squamous lung carcinoma'],
    evTokens: ['squamous', '鳞状', 'keratin pearl', 'intercellular bridges', 'angloops'] },
  { organ: 'lung', name: '微浸润腺癌', polarity: 'malignant',
    aliases: ['minimally invasive adenocarcinoma', 'mia', '肺微浸润腺癌', '微浸润性腺癌'],
    evTokens: ['minimally invasive', 'mia', '肺微浸润', 'lepidic', 'microinvasion', 'invasive component'] },
  { organ: 'lung', name: '黏膜相关淋巴组织淋巴瘤', polarity: 'malignant',
    aliases: ['malt', 'MALT淋巴瘤', '结外边缘区B细胞淋巴瘤', 'extranodal marginal zone b-cell lymphoma', 'balt', 'balt淋巴瘤', 'marginal zone lymphoma'],
    evTokens: ['malt', 'marginal zone', 'balt', 'lymphoepithelial', 'plasmacytic', '边缘区', 'lymphoid'] },
  { organ: 'lung', name: '错构瘤', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['hamartoma', '肺错构瘤', '软骨样错构瘤', 'cartilaginous hamartoma'],
    evTokens: ['hamartoma', '错构', 'cartilage', '软骨', 'fat', 'smooth muscle', 'mesenchymal'] },
  { organ: 'lung', name: '类癌', polarity: 'malignant',
    aliases: ['carcinoid', 'typical carcinoid', 'atypical carcinoid', '神经内分泌肿瘤'],
    evTokens: ['carcinoid', '类癌', 'neuroendocrine', 'insular', 'ribbon', 'organoid', 'nested'] },
  { organ: 'lung', name: '结核/炎性假瘤', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['inflammatory pseudotumor', '炎性假瘤', '结核', 'granuloma', '肉芽肿', '肺炎', 'inflammation'],
    evTokens: ['granuloma', '肉芽肿', 'inflammation', 'epithelioid', 'caseous', 'langhans', '炎性'] },

  // ─────────────────────────── lymph ─────────────────────────────────
  { organ: 'lymph', name: '弥漫大B细胞淋巴瘤', polarity: 'malignant', familyOf: '淋巴瘤',
    aliases: ['弥漫性大B细胞淋巴瘤', '弥漫大B细胞淋巴瘤(纵隔型)', 'dlbcl', 'diffuse large b-cell lymphoma', 'diffuse large b cell lymphoma', '原发性纵隔大B细胞淋巴瘤', '原发纵隔大B细胞淋巴瘤', 'primary mediastinal large b-cell lymphoma', 'pmbl', '弥漫性大b'],
    evTokens: ['dlbcl', 'diffuse large b', 'large cell', 'b-cell', 'centroblast', 'large transformed cells', 'pmbl', '弥漫大'] },
  { organ: 'lymph', name: '霍奇金淋巴瘤', polarity: 'malignant', familyOf: '淋巴瘤',
    aliases: ['经典型霍奇金淋巴瘤', '经典霍奇金淋巴瘤', 'classical hodgkin lymphoma', 'cHL', 'hodgkin lymphoma', '霍奇金', 'nodular sclerosis'],
    evTokens: ['hodgkin', 'reed-sternberg', 'reed sternberg', '霍奇金', 'lacunar', 'eosinophil', 'nodular sclerosis'] },
  { organ: 'lymph', name: '套细胞淋巴瘤', polarity: 'malignant', familyOf: '淋巴瘤',
    aliases: ['外套细胞淋巴瘤', 'mantle cell lymphoma', 'mcl', '外套'],
    evTokens: ['mantle cell', 'mcl', 'cyclin d1', '套细胞', 'monocytoid'] },
  { organ: 'lymph', name: '滤泡性淋巴瘤', polarity: 'malignant', familyOf: '淋巴瘤',
    aliases: ['滤泡性淋巴瘤2级', 'follicular lymphoma', 'fl', '滤泡淋巴瘤', 'centroblasts'],
    evTokens: ['follicular', 'bcl2', 'centroblast', 'germinal center', 'follicle', '滤泡'] },
  { organ: 'lymph', name: '边缘区淋巴瘤（MALT）', polarity: 'malignant', familyOf: '淋巴瘤',
    aliases: ['marginal zone lymphoma', 'malt', 'extranodal marginal zone', '结外边缘区'],
    evTokens: ['marginal zone', 'malt', '边缘区', 'marginal', 'monocytoid'] },
  { organ: 'lymph', name: '伯基特淋巴瘤', polarity: 'malignant', familyOf: '淋巴瘤',
    aliases: ['burkitt', 'burkitt lymphoma', '伯基特', 'starry sky'],
    evTokens: ['burkitt', 'starry sky', 'berth', 'medium-sized', 'starry'] },
  { organ: 'lymph', name: '反应性淋巴增生', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['reactive lymphoid hyperplasia', '淋巴组织反应性增生', '反应性增生', 'reactive lymphadenitis', '良性淋巴增生'],
    evTokens: ['reactive lymph', 'reactive hyperplasia', '反应性增生', 'polymorphic', 'follicular hyperplasia', 'reactive'] },

  // ─────────────────────────── brain ─────────────────────────────────
  { organ: 'brain', name: '胶质母细胞瘤（GBM）', polarity: 'malignant',
    aliases: ['胶质母细胞瘤', 'glioblastoma', 'gbm', 'glioblastoma multiforme', '多形性胶质母细胞瘤'],
    evTokens: ['glioblastoma', 'gbm', '胶质母细胞', 'pseudopalisading', '栅栏样', 'microvascular proliferation', 'glomeruloid', 'pleomorphic astrocytic', 'necrosis'] },
  { organ: 'brain', name: '星形细胞瘤', polarity: 'malignant',
    aliases: ['星形细胞瘤（胶质瘤）', 'astrocytoma', 'glioma', '星形胶质瘤', '胶质瘤'],
    evTokens: ['astrocytoma', 'astrocytic', '胶质瘤', 'glioma', 'fibrillary', 'astrocytes'] },
  { organ: 'brain', name: '少突胶质细胞瘤', polarity: 'malignant',
    aliases: ['oligodendroglioma', 'oligodendro', '少突胶质', 'oligoden'],
    evTokens: ['oligodendroglioma', 'oligoden', '少突', 'fried egg', 'chicken wire'] },
  { organ: 'brain', name: '脑膜瘤', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['meningioma', '脑膜瘤', 'meningiothelial', 'psammoma'],
    evTokens: ['meningioma', '脑膜', 'whorl', 'psammoma', 'meningiothelial', 'lobules'] },
  { organ: 'brain', name: '反应性胶质增生', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['reactive gliosis', 'reactive astrocytosis', 'gliosis', '胶质增生', '反应性星形细胞增生', 'reactive astrocytic gliosis'],
    evTokens: ['reactive gliosis', 'gliosis', 'reactive astrocyte', 'gemistocytic', 'bland', '轻度异型'] },
  { organ: 'brain', name: '髓母细胞瘤', polarity: 'malignant',
    aliases: ['medulloblastoma', '髓母', '成髓细胞瘤'],
    evTokens: ['medulloblastoma', '髓母', 'medulloblastoma', 'small blue cell'] },

  // ─────────────────────────── endometrium ─────────────────────────
  // FIGO 是分级体系非独立病种 → 收为别名。
  // 必须单独成 entry，否则 LLM 说「子宫内膜癌」会被折叠成「子宫内膜样腺癌」而漏检。
  { organ: 'endometrium', name: '子宫内膜样腺癌', polarity: 'malignant',
    aliases: [
      '子宫内膜样癌', '子宫内膜样癌（FIGO）', '子宫内膜样腺癌（FIGO）', 'endometrioid carcinoma',
      'endometrial carcinoma', 'endometrioid adenocarcinoma', 'endometrial adenocarcinoma', 'endometrial cancer',
    ],
    evTokens: ['endometrioid', '子宫内膜样', 'endometrial adenocarcinoma', 'squamous metaplasia', 'nuclear atypia', '腺癌'] },
  { organ: 'endometrium', name: '子宫内膜癌', polarity: 'malignant',
    aliases: ['endometrial cancer', '子宫内膜恶性肿瘤', 'endometrial carcinoma'],
    evTokens: ['endometrial', 'endometrioid', '子宫内膜', '腺癌', 'nuclear atypia'] },
  { organ: 'endometrium', name: '子宫平滑肌肉瘤', polarity: 'malignant',
    aliases: ['leiomyosarcoma', 'uterine leiomyosarcoma', '子宫平滑肌肉瘤', '平滑肌肉瘤'],
    evTokens: ['leiomyosarcoma', '平滑肌', 'spindle cells', 'pleomorphic', 'coagulative necrosis', 'invasive', 'atypical mitoses'] },
  { organ: 'endometrium', name: '子宫内膜间质肉瘤', polarity: 'malignant',
    aliases: ['endometrial stromal sarcoma', 'ess', '子宫内膜间质性肿瘤', 'stromal sarcoma'],
    evTokens: ['endometrial stromal', 'stromal sarcoma', 'ess', 'spindle', 'uniform cells', 'spiral arteriol'] },
  { organ: 'endometrium', name: '子宫内膜增生', polarity: 'premalignant',
    aliases: ['atypical hyperplasia', 'endometrial hyperplasia', '非典型子宫内膜增生', '子宫内膜过度增生', 'complex hyperplasia'],
    evTokens: ['hyperplasia', '增生', 'endometrial hyperplasia', 'atypical', 'crowded glands', 'architectural'] },
  { organ: 'endometrium', name: '子宫内膜息肉', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['endometrial polyp', '息肉', '子宫内膜息肉'],
    evTokens: ['polyp', '息肉', 'endometrial', 'benign glands', 'fibroadenoma-like'] },
  { organ: 'endometrium', name: '正常子宫内膜', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['normal endometrium', 'proliferative endometrium', 'secretory endometrium', '增生期内膜', '分泌期内膜', '正常内膜'],
    evTokens: ['proliferative endometrium', 'secretory endometrium', 'normal endometrium', 'endometrial stroma', '未见异型', '增生期', '分泌期'] },
  { organ: 'endometrium', name: '子宫浆液性癌', polarity: 'malignant',
    aliases: ['serous carcinoma', 'endometrial serous carcinoma', '浆液性癌', 'papillary serous'],
    evTokens: ['serous', '浆液', 'papillary', 'psammoma', 'hgb', 'high grade'] },

  // ─────────────────────────── bladder ──────────────────────────────
  { organ: 'bladder', name: '尿路上皮癌', polarity: 'malignant',
    aliases: ['膀胱尿路上皮癌', 'urothelial carcinoma', '膀胱癌', 'transitional cell carcinoma', '膀胱尿路上皮细胞癌', 'urothelium cancer'],
    evTokens: ['urothelial', '尿路上皮', 'transitional', 'papillary urothelial', 'hyperchromatic', 'pleomorphic', 'invasion', 'nested'] },
  { organ: 'bladder', name: '内翻性乳头状瘤', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['inverted papilloma', '内翻乳头状瘤', '尿路上皮内翻性乳头状瘤'],
    evTokens: ['inverted papilloma', '内翻性', 'inverted', 'intraverted', 'fibrous core', 'tongue-like'] },
  { organ: 'bladder', name: '尿路上皮原位癌', polarity: 'premalignant',
    aliases: ['carcinoma in situ', 'cis', 'urothelial carcinoma in situ', '原位癌', '尿路上皮原位'],
    evTokens: ['carcinoma in situ', 'cis', '原位癌', 'severe dysplasia', 'pleomorphic', 'denuded'] },
  { organ: 'bladder', name: '膀胱腺癌', polarity: 'malignant',
    aliases: ['adenocarcinoma of the bladder', '膀胱腺癌', '腺癌', 'intestinal type'],
    evTokens: ['adenocarcinoma', '腺癌', 'mucin'] },
  { organ: 'bladder', name: '膀胱鳞癌', polarity: 'malignant',
    aliases: ['squamous cell carcinoma', '鳞癌', '膀胱鳞状细胞癌'],
    evTokens: ['squamous', '鳞状', 'keratin', 'intercellular bridges'] },
  { organ: 'bladder', name: '腺性膀胱炎', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['cystitis glandularis', '腺性膀胱炎', '腺性', '膀胱炎', 'cystitis'],
    evTokens: ['cystitis', '膀胱炎', 'glandularis', 'inflammation', 'brunn nests'] },
  { organ: 'bladder', name: '反应性尿路上皮异型', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['reactive urothelial atypia', 'reactive atypia', '尿路上皮反应性异型', '反应性异型', 'umbrella'],
    evTokens: ['reactive atypia', 'umbrella', 'reactive urothelium', '炎症', 'denudation', '未见癌'] },

  // ─────────────────────────── kidney ─────────────────────────────────
  { organ: 'kidney', name: '肾细胞癌', polarity: 'malignant',
    aliases: ['透明细胞肾细胞癌', 'clear cell renal cell carcinoma', '肾癌', 'renal cell carcinoma', 'renal carcinoma', '透明细胞癌'],
    evTokens: ['clear cell', '透明', 'renal cell', '肾细胞', 'alpha', 'nest', 'vacuolated', 'clear cytoplasm', 'granular'] },
  { organ: 'kidney', name: '嫌色细胞肾细胞癌', polarity: 'malignant',
    aliases: ['chromophobe', 'chromophobe renal cell carcinoma', '嫌色细胞癌', '嗜酸性肾细胞癌'],
    evTokens: ['chromophobe', '嫌色', 'oncocytoma-like', 'perinuclear halo', 'bubble'] },
  { organ: 'kidney', name: '乳头状肾细胞癌', polarity: 'malignant',
    aliases: ['papillary renal cell carcinoma', '乳头状肾细胞癌', '乳头状'],
    evTokens: ['papillary renal', 'papillary', 'foamy macrophages', 'papillae', 'stroma'] },
  { organ: 'kidney', name: '肾血管平滑肌脂肪瘤', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['angiomyolipoma', 'aml', '肾错构瘤', '血管平滑肌脂肪瘤', 'angiolipoma'],
    evTokens: ['angiomyolipoma', '血管平滑肌', 'aml', 'thick-walled vessels', 'smooth muscle', 'adipose'] },
  { organ: 'kidney', name: '肾嗜酸细胞瘤', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['oncocytoma', '肾嗜酸细胞瘤', '嗜酸细胞瘤'],
    evTokens: ['oncocytoma', '嗜酸', 'oncocytc', 'eosinophilic cells', 'central scar'] },

  // ─────────────────────────── liver（预留粗覆盖）───────────────────────────
  { organ: 'liver', name: '肝细胞癌', polarity: 'malignant',
    aliases: ['hepatocellular carcinoma', 'hcc', '肝癌', 'hepatocarcinoma'],
    evTokens: ['hepatocellular', 'hcc', '肝细胞癌', 'trabecular', 'pseudogland', 'bile', 'steatosis'] },
  { organ: 'liver', name: '胆管癌', polarity: 'malignant',
    aliases: ['cholangiocarcinoma', '胆管细胞癌', 'bile duct carcinoma'],
    evTokens: ['cholangiocarcinoma', '胆管', 'fibrous stroma', 'ductular'] },
  { organ: 'liver', name: '肝局灶性结节性增生', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['focal nodular hyperplasia', 'fnh', '局灶性结节性增生'],
    evTokens: ['fnh', 'focal nodular', 'nodular', 'central scar', '纤维间隔'] },
  { organ: 'liver', name: '肝腺瘤', polarity: 'premalignant',
    aliases: ['hepatic adenoma', '肝细胞腺瘤', 'adenoma'],
    evTokens: ['adenoma', 'hepatic adenoma', 'liver cell adenoma', 'псевдо'] },

  // ─────────────────────────── esophagus（预留粗覆盖）───────────────────────
  { organ: 'esophagus', name: '食管鳞状细胞癌', polarity: 'malignant',
    aliases: ['squamous cell carcinoma', '食管鳞癌', 'esophageal squamous', '食管癌'],
    evTokens: ['squamous', '鳞状', 'keratin', 'epitheli'] },
  { organ: 'esophagus', name: '食管腺癌', polarity: 'malignant',
    aliases: ['esophageal adenocarcinoma', '食管腺癌', 'barrett', 'adenocarcinoma'],
    evTokens: ['adenocarcinoma', '腺癌', 'barrett', 'intestinal metaplasia'] },

  // ─────────────────────────── testis（预留粗覆盖）──────────────────────────
  { organ: 'testis', name: '精原细胞瘤', polarity: 'malignant',
    aliases: ['seminoma', '精原细胞瘤', 'germ cell tumor'],
    evTokens: ['seminoma', '精原', 'large clear cells', 'lymphoid infiltrate', 'germ cell'] },
  { organ: 'testis', name: '睾丸生殖细胞肿瘤', polarity: 'malignant',
    aliases: ['germ cell tumor', '经生殖细胞肿瘤', '非精原细胞瘤', 'embryonal', 'yolk sac', '畸胎瘤'],
    evTokens: ['germ cell', '生殖细胞', 'embryonal', 'yolk sac', 'teratoma'] },

  // ─────────────────────────── cervix ────────────────────────────────
  { organ: 'cervix', name: '宫颈上皮内瘤变', polarity: 'premalignant',
    aliases: ['宫颈上皮内瘤变（CIN）', 'cin', 'cervical intraepithelial neoplasia', '宫颈鳞状上皮内病变', 'lsil', 'hsil', 'cin2', 'cin3'],
    evTokens: ['cin', 'cervical intraepithelial', 'dysplasia', 'koilocytotic', 'abnormal', 'koliocytes', '上皮内瘤变'] },
  { organ: 'cervix', name: '宫颈腺癌', polarity: 'malignant',
    aliases: ['cervical adenocarcinoma', 'endocervical adenocarcinoma', '宫颈管腺癌', 'adenocarcinoma'],
    evTokens: ['cervical adenocarcinoma', 'endocervical', '腺癌', 'mucin', 'lepidic'] },
  { organ: 'cervix', name: '宫颈鳞状细胞癌', polarity: 'malignant',
    aliases: ['squamous cell carcinoma', 'cervical squamous', '子宫颈鳞癌'],
    evTokens: ['squamous', '鳞状', 'keratin', 'angloops', 'invasive'] },
  { organ: 'cervix', name: '宫颈息肉', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['cervical polyp', '息肉', '宫颈良性'],
    evTokens: ['polyp', '息肉', 'inflammation', 'benign', 'endocervical'] },
  { organ: 'cervix', name: '子宫颈炎', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['cervicitis', '宫颈炎', '慢性宫颈炎', 'inflammation'],
    evTokens: ['cervicitis', '宫颈炎', 'inflammation', 'lymphoplasmacytic', '宫颈'] },

  // ─────────────────────────── bile_duct（预留粗覆盖）───────────────────────
  { organ: 'bile_duct', name: '胆管癌', polarity: 'malignant',
    aliases: ['cholangiocarcinoma', 'bile duct carcinoma', '胆管细胞癌', '肝外胆管癌'],
    evTokens: ['cholangiocarcinoma', '胆管', 'fibrous stroma'] },

  // ─────────────────────────── head_neck（预留粗覆盖）──────────────────────
  { organ: 'head_neck', name: '头颈部鳞状细胞癌', polarity: 'malignant',
    aliases: ['squamous cell carcinoma', '头颈部鳞癌', 'oral squamous', '喉癌', '咽癌', '口腔癌'],
    evTokens: ['squamous', '鳞状', 'keratin', 'ileal', 'moist', 'high'] },
  { organ: 'head_neck', name: '头颈部腺癌', polarity: 'malignant',
    aliases: ['adenocarcinoma', '头颈部腺癌', '唾液腺'],
    evTokens: ['adenocarcinoma', '腺癌'] },

  // ─────────────────────────── mesothelium（预留粗覆盖）─────────────────────
  { organ: 'mesothelium', name: '间皮瘤', polarity: 'malignant',
    aliases: ['mesothelioma', '恶性间皮瘤', 'mesothelial'],
    evTokens: ['mesothelioma', '间皮', 'mesothelial', 'papillary', 'desmoplastic'] },

  // ─────────────────────────── skin（预留粗覆盖）────────────────────────────
  { organ: 'skin', name: '黑色素瘤', polarity: 'malignant',
    aliases: ['melanoma', '恶性黑色素瘤', '皮肤黑色素瘤'],
    evTokens: ['melanoma', '黑色素', 'pigmented', 'melanin', 'nevus cells']
  },
  { organ: 'skin', name: '基底细胞癌', polarity: 'malignant',
    aliases: ['basal cell carcinoma', '基底细胞癌', 'bcc', 'basaloid'],
    evTokens: ['basal cell', 'basaloid', 'palidadic', '基底', 'pearl'] },
  { organ: 'skin', name: '鳞状细胞癌', polarity: 'malignant',
    aliases: ['squamous cell carcinoma', '鳞癌', '皮肤鳞状细胞癌'],
    evTokens: ['squamous', '鳞状', 'keratin', 'pearl'] },
  { organ: 'skin', name: '皮内痣', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['intradermal nevus', 'compound nevus', '痣', 'nevus', '良性痣'],
    evTokens: ['nevus', '痣', 'mature', 'nests', 'intradermal'] },

  // ─────────────────────────── phyllodes（预留粗覆盖）───────────────────────
  { organ: 'phyllodes', name: '叶状肿瘤（Phyllodes）', polarity: 'malignant',
    aliases: ['phyllodes tumor', '叶状肿瘤', 'phyllodes', '叶状', 'cystosarcoma phyllodes'],
    evTokens: ['phyllodes', '叶状', 'leaf-like', 'intracanalicular', 'leaf-like fronds', 'stromal overgrowth'] },
  { organ: 'phyllodes', name: '纤维腺瘤', polarity: 'benign', familyOf: '良性/反应性病变',
    aliases: ['fibroadenoma', '纤维腺瘤', 'fibroepithelial'],
    evTokens: ['fibroadenoma', '纤维腺瘤', 'fibroepithelial', 'biphasic'] },
]

// ============================================================================
// 派生
// ============================================================================

const SPECTRUM_INDEX = new Map<string, SpectrumEntry>()
for (const e of DIAGNOSIS_SPECTRUM) {
  SPECTRUM_INDEX.set(e.name.trim().toLowerCase(), e)
  for (const a of e.aliases) {
    const k = a.trim().toLowerCase()
    if (!SPECTRUM_INDEX.has(k)) SPECTRUM_INDEX.set(k, e)
  }
}

function normName(s: string): string {
  return s.trim().toLowerCase()
}

/** 别名/规范名 → SpectrumEntry（精确匹配，非子串）。避免"癌/肺"这类宽词误解析。 */
export function resolveDiagnosis(name: string): SpectrumEntry | undefined {
  if (!name) return undefined
  return SPECTRUM_INDEX.get(normName(name))
}

/** 常见→少见的器官诊断排序表（临床常见度为主）。key=name 必须与谱内规范名完全一致；
 *  未列名的器官整段不排序、未列名的条目稳定垫尾（保谱内原相对序）。本表只影响 LLM 提示谱（spectrumFor 输出），
 *  不参与 diagnosticMatch/resolveDiagnosis（那些按 name/alias Map 命中，与顺序无关）。 */
const SPECTRUM_ORDER: Partial<Record<Cancer, string[]>> = {
  breast: ['浸润性导管癌（IDC）', '纤维腺瘤', '浸润性小叶癌（ILC）', '导管原位癌', '非典型导管增生', '浸润性癌', '保守性乳腺病变'],
  colon: ['结直肠癌', '结肠癌', '管状腺瘤', '绒毛状腺瘤', '无蒂锯齿状病变', '慢性结肠炎'],
  stomach: ['胃腺癌', '胃癌', '慢性胃炎', '管状腺瘤', '息肉样小凹增生', '胃肠间质瘤（GIST）', '多原发癌'],
  prostate: ['前列腺腺癌', '前列腺增生', '前列腺上皮内瘤变', '无肿瘤'],
  brain: ['胶质母细胞瘤（GBM）', '星形细胞瘤', '脑膜瘤', '少突胶质细胞瘤', '髓母细胞瘤', '反应性胶质增生'],
  endometrium: ['子宫内膜样腺癌', '子宫内膜癌', '子宫内膜增生', '子宫内膜息肉', '正常子宫内膜', '子宫浆液性癌', '子宫平滑肌肉瘤', '子宫内膜间质肉瘤'],
  pancreas: ['胰腺导管腺癌', '胰腺神经内分泌肿瘤', '胰腺腺泡细胞癌', '胰腺黏液性囊性肿瘤', '导管内乳头状黏液瘤', '胰腺炎'],
  lung: ['肺腺癌', '小细胞肺癌', '鳞状细胞癌', '大细胞癌', '类癌', '错构瘤', '微浸润腺癌', '黏膜相关淋巴组织淋巴瘤', '结核/炎性假瘤'],
  lymph: ['弥漫大B细胞淋巴瘤', '滤泡性淋巴瘤', '边缘区淋巴瘤（MALT）', '套细胞淋巴瘤', '霍奇金淋巴瘤', '伯基特淋巴瘤', '反应性淋巴增生'],
  ovary: ['卵巢浆液性癌', '成熟囊性畸胎瘤', '卵巢子宫内膜样腺癌', '卵巢子宫内膜异位囊肿', '卵巢纤维瘤', '未成熟畸胎瘤'],
  bladder: ['尿路上皮癌', '尿路上皮原位癌', '腺性膀胱炎', '反应性尿路上皮异型', '内翻性乳头状瘤', '膀胱腺癌', '膀胱鳞癌'],
  cervix: ['宫颈鳞状细胞癌', '宫颈上皮内瘤变', '宫颈腺癌', '宫颈息肉', '子宫颈炎'],
  kidney: ['肾细胞癌', '乳头状肾细胞癌', '嫌色细胞肾细胞癌', '肾嗜酸细胞瘤', '肾血管平滑肌脂肪瘤'],
}
/** rankIn：order 中越靠前越常见 → index 越小。未列名的返回 order.length+100（垫尾，同值 → Array.sort 稳定 → 保原相对序）。 */
function rankIn(order: string[], name: string): number {
  const i = order.indexOf(name)
  return i >= 0 ? i : order.length + 100
}

/** 该器官完整诊断谱：器官匹配项在前（按 SPECTRUM_ORDER 常见→少见排），site-neutral 项垫后。cap 限制 prompt 长度。 */
export function spectrumFor(organ: Cancer | undefined): SpectrumEntry[] {
  const matches = DIAGNOSIS_SPECTRUM.filter((e) => !e.siteNeutral && e.organ === organ)
  const neutral = DIAGNOSIS_SPECTRUM.filter((e) => e.siteNeutral)
  const order = organ ? SPECTRUM_ORDER[organ] : undefined
  // 常见→少见：按 SPECTRUM_ORDER 重排（未列名稳定垫尾）；未定义 order 的器官不排序（保谱内原序）
  if (order) matches.sort((a, b) => rankIn(order, a.name) - rankIn(order, b.name))
  // 器官特异与 siteNeutral 分开限长：siteNeutral（小细胞癌/淋巴瘤/转移性癌/腺样囊性癌/良性反应性病变）
  // 是跨部位高价值鉴别候选，【永不截断】。
  // 只对器官特异列表限长，大器官未来继续扩展也只丢尾部器官特异项，siteNeutral 恒在。
  const ORGAN_CAP = 12
  const capped = matches.length > ORGAN_CAP ? matches.slice(0, ORGAN_CAP) : matches
  return [...capped, ...neutral]
}

// ============================================================================
// 分层诊断命中评分
// ============================================================================

/** family root 集合 = siteNeutral 泛名 ∪ 被具体条目 familyOf 引用的名。 */
const FAMILY_ROOTS = new Set<string>()
for (const e of DIAGNOSIS_SPECTRUM) {
  if (e.familyOf) FAMILY_ROOTS.add(e.familyOf)
}
for (const e of DIAGNOSIS_SPECTRUM) {
  if (e.siteNeutral) FAMILY_ROOTS.add(e.name)
}

/**
 * 诊断命中分层评分：把「诊断等价性」与「命名精度」分开。
 * - `full`   ：agent 主诊断归一(canonical) == GT 任 accept 归一 —— 严格诊断名命中。
 * - `family` ：agent 是 family root（淋巴瘤/小细胞癌/浸润性癌等泛名），GT accept 归一是它的具体亚型
 *              （其 familyOf 指向该 root）—— 家族正确但命名精度不足，单独记 tier。
 * - `none`   ：否则（含方向对但名完全不对）。
 *
 * 依赖规范词表 resolveDiagnosis 而非字符串含括：CJK 复合词被限定词插入，子串判断不可靠
 * （小细胞癌 ⊄ 小细胞肺癌、浸润性癌 ⊄ 浸润性导管癌），字符串含括会让泛答 vacuity 命中/精确名漏判。
 * 只消费谱数据；rule 路径/证据门不经过这里。
 */
export function diagnosticMatch(pred: string, acc: string[]): 'full' | 'family' | 'none' {
  if (!pred) return 'none'
  const ePred = resolveDiagnosis(pred)
  if (!ePred) return 'none'
  const anchors = acc
    .map((a) => resolveDiagnosis(a))
    .filter((e): e is SpectrumEntry => !!e)
  if (anchors.some((e) => e.name === ePred.name)) return 'full'
  if (FAMILY_ROOTS.has(ePred.name) && anchors.some((e) => e.familyOf === ePred.name)) return 'family'
  return 'none'
}
