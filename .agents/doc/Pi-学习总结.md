# Pi 学习总结：Agent Harness 的前馈设计

> 分析对象：`/share/project/wuhaiming/spaces/pi`（pi-mono 仓库）
> 分析视角：agent harness 设计，重点在**前馈**（feedforward）——让系统在出错之前就正确，而不是出错之后去修。
> 文献基础：2024–2026 年 arXiv 论文（2026 年约 30 篇重点阅读）、主流开源项目（Claude Code、OpenAI Codex、OpenHands、Aider、LangGraph、Temporal、Letta 等）、pi 仓库全部设计文档与源码结构。
> 注意：pi 的 Harness v2（`packages/agent/src/harness`）**尚在建设中**，`prompt()/compact()/resume()` 等核心方法尚未实现（见仓库 `ROADMAP.md`）。本总结的学习对象是**设计**（`packages/agent/docs/harness-v2.md`，3446 行规范），而非已部署的代码；已在生产链路中的 v3 会话系统同样纳入分析。

---

## 0. 摘要：pi 最值得学习的 10 个设计理念

先给结论。按"对前馈工作的参考价值"排序：

| # | 理念 | 一句话 |
|---|---|---|
| 1 | **双流日志：entries + records** | 会话 = 对话事实（条目树）+ 执行事实（记录台账）两条 append-only 流；状态是日志的纯函数 |
| 2 | **崩溃点分类 + 工具重放声明** | 每个工具调用的崩溃位置被枚举（X1–X5），工具声明 `safe`/`never` 可重放性；恢复语义在设计期完全确定 |
| 3 | **预配 ID（幂等键）** | 每个结果在效果执行**前**就分配并持久化 ID；"运行过但结果丢了"与"没运行过"可区分 |
| 4 | **追加-only 上下文不变量** | 一次 run 内，每个 provider 请求的消息列表严格以前一个请求为前缀——KV-cache 纪律被写成不变量并有测试强制 |
| 5 | **单一执行机器 + 门（gate）** | 自动执行 = 门恒放行；手动模式是同一台机器；不存在"测试用的第二套代码" |
| 6 | **泳道 = 单写者 FIFO** | 每个泳道一个操作队列，跨泳道无锁、无共识；并发正确性靠构造而非检测 |
| 7 | **压缩（compaction）是一等持久操作** | 有独立崩溃语义、钩子决策、保留尾、用量记账；上下文溢出被分类为可恢复/不可恢复，每会话输入最多恢复一次 |
| 8 | **设计文档即规范** | 崩溃表、竞争目录、21 条不变量、三层测试策略、工作包所有权表全部写在文档里；实现从文档派生 |
| 9 | **provider 中立 + 能力发现** | stop reason 规范化、错误编码为消息、deferred 执行作为可选能力；harness 不为任何厂商定制 |
| 10 | **Schema-first 类型化遥测 + 用量台账** | span 词汇编译时检查、默认零内容泄露；每个物理请求一条 usage 记录，统计 = 台账求和 |

贯穿全部 10 条的主线：**pi 把"反馈回路"（重试、恢复、压缩）本身工程化为确定性、有界、可测试的日志状态迁移**——这是前馈团队最该拿走的一条元经验（见第 5 节）。

---

## 1. 调研：Agent Harness 的研究与产业现状（2024–2026）

### 1.1 范式转移：瓶颈定位从"模型"转向"模型–harness 耦合"

Agent 系统的研究重心经历了清晰的阶段转移：

- **2022–2023（循环本身）**：ReAct（推理–行动交错）、ToolLLM/Gorilla（工具调用能力）、AutoGen/CAMEL/MetaGPT（多智能体对话）。创新在"让模型用工具"。
- **2024（接口与行动空间）**：SWE-agent 提出 ACI（agent-computer interface）——接口设计与模型能力同等重要；CodeAct 把行动空间统一为可执行代码；SWE-bench 建立真实工程基准；Claude Code/Codex CLI 把 agentic 编码产品化。Agentless 则从反面证明：相当一部分"智能体能力"可以用简单管线替代，复杂循环不一定赢。
- **2025（上下文工程与标准化）**：context engineering 取代 prompt engineering 成为主话语（Anthropic、Cognition、Manus 的工程博客）；MCP 标准化工具/上下文接入；A2A 标准化 agent 间通信；多智能体出现大辩论（Anthropic 多智能体研究系统 vs Cognition《Don't Build Multi-Agents》的上下文共享原则）；durable execution 传统（Temporal 等）开始被引为 agent 可靠性参照。
- **2026（harness 成为一等领域对象）**：这是最重要的变化。"agent harness" 作为独立研究对象在 2026 年集中出现：

| 论文 | arXiv | 贡献 |
|---|---|---|
| AI Harness Engineering: A Runtime Substrate for Foundation-Model Software Agents | 2605.13357 | 把 harness 形式化为**运行时基底**，提出 11 项组件职责（任务规范、上下文选择、工具访问、项目记忆、任务状态、可观察性、失败归因、验证、权限、熵审计、干预记录）与 H0–H3 能力阶梯；提出 trace-based 评估（episode package） |
| From Question Answering to Task Completion: A Survey on Agent System and Harness Design | 2606.20683 | model–harness 视角综述；把 harness 分解为 6 个耦合运行时职责（观察、上下文、控制、行动、状态、验证）；核心问题："性能瓶颈在模型、harness，还是两者耦合处？" |
| Engineering Reliable Coding Agents | 2608.13867 | 多声部综述（164 论文 + 100 实践记录）：大量"模型失败"实际源于 harness/状态/检索/权限层；提出 206 条可靠性记录目录与依赖链评估框架 |
| Evo-Bench: Can Language Models Improve Agent Harness? | 2608.09096 | 第一个专门评测"模型自主改进 harness 能力"的基准 |
| From Determinism to Delegation | 2606.28791 | 范式论文：工作单元从函数变为受监督的 agent 工作流；正确性从二元断言变为不确定性下的统计评估 |

这与 pi 仓库 `ROADMAP.md` 的自述完全同频：pi 把自己定义为"分层代理运行栈"，并把 Harness v2 的目标明确写为"日志是 durable source of truth，reducer 只根据记录重建状态，外部 effect 与状态归约分离"。

### 1.2 研究热点（按主题，2026 年重点）

**1) 上下文工程与上下文管理** —— 2026 年最密集的热点，且结论正在收敛为"上下文管理是承重墙"：

- 《Plans Don't Persist》（2606.22953）：用 hidden-state 探测证明标准 agent **不会把计划内化为持久状态**，计划一旦被驱逐性能即坍塌（信号单步衰减 4.1×）——状态必须外化，不能指望模型"记住"。
- 《Governance Decay》（2606.22528）：压缩是安全关键失效面。1323 个 episode 中，治理约束在压缩后消失导致违规率从 0% 升到 30%（个别模型 59%）；约束只要存活于摘要中违规率就是 0%。提出 Constraint Pinning（把治理约束隔离在损失性压缩之外）。
- 《TokenPilot》（2606.17016）：指出**文本稀疏性与 prompt-cache 连续性之间的根本权衡**——无约束的序列编辑导致前缀失配和缓存失效；提出前缀稳定的 ingest 压缩 + 保守的批–turn 驱逐调度，成本降 56–87%。
- 《Beyond Compaction (CWL)》（2606.11213）：轨迹被标注为带类型、带依赖边的 episode；**确定性的、无 LLM 的策略**按优先级驱逐"效果已持久化到环境"的行动 episode——与 pi "条目已进树，上下文只是投影"的思想同构。
- 《Self-GC》（2607.00692）：上下文对象有生命周期（fold/mask/prune）；harness 强制执行**可恢复的 sidecar、安全提交边界、cache-aware commit**。
- 《Less Context, Better Agents》（2606.10209）：剪到最近 5 对工具调用 + 自动摘要，完成率 71%→91.6%，token 降约 93%。
- 学习路线：《SWE-MeM》（2606.28434）用 GRPO 联合优化记忆管理与任务解决；《Escaping the Context Bottleneck》（2604.11462）用 RL 做主动上下文策展——与上面的确定性规则路线形成两条技术路线。

**2) 持久执行、事务与恢复**：

- 《AgentRewind》（2608.14380）：记录 **agent 上下文与受控环境的对齐检查点**，出错可回滚到早期状态并携带前次尝试信息继续。
- 《Agentic Transaction》（2608.13900）：把 ACID 重新解释为语义原子性/一致性/隔离性/持久性，构建 ACID 合规 agent 系统，在基准上超 SOTA 10.6%。
- 《Looping Is Not Reliability》（2607.24604）：generate–test–revise 循环本身不提供可靠性保证；**陈旧轨迹比当前轨迹危害大 22.2 个百分点**（34/135 vs 4/135）；提出把验证证据绑定到精确代码状态、保留已验证检查点、发出可审计的准入回执（typed revision contract）。
- 多智能体并发异常的形式化检测（2606.17182）。

**3) 工具架构与 ACI/AOI**：

- 《The Devil Is in the Interface》（2608.11386）：11700 条轨迹受控实验——工具**架构**（同样的能力如何组织暴露）显著改变行为：结构化低层接口使跨重复尝试一致性提高最高 4.7×；CodeAct 风格接口步数 −41.6%、token −56.3%；轻量认知脚手架工具（todo 等）收益有限。
- 《AOI》（2606.29472）：SWE-agent 确立了行动接口是设计轴，这篇把**观察接口**确立为独立的第二轴（连续自适应观察与离散行动解耦），+17~48pp 且零再训练。
- 《The Bitter Lesson of Tool Calling》（2608.06370）：程序化工具调用（工具暴露为类型化 Python 桩，模型写代码调用）在 14 个模型中 11 个持平或优于原生 JSON 调用。

