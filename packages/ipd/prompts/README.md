# IPD 提示词组装与上下文管理

本文说明当前实现中，外层 Pi、Process Selector、Workflow Designer、Execution Node 和 Review Node
分别会向模型提供什么上下文，以及首次工作、设计修订、提交补正、机械失败、质量返工和技术重试时
哪些内容会变化。

本文描述当前代码事实，不描述旧 V1。提示词正文以本目录文件为准，字段结构以 Tool Schema 和
Workflow Schema 为准。

## 1. Provider 最终收到什么

一次模型请求最终由三部分组成：

```text
{
  systemPrompt: string,
  messages: AgentMessage[],
  tools: ToolDefinition[]
}
```

- systemPrompt：Session 生命周期内稳定的规则、契约、角色画像、Skill 目录和 cwd。
- messages：持续 Session 历史、当前派发消息、工具调用/结果，以及节点专用的临时 round context。
- tools：当前角色真正可调用的工具名称、描述和参数 Schema。

工具参数不复制到角色 Prompt。模型如何调用工具，以 Provider 请求中的 ToolDefinition 为准。

## 2. Pi 的固定 systemPrompt 顺序

Pi 的 buildSystemPrompt 按以下顺序组装：

```text
Pi Base
→ appendSystemPrompt
→ contextFiles
→ Skill Catalog
→ Current Working Directory
```

来源见 [Pi system-prompt.ts](../../coding-agent/src/core/system-prompt.ts)。

IPD 的节点 Session 使用这个顺序形成：

```text
Pi Base
→ common.md
→ TASK_SCOPE.md
→ NODE_CONTRACT.md 或 REVIEW_CONTRACT.md
→ PROFESSIONAL_ROLE.md
→ EXECUTION_PROTOCOL.md 或 REVIEW_PROTOCOL.md
→ 指定的 Skill Catalog
→ Run workspace
```

其中 common.md 通过 appendSystemPrompt 加入；后面四个 Markdown 是 Runtime 生成或装配的虚拟
context files。它们按上述顺序包装在 project_context 中。

控制角色没有节点 Contract，其 systemPrompt 是：

```text
Pi Base
→ common.md
→ Control Role Runtime Profile
→ Process Selector 或 Workflow Designer Protocol
→ 该控制角色绑定的 Skill Catalog
→ Run workspace
```

## 3. 信息所有权

同一概念只应由一层负责，其他层引用它而不重新定义。

| 信息 | 权威来源 | 稳定性 |
|---|---|---|
| Pi 身份、工具摘要、通用规则 | Pi Base | Session 稳定 |
| IPD 控制权、信任和事实纪律 | [common.md](common.md) | Session 稳定 |
| 原始任务及本节点相关要求 | TASK_SCOPE.md | 节点稳定 |
| 节点目标、输入声明、输出、标准和权限 | NODE_CONTRACT.md / REVIEW_CONTRACT.md | 节点稳定 |
| 员工身份和专业方法 | Runtime Agent Profile | 节点稳定 |
| 角色怎样与 Runtime 协作 | 对应 Role Protocol | Session 稳定 |
| 当前 round、确切输入版本和反馈 | ipd_current_round | 每次派发更新 |
| 专业操作步骤 | Skill 正文和 references | 按需读取 |
| 参数、枚举和提交字段 | ToolDefinition / Schema | Tool 稳定 |
| 权限是否真的允许 | Compiler、文件 Scope Extension、Runtime | 代码强制 |

Task material、网页、上游产物、Tool Result 和 Artifact 内容属于数据或证据，不能改变上表中的角色、
权限、契约或标准。

## 4. 资源装配的共同规则

IPD 创建内部 Session 时禁用 Pi 对普通用户资源的自动发现：

- noExtensions=true
- noSkills=true
- noPromptTemplates=true
- noThemes=true
- noContextFiles=true

只有 ExecutionBaseline 或控制面明确绑定的资源会重新加入：

- AgentCard 选择实际模型和 thinking level；
- lockedSkills 作为 additionalSkillPaths；
- lockedTools 加入启用工具列表；
- Runtime 控制工具额外加入当前 Session；
- 节点虚拟 context files 通过 agentsFilesOverride 注入。

每个 Skill 在 Session 创建前重新计算完整包 Hash；内容改变时拒绝创建。Skill Catalog 只有在 Session
具有 read 或 bash 时才会进入 Pi systemPrompt。Compiler 同时要求绑定 Skill 的节点至少具有其中一种
读取能力。

