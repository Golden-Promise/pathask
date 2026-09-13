# 第三方声明（THIRD_PARTY_NOTICES）

本仓库**包含**的第三方代码，以及**用到但不再分发**的第三方数据与模型。

---

## 一、包含在本仓库中的第三方代码

### pi-agent — MIT

本仓库的 agent 骨架基于 **pi-agent** 二次开发。上游以 git submodule 的形式引用
（`pi-agent/`），锁定 commit `dcd461925db2edf69a43c8135db1180d418afd54`，**未做任何修改**。
构建实际依赖的是上游发布的同版本 npm 包。

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
`@types/node`（MIT）。完整依赖树与版本见 [`package.json`](package.json) / `package-lock.json`，各包自带许可证。

---

## 二、用到但不分发的第三方数据与模型

> **本仓库不包含下列任何数据、切片、标注或权重。** 本节只是出处声明与获取指引——
> 想复现本项目的工作，须**自行**向对应来源申请访问并遵守其条款。

| 名称 | 用途 | 性质 / 条款 | 入口 |
|---|---|---|---|
| **TCGA / GDC** | 切片与临床信息来源 | 开放层级可自由使用；受控层级需向 dbGaP 申请 | <https://gdc.cancer.gov/> |
| **HISTAI** | 良性对照 patch | HuggingFace gated + CC BY-NC 4.0 | <https://huggingface.co/datasets/histai/HISTAI-metadata> |
| **HistGen** | 报告生成 benchmark | TCGA/GDC 衍生的第三方加工文本 | <https://huggingface.co/datasets/david4real/HistGen> |
| **reg²** | 肾癌分级评测数据 | 挑战赛数据，条款见官网 | <https://reg2026.grand-challenge.org/> |
| **Patho-R1-7B** | 病理 VLM（读图） | HuggingFace gated，CC BY-NC-ND 4.0 | <https://huggingface.co/WenchuanZhang/Patho-R1-7B> |
| **Qwen3-8B** | 决策 / 编排 LLM（纯文本） | 依上游自身许可证 | <https://huggingface.co/Qwen/Qwen3-8B> |

---

## 关于本项目自有的评测集

本项目构建的评测集（PARE）**不在本仓库中**：上面几家数据源的再分发条款均未落实，故在条款明确前不予公开。
