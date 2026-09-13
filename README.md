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
PATHASK_WSI_REGISTRY=wsilist.json python wsi-bridge/server.py   # 默认 http://127.0.0.1:8787
```

`PATHASK_WSI_REGISTRY` 是必需的，缺了服务直接退出（登记表格式见 [`wsi-bridge/README.md`](wsi-bridge/README.md)）。
登记表与切片文件都不在本仓库——请自备切片并向对应数据源申请访问（见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)）。

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
