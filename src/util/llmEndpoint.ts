/**
 * LLM 端点解析（编排器 + 决策 LLM 共用）。
 *
 * 为什么单独成模块：端点相关的**四件事**——**代理挂不挂**、**key 从哪来**、**思考字段怎么发**、
 * **model id 用哪个**——必须一起变。两份复制品必然漂移，故收敛到这里。
 *
 * **默认 = 本地自建端点**：不设任何 env 时打下面那个 `DEFAULT_LLM_BASE_URL`。
 * 公网硅基流动降为**可选**——只设 `PATHASK_LLM_BASE_URL=https://api.siliconflow.cn/v1` 即可，
 * model id 由 `llmModelId()` 随端点自动推出，**不需要第二个 env**。
 *
 * ⚠️ 第 ④ 件（model id）是后补的，补之前「只设 BASE_URL」是**假的**：硅基的 `Qwen/Qwen3-8B`
 *    会被发给非硅基端点 → 404 → analyzeEvidence 静默回落规则投票，而日志看着像正常跑完。
 */
import { ProxyAgent } from 'undici'

/** 默认端点 = **回环占位**。本仓库不携带任何内网地址，请按你的部署改成实际端点
 *  （任意 OpenAI 兼容：自建 vLLM / 硅基流动 / 其他）。 */
export const DEFAULT_LLM_BASE_URL = 'http://127.0.0.1:8014/v1'
/** 硅基流动的 model id 带组织前缀，与自建 vLLM 的 `--served-model-name` 不同名。 */
export const SILICONFLOW_LLM_MODEL = 'Qwen/Qwen3-8B'
/** 非硅基端点的默认 model id，按自建 vLLM 常见的 `--served-model-name` 取值。 */
export const LOCAL_LLM_MODEL = 'qwen3-8b'
export const DEFAULT_LLM_CONTEXT_WINDOW = 131072

/** 是否为硅基流动官方端点。**只**用它判别「思考字段发哪一种形态」「默认超时」「默认 model id」。 */
export function isSiliconFlow(baseUrl: string): boolean {
  try {
    return /(^|\.)siliconflow\.(cn|com)$/i.test(new URL(baseUrl).hostname)
  } catch {
    return false
  }
}

/** 回环 / 内网地址（RFC1918 + loopback）。用于决定**不挂代理**与**允许无 key**。 */
export function isPrivateHost(baseUrl: string): boolean {
  let host: string
  try {
    host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  if (host === 'localhost' || host === '::1') return true
  return (
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  )
}

/** 默认 model id **随端点推**（端点相关的第 ④ 件事）。
 *
 *  判据用 `isSiliconFlow`，**不是** `isPrivateHost`：model id 与「思考字段形态」都是
 *  **服务端是什么软件/哪家厂商**的属性，而 `isPrivateHost` 是网络可达性轴（挂不挂代理、
 *  允不允许无 key）。两者混用会造出「model 按一个判据推、thinking 按另一个判据推」的错配，
 *  正是当初把这几件事收敛到本模块要消灭的东西。
 *
 *  推论：第三方公网非硅基端点会同时拿到 `chat_template_kwargs` + `qwen3-8b` + 120s——
 *  这是「非硅基 ⇒ 按 vLLM 对待」的**有意**口径，逃生口是显式 `PATHASK_LLM_MODEL`。
 *
 *  显式 env 优先级最高，与 `llmTimeoutMs` 的 `PATHASK_LLM_TIMEOUT_MS` 同构。 */
export function llmModelId(baseUrl: string): string {
  const explicit = process.env.PATHASK_LLM_MODEL
  if (explicit) return explicit
  return isSiliconFlow(baseUrl) ? SILICONFLOW_LLM_MODEL : LOCAL_LLM_MODEL
}

export function llmProxyUrl(): string {
  return process.env.PATHASK_LLM_PROXY ?? process.env.SILICONFLOW_PROXY ?? 'http://127.0.0.1:7890'
}

/** 代理 Agent；**内网/回环返回 undefined（=不挂 dispatcher）**。
 *  ⚠️ undici 的 ProxyAgent **不读 `NO_PROXY`/`no_proxy`**（实测）。
 *  若不加判别，指向内网自建端点的请求会被强行经 `SILICONFLOW_PROXY` 转发 → 连不通。
 *  这是切换端点时最容易漏的一环。 */
export function llmProxyAgent(baseUrl: string): ProxyAgent | undefined {
  if (isPrivateHost(baseUrl)) return undefined
  return new ProxyAgent(llmProxyUrl())
}

/** API key。本地 vLLM 不校验 Authorization，故内网端点缺 key 时给占位符而非抛错；
 *  公网端点缺 key 仍返回 undefined（调用方照旧抛错，默认路径行为不变）。 */
export function llmApiKey(baseUrl: string): string | undefined {
  const k = process.env.PATHASK_LLM_API_KEY ?? process.env.SILICONFLOW_API_KEY
  if (k) return k
  return isPrivateHost(baseUrl) ? 'EMPTY' : undefined
}

/** 思考开关的**请求体形态随端点而异**：
 *  · 硅基流动：认**顶层** `enable_thinking`（其私有扩展字段），且须显式双向传——不传关不掉。
 *  · vLLM：顶层字段是**彻底的空操作**。vLLM 的 `OpenAIBaseModel` 是 `extra="allow"`
 *    （entrypoints/openai/engine/protocol.py:28，注释还写着「OpenAI API does allow extra fields」），
 *    所以**不会 400**；但 `chat_completion/protocol.py:262` 的 `chat_template_kwargs` 才是唯一
 *    被转给 Jinja 模板的客户端字段（:367 取显式入参，掏不到 extra dict）。 */
export function thinkingFields(baseUrl: string, enabled: boolean): Record<string, unknown> {
  return isSiliconFlow(baseUrl)
    ? { enable_thinking: enabled }
    : { chat_template_kwargs: { enable_thinking: enabled } }
}

/** 错误文案里的端点标签。⚠️ 改动此处必须同步 `src/tools/toolErrors.ts` 的 guessPhase 词表，
 *  否则 LLM 侧的错误会被判成 phase 未知。 */
export function endpointLabel(baseUrl: string): string {
  if (isSiliconFlow(baseUrl)) return 'SiliconFlow'
  return isPrivateHost(baseUrl) ? '本地 LLM' : 'LLM 端点'
}

/** 单次调用超时上限。默认**随端点**：
 *  · 硅基流动 240s——该端点为了不误杀坏签只能给足余量。
 *  · 本地 120s——让「真挂了」2 分钟暴露而不是白烧 4 分钟。
 *  仍**不自动重试**：超时 → analyzeEvidence 回落规则投票，只改上限不改行为。 */
export function llmTimeoutMs(baseUrl: string): number {
  const raw = process.env.PATHASK_LLM_TIMEOUT_MS
  if (raw) return Number(raw)
  return isSiliconFlow(baseUrl) ? 240_000 : 120_000
}