**4) 技能（skills）与程序性记忆**：

- 《Demystifying Agent Skills》（2608.14036）：8135 条受控试验——技能起作用的方式是**程序性锚定（65.7%）而非知识注入（4.5%）**：技能稳定的是"怎么做"，不是"知道什么"；检索是独立瓶颈（池从 5 增到 100，实际使用精度 29.6%→大幅下降）。
- 《What Keeps Agent Skills from Being Reusable?》（2608.08453）：13.8 万个公开 SKILL.md，**91.8% 至少一个缺陷**；主导缺陷是路由元数据弱、正文臃肿不可执行；有效路由元数据的技能被启动描述检索到的可靠性显著更高；轻量 lint + 自动修复工作流有效。
- 《Muscle Memory for Agents》（2608.08995）：主张把重复用户意图**编译**为专用 agent，而不是每次检索再解释。

**5) 记忆**：《From Storage to Experience》（2605.06716）给出三阶段演化框架：Storage（轨迹保存）→ Reflection（轨迹精炼）→ Experience（轨迹抽象）。关键推论：**Storage 阶段的质量决定后两阶段的天花板**——没有结构化轨迹日志，就没有可靠的反思与经验抽象。项目级记忆走向结构化：《MOOSEDev》（2608.13662）用语义类型化的知识图谱（决策、教训、约束、理由，带生命周期/溯源/替代链）替代向量检索，替代链/集合完整性/否定类问题召回 0.98–1.00 vs 向量基线 6–27%。

**6) 溯源与可观察性**：《From Agent Traces to Trust》（2606.04990）把执行溯源定义为 agent 执行的**类型化图**，证据追踪是其投影；统一了检索接地、声明支持、工具安全、记忆谱系、可观察性、调试、审计、恢复。《A²E》（2608.07346）、《Long-Horizon Agent Trajectory Attribution》（2608.06909）是工程化与基准化。

**7) 评测与生产化**：《RAMP》（2605.27492）：静态基准反映不了生产运行时（长链、工具交互、依赖管理）；构建生产级运行时评估基础设施，含**部分工作流失败下的分阶段恢复机制**。《Benchmarks Are Not Validation》（2607.28840）同题。τ-bench 的 pass^k 一致性指标（同任务重复 k 次全对）成为可靠性评测的事实标准。

**8) 自我改进（反馈侧，与用户团队非重点，但必须了解边界）**：

- 综述《Self-Improvements in Modern Agentic Systems》（2607.13104）：现代 agent = 基础模型 + **操作脚手架**（提示、记忆、工具、控制逻辑）的耦合；自我改进 = 对参数或脚手架组件的自诱发更新算子。
- 《DarwinX》（2608.07545）：模型冻结，对 **harness 种群**做自然选择；preserve-and-extend 契约（只接受覆盖扩大且不回退的变体）；一轮平均 +17 分。
- 反面证据同样重要：《Phantom Guardrails》（2607.13083）——自我改进的 harness 优化器会**为从未发生的失败发明护栏**（15/60 次在存在"像违规模式"的合法输入时启用不存在的规则护栏）；《Blind Resampling Outperforms Self-Repair》（2607.26117）——小模型上盲目重采样强于携带失败尝试的自我修复（锚定效应：看到自己的失败尝试后 33–68% 重现实验）；《Self-Authored Verification Is Unreliable》（2607.24300）；《Skill Misevolution》（2608.12851）——不安全成功会沉淀为可复用策略。

### 1.3 痛点与瓶颈（跨项目、跨论文的共同问题）

1. **状态易失，无事务语义**。主流 agent 的"状态"散落在内存变量 + 消息列表里；崩溃 = 丢失；"这步工具跑没跑过"无答案。LangGraph 用每 superstep 全量状态快照（checkpointer）缓解，MemGPT 用分页记忆缓解，但都不是日志/事务模型。这是 AgentRewind、Agentic Transaction 两篇 2026 论文共同指向的第一痛点。
2. **上下文管理是承重墙，且是安全面**。窗口有限 + 成本随长度增长 + 压缩会丢治理约束（Governance Decay）+ 缓存连续性与编辑自由度互相冲突（TokenPilot 的核心权衡）+ 计划类信息最先被驱逐（Plans Don't Persist）。上下文策略同时决定成本、性能、安全三个维度。
3. **工具副作用非幂等，重放语义未定义**。模型调用天然非幂等（token 消耗、随机性），工具调用有真实副作用（写文件、发消息）。崩溃恢复时"要不要再执行一次"在主流 harness 中没有形式化答案；pi 的 safe/never 重放声明是目前见到的最系统的设计。
4. **模型耦合**。stop reason、错误格式、思考标记、流式事件各厂商不同；harness 为单厂商定制后难以换模型。π-ai 的规范化层、AOI 的"model-agnostic"主张都针对这一点。
5. **多智能体上下文碎片化**。Cognition 的反多智能体立场 + Anthropic 多智能体系统的高 token 成本（~15× chat）说明：共享上下文昂贵，不共享则上下文分裂。跨 agent 状态一致性缺乏设计工具。
6. **成本与延迟不可归因**。没有请求级用量台账，就无法回答"哪个工具/哪次重试/哪次压缩花了多少"，前馈式的成本优化（缓存、路由、剪枝）失去数据基础。
7. **评测与生产的差距**。SWE-bench 类静态基准 vs 生产长链运行时（RAMP）；pass^k 揭示重复稳定性差；自我改进系统还会"修复从未发生的失败"（Phantom Guardrails）——**评估证据本身需要治理**。
8. **harness 膨胀与责任边界模糊**。框架功能面不断扩张（MCP、subagent、permission、todo、后台任务全塞 core）vs 最小核 + 扩展的路线；2026 年的框架比较研究（2606.04967 Process Taxonomy）观察到行业在收敛于"持久工件 + 工作契约 + 可追溯性 + 人工评审"。
9. **harness 本身成为优化对象，但缺乏模块化与真实证据**。自我改进回路需要：可识别的更新目标、真实的失败证据、不回退的门、可验证的 fitness（DarwinX 的 preserve-and-extend）。脚手架设计质量决定自我改进是否可行且安全。

### 1.4 pi 在这张地图上的位置

把 pi Harness v2 的组件对到 2026 年两篇 harness 论文的职责框架上：

| AI Harness Engineering（2605.13357）11 项职责 | pi 对应物 |
|---|---|
| 任务规范 | prompt/skill/模板展开、`operation_started.originalPrompt` |
| 上下文选择 | 会话树投影、transform_context、compaction |
| 工具访问 | 门控工具集、before_tool 钩子、重放声明 |
| 项目记忆 | 会话树 + 事实（labels/session info）+ v3/v4 迁移 |
| 任务状态 | records + lanes + 纯 reducer |
| 可观察性 | schema-first 遥测、事件目录 |
| 失败归因 | X1–X5 崩溃点、RunFailed/overflow 分类、usage 台账 |
| 验证 | 三层测试（恢复/写者一致性/确定性交错）、21 不变量 |
| 权限 | fail-closed 钩子、钩子隔离（注：pi 刻意不做 core 级沙箱，见 §7） |
| 熵审计 | 用量台账 + 统计 = 台账求和（部分对应） |
| 干预记录 | 操作日志 + 钩子 resumeData + 持久队列项 |

| 综述 6 职责（2606.20683） | pi 对应物 |
|---|---|
| 观察 | 消息/快照/事件 |
| 上下文 | 树 + 投影 + compaction + 追加-only 不变量 |
| 控制 | driver loop、门、泳道 FIFO |
| 行动 | Effects 边界、工具三阶段 |
| 状态 | reducer、facts、lanes |
| 验证 | 不变量、测试层、恢复幂等 |

结论：pi 不是某个单点创新，而是**对 2026 年才刚被学术界命名的问题域（harness 作为运行时基底）给出的一套完整工程答案**，且在持久性、溯源、缓存纪律三个维度上比主流产品激进。下面的分析按主题展开。

---

## 2. 我的分析标准与维度（元方法说明）

用户要求显式列出分析标准。我使用的判定框架如下。

### 2.1 "值得学习"的判定标准（4 条，全部满足才算一等设计理念）

1. **改变问题类别，而非改进参数**。该设计是消除了某一类故障/复杂度（结构性），还是把某个指标调得更好（增量性）？例如：X1–X5 崩溃点分类消除了"恢复语义靠运气"这一整类问题；把重试延迟从 1s 调到 2s 不是。
2. **对抗性条件下成立**。在崩溃、并发、超长会话、恶意输入、provider 故障下是否仍然正确？只看 happy path 的设计降级。
3. **有验证手段**。设计是否自带不变量、测试钩子、可执行的断言？不可验证的"好设计"不可学习（因为不知道学对了没有）。
4. **复杂度预算诚实**。引入的抽象是否被使用面 justify？pi 的很多设计恰恰赢在"用最少的构件覆盖最多的正确性"（一台机器、一个门、一条队列）。

### 2.2 前馈透镜（为什么用这个视角，以及操作化定义）

控制论定义：**前馈**使用已知信息（输入、状态、模型、先验）在输出误差被观测到**之前**起作用，降低误差发生的概率；**反馈**在输出误差被观测到**之后**纠正。

在 agent harness 语境下，前馈 = 一切"让这个请求一开始就正确、便宜、安全"的工程；反馈 = 出错后的重试/自我纠正，以及跨会话的自迭代自优化（用户团队非重点）。

我把每个 pi 设计点按 5 类前馈机制归类：

