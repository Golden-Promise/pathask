# PathAsk

[English](README.en.md) | 简体中文

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-339933?logo=node.js&logoColor=white)](REQUIREMENTS.md)
[![CI](https://github.com/Golden-Promise/pathask/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Golden-Promise/pathask/actions/workflows/ci.yml)

> 对话式全片病理（WSI）阅片 agent —— 对整张切片提问，输出带证据链的研究级分析报告。

针对通用模型病理垂域识别能力不足、垂域模型证据链编排困难的问题，基于 [Pi-Agent](https://github.com/earendil-works/pi) 开发面向病理阅片场景的多模态智能体，支持任意 WSI 的对话式提问与可溯源报告。

## 工具集（`createTools` 注册的 10 个）

| 工具 | 作用 |
|---|---|
| `scan_overview` | 低倍全览：缩略图 + 组织掩膜 + 候选网格 |
| `detect_roi` | 按打分挑候选 ROI，返回 `region_ref` |
| `perceive` | 单次「切块 + 批量 VLM 描述」 |
| `verify_region` | 带假设的复核：对某区域问「是否见到 X」，返回 支持/质疑/不确定 |
| `query_clinical` | 临床信息检索 |
| `query_knowledge` | 知识库检索 |
| `retrieve_similar_case` | 相似病例检索 |
| `analyze_evidence` | 决策层：把全部证据交给 LLM 做病例级判断 |
| `counterfactual` | 反事实：剔除某条证据看结论是否翻转 |
| `generate_report` | 收尾：产出结构化报告 |

## 报告长什么样

报告是一个纯数据的 `Report` 对象：

```ts
export interface Report {
  primary_diagnosis: string
  confidence: number
  differential: DifferentialDiagnosis[]        // 鉴别诊断：诊断 + 支持证据 + 反对证据 + 置信
  evidence_graph: EvidenceGraph                // { nodes: EvidenceNode[]; edges: EvidenceEdge[] }
  uncertainty?: Uncertainty                    // 证据冲突/不足时的显式「待评估」，而非免责声明
}

export type EvidenceRelation = 'supports' | 'contradicts' | 'excludes' | 'refines'
```

每条证据节点都带 `source`：工具名、`coords`（`x/y/w/h` + 倍率 + 打分）、`magnification`、模型名，以及 `stub` / `degenerate` / `fallback` 等降级标记——被标记的观察不进投票。

示例（长列表已删减）：

```jsonc
{
  "primary_diagnosis": "腺样囊性癌",
  "confidence": 0.5,
  "differential": [
    {
      "diagnosis": "导管原位癌（DCIS）",
      "confidence": 0.65,
      "evidence_for": ["态（Patho-R1）：导管内见异型上皮，细胞核增大深"],
      "evidence_against": ["大深染、极性紊乱，局部见浸润性生长趋势"]
    },
    {
      "diagnosis": "浸润性导管癌（IDC）",
      "confidence": 0.65,
      "evidence_for": ["复核 r1 @40×：基底膜局部断裂，间质见异型细胞巢 →"],
      "evidence_against": []
    }
  ],
  "evidence_graph": {
    "nodes": [
      {
        "id": "ev-1",
        "type": "observation",
        "claim": "全览：低倍全览（1.25×）：组织覆盖 68%，可见 3 处导管结构紊乱、细胞密度升高区域（r1/r2/r3）。",
        "confidence": 0.6,
        "source": { "tool": "scan_overview", "magnification": 1.25 }
      },
      {
        "id": "ev-2",
        "type": "observation",
        "polarity": "against",
        "claim": "在 \"寻找导管异型增生与可疑浸润灶\" 引导下检测到 3 个候选 ROI，按异常分降序：r1(导管上皮异型增生, score=0.87)、r2(可疑浸润灶, score=0.72)、r3(反应性增生, score=0.31)",
        "confidence": 0.65,
        "source": { "tool": "detect_roi" }
      },
      {
        "id": "ev-3",
        "type": "observation",
        "claim": "区域 r1 在 20× 下切取 4 个 patch（首块 patch_r1_0）",
        "confidence": 0.65,
        "source": {
          "tool": "inspect_region",
          "magnification": 20,
          "coords": {
            "id": "r1", "slide_id": "slide_brca_001",
            "x": 1200, "y": 3400, "w": 1024, "h": 1024,
            "magnification": 20, "anomaly_score": 0.87, "label": "导管上皮异型增生"
          }
        }
      },
      {
        "id": "ev-6",
        "type": "observation",
        "claim": "patch patch_r1_0 形态（Patho-R1）：导管内见异型上皮，细胞核增大深染、极性紊乱，局部见浸润性生长趋势",
        "confidence": 0.75,
        "source": { "tool": "describe_patch", "magnification": 20, "model": "patho-r1-7b", "fallback": true }
      },
      // … 中间略去 17 条；全图共 23 条（19 observation / 2 inference / 2 conclusion）
      {
        "id": "ev-22",
        "type": "inference",
        "claim": "综合推断：腺样囊性癌（基于 19 条证据（规则投票））",
        "confidence": 0.5,
        "source": { "tool": "analyze_evidence" }
      },
      {
        "id": "ev-23",
        "type": "conclusion",
        "claim": "诊断：腺样囊性癌",
        "confidence": 0.5,
        "source": { "tool": "analyze_evidence" }
      }
    ],
    "edges": [
      { "from": "ev-1", "to": "ev-19", "relation": "supports",    "strength": 0.6 },
      { "from": "ev-2", "to": "ev-19", "relation": "contradicts", "strength": 0.65 }
      // … 共 39 条边
    ]
  },
  "uncertainty": { "type": "evidence_conflict", "recommended_action": "verify_region" }
}
```

几点读法：

- `differential[].evidence_for` 是命中短语 ±12 字上下文的摘录（`analyzeEvidence.ts` 的 `evidenceExcerpt`），
  所以看着像被截断——那是设计如此，不是丢字。它保证摘出来的每个片段都真的含形态学关键词。
- `source.fallback: true` 表示该形态描述来自降级模板而非真实 VLM。这类观察不参与投票——
  否则「模型一挂、全片变温和模板」会把结论洗成良性。
- `confidence: 0.5` 配上 `uncertainty.type: "evidence_conflict"`，意思是证据之间互相打架：agent 不硬给结论，
  而是显式建议 `verify_region` 复核。

## Quick Start

```bash
git clone --recurse-submodules https://github.com/Golden-Promise/pathask.git
cd pathask
npm install
cp .env.example .env      # 按需填写端点与 key
npm run typecheck         # tsc --noEmit
npm run dev               # 离线脚本化闭环
```

环境要求（Node 版本、Python / OpenSlide、模型端点）见 [`REQUIREMENTS.md`](REQUIREMENTS.md)。

### 起 WSI 桥

TS 调不动 OpenSlide（Python 库），所以有一个 FastAPI 薄桥：

```bash
pip install -r wsi-bridge/requirements.txt   # openslide-python / fastapi / uvicorn
python wsi-bridge/server.py                  # 默认 http://127.0.0.1:8787
```

登记表与 WSI 文件不在本仓库——请自备切片并向对应数据源申请访问（见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)）。

## 模型端点

| 角色 | 用途 | 默认端点 | 默认 model id | 环境变量 |
|---|---|---|---|---|
| 决策 / 编排 LLM | 纯文本：编排循环 + 病例级判断 | 本地 vLLM `http://127.0.0.1:8014/v1` | `qwen3-8b` | `PATHASK_LLM_BASE_URL` / `PATHASK_LLM_MODEL` |
| 病理 VLM | 读图：形态学描述与复核 | 本地 vLLM `http://127.0.0.1:8012/v1` | `patho-r1-7b` | `VLLM_BASE_URL` / `VLLM_MODEL` |

两者都是可替换的 OpenAI 兼容端点——自建 vLLM、硅基流动或其他托管服务皆可。默认值是回环占位地址（本仓库不携带任何内网地址），请改成你自己的部署。

## 文档

| 文件 | 内容 |
|---|---|
| [`REQUIREMENTS.md`](REQUIREMENTS.md) | 运行与部署要求（Node / Python / OpenSlide / 模型端点） |
| [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) | 用到的第三方代码、数据与模型，及其入口链接 |
| [`CHANGELOG.md`](CHANGELOG.md) | 变更记录 |
| [`LICENSE`](LICENSE) | MIT |
