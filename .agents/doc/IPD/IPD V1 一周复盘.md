# IPD V1 一周复盘

> **时段：2026\.08\.31 \- 2026\.09\.03**
> 
> 

## 结论先行

这套实现的技术方向是成立的，但 V1 的工程有效性尚未被证明。

成立的是：结构化 Workflow、独立 AgentCard、确定性 Compiler、SQLite Ledger、Candidate/Accepted Artifact、逐节点 Gate 和独立 Reviewer，确实能约束模型，并且真实 Gate 已发现数据口径、引用和一致性问题。

没有成立的是：**它还没有证明自己能够以合理的时间和成本稳定完成真实长程任务**。

当前 Ledger 的事实是：

- 共 30 个 Run。

- 16 个成功编译 Workflow。

- 15 个进入节点执行。

- 0 个 Run 最终 `succeeded`。

- 最新 PPT Run 执行 **7\.33** 小时，仍在 PPT 构建前失败。

- 当前工作树的 132 项 faux 测试全部通过，但最近修复尚未经过新的真实 Run 验证。

因此，当前产品更准确的定位是：

> 一套已经具备较完整治理协议的实验性 Agent Workflow Runtime，而不是已经验证可用的企业级长程任务工具。
> 
> 

## 一、哪些核心设计已经正确落实