Skill Catalog 只列出名称、描述和文件位置，不自动注入正文。控制角色消息以 /skill:name 开头时，
Pi 会在发送 Provider 之前把它展开为 skill XML：去掉 frontmatter 后的完整 SKILL.md 正文、Skill 文件
位置、references 相对目录，再接原命令后的任务参数。Provider 正常情况下看不到字面量 /skill:name。
references 不会自动全文加载，角色根据 SKILL.md 的路由使用 read 按需读取。

## 5. 外层 Pi 与 IPD Tool

外层 Pi 不是 IPD 内部员工。它保留普通 Pi 的项目上下文、用户对话和 Skills。加载
examples/ipd-extension.ts 后，Provider 的 tools 中增加：

- ipd：创建 Run；
- ipd_get_run：读取状态；
- ipd_read_events：按游标读取事件；
- ipd_get_result：读取终态结果。

Extension 通过 Tool promptSnippet 和 promptGuidelines 告诉外层模型何时创建 Run、必须保留用户要求，
但不会把内部 ProcessSpec、Workflow、AgentCard 或节点 Session 历史回灌给外层模型。

典型外层上下文：

```text
systemPrompt
  Pi Base（其中已包含 IPD Tool snippet 和 guidelines）
  当前项目 Context / Skills
  cwd

messages
  用户与外层 Pi 的正常对话
  ipd 调用及 Run receipt
  后续只读状态/事件/结果查询

tools
  外层 Pi 原有工具
  ipd / ipd_get_run / ipd_read_events / ipd_get_result
```

ipd 返回 accepted receipt 后，内部主控在后台继续。外层对话结束或查询中断不会成为 Run 完成条件。

## 6. Process Selector

### 6.1 稳定 systemPrompt

```text
Pi Base
common.md
Process Selector 的 Runtime Agent Profile
process-selector.md
process-selection Skill Catalog
cwd
```

Runtime Profile 只包含员工名称、描述、职责、非职责、专业原则和工作方法。AgentCard 的适用场景、
通用交付模板和验证参考不默认注入运行画像。

### 6.2 首次且唯一的选型消息

[buildProcessSelectionPrompt](../src/control/control-role-prompts.ts) 向 Pi 提交：

```text
/skill:process-selection Load the process-selection method...

TaskInput:
<canonical TaskInput JSON>
```

process-selection Skill 已锁定到这个 Session。模型先按需读取 Skill 及 references，再调用资产目录工具。
Pi 在 Provider 请求前将上述消息展开为：

```text
<skill name="process-selection" location="<...>/process-selection/SKILL.md">
References are relative to <...>/process-selection.

<去掉 frontmatter 的完整 SKILL.md 正文>
</skill>

Load the process-selection method...

TaskInput:
<canonical TaskInput JSON>
```

### 6.3 消息和工具完整形态

```text
messages
  user: 展开的 process-selection Skill body + TaskInput
  assistant: 可选的 search_process_specs 调用
  tool: compact ProcessSpec candidates
  assistant: 可选的 get_process_spec 调用
  tool: 某个确定版本的完整 ProcessSpec
  assistant: submit_process_selection
  tool: candidate captured，结束当前响应

tools
  read
  search_process_specs
  get_process_spec
  submit_process_selection
```

search_process_specs 只返回候选摘要；get_process_spec 才返回完整规范。查询星号可列出紧凑目录。

### 6.4 selected 与 blocked

两种场景使用同一份 systemPrompt、TaskInput 和资产工具，只改变最终提交：

- selected：提交确定的 ProcessSpec ID/version、rationale 和合法引用；
- blocked：提交 reason 和相关 unresolved_fact_refs，不伪造规范。

结构校验失败时，submit_process_selection 返回诊断，同一 Session 在当前选择轮次中补正。合法 blocked
由主控记录为 preparation_blocked，不启动 Designer。

Process Selector 不使用节点 TASK_SCOPE、Contract 或 ipd_current_round。

## 7. Workflow Designer

### 7.1 稳定 systemPrompt

```text
Pi Base
common.md
Project Shepherd 的 Runtime Agent Profile
workflow-designer.md
workflow-design Skill Catalog
本 Run 指定的 Run Skill Catalog
cwd
```

Designer 的 tools：

