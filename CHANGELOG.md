# Changelog

本项目所有值得记录的变更都写在这里。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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

## [0.1.0] - 2026-09-12

首次发布。这是**研究级参考实现**，不是可直接投入使用的产品——边界见 README 的「诚实边界」一节。

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

### Notes

- **默认走离线桩**：`src/main.ts` 是 mock 入口，真实会话工厂 `createRealSession()`
  已实现但**未接到任何入口**——真实读片需自行接线，并自备 WSI 登记表、切片原片、
  病理 VLM 端点与决策 LLM 端点。
- 本项目**不训练、不分发任何模型权重**，也不包含任何数据集、切片或评测标注。
- 许可证 **MIT**。上游 [pi-agent](https://github.com/earendil-works/pi) 同为 MIT，
  其版权声明完整保留在 `THIRD_PARTY_NOTICES.md`。

[Unreleased]: https://github.com/Golden-Promise/pathask/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Golden-Promise/pathask/releases/tag/v0.1.0
