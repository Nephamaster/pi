# IPD 风格多智能体长程任务技术设计方案

## 1. 方案定位与设计目标

本方案面向长程、多步骤、跨角色协作任务。其出发点不是单纯提升单个 Agent 的规划能力，也不是构建自由协商式的 Multi-Agent Team，而是将现实工程中的组织流程控制引入 Agent Harness：任务执行前明确工作分解、角色职责、资源分配和准出标准；任务执行过程中，每个节点在局部保持 Agent 自治，但节点产物只有经过预先固化的 Gate 评审后才能进入下游，从而把局部错误尽量限制在当前节点或当前阶段内，降低错误沿长链累积并在终态集中暴露的风险。这与原始方案中“通过标准化阶段流程、角色职责边界和启动前固化的准出标准逐关收口”的核心设想一致。

该能力作为现有极简 Agent Harness 中的 `IPD Tool` 存在，不改变外层 ReAct Agent 的基本结构。外层 Agent 仍然负责理解用户任务、选择适用 Skill，并在判断任务需要 IPD 协作时调用 IPD Tool；复杂的组织编排、节点运行和过程治理进入独立的 IPD 模块。这与“极简 Agent 本体保持简单，流程规划作为独立 Tool”的总体设计保持一致。

系统最终要形成三个彼此解耦、职责明确的主体：**Staff Teams（ST）负责设计和治理流程，数字员工负责执行具体工作，Graph Engine 负责把制度确定性地执行出来。** Agency-Agents 对角色、流程和治理资产化的实践提供了组织设计参考，而 edict 最重要的教训则是：流程中的“必须”不能停留在 Prompt 里，状态迁移和准出规则必须真正进入运行时。 

## 2. 总体架构

系统暂时建立在 Pi 之上进行探索和迭代，在 Pi monorepo 中增加一个相对独立的 IPD 模块，不另起 Python Runtime，不重写 Agent Loop。数字员工继续使用 Pi 现有 Agent 能力执行任务，IPD 层只增加流程配置、图编译、节点调度、任务账本以及 ST 控制能力。

整体调用链可以概括为：

```text
用户
 ↓
外层 Pi ReAct Agent
 ├─ 理解任务
 ├─ 选择适用 Skill
 └─ 判断需要 IPD → 调用 IPD Tool
                         ↓
                 创建 IPD Run
                         ↓
                     ST Core
          接收任务 + 已选 Skill + 全局预算
                         ↓
       编排 Workflow / 选择数字员工 / 固化 Gate
                         ↓
                  Workflow IR
                         ↓
                   Graph Engine
                         ↓
               Execution Workflow
          ┌──────────┼──────────┐
          ↓          ↓          ↓
      执行节点     执行节点     执行节点
          │          │          │
       Artifact   Artifact   Artifact
          │          │          │
         Gate       Gate       Gate
          └──────────┼──────────┘
                     ↓
               Staff Teams
             Dynamic Reviewer
                     ↓
           PASS / REWORK / ESCALATE
                     ↓
                 Graph Engine
```

这里需要特别强调：ST、执行工作流和 Graph Engine 并不是三套互相独立的系统。**ST 和业务员工都运行在同一个图引擎之上，只是使用不同的节点类型。**业务人员是 Execution Node，ST 成员是 Decision Node；Graph Engine 对两者进行统一实例化、调度、状态记录和资源统计。

整个系统只有两类 Agent Node：

| 节点 | 主要职责 | 典型角色 |
|---|---|---|
| Execution Node | 完成具体任务并产生业务 Artifact | 产品经理、SE、架构师、开发、测试、研究员、PPT 设计师 |
| Decision Node | 基于事实、证据和既定规则形成控制决策 | ST Planner、ST Core 成员、Dynamic Reviewer、最终验收员 |

两类 Node 的差异不只是 Prompt 不同，而是运行语义不同：**Execution Node 改变业务状态并产生交付物，Decision Node 不负责业务生产，只产生会影响执行图的决策。**

