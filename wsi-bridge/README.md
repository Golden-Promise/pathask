# WSI bridge（OpenSlide 切片服务）

TS agent（pi-agent-core）无法直接调 OpenSlide（Python 库），此 FastAPI 服务把
WSI 读取暴露成 HTTP 接口，作为 TS↔Python 的薄桥。每个 `slide_id` 对应登记表
（`PATHASK_WSI_REGISTRY` 指向的 JSON）里的一条登记（真实 WSI 原片路径）。

## 启动

```bash
# 需先装好 openslide-python / fastapi / uvicorn（见 requirements.txt）
PATHASK_WSI_REGISTRY=/path/to/wsilist.json python wsi-bridge/server.py
# 默认 http://127.0.0.1:8787
```

`PATHASK_WSI_REGISTRY` **是必需的**——指向登记表 JSON，不设（或文件不存在）服务直接
`RuntimeError` 退出，连 `/health` 都不会起。登记表格式：

```json
{"slides": [{"id": "case_00001", "path": "slides/case_00001.tiff", "cancer": "breast"}]}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | `/slides/{id}/...` 里的 `{id}`；TS 端会做去扩展名 / basename 回退 |
| `path` | 是 | 切片原片路径，**相对登记表所在目录**解析；文件不存在时该条跳过并打印 `[warn]` |
| `cancer` | 是 | `/slides` 列表里回显的癌种。**缺了 `/health` 仍返 200，但 `/slides` 会 500**（`KeyError`） |
| `case_id` | 否 | 可选的病例号，`/slides` 原样回显 |

其它环境变量（可选）：`PATHASK_BRIDGE_PORT`（默认 8787）、`PATHASK_BRIDGE_HOST`（默认 127.0.0.1）。

## 接口

### 切片读取（GET）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活 + 已登记 slide 数 |
| GET | `/slides` | 列出登记 slide |
| GET | `/slides/{id}/info` | 尺寸 / 层数 / downsamples / objective |
| GET | `/slides/{id}/thumbnail?max_dim=1024` | 缩略图 PNG（base64） |
| GET | `/slides/{id}/tissue-mask?max_dim=2048` | 组织掩膜：覆盖率 + bbox + 粗网格候选细胞（每格带 `tissue_fraction` / `nuclear_fraction`） |
| GET | `/slides/{id}/region?x&y&w&h&level` | 指定层级真读一块 → PNG（base64） |

`{id}` 会先经 `_resolve` 归一化：精确命中登记表 → 去扩展名回退 → basename 回退
（TS 端 `WsiClient` 会剥掉目录前缀再进 URL，否则 `/` 会让路径参数被截断）。

### 向量编码（POST）

请求体统一为 `EmbedReq`：`{"images": ["本地路径或 data-uri"], "texts": ["..."]}`，
两者都可省略；返回 `image_vectors` / `text_vectors`。**首次调用懒加载权重**（CONCH ~25s，PLIP ~20s），之后的调用才快。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/embed` | **PLIP** 双塔编码 → 归一化向量（图/文） |
| POST | `/conch-embed` | **CONCH** 病理专用双塔编码 → 归一化向量（图/文）。检索首选 |
| POST | `/conch-embed-raw` | CONCH **未归一化**特征（`ln_contrast` 池化），MIL 特征协议用 |
| POST | `/mil` | `{"slide_id","capability_id","max_patches"?}`：在线抽特征 → RRTMIL 权重 → slide 级预测（需 `data/capability_registry.json` 与 `PATHASK_STREAM_ROOT`） |

> ⚠️ **`/conch-embed-raw` 与 `/mil` 服务的是 `run_mil` 专病分类器，而该工具当前不在 agent 的工具集里**
> （`src/tools/index.ts` 的 `createTools` 不注册它，源码 `src/tools/runMil.ts` 保留但无调用方）。
> 桥侧路由与 `mil_inference.py` 都保留着，但 `/mil` 还依赖两样**不在本仓库**的东西：
> `data/capability_registry.json`（`/data/` 已 gitignore）与 STREAM 权重（`PATHASK_STREAM_ROOT`）。
> 克隆本仓库后这两条路由**不可用**。

> 权重路径全部走环境变量，为空时懒加载会抛清晰错误：`CONCH_WEIGHTS`（`/conch-embed`、`/conch-embed-raw`、`/mil`）、
> `PLIP_PATH`（`/embed`）。也就是说**不配权重时，只有 GET 那六条切片读取路由可用**。

## TS 客户端

`src/wsi/WsiClient.ts`（Node fetch，不走代理）。工具层通过 `realWsi(ctx, slideId)`
判断真实路径是否可用：可用走 OpenSlide，否则回落 mock 桩。

`npm run bridge` 等价于 `python wsi-bridge/server.py`。

> 注：`http_proxy` 环境变量若设置，会把 localhost 请求也代理走（curl/urllib 会 502），
> Node fetch 不受影响。手动 curl 测试时加 `--noproxy '*'`。
