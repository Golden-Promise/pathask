/**
 * Agent 工厂（B3，2026-09-11）：把 Agent 的构造**收敛到一处**，并挂上治理钩子。
 *
 * **为什么必须抽工厂**：治理钩子（`transformContext` / `beforeToolCall` / `shouldStopAfterTurn`）
 * 都挂在 `new Agent({...})` 的 config 上，而 Agent 在**调用方脚本**里构造——
 * `eval_core.ts`、`agent_real.ts`、`agent_mock.ts` 各一份。不收敛的话，治理层就只是
 * **评测侧补丁**：生产脚本走 `agent_real.ts` 时什么治理都没有，而评测分数却会变。
 * 收敛之后「评测里跑的东西 = 产品里跑的东西」，这是本文件存在的全部理由。
 *
 * **钩子分工**（四条都是框架既有公开能力，不改 vendored `pi-agent`）：
 *  - `transformContext`：每轮刷新，**不进 transcript**（框架在 `agent-loop.ts:290` 只把它当
 *    本轮的 messages 用，不写回 `state.messages`）→ 天然免去重，适合放「预算/停滞」这类
 *    每轮都该是最新数字的状态行。
 *  - `beforeToolCall`：**唯一的执行前门禁**（B4）。位置事实见 `governance.ts` 拦截节顶部。
 *  - `agent.steer()`：一次性投递（框架在每轮 turn_end 后 drain）→ 停滞/振荡/硬预算提示（B4）。
 *    **不是 `getSteeringMessages`**：`AgentOptions` 里没有这个字段，Agent 把它写死成 drain 自己的队列。
 *  - `shouldStopAfterTurn`：优雅退出 → 撞硬预算且本轮没走到收尾时收场（B4）。
 *  - `afterToolCall`：**永远不接**。`agent-loop.ts:747-750` 里它一旦 throw 会丢掉真实 tool result。
 *
 * `governance: false` 给 `smoke.ts` 用：它跑脚本化 streamFn，要的是**直连**框架、
 * 不受任何治理层影响（否则 smoke 绿了也说明不了框架本身没坏）。
 * **`PATHASK_LOOP_GUARD_ENFORCE=0` 是另一件事**：它关的是「干预」，A/B 的对照臂靠它
 * 精确复现治理层落地前的行为——两处合起来才是 `enabled`，但仍共用同一个工厂，
 * 所以「评测里跑的 = 产品里跑的」不因 A/B 而破。
 */
import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { PathAskSession } from '../types'
import { buildSystemPrompt } from './protocol'
import { makeRefResolver } from '../tools/common'
import { fingerprintToolCall } from './fingerprint'
import { budgetStatus, budgetStatusLine, createLoopGuard, loopGuardEnforce, resolveMaxTools } from './governance'
import { QWEN3_8B, siliconflowStreamFn } from './siliconflowStreamFn'

/** Agent 构造函数首个参数的完整类型——`streamFn`/`model` 都用它取，避免手抄签名后与框架漂移。 */
type AgentConfig = ConstructorParameters<typeof Agent>[0]

export interface CreateAgentOpts {
  session: PathAskSession
  /** 缺省取 session.currentWsiId 的注册信息（与三处原实现一致） */
  wsiId?: string
  cancer?: string
  /** 已建好的工具集；缺省由 createTools(session) 现建（避免循环 import，故由调用方注入） */
  tools: AgentTool<any>[]
  /** 关闭全部治理钩子（smoke 用）。**默认开**——关掉的是钩子，不是台账：
   *  台账在工具层（`guardedExecute`），与这里无关，故观测数据照样落。 */
  governance?: boolean
  /** 覆盖 system prompt（探针用） */
  systemPrompt?: string
  /** 覆盖流式函数（smoke 用脚本化流）。缺省 `siliconflowStreamFn`。
   *  **smoke 走这个口而不是自己 `new Agent`**：`governance:false` 的「行为逐字如初」是
   *  A/B 对照臂成立的前提，得有人真的跑这条路径才算被证明过。 */
  streamFn?: AgentConfig['streamFn']
  /** 覆盖模型（smoke 用 MOCK_MODEL）。缺省 QWEN3_8B。
   *  `initialState` 在构造签名里是可选的，故先 `NonNullable` 再取 `model`。 */
  model?: NonNullable<AgentConfig['initialState']>['model']
  /** 工具调用硬上限。缺省走 `resolveMaxTools()`（`PATHASK_MAX_TOOLS` → 旧 `MAX_TOOLS` → 15）。
   *  **显式传值优先于 env**：探针要能在一个进程里用不同上限跑多次（`PATHASK_LOOP_GUARD_ENFORCE`
   *  那种"每次调用时读 env"的写法在这里不适用——上限是 Agent 构造期的一次性决定）。 */
  maxTools?: number
}