Gate、并行汇聚、超时、预算、返工和路由都不是第三种节点，而属于 Graph Engine 和节点配置所定义的控制语义。

## 3. Staff Teams 的组织与职责

### 3.1 ST Core 与 Dynamic Reviewer

Staff Teams 是贯穿整个 IPD Run 的控制团队，但不应理解成“一群 Agent 一直开着群聊”。ST 的逻辑身份在整个 Run 中持续存在，具体 LLM Session 则根据事件按需启动和恢复。

ST 分成两个部分。

**ST Core** 是每个 Run 创建时就确定的治理核心，负责工作流编排、人员分配、预算规划、异常仲裁、评审组织和最终端到端验收。V1 可以预设少量稳定职责，例如流程规划、项目/资源管理和评审协调，但这些职责最终同样引用数字员工池中的 AgentCard，并不是另一套特殊 Agent。

**Dynamic Reviewer** 是临时评审团。ST 在工作流设计阶段只固定某个 Gate 需要从哪些维度进行评审，以及 Reviewer 应满足哪些能力条件；当执行真正到达该 Gate 时，ST Core 再从数字员工池中选择合适的评审员，创建临时 Decision Node 实例。评审结束后该 Session 即可释放，不需要保存长期对话记忆。

因此，“ST 成员固定”和“评审成员动态”并不冲突：

> ST Core 固定的是治理职责；Dynamic Reviewer 动态的是针对具体交付物所需要的专业判断能力。

### 3.2 ST 的共享记录

ST Core 不能依靠一段持续增长的“ST 群聊历史”维持长期任务状态。长程任务中的事实应归 Graph Engine 所维护的任务账本。

每次 ST Core 被重新唤醒时，应从一个统一的 **ST Control Record** 恢复当前任务事实，内容至少包括：原始任务目标及用户约束、当前 Workflow 版本、节点及 Gate 状态、已经成功交付的 Artifact 清单、尚未解决的风险/异常、预算使用情况、历次 ST 决策及依据。ST Agent 的 Conversation 只服务本次局部推理；Control Record 才是跨事件持续存在的项目记录。

这也使整个运行过程天然具备透明性：任何时刻都可以回答“当前在哪个节点、谁在执行、使用了多少预算、交付了什么、为什么被打回、哪几个 Reviewer 做出了什么判断”，而不需要重新分析模型聊天文本。Agency-Agents 对结构化交接和任务证据的强调，以及 edict 对独立任务账本的需求，都支持这一方向。 

## 4. 工作流编排机制

### 4.1 Skill 的入口位置

ST 不自行完成第一次 IPD Skill 选择。外层 ReAct Agent 在理解用户任务时已经通过现有 Skill 机制确定适用 Skill，并在调用 IPD Tool 时把该 Skill 一并传入。

因此 ST 的输入是：

> “这是用户任务、全局预算以及外层 Agent 已为这类任务选择的组织/流程 Skill，请据此设计本次执行方案。”

Skill 中沉淀的是适合 Agent 执行的流程知识，例如常见阶段、典型角色分工、适合并行的工作、常见 Artifact、质量控制原则、风险点以及可参考的历史 Workflow。它提供组织知识和设计依据，但不等价于一个固定 Workflow。

ST 在具体编排时始终拥有两个平级选择：**从零设计新的 Workflow，或者参考/复用已有模板后形成 Workflow。** Graph Engine 不偏好任何一种来源，也不把模板作为运行前提。模板的价值是历史流程资产，而不是强制流程入口。

### 4.2 ST 编排的正式结果

ST 编排阶段最终只需要交付一个结构化的 `WorkflowDefinition`，其中包含本次任务使用的执行节点、具体数字员工、节点依赖、输入输出映射、预算以及每个节点对应的 Gate。

这个 WorkflowDefinition 就是本系统的 **Workflow IR（中间表示）**：它是一份机器可校验、可版本化、可编译的流程描述。

