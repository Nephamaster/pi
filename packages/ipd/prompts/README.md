# IPD 提示词组装与上下文管理

本文说明四类内部角色在**每一次模型请求**中看到什么，以及首次执行、工具续接、补正、返工、暂停恢复和压缩时如何变化。

## 目录

- [1. 先区分轮次、会话与模型请求](#1-先区分轮次会话与模型请求)
- [2. Pi 原生组装方式与资源边界](#2-pi-原生组装方式与资源边界)
- [3. 流程选择者](#3-流程选择者)
- [4. 工作流设计师](#4-工作流设计师)
- [5. 执行与评审节点的稳定上下文](#5-执行与评审节点的稳定上下文)
- [6. 当前轮次状态与派发消息](#6-当前轮次状态与派发消息)
- [7. 补正、返工、阻塞与恢复](#7-补正返工阻塞与恢复)
- [8. 长历史、图片与容量管理](#8-长历史图片与容量管理)
- [9. 可还原的请求示例](#9-可还原的请求示例)
- [10. 外层 Pi、模板与不会自动注入的内容](#10-外层-pi模板与不会自动注入的内容)
- [11. 文件、标签和验证入口](#11-文件标签和验证入口)

## 1. 轮次、会话与模型请求

| 概念 | 当前含义 |
|---|---|
| Run | 从任务接收、流程选择、设计到执行和交付的一次治理任务。 |
| Baseline | Compiler 校验后冻结的执行基线：工作流、已解析员工/资源、标准、图关系及环境绑定等。不是基础提示词。 |
| 节点 round | 一次业务执行或评审轮次，例如 `produce:round:2`。正式质量返工通常开新 round。 |
| Attempt | 某个 round 的执行尝试，带控制者 term 和 scope epoch。恢复可以保持 round、产生新 Attempt。 |
| dispatch | IPD 对一个 Session 的一次真实派发。Runtime 提交补正可以在同一 round/Attempt 中再次派发。 |
| Session | 以 `runId + nodeId + participantId` 绑定的持续对话。当前每个执行/评审节点仅一个员工。 |
| 模型请求 | 一次 LLM 调用。一次 dispatch 内可能出现多次“模型 → 工具 → 模型”，不是每次工具返回都开新 round。 |

概念上，模型信息分为**系统指令、有效对话历史、工具定义**三部分；但不要把旧版 `{systemPrompt, messages, tools}` 当成当前 Provider 内部的固定结构。

当前 Pi 将指令和工具声明记录在原生 transcript 的 `role: "system"` 消息中：

```text
SystemMessage
  content
  sections                  命名系统段；后续同名项替换，null 删除
  toolsAdded / toolsRemoved 工具定义及工具集变化
UserMessage                 真实任务/派发
AssistantMessage            回答、思考块、工具调用
ToolResultMessage           工具内容/错误
```

公共 `Context.systemPrompt/tools` 仍可作为简写，但会被 `normalizeContext()` 归入首条 system 消息。Provider 接收的是 `TranscriptContext.messages`，再转为供应商 API 的 system/messages/tools 等字段。支持对话中途系统消息的模型可在原位接收变化；其他模型使用重放后合并的系统状态。**系统段变化不等于用户又发来了一条指令。**

源码：[Pi 类型](../../ai/src/types.ts)、[系统提示词组装](../../coding-agent/src/core/system-prompt.ts)、[AgentSession](../../coding-agent/src/core/agent-session.ts)。

## 2. Pi 原生组装方式与资源边界

### 2.1 系统段的顺序

无自定义基础系统提示词时，`buildSystemPromptSections()` 按下列顺序构建：

```text
preamble                  Pi 默认身份，无外层标签
<tools>                   已启用工具中提供 promptSnippet 的说明
<rules>                   工具 guidelines 与 Pi 通用规则
<docs>                    Pi 文档位置和使用说明
<addendum>                IPD 传入的 appendSystemPrompt
<project_context>         IPD contextFiles，控制角色通常没有这一段
<skills>                  绑定 Skill 的目录，内部含 <available_skills>
<cwd>                     当前工作目录
<ipd_current_round>       仅执行/评审节点；当前有效状态
```

工具没有 `promptSnippet`，不代表工具不存在；模型仍通过原生工具定义获得名称、描述和参数 Schema。README 中的“Pi Base”指上述原生基础段，不是 IPD 的 Baseline。

一个容易遗漏的现状：`noContextFiles` **不关闭**全局 `SYSTEM.md` 发现。当前工厂没有覆盖 `systemPrompt`，因此如果指定的 `agentDir/SYSTEM.md` 存在，Pi 会以它替换默认 preamble，且不生成默认 tools/rules/docs 段。项目被标为不可信，项目内 `.pi/SYSTEM.md` 不会按可信项目路径载入。IPD 显式传入 append 数组，所以不会再自动发现 `APPEND_SYSTEM.md`。还原实际请求时必须区分这一分支，不能声称所有宿主提示词都被关闭。

### 2.2 内部 Session 不继承外层资源全集

[PiNodeSessionFactory](../src/adapter/pi-node-session-factory.ts) 关闭自动发现的 Extensions、Skills、Prompt Templates、Themes、Context Files，然后只加入：

- `lockedSkills` 对应的 `additionalSkillPaths`；
- `lockedTools` 与该角色私有控制工具；
- IPD 内联扩展：提交结果处理、请求准入、请求视图，节点另加当前轮次扩展；
- 执行/评审的四个 `agentsFilesOverride` 上下文文件；
- 可信宿主设置中的 `retry/compaction/httpIdleTimeoutMs/images`，而非节点目录内任意配置。

模型与 thinking level 按冻结 AgentCard 的显式选择或 Run 默认值解析。API 凭据用于请求，不作为提示词正文。

控制角色仅有锁定 Skill 范围的文件读取能力；执行/评审的文件、搜索、图片和 Bash 由明确的环境后端提供。没有后端不能自动退回宿主工具。获准的 `control_read` 服务沿用外层注册工具的实现/Schema，例如搜索和网页读取，并不因此获得节点文件系统写权限。

### 2.3 Skill 目录与正文是两件事

系统目录通常只列 name、description、location；不加载正文或 references。有 `read` 或 `bash` 才展示目录；`disable-model-invocation` 的 Skill 不自动列入目录。

控制角色首次派发以 `/skill:process-selection` 或 `/skill:workflow-design` 开头，Pi 在发送前展开为：

```xml
<skill name="workflow-design" location="/locked/.../SKILL.md">
References are relative to /locked/....

[该 SKILL.md 去掉 frontmatter 后的完整正文]
</skill>

[同一条命令后面的任务正文]
```

这是一条 **user 消息**，不是 system section。references 由模型按需读取。业务 Run Skill 可选，Designer 只得到其确切读取路径，不自动展开正文；执行/评审只获得自身显式绑定的 Skills。

Docker 节点的目录路径改写为 `/ipd/skills/<id>/<hash>/SKILL.md`，实际包也绑定到该只读位置。正常节点派发不是 `/skill:` 命令；正文通常通过授权 `read/bash` 成为工具结果。不要据此假定控制侧原生 Skill 命令展开可以直接读取容器虚拟路径。

---

现在开始阐述各类角色的上下文组织。

## 3. 流程选择者

### 系统上下文

```text
Pi Base
<addendum>
  common.md（自带 <core_rules>）
  renderAgentRuntimeProfile(selectorCard)（<professional_role>）
  process-selector.md（<process_selection_protocol>）
</addendum>
<skills> process-selection 的目录 </skills>
<cwd> Run 的宿主 workspace </cwd>
```

没有节点 contextFiles，也没有 `ipd_current_round`。

运行画像只包含名称、描述、职责、非职责、原则和 `promptProfile.approach`，不是完整 AgentCard。选择画像则额外包含场景、能力、通用交付物、验证参考、默认 Skills、允许工具和权限上限。

### 首次请求与工具续接

首条 user 消息是展开的流程选择 Skill，加 `<process_selection_assignment>`；其中放完整 TaskInput V2：

```json
{
  "schema_version": 2,
  "task_input_id": "request-demo",
  "raw_task": {
    "text": "根据提供的事实写一份经过独立评审的简报。",
    "source": "external-agent-request"
  },
  "materials": [],
  "unresolved_facts": []
}
```

当前没有 `objectives`、`requirements` 或 `task_requirement_refs`。

默认工具为 `read`、`search_process_specs`、`get_process_spec`、`submit_process_selection`，另有 `ipd_read_context`。全部 ProcessSpec 不预先注入；搜索给摘要，精确查询才给完整规范。

一次派发中的后续请求看到同一系统状态、首条任务、既有 assistant/tool 历史和最新工具结果。查询错误、非法选择引用是工具诊断，模型可在同一派发内修正；不会因此收到新一轮 Runtime 状态通知。

`submit_process_selection` 捕获 selected/blocked 后终止此派发，控制层记录结果并释放选择 Session。Selected 不等于员工配备足够：随后仍有 ProcessSpec staffing 检查。默认选择派发保护为 40 次工具调用、5 次工具错误的阈值（超过才中止），不是时长限制。

源码：[控制角色](../src/control/pi-control-roles.ts)、[派发文本](../src/control/control-role-prompts.ts)、[目录工具](../src/control/asset-catalog-tools.ts)。

## 4. 工作流设计师

### 系统上下文与首次任务

稳定 addendum 为 `common + Designer 运行画像 + workflow-designer 协议`；Skill 目录包含 `workflow-design` 和可选业务 Run Skill。没有节点契约文件，也没有 `ipd_current_round`。

**当前不存在单独的“方法准备轮”。**同一次首次 user 派发同时包含：

```text
<skill name="workflow-design" ...>
  完整方法 Skill 正文
</skill>
<workflow_design_assignment>
  方法使用说明
  可选业务 Skill 的 id/filePath，或明确说明没有业务 Skill
  TaskInput: 完整原任务、材料描述、未决事实
  ProcessSelection: 确切所选规范引用、理由和合法引用
  ProcessSpec: 所选版本完整规范
  Available non-employee resources: 资源摘要
  搜索并检查员工的要求
  Compiler diagnostics: 首次通常为 None
</workflow_design_assignment>
```

资源摘要目前含 `unavailableProfiles/environmentPolicy/skills/tools/toolDependencies/externalReadTools/unavailableAgentCards/mechanicalChecks/environmentProfiles`。员工全文通过 `search_agent_cards/get_agent_card` 渐进读取，不全库预载。材料只有描述和 reference 时，不等于 Designer 已读到正文；其 `read` 不能读任意任务文件。

### 草稿工具与修订

当前模型侧工具是：

```text
read, ipd_read_context
search_agent_cards, get_agent_card
workflow_draft_open, workflow_draft_read
workflow_draft_topology, workflow_draft_configure_nodes
workflow_draft_outputs, workflow_draft_criteria, workflow_draft_inputs
workflow_draft_reviews, workflow_draft_stages, workflow_draft_governance
workflow_draft_coverage, workflow_draft_completion
workflow_draft_validate, workflow_draft_submit
report_workflow_design_blocked
```

共 14 个草稿工具：10 个领域编辑，加 open/read/validate/submit。模型编辑的是 **AuthoringDraft V2**，代码生成 **WorkflowDefinition V3**。旧 `workflow_draft_apply` 不是当前模型工具。

草稿在 Runtime 管理的文件中持久化，不靠模型记忆整份 JSON。`read` 为有界视图，支持游标及超长项片段。工具结果使用 `<workflow_draft_result>` 或 `<workflow_draft_error>`。普通编辑/验证失败留在当前工具往返中修正。

候选提交成功后结束派发。若外层 Compiler 要求修订，**同一活跃 Designer 实例的原 Session**追加：

```xml
<workflow_design_revision>

Draft revision: 9

Compiler diagnostics:
/nodes/produce: [实际诊断文字]

Revise the existing draft and submit the corrected revision.

</workflow_design_revision>
```

不会重复发送完整 TaskInput/ProcessSpec/Skill；旧任务仍在有效历史或原生压缩摘要中，草稿、规范项和资源可以按需再读。控制角色的原始任务**没有**像节点 TASK_SCOPE 一样永久放进系统段，因此不能承诺其全文在历史压缩后始终内联可见。

设计派发阈值为 120 次工具调用、8 次工具错误；准备控制面最多接收 10 次设计修订。真正设计阻塞用 `report_workflow_design_blocked`，不是删除要求来消除诊断。

进程退出后的准备恢复复用持久 TaskInput、ProcessSelection、候选/草稿等；如果需要重新调用控制 Agent，会建立新的控制 Session 并发送首次完整任务。它不等同于执行节点的原 Session 恢复。旧草稿被关闭或协议不兼容时仍可能需要可信控制处理，不能靠模型另建草稿绕过。

## 5. 执行与评审节点的稳定上下文

系统 addendum 只放 `common.md`。其余通过 Pi 原生 contextFiles，依次形成：

| 文件（默认位于 /ipd/context） | 内容与来源 |
|---|---|
| `TASK_SCOPE.md` | 原始请求及 source、此节点显式绑定的 task-material 描述与位置、全部 unresolved facts。来自 `taskContextForNode()`。 |
| `NODE_CONTRACT.md`（执行） | 目标、职责/非职责、工作要求、约束、静态输入、输出 ID/类型/用途/路径/证据/标准引用、标准全文及 Blocking/Authority、权限与环境说明。 |
| `REVIEW_CONTRACT.md`（评审） | 目标、职责、被评输出与标准、允许返工节点、组合对象/推导关系/修复授权/决策政策、评审要求、约束、标准及权限环境说明。 |
| `PROFESSIONAL_ROLE.md` | 冻结 AgentCard 的运行画像，不是选择画像全文。 |
| `EXECUTION_PROTOCOL.md` 或 `REVIEW_PROTOCOL.md` | 对应 prompts 文件全文；提交、证据、补正、返工和控制权边界。 |

每个节点是**四个文件**，不是五个；两种契约和协议按角色二选一。它们包在：

```xml
<project_context>
Project-specific instructions and guidelines:

<project_instructions path="/ipd/context/TASK_SCOPE.md">
<task_scope>
[完整任务范围]
</task_scope>
</project_instructions>

[其余三个文件，同样各有 project_instructions 与内部语义标签]
</project_context>
```

这些文件在 Session 创建时直接进入系统提示词，**不需要模型先调用 read 才知道契约**。Docker prepare 阶段还会将相同内容物化到只读路径，因此模型确实可以再读它们。正常返工复用同一冻结配置；恢复创建 Session 对象时由冻结信息重建这些段。

两个重要的投影边界：

- `TASK_SCOPE.md` 保留完整原任务，不做模型摘要；材料只选当前节点声明的那部分，未决事实目前不按节点过滤。
- 执行契约的输出渲染**没有单独内联 output.description 或 process_evidence_requirement_refs**；标准渲染也不展开完整 check parameters。关键作业要求应在 `contract.work_requirements` 中明确。不能将 Baseline 内存在某字段等同于模型已看到该字段全文。

### 路径与权限不是同一个概念

默认私有环境：

```text
/workspace                              节点私有 cwd，可放中间工作
/ipd/context                            只读任务/契约/角色/协议
/ipd/inputs/<input_id>                   当前确切输入，受控只读
/ipd/skills/<skill_id>/<hash>            已锁定 Skill，只读
/workspace/outputs/...                  声明产物的常规位置
```

文件访问、Bash cwd 和产物导出分别治理；私有 workspace 中间文件不必全部声明为 Artifact。契约还列出冻结网络策略、项目内依赖安装方式、探针要求、私有评审副本和恢复后重启服务说明。

Reviewer 可使用实际授权的 Bash/写工具在私有目录做检查、渲染并保存 `outputs/review-evidence/`，不能改封存输入或代替生产者交付。Legacy 共享工作区模式仍有更严格的评审写入限制；它不是 Docker 失败后的自动降级。

任务材料 reference 若是实际绝对文件/目录路径，当前 Docker Worker 才在 prepare 中按输入 ID 绑定；任意 URL 或消息引用并不会自动变成下载后的文件。README 的路径示例不保证所有 reference 都已可读。

源码：[节点上下文](../src/adapter/node-context.ts)、[Worker](../src/adapter/pi-node-worker.ts)、[任务投影](../src/runtime/runtime-state.ts)。

## 6. 当前轮次状态与派发消息

### 6.1 状态：ipd_current_round 系统段

真实 dispatch 的 prepare 阶段调用 `renderCurrentRoundContext(work)`，然后在 `before_agent_start` 设置 `systemPromptOptions.sections.ipd_current_round`。Pi 为其加标签、与已有系统状态做差异比较。

当前 JSON 字段是：

```text
run_id, node_id, round_id, generation, attempt_id, dispatch
inputs[]
  input_id, submission_id, output_id, approval_review_node_ids
  revision_id, purpose, release_ids
  consumption                         交接信息/文件导航/消费目标
  sealed_root, submission_record       节点可读取位置
feedback[]
  type, source_id, criterion_id, output_id, issue
  diagnostics, evidence_ref, expected_correction, finding_id
findings                              当前分配的问题单
review_bundle                         评审的确切对象、关系和决策政策
preservable_outputs                   允许保留的输出版本
governance_contract                   工作流 requirements/decisions 与相关 stages
```

不存在的可选值在序列化时省略。这里只列上游 Submission 绑定；task materials 在 TASK_SCOPE 和静态输入契约中。

`consumptionView()` 基于 output.handoff，并标记 `producer_authored_summary`；导航来自 Manifest，另加当前节点 objective。它不是自动核验的语义摘要。Manifest 和证据全文不再默认复制进状态段，模型通过 `submission_record` 和精确输入文件按需读取。

`governance_contract` 当前包含工作流完整 requirements/decisions，只有 stages 按节点相关性过滤；不能笼统声称所有治理信息都已最小化为节点局部子集。

### 6.2 事件：一次 node_round_dispatch 用户消息

[buildNodeRoundPrompt()](../src/runtime/node-prompts.ts) 只发送一次简短派发：

```xml
<node_round_dispatch>

Begin IPD work round produce:round:1.
Dispatch: execute.
Execute the frozen contract and call submit_artifact when the complete candidate is ready.

</node_round_dispatch>
```

类型按此优先级选择：`submission_correction → resume → quality_rework → mechanical_rework → review/execute`。多类反馈可同时在状态中，派发名称不是反馈全集。

一次派发内的实际消息关系：

```text
system：首次系统状态，或本次发生变化的 system sections
user：一次真实派发
assistant：调用 read
toolResult：文件内容
assistant：调用 bash/write/其他获准工具
toolResult：实际结果或错误
assistant：继续工作或正式提交
```

工具续接没有新 `user: ipd_current_round`。当前段持续有效，但不会被表达为 Runtime 反复确认本轮或重复发来评审通知。成功提交工具带 `terminate: true`，其回执写入会话后结束派发；不保证模型立刻再收到一次调用去“确认提交成功”。

## 7. 补正、返工、阻塞与恢复

| 场景 | 下一次模型请求看到什么 | Session / round |
|---|---|---|
| 首次执行 | 稳定四文件 + 当前输入/治理状态 + execute 派发 | 新 Session / round 1 |
| 首次评审 | 评审四文件 + 精确候选输入、review bundle、Findings + review 派发 | 独立 Reviewer Session / round 1 |
| 普通工具或原生参数校验失败 | 最新 toolResult 错误；其余状态不变 | 原 Session / 原 round，不重新派发 |
| 提交工具内部预校验拒绝 | `submission_validation_result` 具体诊断；可查询 correction base | 当前派发中继续，原 round |
| 捕获后导出/封存等协议失败 | system 更新 feedback.diagnostics 等，新增 submission_correction 派发 | 原 Session / 同 round；不是质量返工 |
| 机械 FAIL | 新状态的 mechanical_failure 反馈 + mechanical_rework 派发 | 原生产者 Session / 新业务 round |
| 正式质量返工或依赖失效后的修复 | 新绑定、Findings、quality_rework、可保留输出 + 返工派发 | 原责任节点 Session / 新业务 round |
| 新候选复审 | 新候选版本、review bundle、当前 Findings + review 派发 | 原 Reviewer Session / 新评审 round |
| 原生模型重试 | Pi 管理重试；不伪造新的 IPD 用户反馈 | 原派发内；耗尽后由 Runtime 分类 |
| 显式 resume | 保留历史与文件、当前 Attempt/输入/反馈 + resume 派发 | 能恢复时原 Session ID / 原业务 round |
| 配置了 soft deadline | 一条明确的保存进展 steering 指令 | 原派发，不是评审反馈；默认不启用 |
| 执行提交 report_node_blocked | 捕获阻塞报告后结束；无自动等待反馈对话 | Runtime 记录阻塞，等待外部条件与恢复 |
| 评审 BLOCKED | 提交标准级报告，说明无法判断的条件 | Runtime 决定暂停/阻塞及已知缺陷的修复 |

### 补正工具不是另一套审批

执行节点额外获得 `submit_artifact/report_node_blocked/submission_context/correct_submission`；评审节点获得 `submit_review/submission_context/correct_submission`。两者都有 `ipd_read_context`，业务工具仍由绑定决定。

`submission_context` 的 evidence 模式对 Reviewer 返回允许的确切证据元组，对生产者返回输出范围和保留候选的声明文件。它不读取文件，也不证明文件存在或质量通过。

协议拒绝后，correction 模式按指定 JSON Pointer 返回小范围字段和 `base_hash`。`correct_submission` 只修改保留负载，然后调用原提交校验；不是改文件、改标准或自动批准。它的基底按 Run/节点/参与者/round/契约/输入限定，且仅在内存保留；进程重启或新业务轮次不能保证可复用。原生 Schema 在工具执行前拒绝时也可能没有基底。

`ArtifactValidationError.diagnostics[]` 已透传到 Runtime 补正反馈。业务阻塞 Schema 当前没有旧的 `affected_requirement_ids` 字段。

### 质量反馈的含义

Review 总体决策是 `PASS/REWORK/BLOCKED`，单条标准是 `PASS/FAIL/BLOCKED`。只有 blocking 标准影响总体放行；advisory FAIL 不等于整轮 REWORK。不能再写成“所有标准一律 PASS 才允许总体 PASS”。

执行修复通过 `resolution_claims` 声明，Reviewer 通过标准内的 `finding_resolutions` 验证。旧 Review 过时不自动关闭问题单；历史讨论也不授权继续使用已失效输入。

### 暂停与进程恢复

正常暂停保留原 Session 文件、身份/历史边界和工作进度，环境进程可停止而文件保留。恢复校验冻结基线、输入、工作区、环境引用和 Session 身份；合法时用 `SessionManager.open()` 恢复，而不是重新建一个没有历史的员工冒充恢复。异常退出还需隔离旧执行、核对外部操作结果；未知副作用不能盲目重放。

资料缺失、环境丢失、历史边界变化或外部结果未核对，仍可能拒绝恢复。默认 `roundTimeoutMs = 0`，没有隐式 20/30 分钟整轮期限；模型网络等待、原生重试和工具超时是独立配置。

## 8. 长历史、图片与容量管理

当前不是“发现超限就永远抛错”，也不是“无限保留全部历史内容在每次请求里”。

1. Pi 原生 Session 保存消息，按可信配置管理 token 压缩、重试与图片处理。
2. IPD 的 `context` hook 在每次请求构造有界工具证据视图：优先将较早的大文本/图片块替换为带 `entry_id/block` 的引用，保留原消息身份、工具调用及原始证据。
3. `turn_end` 使用原生 `context_edit` 记录投影；原 ToolResult 仍在 Session 中，不是被虚构摘要替代。
4. `ipd_read_context` 分页回读本 Session 分支的原文（默认最多 8,000 字符），图片一次一张；不重新执行原工具，也不读取别人的 Session。
5. `before_provider_request` 对实际序列化 payload 检查字节与图片上限。局部可修时进一步缩减请求视图，通过 `agent_before_settle` 继续；最多两次修复，不重放派发或工具副作用。无法安全缩减则拒绝请求。

默认本地工作预算是 **4 MiB/请求、8 图/请求、4 图/消息**；模型显式 inputLimits 或可信配置可使其更低。这不是宣称所有供应商 API 都有相同限额。投影初始将 messages 目标设为字节预算的 70%，但最终还需计算系统、工具定义和供应商包装后的实际请求。

只替换可定位的工具内容，不任意删除用户任务、assistant 工具参数或系统契约。最新回读页要实际送达一次；单图过大或不可缩减的任务/Schema 太大仍可失败。token 容量与 HTTP 请求字节限制不是同一件事。

原生压缩保留有效系统状态，节点任务/契约/当前输入不会仅依赖历史摘要；控制角色首条 user 中的 Skill 和任务则可能被摘要替代。恢复读取原文或原文件仍应遵守现有授权。

外部只读服务结果还可能经 [external-read-results](../src/adapter/external-read-results.ts) 转换：受控 PDF 提取文件导入节点 workspace，返回节点路径及 `retrieval_receipt`。取回时间不是发布日期，续读也不保证重新联网。长文工具所需伴随工具仍须显式绑定。

源码：[请求视图](../src/adapter/request-view.ts)、[请求准入](../src/adapter/provider-request-admission.ts)、[Session 设置](../src/adapter/session-policy.ts)。

## 9. 可还原的请求示例

以下是**结构示例，不是某次历史请求抓包，也不是可直接运行的工作流参数**。静态正文标记如 `[common.md 全文]` 表示从唯一源文件原样展开一次（正文已自带标签，不要重复包标签）。实际工具 Schema 由该 Session 的 ToolDefinition 提供，不在示例中重复数百行。

### 9.1 Selector：同一派发的第二次模型请求

```text
system
  Pi Base
  <addendum>
    [common.md 全文]
    [Selector 的 professional_role]
    [process-selector.md 全文]
  </addendum>
  <skills>[process-selection 的目录]</skills>
  <cwd>/repo/.pi/ipd/runs/run-demo/workspace</cwd>
  toolsAdded: read, search_process_specs, get_process_spec,
              submit_process_selection, ipd_read_context

user
  <skill name="process-selection" location="/locked/process-selection/SKILL.md">
  References are relative to /locked/process-selection.
  [方法 Skill 正文]
  </skill>
  <process_selection_assignment>
  Load the process-selection method, evaluate this TaskInput,
  inspect serious ProcessSpec candidates through the catalog tools,
  and submit one decision.
  TaskInput:
  [第 3 节的完整 TaskInput JSON]
  </process_selection_assignment>

assistant
  search_process_specs({"query":"brief","limit":5})
toolResult
  <process_spec_search_results>
  [候选 id、version、适用/排除条件与数量摘要]
  </process_spec_search_results>

→ 下一次模型继续检查候选；此处没有新的 Runtime user 消息。
```

### 9.2 Designer：第一次与 Compiler 修订请求

```text
system
  Pi Base + <addendum>[common + Designer 画像 + designer 协议]</addendum>
  <skills>workflow-design；可选业务 Skill 的目录</skills>
  <cwd>宿主 Run workspace</cwd>
  toolsAdded: 第 4 节的完整工具集合

user（一次，而非两个方法/业务回合）
  <skill name="workflow-design" location="/locked/workflow-design/SKILL.md">
  References are relative to /locked/workflow-design.
  [方法 Skill 正文]
  </skill>
  <workflow_design_assignment>
  [方法说明；无业务 Skill 时明确 absence is not a resource gap]
  TaskInput: [完整 V2 JSON]
  ProcessSelection: [完整 V2 JSON]
  ProcessSpec: [所选规范完整 V2 JSON]
  Available non-employee resources: [实际资源摘要]
  Search and inspect AgentCards before binding employees.
  Compiler diagnostics: None
  </workflow_design_assignment>

assistant / toolResult
  搜索员工 → 读取画像 → 建立草稿 → 小范围编辑 → 验证 → submit

若外层 Compiler 请求修订：
  [保留上述有效历史；必要时已由 Pi 压缩]
  user: <workflow_design_revision>修订号 + 实际诊断 + 修改要求</workflow_design_revision>
  assistant: workflow_draft_read({"view":"nodes","node_ids":["produce"],"sections":["inputs"]})
  toolResult: <workflow_draft_result>限定视图</workflow_draft_result>
  → 继续局部修订，不重发全部背景，不重开第二份草稿。
```

### 9.3 Execution：首次、工具续接与质量返工

假设 `produce` 无上游 Submission，要求基于原任务内联事实写简报，未绑定业务 Skill：

```text
system
  Pi Base
  <addendum>[common.md 全文]</addendum>
  <project_context>
    TASK_SCOPE.md        原任务、source、空材料/未决事实
    NODE_CONTRACT.md     produce 职责、outputs/produce、标准、权限/环境
    PROFESSIONAL_ROLE.md 该员工运行画像
    EXECUTION_PROTOCOL.md [execution-node.md 全文]
    （实际逐文件 project_instructions 包装见第 5 节）
  </project_context>
  <cwd>/workspace</cwd>
  <ipd_current_round>
  {
    "run_id":"run-demo",
    "node_id":"produce",
    "round_id":"produce:round:1",
    "generation":0,
    "attempt_id":"produce:round:1:attempt:1:term:1:scope:1",
    "dispatch":"execute",
    "inputs":[],
    "feedback":[],
    "findings":[],
    "preservable_outputs":[],
    "governance_contract":{}
  }
  </ipd_current_round>
  toolsAdded: read, write, submit_artifact, report_node_blocked,
              submission_context, correct_submission, ipd_read_context

user
  [第 6.2 节的 execute 派发]

assistant / toolResult
  write → 写入结果 → read → 自检内容 → submit_artifact → 候选捕获
```

若 Reviewer 在正式评审中提出一个缺陷，下一次生产派发为：

```text
[原系统与该生产者有效历史保留]
system.sections.ipd_current_round 更新为：
  round_id: produce:round:2
  attempt_id: 本轮真实 Attempt ID
  dispatch: quality_rework
  inputs: 本轮重新解析的合法输入
  feedback: [{
    type: "quality_rework",
    source_id: 实际 Review ID,
    criterion_id: "fidelity",
    output_id: "brief",
    issue: "将提议状态误写成已批准。",
    expected_correction: "恢复原事实中的未批准限定。",
    finding_id: 实际 Finding ID
  }]
  findings / preservable_outputs / governance_contract: 当前真实投影

user
  <node_round_dispatch>
  Begin IPD work round produce:round:2.
  Dispatch: quality_rework.
  Apply the formal review requirements in ipd_current_round, preserving work
  that remains valid, then submit a complete revised candidate via submit_artifact.
  Review references: [实际 sourceId].
  </node_round_dispatch>

assistant → edit
toolResult → 修改结果
assistant → 自检或提交，不是再次确认收到一份新 feedback。
```

恢复同一 round 时则更新 generation/Attempt，以 resume 派发要求检查保留进展、不要盲目重放副作用。若只是提交字段补正，不进入 round 2；反馈类型和派发为 submission_correction。

### 9.4 Reviewer：确切输入、评审 bundle 与协议补正

Reviewer 不继承生产者 Session：

```text
system
  Pi Base + <addendum>[common.md 全文]</addendum>
  <project_context>
    TASK_SCOPE.md / REVIEW_CONTRACT.md /
    PROFESSIONAL_ROLE.md / REVIEW_PROTOCOL.md
  </project_context>
  <skills>[若绑定检查 Skill，则列目录]</skills>
  <cwd>/workspace</cwd>
  <ipd_current_round>
    run_id/node_id/round_id/generation/attempt_id: 本次评审身份
    dispatch: review
    inputs: [{
      input_id: "candidate",
      submission_id: "produce:round:1:attempt:1:term:1:scope:1:submission",
      output_id: "brief",
      revision_id: 实际输出版本,
      purpose: "test_subject",
      approval_review_node_ids: [],
      release_ids: [],
      consumption: 生产者交接说明与 Manifest 文件导航（不是质量证明）,
      sealed_root: "/ipd/inputs/candidate",
      submission_record: "/ipd/inputs/candidate/submission.json"
    }]
    feedback: []
    findings: 当前分配的问题单
    review_bundle: 确切对象版本、标准对象集合、关系、决策政策
    preservable_outputs: []
    governance_contract: 工作流治理来源及相关阶段
  </ipd_current_round>
  toolsAdded: [获准检查工具], submit_review, submission_context,
              correct_submission, ipd_read_context

user
  <node_round_dispatch>
  Begin IPD work round review-produce:round:1.
  Dispatch: review.
  Review the exact input versions against the assigned criteria, then call submit_review.
  </node_round_dispatch>

assistant → read("/ipd/inputs/candidate/submission.json")
toolResult → 该输出范围内记录
assistant → 读取实际文件 / 获准的副本检查 / submission_context
toolResult → 实际证据或允许引用的确切标识符
assistant → submit_review
```

`candidate` 是示例显式 input ID；Authoring V2 自动生成的评审输入通常是 `reviewin-<hash>`，应复制真实状态中的路径。

如果误把标准证据绑定到未分配的输出，工具拒绝并返回诊断；模型在当前派发内读 correction base，修正字段，再走完整校验。若捕获之后 Runtime 的证据封存或 Finding 校验才失败，则新增一次同 round 的 submission_correction 派发。新版本复审时，历史保留，但 inputs/review_bundle 指向新版本；旧结论不是新版本的批准。

## 10. 外层 Pi、模板与不会自动注入的内容

外层 Pi 保留它自己的用户历史和配置，不是内部 Selector/Designer/员工。IPD 扩展注册 `ipd`、`ipd_get_run`、`ipd_read_events`、`ipd_get_result`、`ipd_cancel_run` 和外部操作核对工具；`/ipd` 是交互命令，不是某个节点内的递归工作流权限。

`ipd` 创建参数为必需 `request_id/task` 与可选 `skill_name/materials`。task 保留用户原文；materials 是用户提供的材料，不包含 Skill 文件或推断的新要求。外层入口生成 TaskInput V2，默认 `unresolved_facts: []`；其他可信程序入口可显式提供未决事实。

选择了流程规范模板时，可跳过 Selector；同时选择合法工作流模板时，可跳过 Designer。仍须经过绑定、校验和冻结，不是绕过治理直接执行任意 JSON。因此这类 Run 可能没有任何控制角色模型请求。

执行/评审默认不全量收到：

- 外层 Pi 或其他节点的 Session 历史；
- 完整 ProcessSpec、全部员工库或未绑定 Skill；
- 整个 Workflow/Baseline、调度状态或全量事件；
- 上游未授权输出或生产者仍可变的私有工作区；
- 完整 Manifest/证据正文（提供精确按需读取入口）；
- 未绑定知识库（当前非空知识库绑定直接被 Compiler 拒绝）。

这不意味着所有提示内容都是局部最小集合：完整原任务、全部未决事实和工作流 requirements/decisions 仍可能进入节点上下文，详见第 5、6 节。

## 11. 文件、标签和验证入口

### 文件与中文镜像

| 英文运行源 | 中文译文 |
|---|---|
| `prompts/common.md` 与四个角色协议 | `prompts/zh/` 同名文件 |
| `assets/skills/process-selection/` | `assets/zh/skills/process-selection/` |
| `assets/skills/workflow-design/` | `assets/zh/skills/workflow-design/` |

中文目录是完整结构的阅读镜像，包括 references；运行时 `loadPrompt()` 仍读取英文目录，不自动切换语言。仓库现有 `.gitignore` 忽略 `zh/`，所以本地译文不会自动出现在普通 Git 状态中；本轮没有改变该策略。

提示词读取会 trim 首尾空白。执行/评审协议及节点 common 在模块加载时缓存；Skill 包在接受/编译时锁定内容。编辑文件后，应重启 Pi 并创建使用新资产的 Run 来验证，不应期待已有 Session 或冻结 Run 自动更新。

### 标签清单

| 来源 | 实际标签/形式 |
|---|---|
| 通用、角色协议 | `core_rules`、`process_selection_protocol`、`workflow_design_protocol`、`execution_protocol`、`review_protocol` |
| 画像 | `professional_role`、`agent_selection_profile` |
| 任务/契约 | `task_scope`、`execution_contract`、`review_contract` |
| 派发 | `process_selection_assignment`、`workflow_design_assignment`、`workflow_design_revision`、`node_round_dispatch` |
| 轮次 | Pi 原生 section 包装的 `ipd_current_round` |
| 目录 | `process_spec_search_results`、`process_spec`、`agent_card_search_results` 及相应 lookup_error |
| 草稿 | `workflow_draft_result`、`workflow_draft_error` |
| 提交 | `submission_capture_result`、`submission_validation_result` |
| 原生结构 | `addendum`、`project_context/project_instructions`、`skills/available_skills`、`cwd`、显式展开的 `skill` |

并非每个工具结果都有 XML 标签：`submission_context`、补正错误、请求视图引用等使用 JSON 或普通文本。标签便于辨认，不是权限校验器，也不能把其中的数据自动升级成指令。

### 代码与测试索引

| 关注点 | 入口 |
|---|---|
| 静态 prompt 与画像 | [prompt-loader](../src/adapter/prompt-loader.ts)、[render-agent-profile](../src/adapter/render-agent-profile.ts) |
| 控制派发与 Session | [control-role-prompts](../src/control/control-role-prompts.ts)、[pi-control-roles](../src/control/pi-control-roles.ts) |
| 草稿字段和结果 | [workflow-draft-schema](../src/control/workflow-draft-schema.ts)、[workflow-draft-tools](../src/control/workflow-draft-tools.ts) |
| 工厂、资源、恢复 | [pi-node-session-factory](../src/adapter/pi-node-session-factory.ts)、[pi-node-worker](../src/adapter/pi-node-worker.ts) |
| 稳定与动态节点上下文 | [node-context](../src/adapter/node-context.ts)、[node-prompts](../src/runtime/node-prompts.ts) |
| 轮次与 Runtime 补正 | [workflow-runtime](../src/runtime/workflow-runtime.ts)、[node-session-adapter](../src/adapter/node-session-adapter.ts) |
| 提交预校验与局部补正 | [structured-submissions](../src/adapter/structured-submissions.ts)、[submission-context](../src/adapter/submission-context.ts)、[submission-correction-tool](../src/adapter/submission-correction-tool.ts) |
| 真实原生 Session 的无模型费测试 | [native-session-contract.test](../test/native-session-contract.test.ts)、[submission-correction-session.test](../test/submission-correction-session.test.ts) |
| 控制消息/节点投影测试 | [control-role-prompts.test](../test/control-role-prompts.test.ts)、[node-context.test](../test/node-context.test.ts) |
| 草稿协议测试 | [workflow-draft.test](../test/workflow-draft.test.ts) |

Session JSONL 包含原始消息、系统段/工具声明、原生 context edits/compaction；Run 状态还有部分请求容量观测。它们有助于还原，但不等于逐次保存了供应商序列化后的完整 HTTP 请求。历史请求分析应核对当时加载的代码/资产/配置，不能用当前 README 代替抓包证据。