| 前馈类型 | 含义 | pi 的代表设计 |
|---|---|---|
| 正确上下文 | 模型看到的上下文本身是正确的、完整的、无冲突的 | 会话树投影、追加-only 不变量、steering 只在校准点消费 |
| 安全契约 | 外部动作的副作用语义预先定义，出错也有确定结局 | 工具 safe/never 重放声明、预配 ID、fail-closed 钩子 |
| 确定性执行 | 执行路径由构造确定，不依赖运行时调度巧合 | 单一执行机器 + 门、泳道单写者、竞争目录双向测试 |
| 成本可预测 | 成本/延迟行为在设计期可推导 | 缓存纪律不变量、deferred 停放零烧 token、用量台账 |
| 可验证性 | 正确性可被独立检验 | 21 不变量、三层测试、reducer 不动点自检、遥测 schema |

**判定方法**：对每个设计点问两个问题——(a) 它降低的是"故障发生的概率"还是"故障发生后的损失"？前者是前馈，后者是反馈（但见 5.1：pi 把反馈回路也前馈化了，这是最高级的形态）。(b) 如果把它删掉，哪一类故障/成本/不可验证性会重新出现？

### 2.3 分析维度（8 个）

1. **状态模型**：状态存在哪、持久单位是什么、读写路径是否分离。
2. **崩溃/恢复语义**：崩溃点是否枚举、恢复是否幂等、副作用是否有 at-least-once/exactly-once 答案。
3. **并发模型**：谁写什么、锁/共识是否必要、竞态是否被构造排除。
4. **外部契约**：工具与 provider 的接口如何隔离变化（错误、stop reason、能力差异）。
5. **上下文纪律**：发给模型的上下文如何增长、何时失效、缓存亲和如何保持。
6. **可观察性与成本**：执行过程能否被追溯、成本能否归因到物理请求。
7. **扩展性**：产品能力如何不污染核心（扩展/技能/钩子）。
8. **工程方法论**：设计如何被文档化、测试化、版本化、所有权化。

---

## 3. Pi 项目自身速览（后续章节的地基）

pi 是分层代理运行栈，五个关键层（详见仓库 `ROADMAP.md`）：

```
pi-ai          统一所有 LLM provider：消息/流事件/工具调用/认证/错误格式的差异被压在 adapter 下
pi-agent-core  最小 agent 循环：agentLoop（推理–工具循环）+ Agent（状态/队列/事件屏障）
coding-agent   产品级 harness：AgentSession 编排（skills/扩展/压缩/重试/分支/TUI/RPC/SDK）
pi-tui         独立终端渲染引擎（与 agent 语义无关）
harness v2     正在建设的下一代：持久 SessionTree + lane + operation + step + 纯 reducer + Effects
```

**关键现状**（ROADMAP.md 的诚实自述）：生产主链路是 v3 的 `AgentSession` + JSONL 会话树；`AgentHarness`（v2）已公开导出但 `prompt/compact/resume` 等返回 `HarnessNotImplemented`，目前只能打开空会话。所以学习 v2 设计时要清醒：**它是一份已完成论证、正在分工作包落地的规范**（§20 有 26 个带依赖图的工作包），不是已验证的运行时。

v2 的核心数据结构（`packages/agent/docs/harness-v2.md` §5/§12/§13）：

```
Session（一个存储对象，可换后端：memory / JSONL / SQLite）
├── entries   对话条目树（用户/助手/工具结果/压缩/摘要…）——"对话里发生了什么"
├── records   执行记录（op_started / step_attempt / tool_started / usage / …）——"执行器做了什么"
├── lanes     泳道（名字 + 叶指针 + 空闲/挂起状态）——"并行工作流"
└── facts     事实（labels、session info…）——"与条目无关的持久元数据"
```

核心心智模型一句话：**日志是唯一持久真相，泳道状态 = reduce(日志)，所有外部效果必须跨 Effects 边界，每个操作（run/compaction/navigation）有显式的持久生命周期**。

---

## 4. 最值得学习的设计理念（核心交付）

每条按【pi 的实现】→【对照业界/学界】→【前馈价值】展开。

### 主题 A：状态与持久性

#### A1. 双流日志：entries（对话事实）与 records（执行事实）分离

【pi 的实现】会话里有两条独立的 append-only 流。entries 是模型与用户可见的对话树（assistant 消息、工具结果、压缩条目…）；records 是执行器可见的操作台账（`operation_started`、`step_attempt`、`tool_started`、`usage`、`finishOperation`…）。两者用预配 id 关联（一条 `tool_started` 记录指向它将要产生的 entry id）。恢复时，entries 重建对话，records 重建"执行到哪一步了"——**对话完整性与执行进度是两个正交事实**（harness-v2.md §5、§7）。

【对照】主流产品把两者混在一根消息列表里：Claude Code 的 JSONL 会话只有对话条目，"上次重试到第几次"这类执行状态不在日志里（靠内存）；LangGraph 的 checkpointer 存的是整个状态图节点的快照（全量状态，不是事实流）；MemGPT 把记忆分页但不记录"谁在何时为什么改了记忆"。学界同向：《From Agent Traces to Trust》（2606.04990）把执行溯源定义为类型化图——pi 的 records 就是那张图的可持久化形态；《Agentic Transaction》（2608.13900）的语义持久性也要求执行事实独立于对话内容存活。

【前馈价值】**正确上下文 + 可验证性**。把执行事实从对话中剥离后：(a) 恢复不需要猜（台账说了算）；(b) 对话条目可以安全地作为"发给模型的上下文"的来源，因为里面没有执行噪声；(c) 溯源（"这个工具结果是哪次尝试、哪个操作产生的"）变成查表而不是考古。这是整个前馈体系的底座——没有它，后面的崩溃分类、缓存纪律、成本归因全部无根。

#### A2. 预配 ID：效果执行前先持久化结果的"位置"

【pi 的实现】任何会产生持久结果的动作（assistant 响应、工具结果、压缩摘要），其结果 entry 的 id 在**动作开始之前**就分配并写入意图记录（`step_attempt(resultEntryId)`、`tool_started(resultEntryId)`）。效果完成后，结果落到这个预配位置；恢复时靠"预配位置上有没有条目"区分三种状态：已完成 / 已执行但结果丢失 / 从未执行（§5、§6）。

【对照】这是分布式系统里"事务消息/幂等键"模式（outbox pattern、Kafka 事务、Stripe 幂等键）在 agent 领域的移植。Agent 领域此前基本没有对应物：AgentRewind（2608.14380）用"上下文+环境的对齐检查点"解决类似问题，粒度是检查点而非单个动作；《Looping Is Not Reliability》（2607.24604）的"可审计准入回执"（admission receipts）是同一思想在代码修复循环里的独立重发现。

【前馈价值】**安全契约 + 正确性**。预配 ID 让"副作用是否发生"从不可知变为可判定——这是 exactly-once 语义的前提（配合 A3 的重放声明）。它同时让树结构在崩溃后仍保持一致：放弃的尝试会补一个"完成预配 id"的错误条目，树里永远没有悬空引用。一个看似微小的机制，实际上支撑了 §4 主题 B 的全部恢复语义。

#### A3. 纯 reducer + 不动点自检：状态归约无副作用，且每次恢复后自证

【pi 的实现】`LaneState`（队列、尝试计数、工具批、deferred handle、结构化目标…）完全由 reducer 从记录日志归约出来，归约过程零写入、确定性。harness 在每次 `resume()` 结果后做不动点自检：重算的归约必须等于内存中的存活状态（§15、§19 层 C 不变量）。

【对照】这是 CQRS 的读侧投影 + 数据库 WAL 重放的 agent 化。Temporal/Cadence 的确定性重放是最近的工程亲戚，但 pi 把"状态=归约(日志)"推到了可自证的程度（每次恢复都做一次完整对账）。LangGraph 的 checkpointer 是快照路线，无法回答"两个快照之间的每个动作是否合法"；pi 的日志路线可以（§5 的合法性规则就是对"日志前缀是否合法"的判定）。

【前馈价值】**可验证性 + 确定性执行**。把状态从"内存里逐渐变脏的东西"变成"日志的函数"，等于把一整类 bug（内存状态与持久状态漂移）在构造上排除。不动点自检更进一步：恢复逻辑自己会在每次运行时验证自己——**验证内嵌在运行路径里，而不是只在测试里**。

#### A4. 格式演化纪律：v3→v4 的只读规范化 + 首写崩溃安全转换

【pi 的实现】旧格式会话打开时做只读规范化（不改物理文件）；第一次写时才通过临时 format-4 文件重写（rename 原子提交，崩溃不损坏原文件），并补一条聚合用量调整记录保证 `getStats()` 总和不变（§13、工作包 J4/J5）。

【对照】agent 会话格式的版本演化成熟度普遍很低（很多产品的会话格式事实上是 v1 永久制，格式变了就迁移脚本）。pi 把数据库迁移的纪律（读兼容先行、写转换崩溃安全、统计守恒）完整搬了过来。

【前馈价值】**正确上下文（跨时间）**。格式演化保证的是"未来的 harness 能读懂今天的轨迹"——这对前馈团队尤其重要：轨迹是未来一切反思/经验抽象/自我改进的原料（《From Storage to Experience》的 Storage 阶段），原料格式不稳定，下游全部失效。统计守恒（调整记录）则保证成本分析在迁移前后连续。

### 主题 B：崩溃与恢复

#### B1. 崩溃点分类（X1–X5）：每个动作的每个崩溃位置都有名字和语义