实际工程中使用 TypeScript Schema 作为唯一类型定义，由 Schema 同时约束 ST 的结构化输出以及人工维护的模板文件。运行时可以存 JSON；为了人工可读性，模板也可允许 YAML，但加载后必须统一转换成相同的 IR。

Workflow IR 不需要设计成通用 BPMN。它只要精确表达这套 IPD Harness 真正需要的控制信息即可。这份配置文件会被 Graph Engine 在运行时编译组装并真正发挥作用。

## 5. AgentCard 与数字员工池

数字员工池和 Workflow 是两套完全独立的资产。AgentCard 描述“这个数字员工是谁、能做什么、能使用什么资源”；Workflow 描述“这次任务在哪里需要谁完成什么”。

AgentCard 应当有统一填写规范，角色创建者不能自由发挥字段。这一点可以借鉴 A2A 中“通过结构化能力描述让外部系统理解一个 Agent”的思想，但这里的 AgentCard 面向的是 IPD 内部人员编排，因此还需要包含职责边界、资源和历史绩效等信息。

AgentCard 第一版组织为五个信息区：

| 信息区 | 内容 |
|---|---|
| Identity | ID、版本、角色名称、角色说明 |
| Capability | 能力标签、适用任务、职责、禁止职责 |
| Runtime Profile | 模型规格、提示范式、上下文策略 |
| Resource & Permission | Skill、Tool、知识库、数据范围、工具权限 |
| Asset Metrics | 历史使用次数、成功次数、返工情况、Token/时间等客观数据 |

其中 AgentCard 核心能够回答三个调度问题：**这个员工是否有能力完成当前节点；它是否有权限完成当前节点；历史上它在类似工作中的表现如何。** Agency-Agents 将角色从临时 Prompt 升级成可管理资产的思想值得直接继承，但其大量长文本 Operations 内容应更多转入 Skill，而不应全部常驻 Agent Static Frame。

ST 编排 Workflow 时直接引用具体 AgentCard。也就是说，V1 中角色选择发生在设计阶段，而不是 Graph Engine 运行到节点时才临时匹配；Graph Compiler 只负责校验引用是否有效、权限是否满足节点要求。

## 6. Execution Node 与 Gate

### 6.1 Execution Node 的责任边界

Execution Node 是业务流程的基本工作单元。它必须描述目标、输入、数字员工、资源、期望时间、可使用能力和要求输出，这与原始 IPD 方案中对节点配置的定义一致。

一个节点实例启动后，Graph Engine 根据 AgentCard 和 Node Definition 创建对应的 Pi Agent Session，只给它当前节点需要的输入、Skill、Tool 和权限。Agent 在节点内部仍然保持 ReAct 自治：如何分析问题、调用几次工具、怎样组织工作，只要没有越过节点责任和预算边界，都不由 Graph Engine 微观管理。

节点最终交付是一个正式 Artifact 以及对应 Manifest。Manifest 记录产物类型、地址、版本、生产者、输入来源和必要证据，成为后续 Gate 和下游节点读取信息的统一入口。

值得提出的是，节点内 Agent 通常不需要整个外层用户会话或用户长期的记忆，但它有权掌握整套工作流执行周期中属于它所在的节点的任务短期记忆。

### 6.2 Gate 是 Execution Node 的固定组成，不是节点

每个 Execution Node 都必须对应一个 Gate。Gate 本身不是 Agent，也不是第三种 Node，而是**该节点交付成果进入下游之前必须满足的准出契约**。

ST 在编排 Workflow 时同时为节点确定 Gate 的标准。标准可以来自传入的 Skill、用户要求、行业规范或 ST 在设计阶段额外检索到的可靠资料。一旦 Workflow 被编译并冻结，这些标准随之冻结，执行期间不能临时改变。

Gate 在运行时分三层发挥作用。

第一层是节点内自检。执行 Agent 生成候选产物后，使用同一套 Gate Criteria 对自己的交付进行检查；若明显不满足，可以继续在当前节点内修改，只要仍在任务和预算允许范围内。这样可以避免大量低级问题直接进入 ST。