export interface PathAskAgent {
  agent: Agent
  /** transformContext 被调用的轮数 */
  transformCount: () => number
  /** **真正注入了状态行**的轮数。与 `transformCount` 分开是必要的：
   *  未过软阈时钩子照样每轮被调用（只是原样返回 messages），只看 transformCount 会把
   *  「治理层每轮都在工作」误读成「预算提示生效了」。这是软阈在评测里唯一可落盘的证据——
   *  若 A/B 两臂的 `injectCount` 都是 0，两臂其实逐字相同，A/B 什么也没证明。 */
  injectCount: () => number
  /** 上一次注入的状态行；null = 本轮未注入（未超软阈） */
  lastStatusLine: () => string | null
  /** 本次生效的工具调用硬上限（步数）。落盘/断言用——「上限是多少」不该靠猜 env。 */
  maxTools: number
  /** 干预是否真的装上了（`governance:false` 或 `PATHASK_LOOP_GUARD_ENFORCE=0` 时为 false）。
   *  A/B 的对照臂要靠它自证「这一臂确实什么都没装」，否则「两臂无差异」无法归因。 */
  enforced: boolean
}

/** 构造 PathAsk 的 Agent。治理钩子默认挂上；`governance:false` 时行为与治理层落地前**逐字相同**。 */
export function createPathAskAgent(opts: CreateAgentOpts): PathAskAgent {
  const { session } = opts
  const wsiId = opts.wsiId ?? session.currentWsiId
  const cancer = opts.cancer ?? session.wsiRegistry.get(wsiId)?.cancer
  // `governance:false`（smoke 的直连测试）与 `PATHASK_LOOP_GUARD_ENFORCE=0`（A/B 对照臂）
  // 都要求「什么钩子都不挂」，但两者的**理由不同**，别合并成一句注释：前者要证明框架本身没坏，
  // 后者要一个可复现今天的对照臂。
  const enabled = opts.governance !== false && loopGuardEnforce()
  const maxTools = opts.maxTools ?? resolveMaxTools()

  let transforms = 0
  let injections = 0
  let lastLine: string | null = null

  const config: AgentConfig = {
    streamFn: opts.streamFn ?? siliconflowStreamFn,
    initialState: {
      model: opts.model ?? QWEN3_8B,
      systemPrompt: opts.systemPrompt ?? buildSystemPrompt([...session.capabilityRegistry.values()], { wsiId, cancer }),
      tools: opts.tools,
    },
  }

  // 治理钩子要投递提示，而投递口是它自己构造出来的 Agent（`agent.steer()`）。构造顺序上
  // 钩子在前、Agent 在后，所以留一个先声明、后填的盒子——见下方创建 guard 处的完整说明。
  let agentRef: Agent | null = null

  if (enabled) {
    // 软阈状态行：每轮重新算，**不进 transcript**。
    // 未超软阈 → 原样返回 messages（引用同一数组），prompt 逐字不变——这是「默认零改动」的落点。
    config.transformContext = async (messages) => {
      transforms++
      const line = budgetStatusLine(budgetStatus(session))
      lastLine = line
      if (!line) return messages
      injections++
      // 追加为**最后一条**（越靠后的 user 消息对模型的即时影响越大），且每次都重算而非累积。
      // ⚠️ `timestamp` 是框架 UserMessage 的必填字段——它只用于 transcript/遥测，
      // 但漏了会直接 tsc 报错（这是好事：框架把「这是条真消息」与「这是段注入文本」分开对待）。
      return [...messages, { role: 'user' as const, content: line, timestamp: Date.now() }]
    }

    // B4：门禁 + 一次性提示 + 收尾保险丝。**引用解析器现建**（`makeRefResolver` 查的是 session 上的
    // Map，detect_roi 会在运行中往 roiCache 里塞——缓存一次就等于用开局的空缓存去解析整场）。
    const guard = createLoopGuard({
      session,
      maxTools,
      fingerprintOf: (tool, args) => fingerprintToolCall(tool, args, makeRefResolver(session)),
      // 提示的投递口**晚绑定**：`createLoopGuard` 必须先于 `new Agent` 存在（钩子要写进 config），
      // 而投递又只能用 `agent.steer()`——先有鸡还是先有蛋。用一个盒子解开：钩子直到第一次
      // 工具调用才会真的碰它，那时 Agent 早已构造完毕。`?.` 不是防御性编程——探针只取 `guard`
      // 而不建 Agent 时，投递无处可去，静默丢弃正是想要的语义。
      steer: (text) => agentRef?.steer({ role: 'user', content: text, timestamp: Date.now() }),
    })
    config.beforeToolCall = guard.beforeToolCall
    config.shouldStopAfterTurn = guard.shouldStopAfterTurn
  }

  const agent = new Agent(config)
  // 晚绑定赋值点：必须在 `new Agent(config)` 之后（见上方盒子注释），且只有挂过钩子才有意义。
  if (enabled) agentRef = agent

  return {
    agent,
    transformCount: () => transforms,
    injectCount: () => injections,
    lastStatusLine: () => lastLine,
    maxTools,
    enforced: enabled,
  }
}
