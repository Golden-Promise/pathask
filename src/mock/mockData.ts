import type { Capability, KnowledgeEntry, OverviewCache, SimilarCaseRecord } from '../types'

// ---------- 能力库（mock 注册，Phase 3 换成真实 STREAM 权重 + h5） ----------
export const MOCK_CAPABILITIES: Capability[] = [
  {
    id: 'tcga-brca-er',
    cancer: 'breast',
    task: 'er_status',
    source: 'local',
    model_arch: 'abmil',
    model_path: '<STREAM_ROOT>/.../tcga_brca_er_best.pth',
    metadata_path: '<STREAM_ROOT>/doc/tcga_brca_er_metadata.csv',
    feature_dim: 512,
    num_classes: 2,
    labels: ['negative', 'positive'],
  },
  {
    id: 'tcga-brca-tp53',
    cancer: 'breast',
    task: 'tp53',
    source: 'local',
    model_arch: 'transmil',
    model_path: '<STREAM_ROOT>/.../tcga_brca_tp53_best.pth',
    metadata_path: '<STREAM_ROOT>/doc/tcga_brca_tp53_metadata.csv',
    feature_dim: 512,
    num_classes: 2,
    labels: ['wildtype', 'mutant'],
  },
  {
    id: 'zjch-oc-hrd',
    cancer: 'ovary',
    task: 'hrd',
    source: 'local',
    model_arch: 'abmil',
    model_path: '<STREAM_ROOT>/.../zjch_oc_hrd_best.pth',
    metadata_path: '<STREAM_ROOT>/doc/zjch_oc_hrd_metadata.csv',
    feature_dim: 512,
    num_classes: 2,
    labels: ['hrd_negative', 'hrd_positive'],
  },
  {
    id: 'phyllodes-tumor',
    cancer: 'phyllodes',
    task: 'tumor_type',
    source: 'local',
    model_arch: 'clamsb',
    model_path: '<STREAM_ROOT>/.../phyllodes_tumor_best.pth',
    metadata_path: '<STREAM_ROOT>/doc/phyllodes_metadata.csv',
    feature_dim: 512,
    num_classes: 3,
    labels: ['benign', 'borderline', 'malignant'],
  },
]

// ---------- 临床表（mock，Phase 3 读真实 CSV/TSV） ----------
export const MOCK_CLINICAL: Record<string, Record<string, string>> = {
  'TCGA-AB-0001': {
    er: 'positive',
    pr: 'positive',
    her2: 'negative',
    stage: 'IIA',
    subtype: 'Luminal A',
    tp53: 'wildtype',
    follow_up_days: '2130',
    outcome: 'alive',
  },
  'TCGA-AB-0005': {
    er: 'positive',
    pr: 'negative',
    her2: 'positive',
    stage: 'IIB',
    subtype: 'Luminal B',
    tp53: 'wildtype',
    follow_up_days: '1720',
    outcome: 'alive',
  },
  'ZJ-OC-0017': {
    hrd: 'hrd_positive',
    brca: 'germline_BRCA1',
    gss: 'GSS=42',
    stage: 'III',
  },
}

// ---------- 知识库（初始策划 JSON，Phase 2 可换 LLM 检索） ----------
export const MOCK_KNOWLEDGE: KnowledgeEntry[] = [
  {
    id: 'k-luminal',
    topic: 'ER/HER2 分型',
    content: 'ER+/HER2- 对应 Luminal A/B 型，对内分泌治疗敏感；ER-/HER2+ 为 HER2 富集型，抗 HER2 靶向治疗。',
    keywords: ['er', 'her2', 'luminal', '内分泌', '内分泌治疗'],
  },
  {
    id: 'k-scnc',
    topic: '小细胞癌形态学诊断标准',
    content: '小细胞癌：细胞小、核深染、胞质少、镶嵌状/栅栏状排列、挤压伪影常见；坏死广泛。',
    keywords: ['small cell', '小细胞', '小细胞癌', 'scnc', 'sclc'],
  },
  {
    id: 'k-mitosis',
    topic: '有丝分裂计数分级',
    content: '有丝分裂计数（实体瘤分级常用参数，适用于乳腺癌/叶状肿瘤/软组织肉瘤等）：在组织学最活跃区、选择 10 个 HPF 平均；≤5 为 1 分，6-10 为 2 分，>10 为 3 分；≥8/10HPF 提示高级别。',
    keywords: ['mitosis', '有丝分裂', '核分裂', '分级'],
  },
  {
    id: 'k-ki67',
    topic: 'Ki-67 增殖指数',
    content: 'Ki-67 增殖指数：<14% 低增殖，14-30% 中等，>30% 高增殖；Luminal B 常 ≥14%。',
    keywords: ['ki67', 'ki-67', '增殖指数'],
  },
]

// ---------- 相似病例索引（mock，Phase 2 用 CONCH embedding 重建） ----------
export const MOCK_SIMILAR: SimilarCaseRecord[] = [
  { id: 'sc-1', case_id: 'TCGA-AB-0005', diagnosis: '浸润性导管癌（IDC）', subtype: 'Luminal B', cancer: 'breast', embedding: [0.1, 0.3, 0.8, 0.4] },
  { id: 'sc-2', case_id: 'TCGA-AC-0002', diagnosis: '浸润性导管癌（IDC）', subtype: 'Luminal A', cancer: 'breast', embedding: [0.2, 0.25, 0.75, 0.3] },
  { id: 'sc-3', case_id: 'TCGA-A7-0004', diagnosis: '浸润性小叶癌（ILC）', subtype: 'Luminal A', cancer: 'breast', embedding: [0.4, 0.6, 0.2, 0.9] },
  { id: 'sc-4', case_id: 'PUB-SCLC-012', diagnosis: '小细胞癌（SCLC）', cancer: 'lung', embedding: [0.9, 0.1, 0.3, 0.5] },
]

// ---------- WSI 全览缓存（mock，Phase 2 用 OpenSlide 真生成） ----------
export const MOCK_WSI: Record<string, OverviewCache> = {
  slide_brca_001: {
    slide_id: 'slide_brca_001',
    case_id: 'TCGA-AB-0001',
    thumbnail: 'data:image/png;base64,<mock-thumbnail>',
    tissue_coverage: 0.68,
    overview_text:
      '低倍全览（1.25×）：组织覆盖 68%，可见 3 处导管结构紊乱、细胞密度升高区域（r1/r2/r3）。',
  },
  slide_lung_001: {
    slide_id: 'slide_lung_001',
    case_id: 'PUB-SCLC-012',
    thumbnail: 'data:image/png;base64,<mock-thumbnail>',
    tissue_coverage: 0.55,
    overview_text:
      '低倍全览（1.25×）：组织覆盖 55%，肺穿刺标本，见片状深染小细胞区域，疑似小细胞癌特征。',
  },
  slide_phyllodes_001: {
    slide_id: 'slide_phyllodes_001',
    case_id: 'PHY-001',
    thumbnail: 'data:image/png;base64,<mock-thumbnail>',
    tissue_coverage: 0.62,
    overview_text:
      '低倍全览（1.25×）：组织覆盖 62%，见分叶状结节轮廓、梭形细胞束状排列区域（r1/r2）。',
  },
}