第二层是确定性检查。Agent 提交以后，Graph Engine 对能够机器判断的规则直接验证，例如 Artifact 是否存在、输出 Schema 是否完整、指定测试是否通过、必需字段是否存在。机器可以确定的事情不交给 LLM Reviewer。

第三层才是 ST 评审。只要候选 Artifact 完成自检并通过必要的机器检查，就会经 Gate 回流 ST。ST 根据事先固化的评审维度创建 Dynamic Reviewer，进行独立语义评审。

因此，任何 Execution Node 的成功交付都遵循同一条路径：

> **节点执行 → 节点自检 → 机器检查 → ST Dynamic Review → Gate PASS → Artifact 对下游可见。**

没有通过 Gate 的产物仍然可以保留用于追踪，但不能成为下游节点的正式输入。

## 7. ST 评审机制

Dynamic Reviewer 的选择是动态的，但**评审维度、准出标准和汇总规则是静态的**。

例如产品设计节点在工作流冻结时已经确定要从需求覆盖、方案可行性和风险完整性三个维度进行评审。真正运行到该 Gate 时，ST 可以根据数字员工池情况分别选择产品、SE 和风险方向 Reviewer；下一次运行相同 Workflow 时，具体 Reviewer 可以不同，但它们评判的是同一套冻结标准。

评审过程采用“独立评审—统一汇总”。每个 Reviewer 只获得必要 Artifact、Gate Criteria 和自身负责的评审维度，分别给出逐条 Criterion 的结论、证据和返工建议。这样做一方面减少 Reviewer 相互诱导，另一方面使每个结论具备明确责任来源。

最终决策应围绕 Criterion 是否被满足，而不是简单多数投票。硬性 Criterion 未满足则不能 PASS；证据不足应保留为 INCONCLUSIVE，而不能因为重试次数过多自动转为通过。edict 中“第三轮强制准奏”就是必须避免的典型反例。

评审通过后，Graph Engine 才把该 Artifact 标记为正式成功交付，并解锁依赖它的下游节点。评审不通过则按照 Workflow 中事先定义的返工/回退规则重新激活相应节点；确实无法在既定流程内处理时，再形成异常事件交由 ST Core 仲裁。

最终端到端验收也复用完全相同的 Gate 机制，只是其 Criteria 重新面向原始用户目标和最终交付物，并通常需要覆盖更广的 Reviewer 维度，因此没有必要再设计新的“终验节点类型”。

需要特别说明：以上 Gate 强制要求面向 Execution Node。Decision Node 自身不再递归创建新的 ST 评审，否则会形成无穷监督链。Decision Node 的输出通过固定 Decision Schema、权限和合法动作集合由 Graph Engine 校验。这是两种节点在治理模型上的必要终止边界。

## 8. 图模型与运行时

### 8.1 成功交付路径是 DAG

整套业务流程可以存在返工、回退和异常恢复，因此完整的控制流并非严格无环。这里为系统核心语义下一个定义：

> **所有“成功交付”的 Artifact 流动路径构成 DAG。**

也就是说，如果只看已经通过 Gate 的正式成果：

> A 的成功产物 → B → C → 最终交付

这条依赖关系必须无环。下游只能引用已经通过 Gate 的上游产物，从而形成明确的依赖和可追溯链。

返工则属于控制路径。例如 B Gate 失败后可以回到 B 自身，或者退回 A 修改；这种边不代表 A 的成功 Artifact 向过去流动，因此不破坏成功交付 DAG。

这一区分非常重要，因为它同时允许 IPD 必需的迭代，又让最终成功执行轨迹具有天然可解释性和依赖拓扑。

### 8.2 Graph Engine 的职责

Graph Engine 是一个轻量确定性执行器，本身不使用 LLM 做流程判断。它主要负责四件事：编译 WorkflowDefinition；维护运行状态和任务账本；根据依赖关系计算可执行节点并调度 Pi Session；根据 Gate/Decision 结果提交合法状态转换。

