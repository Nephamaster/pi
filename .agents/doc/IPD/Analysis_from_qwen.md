核对了四份文档、pi 仓库结构和外部实践后，给出我的分析。先说结论：你的整体方向是对的，两节点抽象也成立，但表述里埋着几个真实矛盾，其中两个是设计级的，必须先解决再动手。

一、总体判断
你构想的这套东西，本质上是把两份分析文档的教训合流：从 edict 分析取"制度必须编译为运行时协议"，从 Agency-Agents 分析取"角色、流程、治理三种资产化"。你的"执行节点 + 决策节点(AT)"抽象与极简 Agent 方案里"复杂性移出模型、移进 Harness"的主张是自洽的——图引擎就是那个新增的 Harness 模块，AT 是运行在引擎上、但被引擎协议约束的元层。这个定位没问题。

但有一个系统性风险要先指出：你的设计里 AT 是全能的（编制、分配预算、选角、评审、裁决、打分），而整个范式恰恰是用"没有人治、只有制度"来立论的。谁制度性地约束 AT，目前是你的设计空白。 这比 edict 的"太子集权"问题更隐蔽，因为 AT 的权力是合法的。下面第四节展开。

二、图引擎：怎么实现
2.1 语言问题——这是第一个矛盾
你说"具体实现方式或许是 python 中的类"，但 pi 是一个纯 TypeScript monorepo（pi-agent-core 是 agent runtime，pi-ai 是多模型 API，pi-coding-agent 是 CLI harness）。如果引擎用 Python 写，你会得到：

两套进程间通信、两套构建、两套测试；
数字员工的执行后端（pi session）在 TS 侧，引擎在 Python 侧，节点派发要跨语言；
这正好复刻 edict 分析里 4.6 的教训："多智能体流程、通信运行时、数据存储和安装形态没有通过适配器边界解耦"——你只是把耦合换了个方向。
判断：引擎应作为 monorepo 内新包（如 packages/ipd）用 TypeScript 实现，直接复用 pi-agent-core 的 session/harness 抽象作为"数字员工实例"的载体（agent-harness.ts、events.ts 里已有事件总线、lane、record-log 这些原语，你的引擎能用上不少）。IPD 范式 PDF 里引用的 openjiuwen.core.workflow.BaseWorkflow.compile 可以读它的 IR 设计，但不建议引入它的运行时。"Python 类"这个说法应修正为"类只是 IR 的类比表达，语言必须跟随宿主 harness"。

2.2 自研还是拿现成的
市面选项的诚实评估：

候选	与你的匹配度	结论
LangGraph	概念最接近（图节点、条件边、checkpoint 持久化、human-in-the-loop 中断）	读它的语义设计，不引入：checkpoint 模型适合"状态图"，但你要的是"IR 编译 + 多会话调度 + 预算账本"，套 LangGraph 反而要绕
Temporal	确定性重放、事件溯源、信号/定时器的语义教科书	不引入：它要求工作流代码确定性可重放，而你的节点就是 LLM 会话——天然不可重放，等于只用了它的存储层却背上整个 server。借它一个观念：收口事务必须原子
CrewAI / AutoGen	角色制 / 事件驱动 actor	都不匹配：CrewAI 是 prompt 驱动编排（edict 的病），AutoGen 是对话驱动（你明确不选）
DBOS / Restate	轻量 durable execution	观望，v1 不需要
判断：自研，且比想象中小。 核心循环就四件事：就绪节点计算 → 派发 session → 校验产物 schema + 准入准出 → 原子提交状态迁移。SQLite（WAL 模式，单写者）做唯一事实源，一张 append-only 事件表 + 一张节点实例表 + 一张预算账本表，产物落文件系统以 URI 登记。粗估核心引擎 1500–2500 行 TS。edict 第一代失败不是"JSON 文件太土"，而是允许多个写者（Agent 自己更新状态）；你只要守住"引擎是唯一写者，Agent 只能提交结构化结果提议"这一条，SQLite 完全够长程任务用——这正是 edict 分析 6.2 第 7 条的直接落地。

2.3 IR 结构建议
两种节点类成立，但要明确一件事：汇聚(ALL/ANY/QUORUM)、路由、超时看门狗、重试上限不是"第三种节点"，是引擎语义。工作流图保持纯数据流（执行节点 + 边上挂 gate 声明），否则 AT 的配置空间会爆炸。节点配置文件的 IR 建议分三段（这个就是给 AT 的使用手册骨架）：


