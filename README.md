# PathAsk

[English](README.en.md) | 简体中文

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-339933?logo=node.js&logoColor=white)](#requirements)
[![CI](https://github.com/Golden-Promise/pathask/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Golden-Promise/pathask/actions/workflows/ci.yml)

> 对话式全片病理（WSI）阅片 agent —— 对整张切片提问，输出**带证据链**的研究级分析报告。

丢给 agent 一张 WSI 和一句问题，它自己决定「低倍扫 → 挑区域 → 放大 → 让病理 VLM 描述 → 拉临床/知识 → 综合判断」。产出的不是单个分类标签，而是**每个结论都能指回坐标、倍率与形态学描述**的报告，并且可以被追问。

agent 骨架用 [pi-agent](https://github.com/earendil-works/pi)（`pi-ai` + `pi-agent-core`）二次开发；视觉理解接开源病理 VLM，决策接纯文本 LLM。

## Highlights

- **证据链而非标签** —— 结论 → 区域坐标 → 倍率 → 形态描述 → 支持/反对极性，`counterfactual` 可剔除单条证据看结论是否翻转。
- **感知与推理分离** —— 病理 VLM 只负责「描述看到了什么」，决策由纯文本 LLM 做。两者都是**可替换的 OpenAI 兼容端点**，本项目不训练也不分发任何权重。
- **不自动重试** —— 瞬时故障只给「重试预算」并改变**跟模型说的话**，决定权始终在模型；超时则回落规则投票，而不是偷偷重发。
- **降级证据出局投票** —— 超时/截断产生的部分证据被显式标记，**不计入投票**，避免「模型一挂、全片变温和模板」把结论洗成良性。
- **熔断区分证据强度** —— 连接类失败是服务死亡的无歧义证据，直接记服务级；超时是模糊证据，先归到单张切片，防止一张病态巨片判死整个服务。
- **循环治理可度量** —— 步数 / token / VLM 预算、重复调用指纹、无进展与振荡检测；观测类默认开且零行为改动，干预类一律 env 门控。

## Quick Start

```bash
git clone --recurse-submodules https://github.com/Golden-Promise/pathask.git
cd pathask
npm install
cp .env.example .env      # 按需填写端点与 key
npm run typecheck         # tsc --noEmit
npm run dev               # 离线脚本化闭环（见下方说明）
```

### `npm run dev` 跑的是什么

跑的是**离线脚本化闭环**：LLM 的决策由 `src/mock/mockStreamFn.ts` 的预写序列回放，数据来自 `src/mock/mockData.ts`。

**工具、证据库、投票、报告都是真的**——10 个工具真的被执行，证据真的入库，投票真的开跑，最后真的产出报告对象。只有**模型决策**与**数据**是假的。所以它验证的是「接线与工具编排有没有断」，**不代表真实读片能力**。

它是确定性的、不联网、不写盘的（`main.ts` 调用 `runQuestion` 时不传 session，故不触发报告落盘），因此也作为 CI 的端到端冒烟步骤运行。

> ⚠️ **离线跑会打印一批看起来吓人的警告，这是预期行为**：
> - `[describe_patch] Patho-R1 不可用，降级模板：EISDIR ...` —— 没有 VLM 端点时，描述器按 `region_label` 查表降级。这类证据被标记为 stub 且**不参与投票**（`src/tools/describePatch.ts` 的降级分支），报告里会以「⚠️ VLM 降级模板（非镜下观察，不参与投票）」单列。
> - `[analyze_evidence] 决策 LLM 失败，回落规则投票: 缺少 SILICONFLOW_API_KEY` —— 决策层走规则投票回落。
>
> 换句话说，离线模式**同时也在跑一遍降级路径**。最终诊断因此**不具临床意义**，看「流程有没有断」即可。

### 接入真实端点

真实读片需要三件套：

1. 一个 **WSI 登记表 + 切片原片**（`PATHASK_WSI_REGISTRY` 指向的 JSON，`slide_id → 原片路径`）
2. 一个**病理 VLM 端点**（`VLLM_BASE_URL` / `VLLM_MODEL`）
3. 一个**决策 LLM 端点**（`PATHASK_LLM_BASE_URL` / `PATHASK_LLM_MODEL`，或 SiliconFlow key）

> ⚠️ **本仓库的 `createRealSession()`（`src/session.ts`）已实现但入口未接出**——`src/main.ts` 走的是 mock 分支。
> 想跑真实读片，需要你自己把 `createRealSession()` 接到 `runQuestion()` 上（约十几行）。
> 本项目**不是一个开箱即跑的 demo**，而是一份可读、可复用的参考实现。

### 起 WSI 桥

TS 调不动 OpenSlide（Python 库），所以有一个 FastAPI 薄桥：

```bash
pip install -r wsi-bridge/requirements.txt   # openslide-python / fastapi / uvicorn
python wsi-bridge/server.py                  # 默认 http://127.0.0.1:8787
```

登记表与 WSI 文件**不在本仓库**——请自备切片并向对应数据源申请访问（见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)）。

## 架构

```mermaid
flowchart TD
    Q(["WSI + 提问"]) --> S["scan_overview<br/>低倍全览：缩略图 + 组织掩膜 + 候选网格"]
    S --> D["detect_roi<br/>候选区采样 · 核密度 blend 打分"]
    D --> P["perceive<br/>切块 + 批量 VLM 描述（合一步，省一次 agent 往返）"]
    P --> E[("证据库<br/>claim · polarity · 置信 · 坐标 · 倍率")]
    P --> V["verify_region<br/>带假设复核：支持 / 质疑 / 不确定"]
    V --> E
    E --> K["检索 · 相似病例 / 临床 / 知识"]
    K --> A["analyze_evidence<br/>决策层：LLM 投票出主诊断 + 鉴别"]
    A --> C["counterfactual<br/>反事实校验"]
    C --> G["generate_report<br/>结构化报告"]
    G --> OUT(["主诊断 + 鉴别诊断 + 证据图"])
```

收尾链的强制顺序是 `analyze_evidence → counterfactual → generate_report`；直接输出「诊断报告」式文本而不调用 `generate_report` 视为失败。

```
src/
├── loop/          agent 循环层
│   ├── agentFactory.ts      createPathAskAgent：组装模型 + 工具 + 循环治理
│   ├── protocol.ts          系统提示词协议（阅片工作流 / 工具约定 / 收尾规则）
│   ├── governance.ts        循环治理：步数/token/VLM 预算、重复指纹、无进展与振荡检测
│   ├── fingerprint.ts       工具调用规范化参数指纹（判「同参重复」）
│   ├── siliconflowStreamFn.ts  编排 LLM 的流式适配（OpenAI 兼容）
│   └── compactContext.ts    上下文压缩（⚠️ 默认关）
├── tools/         10 个 AgentTool
├── wsi/           WSI 接入：桥接客户端、ROI 采样、导航器、CONCH/PLIP 检索
├── util/          resilience.ts（端点熔断 + 瞬时故障重试预算）、llmEndpoint.ts（端点判定）
├── evidence/      证据库（per-session）
├── knowledge/     知识库检索
├── data/          诊断谱（器官 → 疾病词表 + 形态证据签名）
├── mock/          离线桩（脚本化 LLM + 固定数据，供无端点环境跑通闭环）
└── runner.ts      单病例编排（含热点闭环、双倍率复核等非 agent 直调的路径）

wsi-bridge/        TS 调不动 OpenSlide，用这个 FastAPI 薄桥把 WSI 读取暴露成 HTTP
```

### 报告长什么样

```ts
interface Report {
  primary_diagnosis: string
  confidence: number
  differential: DifferentialDiagnosis[]        // 鉴别诊断：诊断 + 支持证据 + 反对证据 + 置信
  evidence_graph: { nodes: EvidenceNode[]; edges: EvidenceEdge[] }
  uncertainty?: { type; recommended_action }    // 证据不足时的显式「待评估」，而非免责声明
}
```

每条证据节点都带 `source`：工具名、`coords`（`x/y/w/h`）、`magnification`、模型名、以及 `stub` / `degenerate` / `fallback` 等降级标记。

### 工具集（`createTools` 注册的 10 个）

| 工具 | 作用 |
|---|---|
| `scan_overview` | 低倍全览：缩略图 + 组织掩膜 + 候选网格 |
| `detect_roi` | 按打分挑候选 ROI（默认 blend = 核密度 + 组织密度），返回 `region_ref` |
| `perceive` | **单次「切块 + 批量 VLM 描述」**，替代 `inspect_region → describe_patch` 两步，省一次 agent 往返 |
| `verify_region` | 带假设的复核：对某区域问「是否见到 X」，返回 支持/质疑/不确定 |
| `query_clinical` | 临床信息检索 |
| `query_knowledge` | 知识库检索 |
| `retrieve_similar_case` | 相似病例检索（CONCH 向量库） |
| `analyze_evidence` | **决策层**：把全部证据交给 LLM 做病例级判断 |
| `counterfactual` | 反事实：剔除某条证据看结论是否翻转 |
| `generate_report` | 收尾：产出结构化报告 |

> `inspect_region` / `describe_patch` 仍在源码里，但**不再暴露给 agent**——由 `runner.ts` 的内部路径
> （热点闭环、双倍率复核）与 `perceive` 直接调用。

### 两个模型分工

| 角色 | 默认 | 环境变量 |
|---|---|---|
| **决策 / 编排 LLM**（纯文本） | SiliconFlow `Qwen/Qwen3-8B` | `PATHASK_LLM_BASE_URL` / `PATHASK_LLM_MODEL` |
| **病理 VLM**（读图） | 自建 `patho-r1-7b` | `VLLM_BASE_URL` / `VLLM_MODEL` |

两者都是**可替换的 OpenAI 兼容端点**——本项目不训练也不分发任何权重。

### pi-agent 是怎么接进来的

两条线，**各有分工**：

| | 用途 | 位置 |
|---|---|---|
| **git submodule** | **锁定到上游的源码凭据**：署名、出处、可审计的版本锚点 | `pi-agent/` → [`earendil-works/pi`](https://github.com/earendil-works/pi) @ `dcd461925` |
| **npm 依赖** | 实际参与构建的产物 | `@earendil-works/pi-ai` / `pi-agent-core` / `pi-telemetry`，**精确钉 `0.84.3`** |

为什么不全用 `file:` 指向 submodule：上游是 monorepo，包的入口指向 `dist/`，
而 `dist/` 是**构建产物、不在 git 里**——用 `file:` 就得先跑通整个 monorepo 的
`npm install && npm run build`（8 个包 + `tsgo`）。对一个以读代码为主的仓库，
直接依赖上游**同一版本**的发布包更省事，且版本与 submodule 锁定的 commit 对应。

> 想改 pi 源码的人：`npm i ./pi-agent/packages/ai ./pi-agent/packages/agent` 切成本地构建即可，
> 但你要先按上游 README 把 monorepo 建起来。

本项目**不修改** submodule 内容——所有裁剪都在 `src/` 层完成。

## Requirements

| | 要求 | 说明 |
|---|---|---|
| **Node.js** | **≥ 22.19** | 下限来自 `undici@8.10.2` 自己声明的 `engines`（`package.json` 的 `engines` 字段与之一致） |
| **Python** | 3.10+ | 仅 WSI 桥需要 |
| **OpenSlide** | 系统级库 | `openslide-python` 依赖它，需先按发行版安装（`apt install libopenslide0` / `brew install openslide`） |
| **Python 包** | 见 `wsi-bridge/requirements.txt` | `openslide-python>=1.4`、`numpy>=1.26`、`pillow>=10`、`fastapi>=0.110`、`uvicorn>=0.29` |

模型端点（病理 VLM / 决策 LLM）**不是安装依赖**——离线桩可以完全不要它们。

## 设计要点

几个不显然、但踩过坑的设计决定，都写在 `src/util/resilience.ts`、`src/loop/governance.ts`
等文件的头部注释里。这里只列最值得先读的：

- **端点分派三件事**（`src/util/llmEndpoint.ts`）：切到自建端点时，**代理**（undici 的 `ProxyAgent`
  **不读** `NO_PROXY`，内网端点必须不挂 dispatcher）、**思考字段**（vLLM 顶层 `enable_thinking` 是空操作，
  必须发 `chat_template_kwargs`）、**超时默认**（240s → 120s）三件事必须一起变。
- **熔断只治「别再付第二次」**（`resilience.ts`）：连接类失败是服务死亡的**无歧义**证据 → 直接记服务级；
  超时是**模糊**证据 → 先归 (端点, slide)，窗口内够多张**不同**片子都超时才升级为服务级
  （否则一张病态巨片能判死整个服务）。业务类 4xx **不进熔断**——那是数据问题不是健康信号。
- **不自动重试**：瞬时故障只给「重试预算」并改变**跟模型说的话**，决定权始终在模型。
  超时 → 回落规则投票，而不是偷偷重发。
- **降级证据出局投票**：超时/截断产生的部分证据会被标记，**不计入投票**。
- **循环治理是防御性的**（`governance.ts`）：观测类默认开且零行为改动，干预类一律 env 门控。
  治理的价值是**堵住可能发生的失控**，以及让循环本身可度量。
- **采样打分用核密度而非裸组织密度**：`tissue_fraction` 会把纤维/平滑肌/空白都算「组织」，
  核密的癌灶反而排名低 → 采样系统性偏向良性结缔组织。默认 `PATHASK_ROI_SCORE=blend`（0.6×核密度 + 0.4×组织密度）。

## 诚实边界

- **研究级工具，不是医疗器械，不宣称临床可用**，不越过病理医生。
- agent 不提高底层模型的固有精度；VLM 差时它只是「优雅地失败」。
- 仓库里的默认配置是**为了可复现评测**而钉死的，不是「最优产品配置」。
- 离线桩的最终诊断**不具临床意义**——它验证接线，不验证读片。

## 发布边界

**本仓库包含**：`src/`（agent 全部源码）、`wsi-bridge/`（WSI 读取桥）、配置模板与文档。

**本仓库不含**（留在私有树）：
- 评测集与金标准标注（涉及三个外部数据源的再分发条款，**未经确认不公开**）
- WSI 切片、slide 登记表、CONCH 向量库、模型权重
- 评测 harness、数据构建脚本、部署脚本（含内部集群配置）
- 临床数据、任何患者可识别信息

已做脱敏：源码与文档中的内部主机名、内网 IP、集群绝对路径、归档切片 id 示例均已移除或改为占位符。
**并已用 n-gram 重合检查复核**：发布面中不含任何 ≥40 字符的评测集源报告文本片段。

### 两处端点默认值是唯一的「有意分歧」

本仓库是从私有开发树**在发版时同步**出来的代码子集，不是实时镜像——私有树会继续演进，
本仓库因此**可能落后于私有树的开发进度**（那属于滞后，不属于分歧）。

两树之间**有意为之**的差异只有两行，都在端点默认值上：

| 位置 | 私有树 | 本仓库 |
|---|---|---|
| `src/util/llmEndpoint.ts` 的 `DEFAULT_LLM_BASE_URL` | 内网真实地址 | 回环占位 `http://127.0.0.1:8014/v1` |
| `src/tools/describePatch.ts` 的 `VLLM_BASE_URL` 兜底 | 内网真实地址 | 回环占位 `http://127.0.0.1:8012/v1` |

**同步 `src/` 时不得互相复制这两行**——把私有树的真实地址带进来会破坏脱敏边界，
把本仓库的回环占位带回去会让私有树默认打不通。本仓库不带脱敏/同步脚本，这条规则靠手工遵守。

> ⚠️ 端点的 model id **随端点推**（`llmModelId()`）：硅基流动是 `Qwen/Qwen3-8B`，
> 非硅基端点默认 `qwen3-8b`。只改地址、不改 model 的话，未匹配的 id 会 404，而
> 决策层会**静默回落**到规则投票——日志看着像正常跑完。详见 `.env.example`。

## 引用与致谢

- **pi-agent** —— MIT，© 2025 Mario Zechner，<https://github.com/earendil-works/pi>。以 submodule 引用，未修改。
- 三个数据源（**TCGA/GDC**、**HISTAI**、**HistGen**）与若干模型权重的出处，见
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。**本仓库不包含它们的任何数据或权重。**

## 许可证

本项目采用 **MIT**，全文见 [`LICENSE`](LICENSE)。

上游 pi-agent 同为 MIT，其版权与许可声明依 MIT 要求完整保留在
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 中。