```text
read
workflow_draft_open
workflow_draft_read
workflow_draft_apply
workflow_draft_validate
workflow_draft_submit
search_agent_cards
get_agent_card
```

工作流草稿工具由控制面私有注入，不进入业务节点。

### 7.2 方法准备轮次

Session 首次创建后先收到：

```text
/skill:workflow-design Load the workflow design method. Do not submit a Workflow yet.
```

Pi 会把它展开成完整 workflow-design SKILL.md body 加后续指令。该轮只加载设计方法；Skill 引用的
references 仍按需读取。它与正式设计轮分开，展开后的消息和读取历史保留在同一个 Designer Session
中。

### 7.3 首次设计轮次

首次 design 消息包含所有稳定设计依据：

```text
/skill:<run-skill> Load the task-specific method, then design this Workflow.

TaskInput:
<完整 TaskInput>

ProcessSelection:
<冻结的 ProcessSelection>

ProcessSpec:
<选定的完整 ProcessSpec>

Available non-employee resources:
  Skills 摘要及关联工具
  Tool IDs
  unavailable AgentCards
  Mechanical Check IDs 和参数 Schema

Search and inspect AgentCards before binding employees.

Compiler diagnostics:
None 或首次已有诊断
```

AgentCard 不全量注入。Designer 先用 search_agent_cards 取得紧凑候选，再用 get_agent_card 读取少量
Selection Profile。Selection Profile 包含场景、职责、能力、方法、通用交付、验证参考、默认 Skills、
允许 Tools 和权限上限。

消息开头的 /skill:<run-skill> 同样在 Provider 请求前展开为该 Run Skill 的完整 SKILL.md body，再接
TaskInput、ProcessSelection、ProcessSpec 和资源摘要。

### 7.4 草稿编辑过程

```text
messages
  方法准备历史
  首次设计消息
  search_agent_cards / get_agent_card 历史
  workflow_draft_open/read
  多次 workflow_draft_apply 及 revision 回执
  workflow_draft_validate 及 diagnostics
  workflow_draft_submit
```

草稿内容由 WorkflowDraftManager 持久化。模型看到的是 Tool Result，不依赖自己在聊天中记住完整 JSON。

### 7.5 Compiler 修订轮次

正式 Compiler 拒绝候选或 Workflow 版本冲突时，原 Designer Session 收到：

```text
Draft revision: <current revision>

Compiler diagnostics:
<new diagnostics only>

Revise the existing draft and submit the corrected revision.
```

不会重复发送 TaskInput、ProcessSelection、ProcessSpec、Run Skill 或资源目录；这些已经存在于同一
Session 历史中。Designer 通过 workflow_draft_read 恢复权威草稿，再局部修改。

Designer 不使用节点 TASK_SCOPE、Contract 或 ipd_current_round。

## 8. Execution Node

### 8.1 稳定 systemPrompt

Execution Session 首次创建时形成以下固定内容：

```text
Pi Base
common.md
project_context
  TASK_SCOPE.md
  NODE_CONTRACT.md
  PROFESSIONAL_ROLE.md
  EXECUTION_PROTOCOL.md
绑定 Skill Catalog
Run workspace cwd
```

四个 context files 的顺序由
[renderNodeContextFiles](../src/adapter/node-context.ts) 固定。

### 8.2 TASK_SCOPE.md

TASK_SCOPE 回答“为什么做”，包含：

- 原始任务及来源；
- TaskInput 的全部 objectives；
- requirement_coverage 指定给当前节点的 task requirements；
- 当前节点显式绑定的 task materials：描述、reference、media type；
- TaskInput 的全部 unresolved facts。

Task material 不会重复进入 ipd_current_round。绝对文件引用会额外成为只读根；相对引用仍按节点
workspace 与权限解析。

### 8.3 NODE_CONTRACT.md

NODE_CONTRACT 回答“本节点必须做什么”，包含：

- node ID 和 execution 类型；
- objective、responsibilities、out of scope；
- work requirements 和 constraints；
- 静态输入声明及 required/availability/required approvals；
- declared outputs、artifact type、purpose、output root；
- 输出证据要求和 criterion refs；
- 每项 mechanical/semantic criterion 的描述与证据要求；
- 当前参与者 read/write/external action 权限声明。

原始 Workflow JSON 留在 Baseline；模型读取的是确定性 Markdown 投影。

### 8.4 PROFESSIONAL_ROLE.md