# execution-node.yaml —— AT 唯一要写的东西
kind: execution
id: arch_design
objective: ...
agent_ref: architect_v2          # 引用数字员工池，运行时校验其 permissions ⊇ node.permissions
entry: [prd_gate_passed]          # 强约束，编译期校验上游确实产出
exit:                             # 设计时固化，运行时不可变
  - {id: C-01, check: interface_contract_exists, evidence: required}
  - {id: C-02, check: traceability_to_prd == 100%, evaluator: rule}
gate:                             # 声明式，评审拓扑不写进图（见 3.2）
  dimensions: [feasibility, completeness, risk]
  aggregation: {policy: any_fail_vetoes, rework_route: self, escalate_after: 3}
budget: {tokens: 30000, timeout_s: 1800}
escalation: {to: at, sla_s: 600}   # 上报协议 + AT 响应时限（看门狗兜底）
三、AT 设计
3.1 核心判断：AT 不是被工作流驱动的，是被事件驱动的
你纠结的"AT 何时加载、成员是否固定"，根源是把 AT 想成了"另一个工作流实例"。建议明确三层结构，你的两节点抽象保持不变：


层1  图引擎语义（harness 内置，固定协议，AT 无权修改）
层2  AT 编写的静态图（纯执行节点 + gate 声明）+ AT 常驻角色配置（planner/PM/评审召集人）
层3  运行时派生的动态实例（评审员 session —— 它们是决策节点的临时实例，
     由评审召集人按 gate.dimensions 现场 spawn，用完即弃，不在静态图里）
这样三个"不确定"全部消解：

加载时机：AT 常驻角色不需要"加载"成进程——引擎事件（节点交付提交、节点异常上报、看门狗超时）到达时，引擎按需拉起对应角色的 session，AT 的共享记忆就是任务账本，不是对话历史。外层 ReAct agent 调用 IPD tool 只是"编译并启动引擎"这个动作。
成员不固定：planner/PM/召集人是准常驻的（每 run 一份），评审员是 ephemeral 的。"AT 所有成员节点类型相同"成立——都是 DecisionNode，区别只是有状态常驻还是无状态临时。
"评审员不预先设计"与"配置文件固化"不矛盾：固化的是评审维度和汇聚规则（gate 声明），动态的只是谁来评审。这条界线是你整个"标准固化"叙事能成立的关键。
3.2 评审员选取机制（你请我给建议的部分）
我的建议——评审 = 三类裁判的组合，选取规则本身固化为 AT 协议：

确定性校验器先行（引擎直接执行：schema 检查、测试跑通、产物存在性）——能机器验的绝不动用 LLM，这是最便宜的"门下省"，且天然免疫"评审员人格制造缺陷"的问题（Agency-Agents 分析 4.3）；
召集人按维度实例化 2–4 个评审员 session，输入只有：待审产物 manifest + 固化的准出标准 + 各评审维度定义。评审员禁止与被评审节点的执行者同源（同 card 同实例），关键 gate 可要求不同 model profile（缓解 edict 分析 5.2 的"共同盲点"）；
汇聚规则编译期固定：任何 FAIL → FAIL（附证据与 required_rework）；全 PASS → PASS；INCONCLUSIVE/BLOCKED 占比超阈值 → 升级人工。INCONCLUSIVE 永远不允许被超时或重试耗尽转化为 PASS——这条写进引擎，是 edict"第 3 轮强制准奏"的直接反面。
3.3 已有实践与 Anthropic 研究（你问的）
有，而且相当对症，但注意：没有任何现成实践做到"AT 作为被同一引擎治理的元层"——这是你的差异化点，不是缺口。

