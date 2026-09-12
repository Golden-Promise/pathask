# 第三方声明（THIRD_PARTY_NOTICES）

本仓库包含的第三方**代码**，以及本研究工作**引用但不分发**的第三方**数据与模型**。
两类性质不同，分开列。

---

## 一、包含在本仓库中的第三方代码

### pi-agent — MIT

本仓库的 agent 骨架基于 **pi-agent** 二次开发。上游以 git submodule 的形式引用
（`pi-agent/`），锁定 commit `dcd461925db2edf69a43c8135db1180d418afd54`，
**未做任何修改**。构建实际依赖的是上游发布的同版本 npm 包（见 README）。

- 上游：<https://github.com/earendil-works/pi>
- 版权：`Copyright (c) 2025 Mario Zechner`
- 许可证：MIT
- 使用的包：`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-telemetry`（均 `0.84.3`）

依 MIT 要求，附许可证全文：

```
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 其它 npm 依赖

`dotenv`（BSD-2-Clause）、`typebox`（MIT）、`undici`（MIT）、`tsx`（MIT）、`typescript`（Apache-2.0）、
`@types/node`（MIT）。完整依赖树与版本见 `package.json` / `package-lock.json`，各包自带许可证。

---

## 二、引用但不分发的第三方数据与模型

> **本仓库不包含下列任何数据、切片、标注或权重。** 本节只是出处声明与获取指引——
> 任何人想复现本项目的实验，都需**自行**向对应来源申请访问并遵守其条款。

### TCGA / GDC

- 提供方：NIH National Cancer Institute — Genomic Data Commons
- 入口：<https://gdc.cancer.gov/>
- 性质：开放获取（open-access）层级的数据可自由使用；**受控获取（controlled-access）层级需向 dbGaP 申请**。
- 使用方式：本项目**不转发**任何 TCGA 数据，使用者须自行下载。
- 引用要求：使用 TCGA 数据请遵循 GDC 的[数据使用与引用政策](https://gdc.cancer.gov/about-data/data-usage-guidelines)，
  并引用对应项目/论文。

### HISTAI

- 提供方：**HISTAI-mixed** 数据集
- 入口：<https://huggingface.co/datasets/histai/HISTAI-mixed>
- 性质：**HuggingFace gated** 数据集 + **CC BY-NC 4.0**（署名 — 非商业性使用）。
- ⚠️ 两点必须注意：
  1. **gated ≠ 许可证**。这是**两层**约束：许可证允许的再分发，仍受 gated 访问条款限制——
     gated 数据集通常要求**第三方自行申请**，不能由他人代传。
  2. 该数据集的许可标注存在**不一致**：arXiv 页头标 CC BY 4.0，而 HuggingFace / GitHub 标 CC BY-NC 4.0。
     本项目按更严格的 **CC BY-NC 4.0** 对待。如需确认请向维护者核实。
- 使用方式：本项目**不转发**任何 HISTAI 数据；使用者须自行在 HuggingFace 上申请访问。

### HistGen

- 提供方：HistGen 病理报告生成 benchmark
- 性质：**TCGA/GDC 衍生** benchmark。WSI 与报告原文均为 TCGA 衍生物。
- ⚠️ HistGen 自身的 `report` 字段是**它用 GPT 清洗过的衍生文本**，不等同于 TCGA 原始报告，
  其再分发条款与 TCGA 不同。本项目**不分发**该字段。
- 使用方式：请向 HistGen 作者确认获取与再分发条款。

### 病理 VLM — Patho-R1

- 本项目默认把 **Patho-R1-7B** 作为读图的病理视觉语言模型接入（`VLLM_BASE_URL`）。
- **本仓库不分发权重**，也不包含其训练数据。请向模型发布方获取并遵守其许可证。

### 决策 / 编排 LLM — Qwen3-8B

- 默认端点使用 **Qwen3-8B**（默认 SiliconFlow 托管；也可指向自建 vLLM，见 `.env.example`）。
- **本仓库不分发权重**。Qwen3 系列依其自身许可证发布，请遵循上游条款。

---

## 三、参考工作（仅学术引用）

本项目在设计上参考了以下工作，**未使用其代码或数据**：

- **AdaptivePath** — arXiv:[2608.08648](https://arxiv.org/abs/2608.08648)
- **Pathology-o3 / Pathology-CoT** — arXiv:[2510.04587](https://arxiv.org/abs/2510.04587)
- **PathAgent** — arXiv:[2511.17052](https://arxiv.org/abs/2511.17052)

---

## 关于本项目自有的评测集

本项目构建的评测集（PARE）**不在本仓库中**，原因正是上面三家数据源的再分发条款均未获允许
（HISTAI 为 gated + 非商业，HistGen 为 TCGA 衍生的第三方加工文本，另有来源出处尚待确认）。
在条款落实之前不予公开。