【pi 的实现】harness-v2.md §6 用一张完整表枚举每个动作（assistant 步骤、工具批、压缩、导航…）的每个持久点，定义崩溃在该点前后的恢复行为。工具批的核心是 X1–X5：X1 意图未持久；X2 意图已持久、效果未开始；X3 效果已执行、结果未持久（最危险）；X4 结果已持久；X5 后续动作。恢复算法对每个位置有唯一确定的动作（harness-v2.md §6 表 + §15 `reconcileToolBatch`）。

【对照】《Looping Is Not Reliability》（2607.24604）证明"循环+重试"不提供可靠性，要求"状态绑定的证据 + 类型化修订契约"——pi 的崩溃点表就是契约的设计期形态。AgentRewind（2608.14380）的回滚粒度是检查点（上下文+环境对），pi 的粒度是单个动作的持久点，更细。Temporal 的"事件历史重放"在语义上等价，但 pi 把它做进了 agent 会话本身，且不需要工作流代码满足确定性约束（reducer 是纯函数，执行代码不需要可重放——这是一个重要区别：Temporal 要求活动代码确定，pi 只要求归约确定）。

【前馈价值】**安全契约（极端形态）**。崩溃恢复的正确性在设计文档里就能审完，不靠测试碰运气。对前馈团队的意义：它示范了如何把"不可控事件"（进程死亡、provider 断连）转化为"有限状态迁移表"——前馈的本质就是对不确定性的**枚举化**。

#### B2. 工具重放声明：safe / never，副作用的幂等性由工具自证

【pi 的实现】工具声明其效果的可重放性。崩溃在 X3（已执行、结果丢失）时：若持久声明与当前声明都是 `safe`（纯计算/幂等），重放并记录两次执行的用量；否则写一个合成的 "interrupted" 结果条目，让对话树闭合，由模型在下一回合自行决定是否重试（§6、§15、§19 层 A 覆盖"replay safe/never/changed 声明"）。

【对照】这是 agent harness 领域我见到过的唯一形式化"工具副作用幂等性"机制。相邻领域：数据库的只读事务声明、K8s 的 `idempotency-key`、gRPC 的 `Idempotency` 元数据，都是同一原理；但把它们组织成"崩溃恢复分派表的一维"是 pi 的独特贡献。《Agentic Transaction》的语义一致性讨论到了类似问题但停留在语义层，没有落到工具契约。

【前馈价值】**安全契约 + 确定性执行**。它把"这个工具能不能再跑一次"从运行时祈祷变成声明式契约。对前馈团队：这是工具设计（§4 主题 E）与恢复设计（本主题）的交汇点——**工具的接口里必须包含副作用语义**，否则崩溃恢复、重试策略、甚至成本计算（两次执行的用量）全部无法正确。

#### B3. 恢复即正常执行：没有第二台机器

【pi 的实现】`resume()` 走与正常执行完全相同的 procedure 代码（同样的 `assistantStep`、`runToolBatch`、`compactionProcedure`），只是输入状态来自归约。测试层 C 直接用 `drive: "manual"` 在真实 harness 上重放崩溃场景（§8、§19）。

【对照】"测试路径 = 生产路径"在 agent 框架里极少做到：多数框架的测试靠 mock LLM/fake tool，与生产路径长期漂移。pi 的手段是**门**（见 D2）：把执行切成离散动作，测试手动放行，生产自动放行——同一台机器。这与 Temporal 的"重放即测试"哲学同源，但实现更轻（不需要确定性工作流约束）。

【前馈价值】**可验证性 + 确定性执行**。恢复逻辑的 bug 是 agent harness 最危险的 bug（它只在生产崩溃时触发）；让恢复跑在日常测试路径上，等于把最危险的代码路径变成最被测试的代码路径。

#### B4. 有界反馈：尝试计数持久化，溢出每会话输入最多恢复一次

【pi 的实现】重试是步骤内的（瞬时错误 + 退避），尝试计数持久在 `step_attempt` 记录里，跨崩溃不丢；上下文溢出被分类——可恢复（输入超过窗口）→ 压缩 → 重试，且**每个对话输入最多触发一次恢复**，`length → length` 再失败即有界终止（§6、§15 `autoCompact`、§19 "overflow classification" 用例）。

【对照】2026 年反馈侧论文的集体结论正好从反面支持这个设计：盲目重试/自我修复在小模型上弱于盲重采样（2607.26117），循环本身不提供可靠性（2607.24604）。pi 的做法是把反馈回路约束成**有界、持久计数、语义分类过的状态迁移**——反馈存在，但被前馈式的纪律驯化。

【前馈价值】**成本可预测 + 确定性执行**。"每输入最多一次恢复"是一个可以直接写进 SLA 和成本模型的上界；持久尝试计数保证崩溃不会把有界性重置。

### 主题 C：上下文工程（pi 最直接的前馈贡献）

#### C1. 追加-only 上下文不变量：KV-cache 纪律写成不变量

【pi 的实现】不变量（harness-v2.md §4，测试层 B 可执行断言）：**一个 run 内，每个 provider 请求的消息列表都以前一个请求的消息列表为精确前缀**——唯一的合法例外是跨压缩条目（"唯一批准的失效"）。实现手段：steering/队列输入只在检查点（turn 边界）消费；工具结果按源顺序追加；所有"想插入中间"的冲动都被设计禁止。

【对照】这是 pi 与 2026 年上下文管理研究最直接的对话点。TokenPilot（2606.17016）的核心发现是"文本稀疏性与 prompt-cache 连续性之间存在根本权衡"，其解法是"前缀稳定的 ingest 压缩 + 保守的批–turn 驱逐"——pi 的做法更极端：干脆**禁止**中途编辑，把缓存连续性变成构造性质。Self-GC（2607.00692）的 "cache-aware commit"、CWL（2606.11213）的确定性驱逐，都在朝同一方向走。服务端背景：vLLM 的 automatic prefix caching、SGLang 的 RadixAttention 让"前缀稳定"直接转化为算力/成本节省——harness 侧的前缀纪律是服务端缓存机制的使能条件。

【前馈价值】**成本可预测（设计期）**。这是教科书级的前馈：不是"缓存未命中后重试/换路由"（反馈），而是"构造上保证命中"。对前馈团队的直接启示：**把服务端的性能机制（prefix cache）变成 harness 的约束（不变量），而不是调优目标**。不变量还能被测试强制（层 B：任何在尾之前插入的写路径都会让测试失败）。

#### C2. 队列语义：steer / followUp / nextRun 只在校准点消费

【pi 的实现】用户输入分三类：`steer`（当前 run 的方向修正，在下一个检查点消费）、`followUp`（run 结束后执行）、`nextRun`（空闲时执行）。队列项是持久记录（崩溃后存活，可取消，取消也持久）；关键规则：**消费只发生在检查点**，即消息前缀已经完整落定、缓存已经"固化"的时刻（§6 "finish-boundary orders"、§15 driver loop）。

【对照】《Plans Don't Persist》（2606.22953）证明模型不会把关键信息内化为持久状态——所以用户中途说的话必须进上下文，但"何时进"直接决定缓存代价。主流做法（立即注入或下个 turn 注入）没有形式化；pi 把"注入点"与"缓存边界"对齐，是上下文工程与执行调度的联合设计。RAMP（2605.27492）在生产评估中观察到的"部分工作流失败下的行为"在 pi 里由持久队列项直接处理（失败后排队的输入不丢）。

【前馈价值】**正确上下文 + 成本可预测**。用户输入永远不丢（持久队列），同时不破坏前缀纪律（校准点消费）。这是"交互性 vs 缓存亲和"这对矛盾在 harness 层的解法——两个维度都被设计满足，而不是折中。

#### C3. 压缩是一等持久操作，不是后台杂务

【pi 的实现】compaction 有自己的操作类型（`operation.kind: "compaction"`）、自己的崩溃语义、自己的钩子决策（`before_compaction`，可拒绝、可提供摘要）、持久尝试上限、用量记账、`retainedTail`（保留尾策略）、结果条目（带 `fromHook` 溯源）。手动压缩、阈值自动压缩、溢出触发压缩共用同一套持久机制，区别只在触发原因（`manual/threshold/overflow`）（§15 `compactionProcedure`/`autoCompact`、§20 工作包 C1–C3）。

【对照】对照 2026 上下文管理论文：CWL（2606.11213）要求"确定性、无 LLM 的驱逐策略"——pi 的保留尾+切点规则（切点不落 toolResult、避免孤儿工具调用）就是确定性策略，摘要生成则是可替换的 LLM 步骤（钩子可接管）；Governance Decay（2606.22528）的 Constraint Pinning 在 pi 里的最近对应是：系统提示/AGENTS.md 类约束在消息流之外，天然不进压缩目标——**但会话中途注入的治理约束仍在目标内**，这是 pi 当前设计的一个真实缺口（见 §7）。SWE-MeM（2606.28434）走的是学习路线（GRPO 联合优化），pi 走的是规则+操作化路线：两条路线在 2026 年并存，pi 的路线优势是可审计、可崩溃恢复、可测试。

【前馈价值】**正确上下文 + 可验证性**。把压缩提升为持久操作后：(a) 压缩本身可以崩溃/恢复（不再是"压缩到一半进程死了怎么办"的悬案）；(b) 压缩的决策可被钩子干预（前馈式的策略注入点）；(c) 压缩的成本可归因（usage 记录）。**"管理上下文的上下文管理"被完整工程化了。**

#### C4. 溢出分类：可恢复 vs 不可恢复，每对话输入一次恢复

【pi 的实现】`isRecoverableOverflow`：溢出形式的错误、静默溢出（输入超窗）→ 可恢复：丢弃失败响应、压缩、重试；真正的输出上限（`length` 且 maxTokens 已用满）→ 不可恢复：直接 `RunFailed`。且每对话输入最多一次恢复，防止 `length → length` 死循环（§6、§15、§19 用例列出全部 provider 形状：272,000 窗口的 268,009 可恢复、1,024 token 满上限不可恢复、Codex 风格拒绝 max_output_tokens 的 provider 等）。