仅包含 Runtime Profile：

- Role name 和 description；
- Responsibilities；
- Boundaries；
- Professional Principles；
- Working Method。

不包含 applicable scenarios、通用 deliverables、verification references、资产 Hash 或来源路径，避免它们
与节点输出和冻结标准竞争。

### 8.5 EXECUTION_PROTOCOL.md

正文来自 [execution-node.md](execution-node.md)，只说明如何消费确切输入、在授权目录工作、自检、提交
和处理反馈，不重新定义节点目标、输出或标准。

### 8.6 当前 round 消息

每次派发持久写入一条极简 user message：

```text
Begin IPD work round <round_id>.
```

在每一次 Provider 请求前，隐藏的 context extension 另将以下消息临时追加到 messages 末尾：

```json
<ipd_current_round source="runtime">
{
  "round_id": "research:round:2",
  "inputs": [
    {
      "input_id": "approved-plan",
      "submission_id": "planning:round:1:submission",
      "output_id": "research-plan",
      "approval_review_node_ids": ["review-plan"],
      "sealed_root": ".../submissions/planning:round:1:submission",
      "submission_record": ".../submissions/planning:round:1:submission/submission.json"
    }
  ],
  "feedback": []
}
</ipd_current_round>
```

inputs 只包含本轮实际绑定的上游 node outputs，并只投影被声明消费的 output。完整 Manifest 和 Submission
evidence 不内联；模型需要时读取 submission_record。该文件位于获准的 sealed read root。

ipd_current_round 不写入 Session 历史。每次模型请求，包括同一次 prompt 内的 Tool 循环，都会在当前
请求副本末尾重新出现。下一轮派发时 Runtime 替换其内容。

### 8.7 Execution 首次执行

```text
systemPrompt
  稳定 Execution systemPrompt

messages
  user: Begin IPD work round node-a:round:1.
  user transient: ipd_current_round，包含当前输入且 feedback=[]
  后续 assistant/tool 消息

tools
  Baseline 锁定的节点业务工具
  submit_artifact
```

submit_artifact 成功只表示候选参数被捕获，并终止当前响应；不会销毁 Session，也不表示机械检查或
独立评审通过。

### 8.8 提交协议补正

以下情况在同一 Session、同一个 round_id 内补正：

- 未调用 submit_artifact；
- 缺少声明输出；
- 文件越过 output root；
- Artifact 路径、类型或内容不符合接收契约。

Runtime 再次派发同一个 Begin round 消息，并把动态反馈更新为：

```json
{
  "feedback": [
    {
      "type": "submission_correction",
      "issue": "Execution node did not call submit_artifact",
      "expected_correction": "Submit a candidate that satisfies the declared submission contract."
    }
  ]
}
```

原 Session 历史仍包含前一次响应。当前实现最多进行 10 次结构化补正；这不是质量返工次数。

### 8.9 Mechanical failure

提交封存成功但机械检查 FAIL 时，当前提交记为 rejected，执行节点进入 waiting_rework。Runtime 创建
新的 execution round，同一 Session 收到：

```json
{
  "round_id": "node-a:round:2",
  "feedback": [
    {
      "type": "mechanical_failure",
      "source_id": "node-a:round:1:submission",
      "criterion_id": "integrity",
      "output_id": "report",
      "issue": "Artifact integrity validation failed",
      "evidence_ref": "mechanical:node-a:round:1:report:integrity",
      "expected_correction": "Correct the output and rerun the required mechanical check."
    }
  ]
}
```

机械检查 ERROR 属于运行故障并阻塞节点，不伪装为质量返工。

### 8.10 Semantic quality rework

Review 返回 REWORK 后，Runtime 失效受影响提交和实际消费它的下游结果。责任 execution 节点在新 round
中复用原 Session：

```json
{
  "round_id": "node-a:round:2",
  "inputs": [<当前仍有效的确切输入版本>],
  "feedback": [
    {
      "type": "quality_rework",
      "source_id": "review-a:round:1:review",
      "criterion_id": "source-quality",
      "issue": "第三节结论没有当前来源支持。",
      "evidence_ref": "review:review-a:round:1:review:source-quality",
      "expected_correction": "补充来源并重新核对结论。"
    }
  ]
}
```

Contract、角色、Skill 和标准不变。若上游版本同时变化，inputs 指向新批准版本。

### 8.11 Technical retry

