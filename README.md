# PathAsk

> 对话式全片病理（WSI）阅片 agent —— 对整张切片提问，输出**带证据链**的研究级分析报告。
> agent 骨架用 [pi-agent](https://github.com/earendil-works/pi)（`pi-ai` + `pi-agent-core`）二次开发，
> 视觉理解接开源病理 VLM，决策接纯文本 LLM。

**本仓库只发 agent 代码**。评测集、WSI 数据、模型权重、内部评测 harness 与部署脚本**均不在此仓库**，
详见下方「发布边界」与 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

---

## 这是什么

丢给 agent 一张 WSI 和一句问题，它自己决定「低倍扫 → 挑区域 → 放大 → 让病理 VLM 描述 → 拉临床/知识 → 综合判断」，
产出的不是单个分类标签，而是**每个结论都能指回坐标、倍率与形态学描述**的报告，并且可以被追问。

价值分两层：
- **结论**（诊断 + 置信度）—— 单分类器也能给
- **证据链**（结论 → 区域坐标 → 倍率 → 形态描述 → 贡献 + 反事实）—— **agent 才能给**，是「可解释」的全部意义

### 诚实边界

- **研究级工具，不是医疗器械，不宣称临床可用**，不越过病理医生。
- agent 不提高底层模型的固有精度；VLM 差时它只是「优雅地失败」。
- 仓库里的默认配置是**为了可复现评测**而钉死的，不是「最优产品配置」。

---

## 架构

```
src/
├── loop/          agent 循环层
│   ├── agentFactory.ts      createPathAskAgent：组装模型 + 工具 + 循环治理
│   ├── protocol.ts          系统提示词协议（阅片工作流 / 工具约定 / 收尾规则）
│   ├── governance.ts        循环治理：步数/token/VLM 预算、重复指纹、无进展与振荡检测
│   ├── fingerprint.ts       工具调用规范化参数指纹（判「同参重复」）
│   ├── siliconflowStreamFn.ts  编排 LLM 的流式适配（OpenAI 兼容）
│   └── compactContext.ts    上下文压缩（⚠️ 默认关，见「已证伪项」）
├── tools/         10 个 AgentTool
├── wsi/           WSI 接入：桥接客户端、ROI 采样、导航器、CONCH/PLIP 检索
├── util/          resilience.ts（端点熔断 + 瞬时故障重试预算）、llmEndpoint.ts（端点判定）
├── evidence/      证据库（per-session）
├── knowledge/     知识库检索
├── data/          诊断谱（器官 → 疾病词表 + 形态证据签名）
├── mock/          无真实模型时的离线桩
└── runner.ts      单病例编排（含 F5 热点闭环、双倍率复核等非 agent 直调的路径）

wsi-bridge/        TS 调不动 OpenSlide，用这个 FastAPI 薄桥把 WSI 读取暴露成 HTTP
```

### 工具集（`createTools` 注册的 10 个）

| 工具 | 作用 |
|---|---|
| `scan_overview` | 低倍全览：缩略图 + 组织掩膜 + 候选网格 |
| `detect_roi` | 按打分挑候选 ROI（默认 blend = 核密度 + 组织密度），返回 `region_ref` |
| `perceive` | **单次「切块 + 批量 VLM 描述」**，替代旧的 `inspect_region → describe_patch` 两步，省一次 agent 往返 |
| `verify_region` | 带假设的复核：对某区域问「是否见到 X」，返回 支持/质疑/不确定 |
| `query_clinical` | 临床信息检索 |
| `query_knowledge` | 知识库检索 |
| `retrieve_similar_case` | 相似病例检索（CONCH 向量库） |
| `analyze_evidence` | **决策层**：把全部证据交给 LLM 做病例级判断 |
| `counterfactual` | 反事实：剔除某条证据看结论是否翻转 |
| `generate_report` | 收尾：产出结构化报告 |

> `inspect_region` / `describe_patch` 仍在源码里，但**不再暴露给 agent**——由 `runner.ts` 的内部路径
> （F5 热点闭环、P4 双倍率复核）直接调用。`run_mil` 已下线（专病模型全癌种覆盖不现实），从工具集撤下。

### 两个模型分工

| 角色 | 默认 | 环境变量 |
|---|---|---|
| **决策 / 编排 LLM**（纯文本） | SiliconFlow `Qwen/Qwen3-8B` | `PATHASK_LLM_BASE_URL` / `PATHASK_LLM_MODEL` |
| **病理 VLM**（读图） | 自建 `patho-r1-7b` | `VLLM_BASE_URL` / `VLLM_MODEL` |

两者都是**可替换的 OpenAI 兼容端点**——本项目不训练也不分发任何权重。

---

## 快速开始

```bash
git clone --recurse-submodules https://github.com/Golden-Promise/pathask.git
cd pathask
npm install
cp .env.example .env      # 按需填写端点与 key
npm run typecheck         # tsc --noEmit
```

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

### 起 WSI 桥

```bash
pip install -r wsi-bridge/requirements.txt   # openslide-python / fastapi / uvicorn
python wsi-bridge/server.py                  # 默认 http://127.0.0.1:8787
```

桥需要一个 slide 登记表（`PATHASK_WSI_REGISTRY` 指向的 JSON，`slide_id → WSI 原片路径`）。
**登记表与 WSI 文件不在本仓库**——请自备切片并向对应数据源申请访问（见 `THIRD_PARTY_NOTICES.md`）。

### 运行

```bash
npm run dev        # tsx src/main.ts
```

> ⚠️ 本仓库**不是一个开箱即跑的 demo**：跑通需要自备 (1) 一个 WSI 登记表 + 切片原片、
> (2) 一个病理 VLM 端点、(3) 一个决策 LLM 端点（或 API key）。缺任一项时 `src/mock/` 提供离线桩，
> 但那只验证接线，不代表真实读片能力。私有树里的 smoke / 评测 harness / 数据构建脚本不在此仓库。

---

## 设计要点

几个不显然、但踩过坑的设计决定，都写在 `src/util/resilience.ts`、`src/loop/governance.ts`
等文件的头部注释里。这里只列最值得先读的：

- **端点分派三件事**（`src/util/llmEndpoint.ts`）：切到自建端点时，**代理**（undici 的 `ProxyAgent`
  **不读** `NO_PROXY`，内网端点必须不挂 dispatcher）、**思考字段**（vLLM 顶层 `enable_thinking` 是空操作，
  必须发 `chat_template_kwargs`）、**超时默认**（抽签端点 240s → 稳定端点 120s）三件事必须一起变。
- **熔断只治「别再付第二次」**（`resilience.ts`）：连接类失败是服务死亡的**无歧义**证据 → 直接记服务级；
  超时是**模糊**证据 → 先归 (端点, slide)，窗口内够多张**不同**片子都超时才升级为服务级
  （否则一张病态巨片能判死整个服务）。业务类 4xx **不进熔断**——那是数据问题不是健康信号。
- **不自动重试**：瞬时故障只给「重试预算」并改变**跟模型说的话**，决定权始终在模型。
  超时 → 回落规则投票，而不是偷偷重发。
- **降级证据出局投票**：超时/截断产生的部分证据会被标记，**不计入投票**。
- **循环治理是防御性的**（`governance.ts`）：观测类默认开且零行为改动，干预类一律 env 门控。
  在真实基线上重复调用只占 6.2%、无病例撞步数上限——治理的价值是**堵住可能发生的失控**。
- **采样打分用核密度而非裸组织密度**：`tissue_fraction` 会把纤维/平滑肌/空白都算「组织」，
  核密的癌灶反而排名低 → 采样系统性偏向良性结缔组织。默认 `PATHASK_ROI_SCORE=blend`（0.6×核密度 + 0.4×组织密度）。

### 已证伪项（留在源码里，但默认关闭，别重复踩）

- **上下文压缩**：`PATHASK_CTX_COMPACT=1` 在全量 101 例上把弃诊从 4.9% 推到 45.9%、
  方向率从 59% 打到 23%。机制是折叠历史 → agent 提前收手 → 决策空虚 → 弃诊。
  **离线探针全绿但测不出行为回归**——源码保留，仅供将来以「证据库感知」的形态重启。
- **`run_mil` 专病分类器**：已从工具集下线。覆盖 24 器官多个分子分型不现实，统一走
  `perceive` + 检索 + 分析的通用路径。
- **廉价 CONCH 病灶性打分**：恶性词库 +0.067 / 跨片 prototype −0.131，被证伪；改用覆盖式 + 密度 + 多样性采样。

---

## 发布边界

**本仓库包含**：`src/`（agent 全部源码）、`wsi-bridge/`（WSI 读取桥）、配置模板与本文档。

**本仓库不含**（留在私有树）：
- 评测集与金标准标注（涉及三个外部数据源的再分发条款，**未经确认不公开**）
- WSI 切片、slide 登记表、CONCH 向量库、模型权重
- 评测 harness、数据构建脚本、部署脚本（含内部集群配置）
- 临床数据、任何患者可识别信息

已做脱敏：源码与文档中的内部主机名、内网 IP、集群绝对路径、归档切片 id 示例均已移除或改为占位符。
**并已用 n-gram 重合检查复核**：发布面中不含任何 ≥40 字符的评测集源报告文本片段。

---

## 引用与致谢

- **pi-agent** —— MIT，© 2025 Mario Zechner，<https://github.com/earendil-works/pi>。以 submodule 引用，未修改。
- 三个数据源（**TCGA/GDC**、**HISTAI**、**HistGen**）与若干参考工作的出处，见
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。**本仓库不包含它们的任何数据。**

## 许可证

本项目采用 **MIT**，全文见 [`LICENSE`](LICENSE)。

上游 pi-agent 同为 MIT，其版权与许可声明依 MIT 要求完整保留在
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 中。

## 参考工作

- **AdaptivePath** — arXiv:2608.08648（导航器训练 / PPO 奖励 / Deliberator-Arbiter 证据整合）
- **Pathology-o3 / Pathology-CoT** — arXiv:2510.04587（阅片行为建模：「看哪里 + 为什么」）
- **PathAgent** — arXiv:2511.17052（零训练基线：检索导航 + Executor 三步自省 + HITL）