【对照】溢出处理是 coding agent 产品的常见痛点，但"可恢复/不可恢复"的严格分类（尤其"静默溢出"——模型没报错但上下文其实装不下了）在公开设计里罕见。2026 的 SWE-MeM/Less Context 都在做"预防溢出"（前馈），pi 的溢出恢复是"溢出发生时的有界反馈"，两者互补。

【前馈价值】**确定性执行 + 成本可预测**。分类本身是前馈（在设计期判定每种 provider 行为属于哪类），恢复次数上界是成本/延迟上界。对前馈团队：这是一个"如何把 provider 的不可靠行为分类成有限个可设计情形"的范例。

#### C5. 上下文 = 投影：完整历史在树里，模型只看视图

【pi 的实现】会话树保存完整历史（含所有分支）；发给 provider 的上下文是 leaf 路径上的投影（经过压缩摘要 + 保留尾 + transform_context 钩子）。pi-ai 的 `transformMessages` 在请求构建时还会修复孤儿工具调用（合成空结果）。导航（切分支）只是移动叶指针（§12、§15、ROADMAP.md 第五节）。

【对照】MemGPT 的"上下文=可编辑的分页视图"、Cognition 的"共享完整上下文"、CWL 的"效果已持久化到环境的 episode 可激进驱逐"——都承认"存储 ≠ 呈现"。pi 把这条原则做成了存储层原语（树 + 投影），而不是运行时技巧。MOOSEDev（2608.13662）从记忆侧得到相同结论：结构化存储 + 类型化查询远胜向量 top-k。

【前馈价值】**正确上下文（根本机制）**。历史不可变 + 投影可变 = 模型看到的上下文永远有完整的可追溯来源；分支、rewind、审计、未来的一切"轨迹再利用"（反思/经验抽象/评测回放）都免费获得。

### 主题 D：并发与执行模型

#### D1. 泳道 = 单写者 FIFO：并发正确性靠构造排除

【pi 的实现】每个泳道是一个操作队列：同一时刻每泳道至多一个活跃操作（admission 返回 `LaneBusy` 而不是排队第二个）；所有持久写入经过每会话的写队列串行化（SQLite 后端用租约，JSONL 用单写者队列，§13）。跨泳道无锁、无共识、无共享可变状态——不同泳道写不同前缀，存储层只保证 `seq` 唯一递增。

【对照】actor 模型（Erlang/Akka）"消息传递代替共享内存"的 agent 化；与 LangGraph 的"每 thread 一个 checkpointer 全局状态"相反——pi 的泳道状态只归约自本泳道流量（§20 R3 验收："one lane never scans another lane's traffic"）。多智能体系统的并发异常检测（2606.17182）要解决的问题，pi 在构造上就没有。

【前馈价值】**确定性执行（构造级）**。竞态条件不是"用测试覆盖"，而是"不存在可竞态的共享状态"。对前馈团队：这是"排除一类故障"而非"缓解一类故障"的范例。

#### D2. 门（gate）：唯一的测试缝隙，自动=恒放行的门

【pi 的实现】执行被切成离散动作（appendEntry、streamAssistant、executeTool、moveLane…），每个动作前过门。`drive: "automatic"` 时门恒放行（生产）；`drive: "manual"` 时 `peekAction()/executeAction()` 手动放行（测试）。**同一份代码、同一个门**——没有 mock harness、没有 fake 执行层（§8、§15、§19 层 C）。

【对照】这是 pi 整个测试体系的地基，也是"恢复即正常执行"（B3）的实现手段。相邻思想：Temporal 的确定性约束（代价：工作流代码必须确定）、混沌工程（代价：生产风险）、模型检查（代价：状态空间爆炸）。pi 的门是"时间控制"原语：测试控制动作顺序，生产控制动作自动性——**并发交错从"运行时巧合"变成"测试时脚本"**。

【前馈价值】**可验证性（最强形态）**。层 C 的覆盖是机械的：驱动每个 §6 追踪、在每个 `executeAction()` 后快照、重开每个快照恢复两次——新加的效果自动获得崩溃覆盖。"测试覆盖"从人工维护的资产变成构造的推论。

#### D3. 准入控制 + 带标签的 Err：预期失败是值，不是异常

【pi 的实现】`prompt()` 等同步准入，返回 `Ok` 或带标签的 `Err`（`LaneBusy`、`InvalidMessage`、`NothingToCompact`、`UnknownTarget`…）；只有真正的内部缺陷才抛出。挂起操作有精确的元数据清点（`SuspendedOperation[]`）（§8、§20 F0/R3）。

【对照】Rust `Result` 哲学在 TS 生态的坚持（整个仓库的类型系统围绕 tagged unions）；与多数 JS agent 框架"一切皆 throw + try/catch"形成对照。`HarnessNotImplemented` 的使用是同一纪律的诚实面：未实现的操作显式拒绝，不返回"看起来成功的空值"（§20 F0 验收："no unfinished method reports plausible success"）。

【前馈价值】**可验证性 + 正确上下文（API 层）**。预期失败可枚举 → 调用方可以穷尽处理 → 集成方的 bug 面缩小。"不报告似真成功"这条对前馈团队尤其重要：**假成功是最贵的前馈失效**，因为它把错误推迟到最远的下游才暴露。

#### D4. 竞争目录：每个竞态是一行表，两个顺序都要测

【pi 的实现】§15 维护一张竞争目录（race catalog），每行列出一个竞态、双方的动作、两个顺序的期望结果。工作包验收直接引用行号（H3："race rows 2, 5, 7, 12 both orders"、H5："rows 4, 6, 8, 10 + crash/reopen after every abort action"）；层 C 要求每行两个顺序都有确定性测试。

【对照】并发工程里竞态分析（happens-before 推导、线性化点）是标准做法，但"把竞态目录当设计工件维护、并机械化为测试矩阵"在 agent 项目里罕见。这直接回应 2606.17182（并发异常检测）：pi 选择在设计期枚举，而不是运行时检测。

【前馈价值】**确定性执行 + 可验证性**。竞态从"祈祷没踩中"变成"表驱动、双向、可回归"。

### 主题 E：外部契约（provider 与工具）

#### E1. provider 中立：差异压到 adapter，失败编码为消息

【pi 的实现】pi-ai 把各厂商的消息格式、流式事件、工具调用、认证、错误格式压到 provider adapter 下；harness 只见统一类型（Message/ToolCall/Usage/StopReason/Model metadata）。关键约定：**模型调用失败被编码为 `stopReason: "error" | "aborted"` 的 AssistantMessage，而不是从流中抛异常**（ROADMAP.md 第一节、harness-v2.md §16 的 stop reason 规范化表：`max_output_tokens → length`、`content_filter → 不可重试 error`）。

【对照】MCP 生态标准化了工具接入但没标准化"agent 执行层与模型层"的契约；OpenAI Agents SDK 事实上与 OpenAI 绑定；LangChain 的 provider 抽象历史上有大量语义漂移。2026 年的 AOI（2606.29472）"model-agnostic perception layer" 是同一原则在观察侧的表述。pi 的 stop reason 规范化表是一个小而关键的契约工件：它让 harness 的分支逻辑只依赖规范化值，adapter 保留 `rawStopReason` 供诊断。

【前馈价值】**安全契约 + 可预测性**。换 provider 不改执行语义；provider 的怪癖（各家溢出报错格式不同——§19 用例里逐一列出）被分类到有限个规范化情形。对前馈团队：**与外部世界的每个接口都需要一张"怪癖→规范化情形"的映射表**，这张表本身就是前馈资产。

#### E2. 能力发现：deferred 是可选能力，无 fetch 的 provider 永不返回 deferred

【pi 的实现】`ProviderStreams.fetchDeferred?/cancelDeferred?` 是可选方法——方法的存在即能力信号。harness 的能力探测基于接口形状而非 provider 名字（§16）。deferred 请求快速返回 handle 而非内容；handle 是持久事实，进入树。

【对照】这是"capability-based design"（能力接口）在 LLM provider 层的应用；对照 OpenAI 的 background mode、各家的 batch API——pi 把"长任务"提升为 provider 契约的一等概念，而不是产品层的轮询 hack。

【前馈价值】**成本可预测 + 正确上下文**。长 provider 工作（大批量、后台推理）以持久 handle 形式停放：agent 不轮询（零 token 燃烧、零上下文污染），`resume()` 时 fetch，pending 则原样重停放。这是"异步 I/O"思想在 agent 循环里的完整落地——主流 agent 框架里几乎没有对应物。

#### E3. 工具契约：验证、拦截、隔离、终结，四个阶段各有语义

【pi 的实现】工具调用经过 prepare（TypeBox 参数校验）→ before_tool 钩子（可改参数、可阻止；**handler 失败 fail-closed：阻止该工具**）→ execute（可并行，但 preflight 顺序、结果按源顺序落盘）→ after_tool 钩子（可改结果；每个 handler 错误隔离，不击穿 run）→ 结果条目（`terminate: true` 可结束整个 run）（§11 钩子语义表、§14 工具三阶段、ROADMAP.md 第三节"并行执行但确定性落盘"）。