由于确定基于 Pi 构建，建议直接在 monorepo 中实现独立 TypeScript package，例如 `packages/ipd`，而不是另起 Python 进程。IR Schema、Graph Runtime 和现有 Agent Runtime 处在同一技术栈，可以直接复用 Pi 的 Agent Session、模型和 Tool/Skill 能力，也避免跨语言 IPC、两套构建测试和部署链路。

V1 不需要引入 LangGraph、Temporal 等完整运行时。图本身只需要支持基本依赖、并行 fan-out、汇聚以及受控回退；调度可以使用 TypeScript 异步任务实现，状态存储使用 SQLite 即可。真正必须坚持的不是某种存储技术，而是：

> **Graph Engine 是 Workflow 状态的唯一写者。**

Agent 只能提交候选输出、异常或决策，不能直接修改自己的节点状态、启动下游或把整个任务写成完成状态。edict 的状态错乱问题正来自业务 Agent 同时承担工作和流程事务提交。

## 9. 运行状态、ST 事件与异常回流

Graph Engine 应采用事件驱动方式连接执行工作流和 ST。节点完成候选交付、Gate 请求、预算预警、异常上报、最终验收请求，都首先成为 Runtime Event，再由引擎决定激活哪个 Decision Node。

Execution Node 遇到问题时遵循明确的升级链：

> **节点自己解决 → 无法解决则上报 ST → ST 无法解决则请求用户 → 用户决策返回 ST → ST 再返回原节点。**

这里要求节点首先具有合理的局部自治。短暂 Tool 失败、可以通过搜索或修改参数解决的问题，不应该立即打断 ST。只有缺少关键信息、发生语义冲突、需要额外权限、流程现有规则无法覆盖等问题，才形成正式 Escalation。

ST 也不能绕过外层 Agent 直接与用户建立第二套交互通道。需要用户决策时，由 ST 将结构化问题交还给外层 ReAct Agent，用户回答后沿原路径回到 ST 和阻塞节点。这样可以保持用户入口唯一。

节点状态可以保持少量稳定状态，例如 Pending、Ready、Running、Blocked、Succeeded、Failed、Cancelled。所有状态变化都由 Graph Engine 根据 Agent 结果或 ST Decision 原子提交。

## 10. 预算管理

用户只向整个 IPD Run 提供全局 Token 预算和预期完成时间，不需要自己为各节点分配资源。ST 编排 Workflow 时根据任务难度、节点类型和角色成本将全局预算分配到各 Execution Node、ST 自身评审开销和必要的返工/缓冲资源。

但全局预算在当前设计中明确是**软上限**，不应该把“刚刚超过预算”直接等同于任务失败。Graph Engine 的责任首先是持续计量和透明暴露，而不是机械 Kill。

运行过程中可以维护“预计预算”和实际使用量。当节点或整体预算接近、达到或略微超出预期时，系统产生 Budget Event 唤醒 ST Core；ST 可以根据任务价值和剩余工作选择继续执行、收缩后续节点预算、减少 Reviewer、替换更经济的员工，或者明确允许一定程度超额。只有存在用户明确给出的绝对限制或系统安全边界时，才需要额外设置真正的 Hard Limit。

因此 IPMT 式资源治理在第一版不需要复杂到动态计算最优算力分配，其核心就是：

> **预算由用户全局给定，ST 负责任务级分配，Graph Engine 负责事实计量，超额后的处理权回到 ST。**

## 11. 任务账本与运行透明化

引入图引擎不仅是为了控制流程，还自然获得了传统自由 Multi-Agent 很难具备的运行透明度。

系统应该维护一个单一事实源，至少保存 Workflow Run、节点实例、Decision、Artifact、Gate Review、Budget 和 Event。V1 使用 SQLite WAL 即可，实际文件仍保存在工作目录，仅在数据库中登记 URI、Hash、版本和关联关系。