以下部分与[IPD：多智能体长程任务范式设计方案 V1](https://my.feishu.cn/docx/WONZdLelhoCSCkxAz5KcSViwnvf)的主线一致，而且是这一周最有价值的成果：

- AgentCard、Workflow、Skill、Run Record 相互解耦。

- Workflow 必须经过 Schema 和 Compiler 才能运行。

- Workflow 只包含 Execution Node；每个节点强制绑定机械和语义 Gate。

- Agent 只能提交 Artifact 或 Decision，不能自行宣布节点成功。

- Candidate Artifact 未通过 Gate 前不能进入下游。

- Reviewer 与生产者分离，按 Criterion 给出证据和返工要求。

- 重试耗尽不会自动转为 PASS。

- SQLite 保存状态、事件、Artifact、Reviewer、Decision、Usage 和 Session 引用。

- AgentSession 通过 NodeRunner Adapter 接入，没有把 Workflow 逻辑塞进 Agent Loop。

- faux provider 测试基本覆盖了 Compiler、Ledger、Graph、Gate 和 Tool 协议。

最新 Run 的数据 Gate 确实发现了敏感性分母、OPEX 口径、跨文件传播和模型假设披露问题。这说明“局部 Gate 阻断缺陷传播”不是纯概念，它已经产生真实价值。

## 二、与最初设计的主要出入

|**原始设计**|**当前实现**|**判断**|
|---|---|---|
|ST 和业务员工都是 Graph Engine 上的一等 Node|Planner、Reviewer、Staff 都由不同模块内联调用，不进入统一节点状态机|工程折中，但削弱统一调度和观测|
|Graph Engine 是状态唯一写者|WorkflowPlanner、BudgetController、GraphEngine 都直接写 Ledger|明显偏离；多写者导致恢复和重规划边界复杂|
|ST 依靠统一 STControlRecord 恢复事实|Planner、Budget、Blocked、Arbitration 分别组装不同 Context|尚未实现|
|Reviewer 由 ST 在 Gate 到达时动态选择|当前由确定性 capability 匹配器选择|是优化：更稳定、可编译；但失去成本、历史绩效和模型多样性选择|
|V1 冻结 Workflow，不在线修改|实际加入 same\-Run Workflow Amendment|真实需求推动的扩展，但引入过早，协议此前不完整|
|start/resume 同步运行到稳定状态|start 后台运行，增加 status/watch/resume\_run|UX 优化，但没有 durable worker，属于半完成方案|
|Skill/Tool 倾向渐进披露|Run Skill 全文进入 Planner、Execution、Reviewer、Staff 的每个 System Prompt|实现简单，但成为严重 Context 和时延来源|
|用户给全局预算，ST 分配节点预算|默认完全 unbounded，所有节点通常也 unbounded|符合后续用户口径，但缺少与预算无关的停滞治理|
|Artifact 有 primary/review/evidence 角色|改成通用多文件 Manifest，作用由 Gate 定义|正确优化，降低领域耦合|
|模型可调用 Resume|改为用户专用 /ipd\-resume，并进一步加入显式 resolution|重要安全优化|
|Workflow 存于模板/generated 目录|改为 \<id\>/\<version\>/\<hash\>\.json 内容寻址结构|更清晰的资产化实现|
|IPD Package 完全隔离|为 Tool 继承和错误压缩修改了 packages/coding\-agent 与 packages/ai|必要适配，但扩大了影响面|
|AgentCard 角色说明适度，Operations 更多进入 Skill|当前完整职责、原则、Prompt Profile 每次都注入|角色资产更丰富，但 Static Prompt 偏重|

其中最重要的偏差是：名义上是统一图运行时，实际上形成了 Planner、Graph、Gate、Budget 四套控制调用路径。它们共享 Ledger，但没有共享统一的 Decision Node 生命周期和命令总线。

## 三、设计层面存在的缺陷

### Workflow 拓扑被重复表达

当前同一关系同时存在于：

- `dependsOn`

- `inputs.fromNodeId`

- `gate.routes.pass`

- `rework.targetNodeId`

- `gate.routes.rework`

这不是单纯冗余，而是产生过真实故障：

- Graph 调度主要读取 `dependsOn`。

- 输入验证读取 `inputs`。

- PASS 路由基本不参与调度。

- Amendment 又必须维护 `gate.routes.pass`。

- 替换失败节点 ID 时，已通过上游的 pass route 必须变化，却又与“accepted 节点不可变”冲突。

近期修复允许受控修改 outgoing pass route，但只是解决了一个症状。长期应确定一个拓扑真相源，其他字段由 Compiler 派生或严格限定用途。

### Gate 没有成本模型和风险分级

“每个 Execution Node 必须有 Gate”是正确不变量，但当前容易被解释成：

> 每个节点都要使用完整材料、多个 Reviewer、长时间工具验证和完整 Skill。
> 
> 

这导致 PPT Workflow 有：

- 6 个执行节点；

- 12 个局部机械标准；

- 23 个局部语义标准；

- 12 个局部 Reviewer Slot；

- Final Gate 再增加 3 个 Reviewer。

系统缺少“低风险 Gate、关键 Gate、终验 Gate”的审查深度控制。每个节点有 Gate，不等于每个 Gate 都要付出相同成本。

### 3\. `retryable: boolean` 无法表达真实恢复语义

真实故障至少需要区分：

- 自动重试；

- 从 Attempt Workspace 恢复；

- 需要 Staff 决策；

- 需要用户明确动作；

- 必须重规划；

- 外部副作用需要核验；

- 真正不可恢复。

此前用一个 boolean 同时影响重试、Attempt 耗尽和重规划，直接造成“2/10 Attempt 被当成已耗尽”。近期加入显式 resolution 后有所改善，但 Failure 模型仍然偏粗。

### 角色分离没有形成认知独立

当前 Run 的 23 个 Session 全部使用：

```Plain Text
aliyun / qwen3.8-flash
```

角色只改变提示词和 thinking level。生产者、Reviewer、Quality Governor 使用相同模型、相同 Skill 和大量相同证据，因此仍可能共享盲点。

“不是同一 AgentCard”只能证明组织身份独立，不能证明判断来源独立。关键 Gate 还需要模型、证据源或工具方法的多样性。

### Context 仍然是批量灌入，而不是按需交接

最初参考材料强调“Manifest \+ 按需读取”，极简 Agent 方案也强调 Skill/Tool 渐进披露。当前实现却把：

- 完整 Skill；

- 完整 Gate；

- 完整 Review Bundle；

- 完整 AgentCard；

- Planner 中全部员工和上一版 Workflow；

直接进入提示词。

这与极简 Agent 的原始方向相反，也是主要性能问题。

### 无预算被错误等同于无执行治理

用户要求默认无 Token/时间预算是合理的，但“无财务预算”不应等于：

- 没有停滞检测；

- Reviewer 工具调用无限；

- Staff Session 无限；

- 没有阶段 SLA；

- 没有无进展判定。

预算和活性保护应是两套机制。当前只有 Execution 的 96 次工具上限，且直到最近才保留最终提交窗口。

---

## 四、代码实现层面仍存在的缺陷

### 机械 Gate 名义丰富，实际只有一个检查器

默认 Runtime 只注册了：

```Plain Text
artifact-integrity
```

它验证路径、Hash、大小、MIME 和 Manifest 一致性。

但真实 Workflow 的机械 Criterion 写了大量要求，例如：

- JSON 字段集合完整；

- ROI 脚本能够重跑；

- 页数一致；

- 关键数值跨文件一致；

- 校验命令退出码为 0。

这些文字放在 `requiredEvidence` 中，却没有对应 CheckExecutor 真正执行。结果是：

> 配置看起来有很多机械标准，实际机器只检查文件是否与 Manifest 一致，其余工作被转移给 LLM Reviewer。
> 
> 

这是当前最严重的“描述能力大于执行能力”。

### Gate Route Schema 与 Runtime 行为不一致

当前运行层面：

- PASS 主要由 DAG `dependsOn` 推进；

- REWORK 实际打回当前节点；

- BLOCKED 主要读取 `node.routes.blocked`；

- `gate.routes.escalate` 基本没有实际控制作用；

- Final Gate 的 `routes.rework` 未实现。

特别是跨节点返工：Compiler 可以接受 QA Gate 指向构建节点，但 GraphEngine 的 `routeRework()` 仍按当前 QA 节点创建返工 Attempt。这属于明确的实现缺陷。

### Reviewer 没有被运行时强制为只读

ReviewerSelector 只要求 Card 有 `readScopes`，不要求：

```Plain Text
permissions.workspace == read
```

Decision Node 又直接获得 AgentCard 的全部 Tool。

真实数据 Gate 中的 Verification Engineer Reviewer 实际执行了：

- 94 个模型轮次；

- 111 次工具调用；

- 105 次 `bash`；

- 6 次 `write`；

- 持续 61\.6 分钟。

它写的是 `/tmp` 校验脚本，没有发现修改候选 Artifact，但运行时并没有阻止它修改。当前只靠 Prompt 说“Decision Node 不编辑业务 Artifact”，这正是设计最初批评 edict 的问题。

### Reviewer 和 Staff 没有工具调用上限

96 次工具保护只覆盖 Execution。Reviewer、Staff 没有对应保护；unbounded Run 中也没有 Timeout。

因此 Verification Reviewer 能执行 111 次工具调用，并成为整个 Gate 的一小时关键路径。

### Gate 的实时状态记录不真实

数据 Gate 在 15:21–16:23 实际已经启动三个 Reviewer，但 Ledger 长时间仍显示：

```Plain Text
mechanical_checking
```

原因是 DynamicGateEvaluator 内部完成机械检查、Reviewer 和聚合后，GraphEngine 才批量写入 Criterion、Reviewer 和状态。

这造成：

- 用户看到的阶段不准确；

- Reviewer 运行过程无法从 Ledger 实时追踪；

- 进程中断时缺少已提交的中间 Gate 状态；

- 设计中的事件驱动 ST 和实时透明化没有真正实现。

### 核心模块过度集中

当前大文件规模：

- `graph-engine.ts`：1677 行

- `sqlite-ledger.ts`：1854 行

- `workflow-planner.ts`：772 行

- `agent-session-node-runner.ts`：761 行

- 关键九个模块合计约 7510 行

- Package 源码约 11,904 行

最初判断核心引擎约 1500–2500 行。实际规模远超预期，说明 Runtime、恢复、Amendment、预算和状态写入尚未形成稳定的命令边界。

行数不是问题本身，但此次缺陷几乎都跨越两个以上大模块，已经说明可维护性风险存在。

### 文档同步仍然漂移

例如：

- \[packages/ipd/README\.md\]\(/home/nepham/Agent/pi/packages/ipd/README\.md\) 仍描述旧的 `start/resume/status/cancel`。

- \[testing\-and\-acceptance\.md\]\(/home/nepham/Agent/pi/packages/ipd/docs/testing\-and\-acceptance\.md\) 仍记录 18 个测试文件、95 项测试；当前实际是 23 个文件、132 项。

这说明文档数量增加了，但缺少可自动验证的事实来源。

## 五、设计与代码耦合产生的缺陷

这些问题不能只归咎于模型或某个函数。

### 丰富机械标准 \+ 单一检查器 = Reviewer 承担全部验证

Workflow 写出了精确标准，但 Runtime 没有对应 CheckExecutor，于是 Verification Reviewer 用 105 次 Bash 调用临时造校验脚本。

这是设计承诺和基础设施能力不匹配。

### 角色专精 \+ 同一模型 \+ 全量上下文 = 成本增加但独立性有限

每增加一个 Reviewer，都重复注入 Skill、Gate 和大块 Artifact，却仍使用同一个模型。系统得到了更多角色名称和 Token 消耗，但不一定得到同比例的新判断能力。

### Workflow 不可变 \+ 多份拓扑引用 \+ Amendment = 无法合法替换失败节点

最新 Run 的失败正是这个组合造成的。Compiler 的严格性没有错；问题是 IR 和 Amendment 规则一度互相不可满足。

### 后台运行 \+ 单进程 Promise = 看起来异步，但不耐久

`start` 很快返回改善了 TUI 体验，但后台 Run 仍依赖当前 Pi 进程。网络断开、Pi 退出或 Extension 重载后必须手工 `resume_run`，并需要处理半完成 Session。

这比同步 Tool 好用，但还不是 durable execution。

### unbounded \+ 长 Prompt \+ 可自由调用 Bash = 开放式执行循环

数据节点反复计划和检查，最终达到工具上限；Reviewer 甚至没有工具上限。模型行为只是触发器，真正让问题扩大到一小时的是 Harness 没有活性治理。

### 多个状态写者 \+ 恢复/重规划 = 终态错误

Planner、Graph、Budget 都能改变 Run。最新故障经过：

```Plain Text
Graph 失败
→ Escalation
→ 用户 Resume
→ Graph request_replan
→ Runtime 启动 Planner
→ Planner compiler_exhausted
→ Run failed
```

每个局部动作都“合法”，组合后却违背了用户要继续节点的意图。这是多写者和恢复协议耦合的典型问题。

## 六、为什么一个 PPT 要跑 7–8 小时

最新 Run 的精确时间线如下：

|**阶段**|**墙钟时间**|
|---|---|
|Workflow 初始规划与两轮编译|11\.7 分钟|
|研究节点 \+ Gate|40\.2 分钟|
|叙事节点三次 Attempt \+ Gate|116\.7 分钟|
|数据 Attempt 1 \+ 三 Reviewer \+ Delivery 决策|103\.7 分钟|
|视觉节点 \+ Gate|70\.9 分钟|
|数据 Attempt 2|38\.6 分钟|
|等待用户回答|52\.6 分钟|
|错误触发的三轮 Amendment|5\.3 分钟|
|总计|439\.7 分钟，即 7\.33 小时|

运行规模：

- 23 个 AgentSession

- 541 个 Assistant Turn

- 646 次 Tool Call

- 270 次 Bash

- 169 次 Read

- 83\.94M 总 Usage Token

- 其中约 77\.7M 是 Cache Read

- Reviewer 初始 User Prompt 最大约 160K 字符

- 23 个 Session 的初始 User Prompt 合计约 1\.71M 字符

这里的 `83.94M` 包含缓存读取，不等于模型实际新生成 8394 万 Token，但它真实反映了上下文被反复处理的规模和时延负担。

主要原因按影响排序：

1. 节点和 Gate 设计过重。

2. 叙事节点发生两次返工，单节点消耗近两小时。

3. 数据 Gate 的 Verification Reviewer 单独运行 61\.6 分钟。

4. Skill、Artifact 和 Workflow Context 被反复全量注入。

5. 模型在节点和 Reviewer 内进行数十轮开放式 Bash 检查。

6. 数据与视觉原本应并行，但旧 Bash 全局锁使视觉晚启动约 1 小时 44 分钟；实际关键路径损失约 71 分钟。

7. unbounded 模式没有独立的停滞和 Decision Node 工具保护。

8. 用户等待占 53 分钟。

9. 故障恢复又错误进入 Workflow Amendment。

而且该 Run 失败时：

- 只有研究、叙事、视觉三个节点 accepted；

- 数据节点未 accepted；

- PPT 构建、独立 QA 和 Final Gate 都还没有开始。

所以如果完全按当前 Workflow 成功跑完，7–8 小时很可能仍是低估，而不是偶发极值。

## 七、修 Bug 过程反映出的总体问题

这一周修复的问题大多不是算法错误，而是协议接缝错误：

- 模型输出与 Tool Schema；

- Planner 与 Compiler；

- Compiler 与 Runtime；

- Workflow Asset 与版本；

- Reviewer Requirement 与实际分配；

- Node Workspace 与并发锁；

- 用户回答与 Agent 权限；

- Attempt Failure 与恢复路由；

- Workflow 不可变性与 Amendment。

这说明当前最大风险不是某个模块不会工作，而是：

> 每个模块的单元契约看起来合理，但跨模块的组合不变量没有在最初设计中被完整定义。
> 
> 

faux 测试证明了预设路径；真实模型 Run 才暴露开放式行为、超长上下文、半完成文件、错误恢复和角色越权工具等组合问题。

## 八、已经约定或计划但尚未实现的内容

### V1 完成前必须补齐

- 至少一次真实 Skill Run 最终 `succeeded`。

- Stage 10 的并行、返工、最终 Gate 和 Artifact 追溯验收。

- Single Agent、自由 Multi\-Agent、固定流程、裁剪 IPD 的 A/B/C/D 对照实验。

- 能执行 Workflow 中真实机械标准的 CheckExecutor 集合。

- Gate pass/rework/blocked/escalate 的完整运行语义。

- 跨节点返工和 Final Gate 局部返工。

- Reviewer 强制只读、Reviewer/Staff 工具和活性限制。

- Gate/Reviewer 实时状态写入 Ledger。

- 从最终 PPT 页反查 Review Bundle、Criterion、Reviewer 和源 Artifact 的完整链路。

- 对最近工具上限、显式 resolution 和 Amendment 修复进行新的真实 Run 验证。

### 已明确设计、但仍是简化实现

- 统一 `STControlRecord`。

- Decision Node 与 Execution Node 统一进入 Graph Engine 生命周期。

- Graph Engine 成为真正单一状态写者。

- 风险驱动的 Process Family/Profile 和流程裁剪。

- 多套可复用 Workflow 模板；当前全局目录只有一个资产。

- AgentCard 的调用次数、首轮 Gate 通过率、返工率和缺陷逃逸率。

- 基于历史指标、成本、模型多样性和负载的 Reviewer/员工选择。

- Review Bundle 独立持久化及 Hash。

- 受控跨 Run Artifact 复用和 supersede lineage。

- 外部副作用 Reconciler。

- Tool Scope 的系统级强制。

- Pi 正式记忆接口接入；当前按约定不自建记忆系统。

- Skill/Tool 渐进式披露和 ToolSearch/CompactAgent。

- 默认无 Skill 的未来形态。

- Tool Result 单独返回 `finalArtifacts`。

- Run Workspace 和 Session 的垃圾回收。

### 后续平台化能力

- Harness v2 Adapter。

- 正式可安装 Extension 或公开 Package。

- 持久 Worker、Lease、Heartbeat、Fencing Token。

- 多进程或分布式 Scheduler。

- 操作系统级沙箱或远程执行后端。

- Dashboard/运行控制台。

- 资产推荐和受治理的异步自演进。

---

## 九、工程判断与建议

下一阶段不应继续增加角色、模板或新治理动作，而应先收敛四件事：

1. 把 Reviewer 强制改成只读并设置工具/轮次上限。

2. 把 Workflow 中的机械 Criterion 变成真正执行的 CheckExecutor。

3. 收敛 Route 和状态写入语义，优先解决跨节点返工、Final Gate 返工和统一 Decision 生命周期。

4. 用一个缩减到 3–5 个节点的真实 Workflow 完成首个成功 Run，并与单 Agent 做时间、质量和 Token 对照。

最终评价是：

> 这套实现已经证明了“组织流程可以被编译成 Harness 协议”，也证明 Gate 能发现真实缺陷；但它同时复现了设计材料曾警告过的问题——步骤过多、Prompt 过重、状态控制分散、观测先于可靠闭环。下一阶段的目标不应是继续补功能，而应是减少流程税、压缩上下文、统一控制权，并用真实成功率证明净收益。
> 
> 