【对照】《The Devil Is in the Interface》（2608.11386）的 11700 轨迹实验证明工具架构（组织与暴露方式）本身改变行为一致性（最高 4.7×）——pi 的工具面刻意小（bash/read/edit/write 四个基础工具 + 扩展注册），与"结构化低层接口提升一致性"的实证结论同向；todo 类"轻量认知脚手架工具"在该实验中收益有限，pi 也没有把它们写死在 core（ROADMAP.md 第六节："刻意没有把 MCP、subagent、plan mode、permission popup、todo、后台 bash 等全部写死在 core"）。fail-closed 的 before_tool 与 SkillSentry（2608.09253，runtime assurance 保证技能可靠执行）同向。

【前馈价值】**安全契约（工具层）**。"工具失败不击穿循环"（异常→`isError` 结果）保证对话树永远合法；"并行执行、源顺序落盘"保证并发效率与可复现性兼得；fail-closed 保证安全默认。**工具接口的每个阶段都有确定的失败语义**——这是 B2 重放声明能成立的前提（没有确定的失败语义，就不知道"interrupted"该不该重放）。

#### E4. 显式上下文传播：拒绝 Ambient State

【pi 的实现】遥测上下文（`TelemetryContext`）作为普通参数穿过每个带效果的边界；pi 明确不用 `AsyncLocalStorage`、全局当前 span、运行时特定上下文 API——"pi 运行在 Node、Bun、浏览器和 worker 中，没有任何运行时的环境上下文机制能作为核心抽象"（§18）。

【对照】ambient state（线程局部、ASL、全局单例）是 Node/Python 生态的可观察性栈默认姿势（OTel context、Python `contextvars`）。pi 的选择牺牲了"自动附着"的便利，换来了：跨运行时可移植、可测试（上下文是参数，测试里一眼可见）、无隐藏耦合。Effect 系统传统（Effect-TS 等）里"效果作为值传递"是同一谱系。

【前馈价值】**确定性执行 + 可验证性**。任何"当前上下文"都是显式的 → 任何行为都可以从调用参数推导 → 可测试性、可移植性、可推理性同时获得。对前馈团队：这是一条容易忽视但回报巨大的纪律——**把隐式环境变成显式参数，是前馈工程的基础设施**。

### 主题 F：可观察性与成本

#### F1. Schema-first 类型化遥测：span 词汇是编译时资产

【pi 的实现】`defineTelemetrySchema` 声明 span 名、属性类型、必需性、封闭值集；`createTypedSpanStarter` 在编译期强制：未知属性、缺失必需属性、类型不匹配、非法封闭值全部编译失败。两个领域 schema（`AI_TELEMETRY_SCHEMA` 1 个 span、`HARNESS_TELEMETRY_SCHEMA` 10 个 span）+ 文档由 schema 对象生成（`generate-telemetry-docs`）（§18、`packages/agent/docs/telemetry-schema.md`）。

【对照】OTel 的 GenAI 语义约定（`gen_ai.*`）是外部词汇，pi 选择自有 `pi.*` 词汇 + adapter 翻译——与"schema 对象也是文档源"配套，版本演化走 changelog。多数 agent 框架的 tracing 是"往 OTel 塞自由属性"；pi 的做法把可观察性词汇变成与 API 同级的受管资产。

【前馈价值】**可验证性 + 成本可预测（数据基础）**。编译时检查保证遥测数据永远 schema 合规 → 下游分析（成本、延迟、失败归因）可以放心依赖字段存在性。"默认属性绝不携带提示/补全/工具参数/机密"（§18 安全节）是隐私默认值。

#### F2. 用量台账：每个物理请求一条记录，统计 = 台账求和

【pi 的实现】`usage` 记录绑定到（操作, 步骤尝试, 预配结果 id, 尝试号）；分 turn 请求每尝试两条；重放工具记录两次执行；v3 导入补聚合调整记录；`getStats()` 的 token/成本字段必须等于台账总和（每次提交后）（§5、§19 "ledger completeness and the match invariant"）。

【对照】《From Agent Traces to Trust》（2606.04990）的"执行溯源"要求资源归因是一等公民；pi 的台账把"钱"和"轨迹"绑定到同一组 id 上。主流产品的 usage 统计多为 provider 侧账单反推，无法归因到"哪次重试、哪个工具、哪次压缩"。

【前馈价值】**成本可预测（闭环）**。台账让成本归因从"月度账单"细化到"物理请求"，这是所有前馈式成本优化（缓存命中率分析、模型路由、压缩策略评估）的数据基础。**没有台账，前馈的成本优化就是盲调。**

### 主题 G：会话拓扑

#### G1. 对话树（不是列表）：分支 = 不同叶指针，rewind = 导航操作

【pi 的实现】会话条目通过 parentId 构成树；当前上下文 = 叶路径投影；切分支 = 移动叶指针（v3 已落地，ROADMAP.md 第五节）。v2 把导航提升为持久操作：`navigateTree` 有自己的接受检查、钩子决策（`before_navigation`）、先移动后摘要的崩溃语义（移动是提交点；移动后崩溃则摘要重新生成，钩子的拒绝权在移动时结束）（§15 `navigationProcedure`）。

【对照】Claude Code 的 /rewind 是产品特性；pi 把"非线性会话"做成存储原语 + 操作语义。对照 Cognition 的多智能体反方立场（上下文共享昂贵）：pi 的树让"同一会话的多个探索方向"成为廉价操作（分支零复制），而"隔离"通过 fork（G2）表达——两种需求分开服务。

【前馈价值】**正确上下文（结构）**。非线性历史支持"从同一前缀探索多个方案"而互不污染——这对规划类前馈（多方案生成后择优）是基础设施级的支持。导航操作的先移动语义保证：任何崩溃点下，"在哪个分支"与"摘要写没写完"都有确定答案。

#### G2. fork = 纯数据复制 + 确定性 ID 派生

【pi 的实现】`repo.fork()` 只复制条目（不带 records/队列）：fork 从空闲开始，成本统计从零（成本归属产生它的会话），`parentSessionId` 记录谱系。Subagent 的子会话 id 由 `f(parentSessionId, toolCallId)` **确定性派生**：安全重放重新附着到同一个子会话，而不是生成双胞胎；子会话即使崩溃吞了工具结果，也能从父侧发现（§17）。

【对照】确定性 ID 派生是事件溯源里"幂等消费者"的标准手法；agent 领域（尤其 subagent）普遍用随机 UUID，导致崩溃后"这个子 agent 是哪个调用的"不可判定。《Long-Horizon Agent Trajectory Attribution》（2608.06909）的跨层归因需求，在 pi 里由 id 谱系直接满足。

【前馈价值】**可验证性 + 确定性执行**。崩溃后子会话可重新附着 → subagent 的恢复语义与普通操作一致（B 主题全部适用）。对多智能体设计：这提示"agent 间关系应该是可推导的（从 id），而不是要记住的（注册表）"。

### 主题 H：工程方法论（最容易被低估的部分）

#### H1. 设计文档即规范：崩溃表、竞争目录、不变量、工作包

【pi 的实现】harness-v2.md（3446 行）不是"说明文档"，是规范本身：§5 记录目录（每个记录的精确形状）、§6 每个动作写什么（含全部崩溃追踪）、§15 竞争目录、21 条不变量（harness.md §9）、§19 三层测试策略、§20 工作包（26 个包，每个有依赖、主要文件、验收标准、所有权标记）。实现从文档派生；测试从文档派生；PR 从文档派生。`ROADMAP.md` 同样以设计文档口吻维护现状与判断。

【对照】《AI Harness Engineering》（2605.13357）的 11 职责、《Engineering Reliable Coding Agents》（2608.13867）的 206 条可靠性记录目录、2606.04967 观察到的行业收敛（持久工件 + 工作契约 + 可追溯性）——2026 年的共识正在形成："harness 的质量取决于它是否有可审计的设计工件"。pi 是少数把这套工件做全的开源项目。

【前馈价值】**可验证性（方法论层）**。设计期可审计 = 把大量正确性验证前移到写代码之前——这是前馈在工程流程本身的应用。

#### H2. 三层测试：每层验证不同的主张

【pi 的实现】层 A（归约与恢复）：用公共 API 预填一个崩溃状态 → `resume()` → 断言持久结果；覆盖所有 X1–X5、所有溢出崩溃点、半完成恢复（同一前缀恢复两次）。层 B（写者一致性）：带仪表的 Session 记录每个 E/R/L/G/H，对 §6 追踪断言**精确顺序**；可执行地断言追加-only 不变量。层 C（确定性交错）：`drive: "manual"` 在真实 harness + 真实后端上，机械派生崩溃点（每个 `executeAction()` 后快照、重开、恢复两次）（§19）。

【对照】"每层验证不同主张、没有哪层替代另一层"的测试分层在 agent 项目里罕见——多数项目只有 happy-path 集成测试。RAMP（2605.27492）的"分阶段恢复机制"在学术侧独立地走向同一结论：恢复行为必须被系统性评估。

【前馈价值】**可验证性（工程闭环）**。三层分别对应"恢复正确"、"写者行为正确"、"交错行为正确"——把 §4 全部主题的正确性主张都映射到了可执行测试。这是"设计文档即规范"（H1）的执行端。

#### H3. 不变量 over 特性：21 条不变量是验收标准

【pi 的实现】harness.md 的 21 条不变量（追加-only 上下文、每操作至多一个 `operation_finished`（除非挂起）、故障写留下有效前缀、停放时零写零调用…）是设计的接受条件；工作包验收引用不变号（如 H3 验收 "provider context grows only at the tail"）。

【对照】形式化验证传统（不变量断言、Hoare 逻辑）的工程化轻量形态；对照《Looping Is Not Reliability》的 typed revision contract、DarwinX 的 preserve-and-extend 契约——2026 年的可靠性文献不约而同地把"可机器检查的约束"当作可靠性的核心机制。

