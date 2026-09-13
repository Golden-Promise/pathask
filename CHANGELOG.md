# Changelog

本项目所有值得记录的变更都写在这里。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **VLM 输出退化判据**（`src/tools/degeneracy.ts`）：词元级重复（`不等样不等样×62` 这类贪心解码
  钩进循环后吐出的串）与骨架级重复两种检测，`describe_patch` 与 `verify_region` 共用一份。
  此前 `describe_patch` 这条路**完全没有退化检测**，`verify_region` 的旧判据也只认骨架签名。
  取向是**宁可漏检、不可误伤**——把一条真实形态描述误判成退化等于静默丢掉真实证据。
  判据随之在 `.env.example` 登记 `PATHASK_CLAIM_QUALITY_GATE`。

### Changed

- **README 重写为「是什么 / 有哪些工具 / 报告长什么样」**：只保留这三块加 Quick Start、模型端点表
  与文档索引。删除 Highlights、`src/` 目录树、架构图、pi-agent 接线说明、`npm run dev` 说明、
  接入真实端点、Requirements 表、设计要点、发布边界、诚实边界、引用致谢与许可证各节；
  简介改为「针对通用模型病理垂域识别能力不足、垂域模型证据链编排困难」的问题陈述。
  Requirements 独立成 `REQUIREMENTS.md`，许可证指向已有的 `LICENSE`。
- README 去掉全部加粗，并删掉工具表里的实现细节括注（打分算法、与 `inspect_region` / `describe_patch`
  的关系、相似病例的向量库）及 `inspect_region` / `describe_patch` 未暴露给 agent 的说明段。
- README 删掉报告样例（一段删减过的真实输出）与随附的几点读法，「报告长什么样」只留 `Report`
  类型定义与 `source` 字段说明。
- **删除 `CONTRIBUTING.md`**，README 的文档索引同步摘掉该行。
- `THIRD_PARTY_NOTICES.md` 只保留「用到什么 + 入口链接」表，删除「参考工作」一节、
  gated 与许可标注不一致的说明、模型的附加来源链接；自建评测集说明压缩为一段；
  补 `reg²` 入口，HISTAI 链接由 `HISTAI-mixed` 更正为 `HISTAI-metadata`。

### Fixed

- **退化 / 空 claim 不再进投票**：`claim` 质量门（默认开）把「输出退化」或「清洗后为空」的
  VLM 观察标 `degenerate: true`，出局投票与置信聚合、且不计入进展；正文换成可读说明，
  观测本身留存（不静默丢弃）。此前这类观察照常入库、照常打方向票，还被 `countsAsProgress`
  算作「有进展」——**证据越空，agent 越觉得自己读到了东西**。
- **`sanitizeClaim` 补中文触发词**：各类过滤规则里此前只有一条管中文，其余全是英文，
  中文 body 的诊断 / 建议 / 推测句全部放行。同时给「形态判定：…」这类**契约要求的结论标签句**
  开豁免——否则「按契约必须写的那个词恰好触发清洗，把写它的那句话连同证据一起删掉」，
  整个证据节点反而出局。
- **README 与 `THIRD_PARTY_NOTICES.md` 的模型默认值陈述与实现不符**：端点已改为本地优先，
  文档仍写「默认 SiliconFlow `Qwen/Qwen3-8B`」。现改为两个端点均为本地 vLLM 默认，
  并说明 model id 随端点推导、硅基流动降为可选后端。

## [0.1.0] - 2026-09-13

首次发布。这是**研究级参考实现**，不是可直接投入使用的产品。

### Added

- **agent 循环层**（`src/loop/`）：系统提示词协议（阅片工作流 / 工具约定 / 收尾规则）、
  循环治理（步数 / token / VLM 预算、重复调用指纹、无进展与振荡检测）、编排 LLM 的流式适配。
- **10 个 AgentTool**（`src/tools/`）：`scan_overview`、`detect_roi`、`perceive`、`verify_region`、
  `query_clinical`、`query_knowledge`、`retrieve_similar_case`、`analyze_evidence`、
  `counterfactual`、`generate_report`。
