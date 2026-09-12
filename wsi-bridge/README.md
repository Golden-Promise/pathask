# WSI bridge（OpenSlide 切片服务）

TS agent（pi-agent-core）无法直接调 OpenSlide（Python 库），此 FastAPI 服务把
WSI 读取暴露成 HTTP 接口，作为 TS↔Python 的薄桥。每个 `slide_id` 对应
`data/wsilist.json` 里的一条登记（真实 WSI 原片路径）。

## 启动

```bash
# 需先装好 openslide-python / fastapi / uvicorn（见 requirements.txt）
python wsi-bridge/server.py
# 默认 http://127.0.0.1:8787
```

可选环境变量：`PATHASK_WSI_REGISTRY`（wsilist.json 路径）、`PATHASK_BRIDGE_PORT`。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活 + 已登记 slide 数 |
| GET | `/slides` | 列出登记 slide |
| GET | `/slides/{id}/info` | 尺寸 / 层数 / downsamples / objective |
| GET | `/slides/{id}/thumbnail?max_dim=1024` | 缩略图 PNG（base64） |
| GET | `/slides/{id}/tissue-mask?max_dim=2048` | 组织掩膜：覆盖率 + bbox + 粗网格候选细胞 |
| GET | `/slides/{id}/region?x&y&w&h&level` | 指定层级真读一块 → PNG（base64） |

## TS 客户端

`src/wsi/WsiClient.ts`（Node fetch，不走代理）。工具层通过 `realWsi(ctx, slideId)`
判断真实路径是否可用：可用走 OpenSlide，否则回落 mock（smoke）。

## 测试

```bash
npm run bridge:test-wsi   # 生成合成金字塔 TIFF（无真实 WSI 时开发用）
npm run bridge            # 启动桥接
npm run smoke:real        # 真实路径冒烟（scan→detect→inspect→describe）
```

> 注：`http_proxy` 环境变量若设置，会把 localhost 请求也代理走（curl/urllib 会 502），
> Node fetch 不受影响。手动 curl 测试时加 `--noproxy '*'`。