Anthropic 官方工程博客 How we built our multi-agent research system（2025-06-13，已核实原文）：orchestrator-worker 模式——lead agent 规划并并行 spawn 子 agent、每个子任务必须带明确目标/输出格式/工具指引/范围限制、显式的工具调用数与子 agent 数预算（对应你的预算分配）、"resume from where the agent was"的检查点恢复（对应你的事件溯源）、LLM-as-judge 带 rubric 评审（对应你的 gate 逐条判定）。文中记录的失败模式——子 agent 过度 spawn、指令模糊导致重复劳动、有状态协调的不确定性——恰好都是 AT"选角"权力要付出的代价，印证了第 3.2 节把选取规则固化的必要性。
更早的 Building effective agents 区分了 workflow（代码编排固定路径）与 agent（模型自主循环），提出 orchestrator-workers 和 evaluator-optimizer 两个复合模式——你的架构就是把这两个复合模式提升为一等公民 IR。
学术界最接近你构想的是 MetaGPT（SOP→角色→结构化产物，"代码即流程"）和微软 Magentic-One（Orchestrator + 双账本：事实账本/进度账本，停滞时换路线而非重问一次——直接对应你的"节点异常上报→AT 处理"，其 outer/inner loop 设计值得细读）。但两者都没有你做"AT 资产化 + 准入准出固化"的野心。
中文语境注意：华为系 openJiuwen 已被你 PDF 引用，读其 compile 实现即可。
四、矛盾点与不清晰问题（按严重度排序）
Python vs TS 的语言矛盾（见 2.1）。必须先裁决：我强烈建议 TS、随仓构建。
"仅两种节点" vs 工作流的汇聚/路由需求（见 2.3）。表述要修正为"两种节点类型 + 固定引擎语义 + 一个动态评审协议"，否则 AT 手册写不出"只有两种节点"的承诺。
AT 的自指监督空白（最重要的设计缺口）。AT 交付物 = 工作流配置，那谁评审 AT 的设计？建议加一道设计时 gate，且完全确定性：IR 编译校验（DAG 无环、准入引用可解、每个产物有归宿、预算求和 ≤ 全局预算、每个 AgentCard 权限满足节点要求）+ 用户对编排结果的显式批准（一次性，任务启动前）。这就是 IPD 里 IPMT 对 PDT charter 的关系：AT 有创造空间，但宪法在 harness 手里。没有这一条，edict 的"太子集权"会以更高级的形态复活。
预算守恒没定义。全局预算 = 执行节点预算 + 返工预留（每个 gate 的 rework 从哪份预算扣？）+ AT 自身开销 + 未分配缓冲。建议 AT 分配时强制写出守恒等式，设计时 gate 校验；IPMT 的"动态调配"在 v1 就是"重新分配未分配缓冲"，仅此而已。
固化 vs 例外的冲突：节点上报异常、AT 裁决后发现准出标准本身不合理怎么办？标准不可原地改——AT 可发起 re-plan，产出 IR 新版本 + 新 run_id（或同 run 内标记 amendment 事件）。资产画像统计也要版本化，否则"失败率"归因不到配置版本。
评分闭环存在循环偏置：被评审者给评审者打分的同事、打分的也是 AT。v1 建议只记原始计数器（append-only 事件：gate 一次通过率、返工次数、缺陷逃逸数=端到端验收时回溯归因），不做"评分"这个抽象。终验结果是延迟的 ground truth，用它反标节点和评审员，才能避免"选角参考档案"在早期噪声上自我固化。
模板问题（你说"不一定需要预置模板"）：我不同意可以没有。模板是"流程资产化"的载体，没有模板，资产画像就没有模板维度的统计对象；且冷启动时 AT 从零编排既贵又方差大。建议 v1 就一个模板（你的五段 OBP 链），但定位是"可裁剪的起点"而非强制——这正好也是 IPD 裁剪原则。
异常上报语义未定义：上报包必须区分 TECH_FAIL（重试）、SEMANTIC_BLOCK（缺输入/标准歧义，AT 决策）、AUTH_REQUIRED（出权限，找用户）——不同类走不同路径，否则 AT 会变成"所有问题的垃圾桶"（edict 分析 5.4：自动重试修不了语义错误）。且 escalation.sla 必须引擎强制执行，AT 不响应就自动升级用户。
一个澄清请求：你说"工作流是由执行节点构成，AT 团队是由决策节点构成"——但端到端验收也是决策节点，验收员是常驻 AT 角色还是临时评审员？我倾向：验收 = 一次特殊的 gate 评审（维度更宽、必含人工裁决触发），复用同一协议，不新增机制。请确认是否符合你的意图。
五、v1 最小闭环（呼应两份分析的"先证净收益"建议）
引擎（IR 编译校验 / SQLite 账本 / 派发-校验-收口 / 预算计数 / 升级协议 / 看门狗）+ 3 类常驻 AT 角色（planner、PM、评审召集人）+ 临时评审员 + 一个五段模板 + 5–7 张 AgentCard + 设计时批准 gate。明确不做：评分、资产自演进、动态预算调配、多看板。然后按 Edict 分析第 8 节跑 A/B/C/D 对照——特别建议把"D 组：结构化流程"和"A 组：单 agent"的成本/质量比作为立项继续推进的唯一证据，这能回答你 PDF 里"流程税"的根本质疑。

如果你认可第 3 点（设计时 gate）和第 1 点（TS）这两个裁决，下一步我可以起草 packages/ipd 的 IR schema 和引擎事件表的具体定义。

Sources:

How we built our multi-agent research system — Anthropic Engineering
Building effective agents — Anthropic
LangGraph 文档 / LangGraph persistence
Temporal / Temporal: durable AI agents
LangGraph vs Temporal 对比 / 开源 agent 框架综述 2026