由于所有关键事件都经过 Graph Engine，运行轨迹可以完整回答：哪个员工什么时候开始哪个节点；读取了哪些已通过 Gate 的 Artifact；产生了什么结果；自检是否发现问题；哪些机器检查通过；哪些 Reviewer 参与了评审；为何被打回；消耗多少 Token 和时间；异常如何逐级上报；最终哪个版本的 Artifact 成为正式输出。

这比记录“Agent 说自己做到 70%”可靠得多。edict 的分析已经说明，模型自报 Progress 与真实业务状态之间存在天然偏差；状态应该来自产物、工具结果和 Runtime 事务。

对于 ST Core 而言，这套账本同时就是其跨事件共享记录；对于调试和研究而言，它又是完整 Trace；对于未来资产演进而言，它还是原始训练/统计数据。

## 12. 流程与角色资产化

系统应从第一版就区分“定义资产”和“运行实例”。

AgentCard 是数字员工定义，Employee Instance 是本次任务中的实际 Session；WorkflowDefinition 是流程定义，WorkflowRun 是本次执行；同理，NodeDefinition 与 NodeInstance、GateDefinition 与 GateReview 都不能混在一起。

这样才能真正实现文档提出的资产库方向：历史流程、角色配置、子流程和其他资产可以累计复用次数、成功次数和失败情况。

V1 暂不做自动“评分”和自动自演进，而优先记录客观事实，包括员工被选用次数、节点成功次数、首次 Gate 通过情况、返工次数、Token 和耗时；Workflow 则记录使用次数、成功次数、Gate 返工情况、整体成本和最终验收结果。

比“ST 给某员工打 87 分”更重要的是获得能够追溯的事实。例如一个节点局部 Gate 通过，但最终验收发现该节点引入了缺陷，就可以反向记录 Defect Escape；同样也可以分析当时 Reviewer 为什么没有发现。这种数据才适合作为未来 ST 选人和流程优化的依据。

后续自演进系统可以异步基于这些历史资产提出新的 AgentCard 版本或 Workflow 版本，但资产修改本身需要独立验证和发布，而不能让某次在线运行直接覆盖稳定资产。

## 13. Pi 中的模块组织

在 Pi 中建议将 IPD 作为独立 package 实现，边界保持清晰：

| 模块 | 主要内容 |
|---|---|
| `ir` | AgentCard、Workflow、ExecutionNode、DecisionNode、Gate、Artifact 等 Schema |
| `engine` | Compiler、Scheduler、State Machine、Budget、Event Runtime |
| `staff` | ST Core 启动、Dynamic Reviewer、异常仲裁、最终验收 |
| `registry` | 数字员工、Workflow Template、Asset 查询 |
| `ledger` | SQLite 任务账本、Event Log、Artifact Manifest |
| `adapter` | 将 Execution/Decision Node 实例映射到 Pi Agent Session |
| `tool` | 对外暴露给 ReAct Agent 的 IPD Tool |

这样 IPD 层不侵入 Pi 核心 Agent Loop。外层 Agent 只是多了一个 IPD Tool；节点中的数字员工仍然是普通 Pi Agent；ST 中的 Decision Node 也仍然使用相同 Agent Runtime。复杂性只集中在图编译、治理协议和任务账本上，符合“极简 Agent 不额外堆积功能”的总体原则。

Graph Compiler 在执行前完成最后一道确定性验证，包括 Employee 引用、权限、Artifact 依赖、成功交付 DAG、每个 Execution Node 是否配置 Gate、返工路径是否合法、是否存在无边界循环以及 Workflow 配置是否合法。ST 具有设计自由，但不能越过这些 Harness 层规则。

## 14. V1 运行闭环

以一个 PPT 长程任务为例，完整流程不是“Leader 自由组队后一直对话”，而是严格经历以下阶段。