RetryingNodeWorker 只对明确标记为 transient 的 NodeWorkerError 重试，默认最多三次。仍使用同一
Session 和 round，并追加：

```json
{
  "feedback": [
    {
      "type": "technical_retry",
      "issue": "<原始瞬时故障>"
    }
  ]
}
```

external_outcome_unknown、session_lost 和 configuration 不自动重试。

## 9. Review Node

### 9.1 稳定 systemPrompt

```text
Pi Base
common.md
project_context
  TASK_SCOPE.md
  REVIEW_CONTRACT.md
  PROFESSIONAL_ROLE.md
  REVIEW_PROTOCOL.md
绑定 Skill Catalog
Run workspace cwd
```

Review 使用与 Execution 相同的 Task Scope 和 Runtime Profile 机制，但 Contract 与 Protocol 不同。

### 9.2 REVIEW_CONTRACT.md

包含：

- review node ID 和 objective；
- responsibilities 与 out of scope；
- 确切 target node/output 及其 semantic criteria；
- allowed rework execution nodes；
- review requirements 和 constraints；
- 当前评审标准描述与证据要求；
- 只读权限声明。

Review 节点不能获得 write、edit、bash 或 powershell；实际文件读取仍经过路径 Scope Extension。

### 9.3 首次评审

```text
messages
  同一 Reviewer Session 的已有历史
  user: Begin IPD work round review-a:round:1.
  user transient: ipd_current_round
    inputs 指向确切 candidate Submission 和被评 output
    feedback=[]

tools
  Baseline 锁定的只读检查工具
  submit_review
```

Reviewer 从 sealed_root 或 submission_record 读取真实文件、Manifest 和 evidence，不读取生产节点的可变
workspace 版本。

### 9.4 Review submission correction

以下问题在同一 review round、同一 Session 中补正：

- 未调用 submit_review；
- 没有恰好覆盖每个 assigned criterion；
- 总 decision 与逐项结果矛盾；
- PASS/REWORK/BLOCKED 与 rework targets 不一致；
- criterion 缺证据或 evidence 指向无关 output；
- FAIL 没有具体 required_rework。

动态反馈示例：

```json
{
  "feedback": [
    {
      "type": "submission_correction",
      "issue": "Review report does not cover each assigned criterion exactly once",
      "expected_correction": "Submit a review report that satisfies the review submission contract."
    }
  ]
}
```

最多 10 次协议补正，不产生新的质量评审轮次。

### 9.5 PASS

submit_review 的每项 criterion 都为 PASS 且有证据时，Runtime 为确切
review + submission + output + criterion IDs 登记 Approval。只有指定 Gate 集合覆盖输出全部 semantic
criteria，成果才构成完整批准。

Reviewer 的 Session 不负责修改下游状态；Runtime 重新计算 ready set。

### 9.6 REWORK 与复审

REWORK 完成当前 review round，并只失效 rework_node_ids 指向的责任子图。生产节点修订并形成新
Submission 后，原 Reviewer Session 进入新的 review round：

```json
{
  "round_id": "review-a:round:2",
  "inputs": [
    {
      "submission_id": "node-a:round:2:submission",
      "output_id": "report",
      "sealed_root": ".../node-a:round:2:submission"
    }
  ],
  "feedback": []
}
```

旧评审意见保留在 Session 历史和 Run 记录中，但新 PASS 必须针对新 Submission。

### 9.7 BLOCKED

存在无法取得的访问、材料或验证条件时，Review 提交 BLOCKED，并提供 unresolved_issues。Runtime 将
review node 标记 blocked；无关分支仍可继续，最终没有 ready work 时 Run 转为 blocked。

当前没有自动创建替代 Reviewer 或降低标准的逻辑。

## 10. Session 历史与 round 的关系

| 事件 | Session | round_id | 稳定 context files | ipd_current_round |
|---|---|---|---|---|
| 首次节点工作 | 新建 | 新建 | 创建并固定 | 当前输入，无反馈 |
| 提交/报告补正 | 复用 | 不变 | 不变 | 追加 submission_correction |
| 技术重试 | 复用 | 不变 | 不变 | 追加 technical_retry |
| Mechanical FAIL | 复用 | 新 round | 不变 | mechanical_failure |
| Review REWORK 后执行返工 | 复用 | 新 round | 不变 | quality_rework |
| 新 Submission 复审 | 复用 Reviewer | 新 round | 不变 | 新 Submission inputs |
| 输入失效中止 | 复用但先 abort 当前活动 | 旧 round 失效 | 不变 | 新 round 就绪后替换 |
| Run 成功 | release | 无 | 释放 | 无后续请求 |
| Session lost | 不新建冒充恢复 | 当前工作失败 | 已有记录保留 | 无合法续跑 |