- **WSI 接入**（`src/wsi/`）：桥接客户端、ROI 采样、导航器、CONCH / PLIP 检索。
- **证据库**（`src/evidence/`）：per-session 的证据节点与支持 / 反对极性。
- **端点韧性**（`src/util/`）：端点分派、熔断器（连接类与服务级、超时与切片级分离）、
  瞬时故障重试预算（只改「跟模型说的话」，不自动重试）。
- **诊断谱**（`src/data/`）：器官 → 疾病词表，供决策层限定主诊断范围。
- **离线桩**（`src/mock/`）：脚本化 LLM + 固定数据，使 agent 循环在无任何端点的环境下也能跑通，
  既是 `npm run dev` 的内容，也是 CI 的端到端冒烟步骤。
- **WSI 桥**（`wsi-bridge/`）：FastAPI 薄桥，把 OpenSlide 读取暴露成 HTTP（6 条 GET + 4 条 POST）。
- 文档：`README.md`（中文）/ `README.en.md`（英文）/ `THIRD_PARTY_NOTICES.md` / 本文件 / `CONTRIBUTING.md`。
- CI：`.github/workflows/ci.yml`（typecheck + 离线闭环）。

### Changed

- **端点默认值改为「本地优先」**：不设任何 env 时，决策/编排 LLM 打 `DEFAULT_LLM_BASE_URL`
  （回环占位，请按自己的部署改），形态描述 VLM 打 `VLLM_BASE_URL` 兜底值。
  **硅基流动降为可选后端**——只设 `PATHASK_LLM_BASE_URL=https://api.siliconflow.cn/v1`
  一个 env 即可，无需再设第二个。
- **model id 改为随端点推导**（`llmModelId()`）：硅基流动 `Qwen/Qwen3-8B`，非硅基 `qwen3-8b`
  （可用 `PATHASK_LLM_MODEL` 覆盖）。此前 model id 被写死为硅基的值，指向非硅基端点会 404，
  并使决策层**静默回落**到规则投票——日志看着像正常跑完。这是「只设一个 URL 就能换端点」成立的前提。
- `npm run dev` 现在把 `VLLM_BASE_URL` 钉到 discard 端口 `http://127.0.0.1:9/v1`，
  避免「预写好的假决策序列 + 真 VLM」混着往外发请求（`${VAR:-}` 形式，显式覆盖仍生效）。

### Fixed

- 修 `.env.example` 中「`PATHASK_LLM_CONTEXT_WINDOW=131072` 与部署脚本的 `--max-model-len` 对齐」
  的说明——两者实际上并不一致，现改为提示按实际部署显式设成同一个数。
- **修「回落时冒充 LLM 决策」**：决策 LLM 失败会兜底回落规则投票，但推断节点与
  `analyze_evidence` 工具回执此前按模块常量 `DECISION_MODE` 落笔（它恒读作 `llm`），
  于是回落的病例在报告里写着「（LLM 决策）」——**LLM 根本没应声**。判据改用跟着实际
  路径翻转的局部量，并把零证据守卫单列为第三种（它既不是 LLM 也不是规则投的）。

### Notes

- **默认走离线桩**：`src/main.ts` 是 mock 入口，真实会话工厂 `createRealSession()`
  已实现但**未接到任何入口**——真实读片需自行接线，并自备 WSI 登记表、切片原片、
  病理 VLM 端点与决策 LLM 端点。
- 本项目**不训练、不分发任何模型权重**，也不包含任何数据集、切片或评测标注。
- 许可证 **MIT**。上游 [pi-agent](https://github.com/earendil-works/pi) 同为 MIT，
  其版权声明完整保留在 `THIRD_PARTY_NOTICES.md`。

[Unreleased]: https://github.com/Golden-Promise/pathask/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Golden-Promise/pathask/releases/tag/v0.1.0