外层 ReAct Agent 首先理解需求并选择适合 PPT/内容生产的 Skill，调用 IPD Tool。IPD 创建 Run 和 ST Core，ST 依据任务、Skill、全局预算和数字员工池设计 Workflow，并为各节点选择具体数字员工，同时确定所有节点的 Gate Criteria。

Compiler 校验并冻结 Workflow 后，Graph Engine 启动执行。内容规划、资料调研等无依赖任务可以并行，每个数字员工只在自己的 Execution Node 内工作。节点认为完成以后先按 Gate Criteria 自检，通过后提交 Artifact；Graph Engine 完成机器检查，再把 Artifact 和冻结 Criteria 回流 ST。

ST 为当前 Gate 动态创建内容、事实或结构方向 Reviewer。Reviewer 独立评审后由 ST 汇总。如果通过，Artifact 成为正式成功交付并进入下游；如果未通过，则按照既定返工路径重新激活相关节点。

如果某执行 Agent 遇到自身能力范围内无法解决的问题，则节点进入 Blocked，并通过 Graph Engine 上报 ST。ST 能处理就给出 Decision 恢复节点；仍然无法处理才通过外层 Agent 请求用户，用户回答再沿原路径返回。

最终 PPT 生成后，其 Gate 采用面向原始用户目标的端到端验收标准，仍由 ST 动态组织 Reviewer。只有该 Gate PASS，Graph Engine 才把整个 Run 原子收口为成功，并将正式 Artifact 返回外层 Agent。

由此形成一条清晰的成功路径：

> **任务 → ST 编排 → 执行 → 自检 → Gate → ST 评审 → 正式 Artifact → 下一节点 → 最终 Gate → 交付。**

而任何返工和异常路径都被完整保留在任务账本中，但不会污染“成功交付 Artifact DAG”。

## 15. 第一阶段实施范围

第一阶段的目标应当是证明这套流程控制机制能够真实运行，并验证它是否相对于单 Agent 或自由 Multi-Agent 带来任务完成度提升，而不是立即建设完整 IPD 平台。

因此 V1 应完成 AgentCard 标准、两类 Node Schema、Workflow IR、每个 Execution Node 绑定 Gate、ST Core 与 Dynamic Reviewer、轻量 Graph Compiler/Runtime、Pi Session Adapter、SQLite 任务账本、Artifact 流转、软预算统计、异常逐级上报和最终端到端 Gate。

模板可以预置一个或几个用于实验，但系统从第一版就同时支持 ST 从零编排；两种方式进入 Runtime 后没有任何区别。

V1 暂不需要动态修改已经冻结的 Workflow 拓扑、不需要在线自演进、不需要复杂员工评分、不需要分布式消息队列或大规模 Dashboard。后续在运行数据证明流程控制有净收益后，再扩展动态图 Amendment、资产推荐、资源动态调配和异步自演进。

## 16. 方案的核心技术边界

最终，这套架构最需要守住的不是某个类如何实现，而是四条边界。

**第一，ST 有设计权和决策权，但没有流程状态的直接写入权。**所有执行状态最终由 Graph Engine 根据配置和事件提交。

**第二，数字员工有节点内部自治权，但没有越过 Gate 把产物直接传给下游的权力。**任何成功 Artifact 都必须先自检、机器验证并回流 ST 完成独立评审。

**第三，Gate 标准是设计时固化的，而 Reviewer 是运行时动态的。**这样既保留 IPD 的流程强约束，又保留团队针对实际问题动态组织专业力量的能力。

**第四，员工、流程和运行记录是三套独立资产。**AgentCard 描述“谁能做什么”，Workflow 描述“这次怎么组织工作”，Ledger 描述“这次实际上发生了什么”。只有三者分开，后续角色选择、流程复用和资产自演进才有可靠基础。

这四条边界把原始方案中的“流程可控、角色专精、逐关评审、资产演进”真正连接成了一套可以在 Pi 上实现的技术系统，而不是另一种依赖 Prompt 自觉遵守的 Multi-Agent 组织形式。 