# 贡献指南

感谢你的兴趣。请先读 [README](README.md) 的「诚实边界」与「发布边界」两节——
本仓库是**研究级参考实现**，且**只发代码、不发数据**，这两点决定了哪些改动是合适的。

## 本地检查

提交前请跑通以下三步（CI 跑的也是这三步）：

```bash
npm ci             # 按 package-lock.json 精确安装
npm run typecheck  # tsc --noEmit
npm run dev        # 离线脚本化闭环，端到端冒烟
```

`npm run dev` 退出码为 0 即为通过。它会打印一批看起来吓人的警告
（`EISDIR` 降级模板、`缺少 SILICONFLOW_API_KEY`），那些是**预期行为**——离线模式
本来就在跑降级路径，理由见 README 的「`npm run dev` 跑的是什么」。

> ⚠️ **用 `./node_modules/.bin/tsc`，不要用 `npx tsc`。**
> 本地 `node_modules` 里没有 `tsc` 时（例如忘了 `npm ci`），`npx` 会去下载一个同名的
> 诱饵包 `tsc@2.0.4`，它只打印一行 `This is not the tsc command you are looking for`，
> **退出码却是 0**——门禁会假绿。`npm run typecheck` 走的是本地 bin，没这个问题。

若改动涉及 WSI 桥，另外验证：

```bash
pip install -r wsi-bridge/requirements.txt
python wsi-bridge/server.py          # 默认 127.0.0.1:8787
curl --noproxy '*' http://127.0.0.1:8787/health
```

## 修改准则

- **不改 `pi-agent/` submodule 的内容。** 它作为上游源码凭据（署名 / 出处 / 版本锚点）被锁定；
  所有适配都在 `src/` 层完成。需要改 pi 行为时，优先考虑在本仓库侧包装。
- **提示词正文（`src/loop/protocol.ts` 等）改动需谨慎。** 它直接决定 agent 的行为分布，
  不是普通字符串——改动应当有可复现的对照测量支撑，而不是「读起来更顺」。
- **降级证据必须标记且出局投票。** 超时 / 截断 / 回落产生的部分证据要带
  `stub` / `degenerate` / `fallback` 之类的降级标记，并**不计入投票**。
  否则「模型一挂、全片变温和模板」会把结论洗成良性——这是一条安全属性，不是风格问题。
- **不引入自动重试。** 瞬时故障只改「跟模型说的话」（错误文本 / 重试预算），
  决定权始终留给模型。超时回落规则投票，而不是偷偷重发。
- **不把评测集、切片、向量库、模型权重、部署脚本纳入发布面。** 外部数据源的再分发条款
  尚未落实（见 `THIRD_PARTY_NOTICES.md`）。新加的数据依赖请先确认许可。
- **不要提交密钥。** `.env` 已在 `.gitignore` 里；文档、注释、示例里都不要出现真实
  API key、内网主机名、私有 IP 或集群绝对路径。

## 提交信息

用简短的主题行说明「改了什么」，正文说明「为什么」。不需要遵循特定格式，
但一条提交只做一件事会让 review 容易得多。

## 发版

版本号遵循语义化版本，且**与 `package.json` 的 `version` 保持一致**：

```bash
# 1. 更新 package.json 的 version
# 2. 在 CHANGELOG.md 顶部把 [Unreleased] 换成新版本号 + 日期
# 3. 打 tag 并推送
git tag -a v0.1.1 -m "v0.1.1"
git push origin v0.1.1
# 4. 建 Release，正文用 CHANGELOG 里对应的那段
gh release create v0.1.1 --title "v0.1.1" --notes-from-tag
```

## 许可证

贡献即表示同意以本仓库的 [MIT 许可证](LICENSE) 授权你的贡献。