【前馈价值】**确定性执行 + 成本可预测（约束面）**。不变量界定了"系统可能处于的状态空间"，任何在此空间外的状态都是 bug 而不是"意外行为"。

#### H4. 公共方法所有权表 + HarnessNotImplemented：未完成的显式化

【pi 的实现】§20 的公共方法所有权表穷尽列出每个公共 API 的拥有包；F0 验收"每个公共方法都不报告似真成功"——未实现的操作以 `HarnessNotImplemented` 拒绝，而不是返回空快照/假 idle（§20 F0/R3）。

【对照】"诚实的脚手架"在开源 harness 里少见：多数框架宁可返回"看起来工作"的空值。这与 D3 的带标签 Err 是同一纪律：API 的每个状态都是可判定的。

【前馈价值】**可验证性（集成方保护）**。集成方不会被假成功误导——前馈链条上任何一环的"假完成"都会放大成下游的系统性错误。

#### H5. 最小核心 + 扩展承载产品策略

【pi 的实现】core 只提供"稳定运行循环 + 钩子点 + 工具注册 + 会话与 UI 接口"；skills（SKILL.md + frontmatter 路由）、扩展（命令/provider/事件/UI/会话钩子）、prompt 模板承载产品能力（ROADMAP.md 第六节、coding-agent/docs/skills.md、extensions.md）。技能有完整的校验夹具（frontmatter 字段、命名、冲突、嵌套——test/fixtures/skills-*）。

【对照】2026 年技能研究（2608.14036、2608.08453）的两个结论直接支持 pi 的选择：(a) 技能的价值在程序性锚定 → 技能应该承载"怎么做"（pi 的 skills 正是 procedure + 资源包）；(b) 91.8% 的公开技能有缺陷、路由元数据是命门 → pi 对技能格式做 lint 级校验（而不是"能加载就行"）是正确投资。《Muscle Memory》（2608.08995）的"编译而非检索"提示技能系统的下一步：把反复出现的意图编译成专用 agent——pi 的 subagent 示例（planner/reviewer/scout/worker）已露出这个方向。

【前馈价值】**正确上下文（可复用知识）+ 可验证性**。把易变的产品策略放进可版本化、可校验、可独立测试的工件（SKILL.md），core 保持稳定——前馈知识（经验、程序）的存储格式与 harness 的演进解耦。

---

## 5. 反馈的边界：pi 不做什么，以及对做反馈的团队意味着什么

### 5.1 pi 里的反馈回路都被前馈化了

pi 使用反馈（重试、溢出恢复、钩子纠正、导航重试摘要），但每一个反馈回路都满足三个性质：

1. **日志化**：反馈的触发、次数、结果全部是持久记录（`step_attempt` 计数、`usage` 记录、`fromHook` 溯源）——反馈过程本身可审计；
2. **有界**：每个反馈回路都有设计期上界（重试 maxAttempts、每对话输入一次溢出恢复、压缩尝试上限）——成本与延迟可预测；
3. **确定性**：反馈引起的状态迁移由崩溃点表/竞争目录完全确定——反馈路径与正常路径同样可测试（B3）。

元经验：**当你无法消除反馈（模型必然出错、provider 必然抖动）时，把反馈回路工程化为"有界、日志化、确定性的状态迁移"，它就变成前馈系统的一部分**。这是 pi 给前馈团队最重要的一条可迁移经验。

### 5.2 pi 刻意不做的事（前馈基线的干净边界）

- 不做自我改进（不编辑自己的 prompt/工具/控制流）；
- 不做轨迹挖掘（不把历史会话自动提炼成新技能）；
- 不做权重更新，不依赖 RL 训练循环；
- 不做模型路由优化（成本数据有了，路由策略留给了上层）；
- 不做运行时权限/沙箱（Project Trust 不是权限系统，见 §7）。

这个边界是干净的：pi 提供了**前馈基线**——一个所有反馈式优化都可以作为"叠加层"来度量的参照系。

### 5.3 对反馈侧（自迭代自优化）团队的四个前置条件

2026 年反馈侧论文（DarwinX、Phantom Guardrails、Blind Resampling、Skill Misevolution、Self-Improvements 综述）共同表明：自我改进回路的安全性取决于脚手架（harness）的四个性质——**全部是前馈团队的产出**：

| 前置条件 | 来源（反面教训） | pi 的对应物 |
|---|---|---|
| 1. **可识别的更新目标**（harness 组件模块化、接口稳定） | Self-Improvements 综述：更新算子作用在"参数或脚手架组件"上；组件不可识别则无法更新 | 公共方法所有权表、包边界、稳定的 Effects/钩子/事件接口 |
| 2. **真实的失败证据**（结构化日志，可判定"失败是否真的发生"） | Phantom Guardrails：优化器会为从未发生的失败发明护栏（15/60）；Skill Misevolution：不安全成功沉淀为策略 | records 台账、X1–X5 崩溃分类、usage 记录、`fromHook` 溯源——"失败是否发生"可判定 |
| 3. **不回退的门**（preserve-and-extend 契约可执行） | DarwinX：单系搜索路径依赖，局部胜利回退其他任务；需要 preserve-and-extend + archive | 21 不变量 + 三层测试 = 可执行的回归门；层 A/B 的精确断言可当 fitness 检查用 |
| 4. **可验证的 fitness**（基准 + 运行时评估分离） | RAMP：静态基准 ≠ 生产；Evo-Bench：harness 改进与模型强度必须解耦 | evals 包（真实 AgentSession 评测）、faux provider 确定性基准、telemetry 生产运行时数据 |

推论：**前馈团队做好 harness 设计，直接决定了反馈团队能否安全地自我改进**。两个方向的团队共享同一份资产：records（证据）、不变量+测试（门）、schema（度量）。这是"前馈/反馈分工"在工程上的落点。

---

## 6. 可执行启示（给前馈团队的清单）

按"可以直接抄"的程度排序：

1. **给 harness 建立双流日志**：对话事实（条目）与执行事实（记录）分开，append-only，用预配 id 关联。这是 10 条理念中地基级的一条，其余 9 条大部分依赖它。（pi：§5/§7/§12）
2. **枚举崩溃点，给每个副作用声明重放语义**：工具接口里加 `replay: safe | never`（或 idempotency-key 约定）；为每个持久点写"崩溃前后恢复行为"表。表写完，恢复语义就设计完了。（pi：§6/§15）
3. **把缓存纪律写成不变量并测试强制**：一次 run 内 provider 请求消息列表前缀单调；用户输入只在缓存边界（turn 检查点）注入。对照 TokenPilot/Self-GC：前缀稳定是成本优化的最大单点。（pi：§4 + 层 B）
4. **把压缩做成持久操作**：独立崩溃语义 + 钩子决策点 + 保留尾 + 用量记账 + 溢出可恢复/不可恢复分类 + 每输入一次恢复上界。（pi：§15）
5. **引入"门"作为唯一测试缝隙**：把执行切成离散动作；生产恒放行，测试手动放行；机械派生崩溃点（每动作后快照→重开→恢复两次）。恢复代码从此跑在日常测试路径上。（pi：§8/§19 层 C）
6. **建用量台账**：每个物理请求一条 usage 记录，统计 = 台账求和，重放记录两次执行。这是成本前馈优化的数据基础。（pi：§5/§19）
7. **给外部接口做"怪癖→规范化情形"映射表**：stop reason、错误格式、能力探测（可选方法=能力）全部规范化；harness 分支只依赖规范化值。（pi：§16）
8. **把治理约束钉在压缩目标之外**：Governance Decay（2606.22528）证明压缩会静默抹掉安全约束（违规率 0%→30%+）。会话中途的治理约束应存储为"事实"（facts 通道）或固定头部，而不是可被摘要的对话消息。这是 pi 当前设计里最值得补的一课（§7）。
9. **把技能（SKILL.md）当受管工件**：格式 lint（frontmatter/路由元数据/命名/冲突）、程序性内容优先（Demystifying Skills：锚定 65.7% vs 注入 4.5%）、池子大了必须解决检索精度（2608.14036）。pi 的校验夹具可直接借鉴。（pi：coding-agent/docs/skills.md + test fixtures）
10. **设计文档即规范**：崩溃表、竞争目录、不变量列表、工作包所有权表全部文档化；测试与 PR 从文档派生；未实现的功能显式拒绝（HarnessNotImplemented），不报告似真成功。（pi：harness-v2.md 全文）

---

## 7. 局限与开放问题（诚实面）

分析 pi 必须同时看到它的边界，否则"学习"会变成"照抄"：

