# Requirements

运行与部署 PathAsk 所需的环境。**离线桩（`npm run dev`）只需要 Node.js 一条**——模型端点与
WSI 桥都是真实读片才需要。

## 必需

| | 要求 | 说明 |
|---|---|---|
| **Node.js** | **≥ 22.19** | 下限来自 `undici@8.10.2` 自己声明的 `engines`；`package.json` 的 `engines` 字段与之一致 |
| **npm** | 随 Node 附带 | 依赖用 `npm ci` 安装（`package-lock.json` 已入库） |

```bash
npm ci          # 或 npm install
npm run typecheck
npm run dev     # 离线脚本化闭环，零端点、零数据即可跑通
```

## WSI 桥（仅真实读片需要）

TypeScript 调不动 OpenSlide（Python 库），切片读取走一个 FastAPI 薄桥。

| | 要求 | 说明 |
|---|---|---|
| **Python** | 3.10+ | |
| **OpenSlide** | 系统级库 | `openslide-python` 依赖它，需先按发行版安装：`apt install libopenslide0` / `brew install openslide` |
| **Python 包** | 见 [`wsi-bridge/requirements.txt`](wsi-bridge/requirements.txt) | `openslide-python>=1.4`、`numpy>=1.26`、`pillow>=10`、`fastapi>=0.110`、`uvicorn>=0.29` |

```bash
pip install -r wsi-bridge/requirements.txt
python wsi-bridge/server.py     # 默认 http://127.0.0.1:8787
```

## 模型端点（仅真实读片需要）

两个都是 OpenAI 兼容端点，**不是安装依赖**——离线桩可以完全不要它们。默认值为回环占位地址
（本仓库不携带内网地址），需改成你自己的部署。详见 README 的「模型端点」一节与 [`.env.example`](.env.example)。

| 角色 | 默认端点 | 默认 model id | 环境变量 |
|---|---|---|---|
| 决策 / 编排 LLM（纯文本） | `http://127.0.0.1:8014/v1` | `qwen3-8b` | `PATHASK_LLM_BASE_URL` / `PATHASK_LLM_MODEL` |
| 病理 VLM（读图） | `http://127.0.0.1:8012/v1` | `patho-r1-7b` | `VLLM_BASE_URL` / `VLLM_MODEL` |

model id 随端点自动推导；指向公网托管（如硅基流动）时，另需一个对应的 API key，见 `.env.example`。

## 真实读片还需自备

以下**不在本仓库**，需自行准备：

1. **WSI 登记表**——`PATHASK_WSI_REGISTRY` 指向的 JSON，内容为 `slide_id → 原片路径`
2. **切片原片**——向对应数据源申请访问，出处处见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)
3. **入口接线**——`createRealSession()`（`src/session.ts`）已实现但未接到 `src/main.ts`，需自行接上（约十几行）