NodeSessionAdapter 以 runId + nodeId + participantId 维护唯一绑定，同一 Session 同时只能执行一个 round。
stop 只中止当前活动，release 才销毁 Session。

## 11. 图片和长上下文

Session 历史由 Pi 原生管理，IPD 不另建消息压缩系统。

Pi 发生历史压缩时，稳定 Task Scope、Contract、Runtime Profile、Role Protocol 和 Skill Catalog 仍由
systemPrompt 提供；当前 round facts 又会在下一次 Provider 请求前重新追加。正式输入、Manifest 和
Evidence 保存在 sealed Submission 中，可通过引用重新读取，不依赖压缩摘要成为唯一事实源。

为避免多页图片在同一 Session 中不断累积请求体：

- 已被后续成功 assistant response 消费的旧 toolResult 图片，在新的 Provider 请求副本中替换为文本占位；
- 最新待分析图片继续保留；
- stopReason=error 或 aborted 不算成功消费；
- 原 Session messages 和磁盘记录不被改写。

该处理只减少 Provider 请求副本中的历史图片，不删除正式 Artifact、Submission 或审计证据。

## 12. 当前不会进入模型的内容

默认不直接注入：

- 全部 AgentCard 库；
- 全部 ProcessSpec 库；
- 未绑定 Skills、Tools、Knowledge Bases 或用户 Extensions；
- Workflow 原始完整 JSON；
- ExecutionBaseline Hash 和资产来源路径；
- 其他节点 Session 历史；
- 完整 Submission Manifest 和 evidence；
- Runtime 内部状态表和事件全集；
- 外层 Pi 的完整对话历史。

需要的资产通过目录工具读取，需要的提交细节通过 submission_record 读取。Runtime 状态和权限由代码
实施，不要求模型维护另一份状态。

## 13. 当前边界

- Process Selector 和 Workflow Designer 没有 ipd_current_round；它们使用自己的持续 Session 与控制消息。
- Execution 没有独立的结构化 business-blocked 工具。未提交 Artifact 会先进入 submission_correction；
  无法继续且不能形成合法提交时，当前轮次最终会因补正耗尽或运行故障而阻塞。
- 当前进程退出后不能恢复原存活 AgentSession；磁盘状态不等于 Session 连续性。
- Bash 的系统级隔离需要外部沙箱；Review 已禁止通用 Shell，Execution 仍只能在受信任环境使用 Bash。
- 生产环境没有永久保存完整 Provider Prompt 的 PromptTrace；测试通过 faux Provider 检查最终
  systemPrompt、messages 和 tools。

## 14. 代码索引

| 内容 | 实现 |
|---|---|
| Pi systemPrompt 固定顺序 | [system-prompt.ts](../../coding-agent/src/core/system-prompt.ts) |
| 节点四个稳定 context files | [node-context.ts](../src/adapter/node-context.ts) |
| 动态 ipd_current_round | [node-context.ts](../src/adapter/node-context.ts) |
| 节点最小派发消息 | [node-prompts.ts](../src/runtime/node-prompts.ts) |
| AgentCard 两种投影 | [render-agent-profile.ts](../src/adapter/render-agent-profile.ts) |
| Session 资源和工具装配 | [pi-node-session-factory.ts](../src/adapter/pi-node-session-factory.ts) |
| 节点 Session 复用 | [node-session-adapter.ts](../src/adapter/node-session-adapter.ts) |
| Selector/Designer 组装 | [pi-control-roles.ts](../src/control/pi-control-roles.ts) |
| 控制角色各轮消息 | [control-role-prompts.ts](../src/control/control-role-prompts.ts) |
| 资产按需查询 | [asset-catalog-tools.ts](../src/control/asset-catalog-tools.ts) |
| 提交/评审工具 Schema | [structured-submissions.ts](../src/adapter/structured-submissions.ts) |
| 补正、评审和返工调度 | [workflow-runtime.ts](../src/runtime/workflow-runtime.ts) |
| 结构化反馈生成 | [runtime-state.ts](../src/runtime/runtime-state.ts) |