1. **Harness v2 尚未在主链路**。`prompt()/compact()/resume()` 未实现（ROADMAP.md 明确"目前不能基于 v2 构建实际 agent 产品"）。本总结评价的是**设计的完备性与自洽性**；设计是否经受住实现检验，要等工作包（H0–O4）落地。v3 主链路（AgentSession + JSONL 树）是已经验证的部分，其"上下文=投影、历史不可变、分支零成本"的设计已被生产使用。
2. **无沙箱/无运行时权限**。ROADMAP.md 自述："core 没有安全沙箱；Project Trust 也不能替代运行时权限控制"。对照 Codex CLI（seatbelt/landlock 沙箱）、OpenHands（容器运行时）、SafeHarness（2604.13630 的生命周期安全架构）：pi 把权限留给扩展/容器层，这在小而快的 CLI 场景合理，但作为通用 harness 运行时，权限/隔离是必须补齐的一等组件（AI Harness Engineering 11 职责里的"permissions"在 pi 里是弱项）。
3. **单进程假设**。泳道/写队列/SQLite 租约都是进程内或单机语义；跨进程/跨机器的 agent 并行（如 subagent 跨机执行）没有设计。对照 Temporal 的集群化、Letta 的有状态服务：pi 选择了"先做对单机，再谈分布"，合理但需要后续章节。
4. **规则式上下文管理 vs 学习式**。pi 的追加-only + 阈值压缩是确定性规则；SWE-MeM（GRPO）、Escaping the Context Bottleneck（RL 策展）证明学习式可以更好。规则路线的优势（可审计、可崩溃恢复、可测试）与学习路线（自适应更优）如何组合（例如：学习策略提议、规则策略裁决+执行）是开放问题。
5. **治理约束的压缩暴露面**（Governance Decay 风险）。系统提示/AGENTS.md 在消息流之外（安全），但会话中途注入的约束（用户说"之后不要动生产配置"）在压缩目标内。pi 的 facts 通道（labels/session info）天然免疫压缩——把治理约束升级为 facts 类型是低成本高收益的改进方向，且与 §6 清单第 8 条一致。
6. **工具面窄，未探索 code-as-action**。pi 默认 bash/read/edit/write；《The Bitter Lesson of Tool Calling》（2608.06370）与《Devil Is in the Interface》（2608.11386）的实证支持程序化工具调用/CodeAct（步数 −41.6%、token −56.3%）。pi 的扩展机制允许上层加 code tool，但核心未表态——对前馈团队这是一个值得跟进的方向（工具架构直接决定一致性）。
7. **熵审计/干预记录的学术对标还不完整**。AI Harness Engineering（2605.13357）的 11 职责中，"entropy auditing"与"intervention recording"在 pi 里只有部分对应（usage 台账、operation log）；"模型输出的熵/漂移在线监测"（对照 2608.14109 的 drift 诊断）在 pi 中缺位。
8. **评测维度偏恢复/并发，任务成功率的系统性证据少**。三层测试是 harness 自身的正确性测试（非常好），但 harness 设计对**端到端任务成功率**的影响需要 evals 侧的数据支持（RAMP 式运行时评估 + τ-bench pass^k 式重复稳定性）。pi 的 evals 包已存在，方向正确，证据尚待积累。

---

## 8. 参考

### 8.1 2026 年重点论文（arXiv）

**Harness 作为设计对象**
- AI Harness Engineering: A Runtime Substrate for Foundation-Model Software Agents — 2605.13357
- From Question Answering to Task Completion: A Survey on Agent System and Harness Design — 2606.20683
- Engineering Reliable Coding Agents: Evaluating and Operating the System Around the Model — 2608.13867
- Evo-Bench: Can Language Models Improve Agent Harness? — 2608.09096
- From Determinism to Delegation: AI-Native Software Engineering and the Evolution of the Agentic Engineer — 2606.28791
- From Prompt to Process: a Process Taxonomy and Comparative Assessment of Frameworks Supporting AI SWE Agents — 2606.04967

**上下文工程**
- Governance Decay: How Context Compaction Silently Erases Safety Constraints — 2606.22528
- Plans Don't Persist: Why Context Management Is Load Bearing for LLM Agents — 2606.22953
- TokenPilot: Cache-Efficient Context Management for LLM Agents — 2606.17016
- Beyond Compaction: Structured Context Eviction (CWL) — 2606.11213
- Self-GC: Self-Governing Context for Long-Horizon LLM Agents — 2607.00692
- Less Context, Better Agents — 2606.10209
- SWE-MeM: Learning Adaptive Memory Management for Long-Horizon Coding Agents — 2606.28434
- Escaping the Context Bottleneck: Active Context Curation via RL — 2604.11462

**持久执行与事务**
- AgentRewind: Recoverable Execution for Long-Horizon LLM Agents — 2608.14380
- Agentic Transaction: Towards ACID-Compliant Agent Systems — 2608.13900
- Looping Is Not Reliability: State-Bound Evidence and Typed Revision Contracts — 2607.24604
- Verified Detection and Prevention of Concurrency Anomalies in Multi-Agent LLM Systems — 2606.17182
- Benchmarks are Not Enough: RAMP for Runtime Assessing of Agentic Models in Production — 2605.27492

**工具与接口**
- The Devil Is in the Interface: Evaluating How Tool Architecture Shapes Coding Agent Behavior — 2608.11386
- Agent-Computer Observation Interfaces Enable Dynamic Computer Use (AOI) — 2606.29472
- The Bitter Lesson of Tool Calling — 2608.06370

**技能与记忆**
- Demystifying Agent Skills: Why They Work—Until They Don't — 2608.14036
- What Keeps Agent Skills from Being Reusable? Evidence from 138K SKILL.md Files — 2608.08453
- Muscle Memory for Agents: Compile, not Merely Retrieve — 2608.08995
- Ontology-Grounded Project Memory for Coding Agents (MOOSEDev) — 2608.13662
- From Storage to Experience: A Survey on the Evolution of LLM Agent Memory Mechanisms — 2605.06716

**溯源与评测**
- From Agent Traces to Trust: A Survey of Evidence Tracing and Execution Provenance — 2606.04990
- A²E: An End-to-End Agent Auditing Engine — 2608.07346
- Long-Horizon Agent Trajectory Attribution — 2608.06909

**反馈侧（对照用）**
- Self-Improvements in Modern Agentic Systems: A Survey — 2607.13104
- DarwinX: Evolving Agent Harnesses Through Natural Selection — 2608.07545
- Phantom Guardrails: When Self-Improving Agent Harnesses Fix Failures That Never Happened — 2607.13083
- Try Again, Don't Look Back: Blind Resampling Outperforms Self-Repair — 2607.26117
- Self-Authored Verification Is Unreliable in Heuristic Self-Improving Agents — 2607.24300
- Practice Makes Unsafe: Skill Misevolution in Self-Improving LLM Agents — 2608.12851
- SAGE: Stochastic Prompt Optimization via Agent-Guided Exploration — 2606.18902

### 8.2 经典论文（2022–2025，背景）

- ReAct (2210.03629)；ToolLLM (2307.16789)；Gorilla (2305.15334)
- SWE-agent: Agent-Computer Interfaces (2405.15793)；CodeAct (2402.01030)；Agentless (2407.01489)
- SWE-bench (2310.06770)；τ-bench (2406.12045，pass^k)；TheAgentCompany (2412.14161)；GAIA (2311.16508)；OSWorld (2404.07972)；WebArena (2307.13854)；BFCL v4
- MemGPT (2310.08560)；Generative Agents (2304.03442)
- AutoGen (2308.08155)；MetaGPT (2308.00352)；CAMEL (2303.17760)
- Reflexion (2303.11366)；Self-Refine (2303.17651)；ExpeL (2308.10144)；Agent Workflow Memory (2409.07429)
- Darwin Gödel Machine (2505.22954)；SEAL (2504.20073)；AlphaEvolve（DeepMind 2025 技术报告）
- DSPy (2310.03714)；TextGrad (2406.07496)
- vLLM/PagedAttention (2309.06180)；SGLang RadixAttention (2312.07104)

### 8.3 业界项目与工程资料

- Claude Code（会话 JSONL、/rewind、压缩、hooks、subagents、MCP）
- OpenAI Codex CLI（沙箱：seatbelt/landlock；AGENTS.md）
- OpenHands（CodeAct 运行时、事件流架构）；Aider（repo map、search/replace 编辑格式）
- LangGraph（图 + checkpointer + interrupt）；OpenAI Agents SDK；Google ADK；CrewAI；PydanticAI；smolagents
- Temporal / Cadence / Inngest / Restate（durable execution、确定性重放、事件历史）
- Letta/MemGPT（分页记忆、stateful agents、sleep-time compute）；Mem0；Zep/Graphiti
- MCP（Anthropic 2024）；A2A（Google 2025）
- Anthropic 工程博客：Building Effective Agents（2024-12）、Multi-Agent Research System（2025-06）、Contextual Retrieval（2025-06）
- Cognition：Don't Build Multi-Agents（Walden Yan，2025-06）；Manus 上下文工程博客（2025）
- OTel GenAI 语义约定（gen_ai.* 属性规范）
- Jay Kreps, The Log: What every software engineer should know about real-time data（2014）；Fowler, Event Sourcing（2005）；Sagas（Harkleroad 1987）

### 8.4 pi 仓库内文档（本总结的直接证据）

- `packages/agent/docs/harness-v2.md`（3446 行，v2 规范：§4 追加-only 不变量、§5 记录目录、§6 崩溃追踪与 X1–X5、§7 恢复、§8 公共 API 与门、§15 泳道/竞争目录/过程、§16 deferred、§17 fork/subagent、§18 遥测 schema、§19 三层测试、§20 工作包）——及其全量中文翻译 `harness-v2-zh.md`
- `packages/agent/docs/harness.md`（v2 前身设计，21 条不变量）+ `harness-zh.md`
- `packages/agent/docs/telemetry-schema.md`（生成的遥测词汇参考）+ `telemetry-schema-zh.md`
- `packages/agent/docs/harness-v2-test-matrix.md`（旧测试处置矩阵）
- `ROADMAP.md`（维护者自述：四层架构、v2 现状、compaction/分支/扩展定位）
- `AGENTS.md`（开发纪律：check 命令、依赖安全、changelog、发布流程）
- `packages/coding-agent/docs/`（30 篇产品文档：sessions、session-format、compaction、extensions、skills、sdk、rpc、security…）
- `tool-design.md`（本会话早前生成的 pi 工具体系介绍）

---

*本总结由 pi 仓库全量文档阅读 + 2026 年 arXiv 论文调研（约 30 篇精读摘要、50+ 篇标题级覆盖）综合写成。论文主张均基于 arXiv 摘要与已知公开资料，引用 arXiv 编号可在 arxiv.org 直接核对。*
