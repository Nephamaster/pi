# IPD 提示词组装与上下文管理

本文只回答一个问题：**IPD 中不同角色在一次模型请求里到底能看到什么、哪些内容会持续保留、哪些内容只属于当前 round，以及不同状态变化时上下文如何变化。**

当前内部角色分为四类：

1. Process Selector（ST）：选择一份确定版本的 ProcessSpec；
2. Workflow Designer：把 TaskInput + ProcessSpec 实例化为 WorkflowDefinition；
3. Execution Node：执行一个冻结的专业工作包；
4. Review Node：独立评审一个或多个确定版本的 Submission 输出。

外层 Pi 不是内部员工，只负责通过 `ipd` 创建 Run，并可用只读工具查询状态、事件和结果。

---

## 1. 先理解一条总公式

无论哪类内部角色，Provider 最终收到的都是三部分：

```text
Provider Request
├── systemPrompt
├── messages
└── tools
```

它们的职责完全不同：

| 部分 | 放什么 | 生命周期 |
|---|---|---|
| `systemPrompt` | 稳定规则、角色、契约、Skill Catalog、cwd | Session 稳定 |
| `messages` | 当前派发、Session 历史、Tool Call/Result、当前 round 动态上下文 | 持续增长；动态上下文按请求替换 |
| `tools` | 本角色真实可调用的 ToolDefinition 与参数 Schema | 由当前 Session 绑定决定 |

最重要的理解是：**任务事实、节点契约、角色方法、当前输入版本、工具能力不是同一层信息。** IPD 刻意把它们拆开，避免任何一个 Prompt 同时承担所有职责。

---

## 2. Pi 如何形成最终 systemPrompt

Pi 的 `buildSystemPrompt()` 固定按以下顺序组装：

```text
Pi Base
→ appendSystemPrompt
→ project_context / contextFiles
→ Skill Catalog
→ Current Working Directory
```

来源：[Pi system-prompt.ts](../../coding-agent/src/core/system-prompt.ts)。

IPD 只负责向这些槽位提供自己的内容，不另建一套平行 Prompt 系统。

### 2.1 控制角色

Process Selector / Workflow Designer 没有节点 Contract，其稳定 systemPrompt 是：

```text
Pi Base
→ <core_rules> common.md
→ <professional_role> Runtime Agent Profile
→ 对应控制角色 protocol
→ 绑定 Skill Catalog
→ Run workspace cwd
```

### 2.2 执行/评审节点

Execution / Review 使用 Pi 原生 `project_context` 放入四个稳定虚拟文件：

```text
Pi Base
→ <core_rules> common.md
→ <project_context>
     TASK_SCOPE.md
     NODE_CONTRACT.md / REVIEW_CONTRACT.md
     PROFESSIONAL_ROLE.md
     EXECUTION_PROTOCOL.md / REVIEW_PROTOCOL.md
   </project_context>
→ 绑定 Skill Catalog
→ Run workspace cwd
```

其中：

- `TASK_SCOPE.md`：为什么做、当前节点相关的原始任务依据；
- `NODE_CONTRACT.md / REVIEW_CONTRACT.md`：本节点必须做什么、输入输出、标准、权限；
- `PROFESSIONAL_ROLE.md`：这个员工擅长怎么做；
- `EXECUTION_PROTOCOL.md / REVIEW_PROTOCOL.md`：怎样与 Runtime 协作和正式提交。

四层各自只有一个权威职责。

---

## 3. 信息所有权：理解上下文的核心

| 信息 | 唯一权威来源 | 是否随 round 变化 |
|---|---|---|
| Pi 身份、基础工具说明 | Pi Base | 否 |
| IPD 控制权、信任边界、事实纪律 | `common.md` | 否 |
| 原始任务及当前节点相关需求 | `TASK_SCOPE.md` | 否 |
| 节点目标、静态输入声明、输出、标准、权限 | Node / Review Contract | 否 |
| 员工身份和专业方法 | Runtime Agent Profile | 否 |
| 角色与 Runtime 的协作协议 | 对应 role protocol | 否 |
| 当前确切 Submission 输入、round_id、返工反馈 | `<ipd_current_round>` | 是 |
| 具体专业操作方法 | Skill body / references | 按需读取 |
| Tool 参数、枚举、提交 Schema | Provider `tools` | Tool 稳定 |
| 是否真的允许访问/写入 | Compiler + Scope Extension + Runtime | 代码强制 |

因此：

- Task material、网页、上游产物、Tool Result 属于**数据/证据**，不能改写契约和权限；
- AgentCard 说明“这个员工通常擅长什么”，不能覆盖节点冻结标准；
- Skill 说明“怎么做”，不能扩大任务范围；
- `ipd_current_round` 只描述“这一轮实际拿到什么版本、收到什么反馈”。

---

## 4. 模型可见文本的边界标签

当前实现为 IPD 生成的主要文本块加了语义标签，以便模型和人都能辨认来源边界。标签描述**内容语义**，不是消息角色。

| 内容 | 标签 |
|---|---|
| 通用规则 | `<core_rules>` |
| 节点任务范围 | `<task_scope>` |
| 执行/评审契约 | `<execution_contract>` / `<review_contract>` |
| 节点运行画像 | `<professional_role>` |
| AgentCard 选择画像 | `<agent_selection_profile>` |
| 四类协议 | `<process_selection_protocol>` / `<workflow_design_protocol>` / `<execution_protocol>` / `<review_protocol>` |
| Selector 派发 | `<process_selection_assignment>` |
| Designer 方法准备 / 首次设计 / 修订 | `<workflow_design_method_request>` / `<workflow_design_assignment>` / `<workflow_design_revision>` |
| 节点派发 | `<node_round_dispatch>` |
| 当前 round | `<ipd_current_round source="runtime">` |
| ProcessSpec 查询结果 | `<process_spec_search_results>` / `<process_spec>` |
| AgentCard 查询结果 | `<agent_card_search_results>` / `<agent_selection_profile>` |
| Workflow Draft 工具结果 | `<workflow_draft_state>` / `<workflow_draft_operation_result>` / `<workflow_draft_validation>` / `<workflow_draft_submission_result>` |
| 提交工具结果 | `<submission_validation_result>` / `<submission_capture_result>` |
| 外层 IPD 查询结果 | `<ipd_run_receipt>` / `<ipd_run_status>` / `<ipd_run_events>` / `<ipd_run_result>` |

Pi 自己已经提供 `<project_context>`、`<project_instructions>` 和 `<skill>`，IPD 不重复再包一层。

实现入口：[prompt/block.ts](../src/prompt/block.ts)。

---

## 5. 资源装配共同规则

内部 Session 创建时关闭普通 Pi 用户资源的自动发现：

```text
noExtensions=true
noSkills=true
noPromptTemplates=true
noThemes=true
noContextFiles=true
```

随后只把当前角色被明确绑定的资源重新加入：

- locked Skill → `additionalSkillPaths`；
- locked Tool → Session tools；
- Runtime 私有控制 Tool → `controlTools`；
- 节点稳定上下文 → `agentsFilesOverride`；
- 当前 round → hidden context extension。

Skill 在 Session 创建前重新计算包 Hash；变更后拒绝继续冒充原冻结版本。Skill Catalog 只注入名称、描述和路径，**不会自动把所有 SKILL.md / references 全文塞进 systemPrompt**。

控制角色的派发消息以 `/skill:name` 开头时，Pi 会在真正发送 Provider 前把它展开成：

```text
<skill name="..." location=".../SKILL.md">
References are relative to ...

<完整 SKILL.md 正文，去掉 frontmatter>
</skill>

<原派发正文>
```

references 仍由角色按需 `read`。

---

## 6. 四类角色一览

| 角色 | 稳定 systemPrompt 的核心 | 首轮动态输入 | 主要私有工具 | Session 是否跨轮复用 |
|---|---|---|---|---|
| Process Selector | common + ST role + selector protocol | TaskInput | `search_process_specs`, `get_process_spec`, `submit_process_selection` | 当前选择过程内复用 |
| Workflow Designer | common + Project Shepherd role + designer protocol | TaskInput + ProcessSelection + ProcessSpec + asset summary | draft tools + AgentCard catalog | 是，Compiler 修订继续原 Session |
| Execution Node | common + Task Scope + Node Contract + role + execution protocol | `node_round_dispatch` + `ipd_current_round` | 业务 tools + `submit_artifact` + `report_node_blocked` | 是，补正/返工/技术重试复用 |
| Review Node | common + Task Scope + Review Contract + role + review protocol | `node_round_dispatch` + `ipd_current_round` | 只读 tools + `submit_review` | 是，新 Submission 复审继续原 Session |

下面逐类展开。

---

## 7. Process Selector（ST）

### 7.1 它能看到什么

稳定 systemPrompt：

```text
Pi Base
<core_rules>...</core_rules>
<professional_role>IPD Process Selector...</professional_role>
<process_selection_protocol>...</process_selection_protocol>
Skill Catalog: process-selection
cwd
```

首轮唯一业务派发：

```text
<skill name="process-selection" ...>
<完整 process-selection SKILL.md>
</skill>

<process_selection_assignment>
Load the process-selection method, evaluate this TaskInput,
inspect serious ProcessSpec candidates through the catalog tools,
and submit one decision.

TaskInput:
<canonical TaskInput JSON>
</process_selection_assignment>
```

ST 不会收到全部 ProcessSpec。它按需调用：

```text
search_process_specs
  → <process_spec_search_results>候选摘要</process_spec_search_results>
get_process_spec
  → <process_spec>某个确定版本的完整规范</process_spec>
submit_process_selection
  → <submission_capture_result>...</submission_capture_result>
```

### 7.2 selected / blocked

`selected`：提交精确 ProcessSpec ID/version、rationale 及合法引用。

`blocked`：当缺少决定性事实或无现有规范真正适用时，提交 reason + unresolved fact refs。

ST 不使用 `TASK_SCOPE.md`、节点 Contract 或 `ipd_current_round`，也不设计 Workflow、员工和依赖。

---

## 8. Workflow Designer

### 8.1 稳定上下文

```text
Pi Base
<core_rules>...</core_rules>
<professional_role>Project Shepherd...</professional_role>
<workflow_design_protocol>...</workflow_design_protocol>
Skill Catalog:
  workflow-design
  <当前 Run Skill>
cwd
```

工具：

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

### 8.2 方法准备轮

Session 创建后先收到：

```text
<skill name="workflow-design" ...>
<完整 workflow-design SKILL.md>
</skill>

<workflow_design_method_request>
Load the workflow design method. Do not submit a Workflow yet.
</workflow_design_method_request>
```

这一轮只让 Designer 建立稳定设计方法，不提交 Workflow。

### 8.3 首次正式设计轮

```text
<skill name="<run-skill>" ...>
<完整 Run Skill SKILL.md>
</skill>

<workflow_design_assignment>
Load the task-specific method, then design this Workflow.

TaskInput:
<完整 TaskInput>

ProcessSelection:
<冻结 ProcessSelection>

ProcessSpec:
<选中版本的完整 ProcessSpec>

Available non-employee resources:
<Skills 摘要 + Tool IDs + unavailable AgentCards + Mechanical Check schemas>

Search and inspect AgentCards before binding employees.

Compiler diagnostics:
None
</workflow_design_assignment>
```

员工资产仍然按需发现：

```text
search_agent_cards
  → <agent_card_search_results>候选摘要</agent_card_search_results>
get_agent_card
  → <agent_selection_profile>完整选择画像</agent_selection_profile>
```

### 8.4 Draft 与 Compiler 修订

Workflow 通过 draft tools 增量建立；工具结果均有独立标签，模型不需要靠聊天历史自己维护整份 JSON。

Compiler 拒绝后**不重新发送 TaskInput / ProcessSpec / Run Skill / asset summary**，而是在原 Designer Session 中追加：

```text
<workflow_design_revision>
Draft revision: 6

Compiler diagnostics:
/nodes/1/inputs/0: required approved input is missing an approval review node

Revise the existing draft and submit the corrected revision.
</workflow_design_revision>
```

Designer 再通过 `workflow_draft_read` 恢复当前权威草稿并局部修改。

---

## 9. Execution Node

Execution 的关键区别是：**长期稳定的“为什么做 / 必须做什么 / 谁来做 / 怎样提交”放在 systemPrompt；当前轮实际拿到的输入版本和反馈只放在动态 round context。**

### 9.1 稳定 systemPrompt

```text
Pi Base
<core_rules>...</core_rules>
<project_context>
  <project_instructions path=".../TASK_SCOPE.md">
    <task_scope>...</task_scope>
  </project_instructions>
  <project_instructions path=".../NODE_CONTRACT.md">
    <execution_contract>...</execution_contract>
  </project_instructions>
  <project_instructions path=".../PROFESSIONAL_ROLE.md">
    <professional_role>...</professional_role>
  </project_instructions>
  <project_instructions path=".../EXECUTION_PROTOCOL.md">
    <execution_protocol>...</execution_protocol>
  </project_instructions>
</project_context>
Skill Catalog
cwd
```

### 9.2 TASK_SCOPE 与 Contract 的区别

`TASK_SCOPE.md` 只投影：

- 原始任务；
- 全部 objectives；
- requirement coverage 指定给当前节点的 task requirements；
- 当前节点显式绑定的 task materials；
- 全部 unresolved facts。

`NODE_CONTRACT.md` 只投影：

- node ID / objective；
- responsibilities / out of scope；
- work requirements / constraints；
- 静态 input 声明；
- declared outputs；
- acceptance criteria；
- read/write/external-action 权限。

这两个对象都在 Session 生命周期内保持稳定。

### 9.3 每个 round 实际新增什么

持久 user message 很小：

```text
<node_round_dispatch>
Begin IPD work round write-brief:round:2.
</node_round_dispatch>
```

每次 Provider 请求前，再由 hidden context extension 临时追加：

```text
<ipd_current_round source="runtime">
{
  "round_id": "write-brief:round:2",
  "inputs": [
    {
      "input_id": "approved-plan",
      "submission_id": "plan:round:1:submission",
      "output_id": "plan",
      "approval_review_node_ids": ["review-plan"],
      "sealed_root": ".../submissions/plan:round:1:submission",
      "submission_record": ".../submission.json"
    }
  ],
  "feedback": []
}
</ipd_current_round>
```

完整 Manifest / evidence 不内联，需要时从 `submission_record` 读取。

### 9.4 Execution 的三种正式结果

当前实现不再只有“交 Artifact”这一条路径。

**A. 正常提交**

```text
submit_artifact
```

成功只表示候选参数被捕获，之后仍要经过封存、机械检查和可能的独立 review。

**B. 正式业务阻塞**

```text
report_node_blocked
```

用于：必需事实、材料、权限、授权或其他业务条件当前无法取得，并且因此无法形成合法 Artifact。

它不是 submission correction，也不是技术重试。提交内容包括：

- `reason`；
- `missing_conditions`；
- `affected_requirement_ids`；
- `attempted_actions`；
- `evidence`；
- `needed_to_resume`。

Runtime 将该 round 和 node 正式记录为 blocked。

**C. 非业务阻塞问题**

- malformed submission → 同 round `submission_correction`；
- mechanical FAIL → 新 round `mechanical_failure`；
- Review REWORK → 新 round `quality_rework`；
- transient technical failure → 同 round `technical_retry`。

这四者不要混用。

---

## 10. Review Node

Review 与 Execution 共用 Task Scope / role / current-round 机制，但 Contract、协议和权限不同。

### 10.1 稳定 systemPrompt

```text
Pi Base
<core_rules>...</core_rules>
<project_context>
  <task_scope>...</task_scope>
  <review_contract>...</review_contract>
  <professional_role>...</professional_role>
  <review_protocol>...</review_protocol>
</project_context>
Skill Catalog
cwd
```

`REVIEW_CONTRACT.md` 包含：

- review node ID / objective；
- responsibilities / out of scope；
- exact target node/output；
- semantic criteria；
- allowed rework execution nodes；
- review requirements / constraints；
- 只读权限。

Review 节点不获得 write/edit/bash/powershell。

### 10.2 当前 round

```text
<node_round_dispatch>
Begin IPD work round review-brief:round:1.
</node_round_dispatch>

<ipd_current_round source="runtime">
{
  "round_id": "review-brief:round:1",
  "inputs": [
    {
      "input_id": "candidate",
      "submission_id": "write-brief:round:1:submission",
      "output_id": "brief",
      "approval_review_node_ids": [],
      "sealed_root": ".../write-brief:round:1:submission",
      "submission_record": ".../submission.json"
    }
  ],
  "feedback": []
}
</ipd_current_round>
```

Reviewer 检查 sealed Submission，而不是生产节点 workspace 中仍可变化的文件。

正式工具只有：

```text
<Baseline 锁定的只读业务工具>
submit_review
```

### 10.3 PASS / REWORK / BLOCKED

- `PASS`：每项 assigned criterion 都是 PASS 且证据完整；Runtime 登记 Approval；
- `REWORK`：本轮结束，Runtime 只让明确责任 execution node 进入返工；
- `BLOCKED`：缺少评审所需的访问、材料、证据或验证条件；Review node 记录 blocked。

如果 producer 重新提交新版本，Reviewer **复用原 Session** 开新 review round；旧意见仍留在 Session 历史与 Run 记录中，但新 PASS 必须针对新 Submission。

---

## 11. 不同事件到底改变什么

| 事件 | Session | round_id | 稳定 systemPrompt/context files | `ipd_current_round` |
|---|---|---|---|---|
| 首次 execution/review | 新建 | 新建 | 创建并固定 | 当前输入 + 空 feedback |
| 提交协议补正 | 复用 | 不变 | 不变 | 追加 `submission_correction` |
| transient 技术重试 | 复用 | 不变 | 不变 | 追加 `technical_retry` |
| Mechanical FAIL | 复用 | 新 round | 不变 | `mechanical_failure` |
| Review REWORK 后返工 | 复用 execution Session | 新 round | 不变 | `quality_rework` |
| 新 Submission 复审 | 复用 reviewer Session | 新 round | 不变 | 指向新 Submission |
| execution `report_node_blocked` | 复用但当前轮结束 | 当前 round → blocked | 不变 | 无后续自动 round |
| 输入版本失效 | 先 abort 当前活动 | 旧 round 失效 | 不变 | 新 round 重新绑定 |
| Run 成功 | release | - | Session 释放 | 无后续请求 |
| Session lost | 不创建新 Session 冒充恢复 | 当前工作失败 | 磁盘记录保留 | 无合法续跑 |

提交补正与质量返工是两个完全不同的概念：前者修“结构化提交协议”，后者修“交付质量”。

---

## 12. Session 历史、Skill 与长上下文

IPD 不自己重写 Pi 的 Session History，也不建立第二套 memory 系统。

长期可靠性来自三层：

```text
稳定 systemPrompt/context files
        +
持续 AgentSession 历史
        +
每次请求重新注入的 ipd_current_round
```

正式输入和 evidence 保存在 sealed Submission 中；即便对话历史被压缩，模型仍可通过 `submission_record` 回到正式源。

旧 toolResult 中已经被后续成功 assistant response 消费过的图片，会在后续 Provider 请求副本里替换为：

```text
<omitted_historical_image>
Image content already consumed by a later assistant response; omitted from this model request.
</omitted_historical_image>
```

这只优化 Provider 请求体，不修改 Session 磁盘记录，也不删除 Artifact/Submission/evidence。

---

## 13. 当前默认不会进入模型的内容

默认不全量注入：

- 全部 AgentCard 库；
- 全部 ProcessSpec 库；
- 未绑定 Skills / Tools / Knowledge Bases / 用户 Extensions；
- Workflow 原始完整 JSON 到 execution/review 节点；
- ExecutionBaseline 内部 Hash 与资产来源路径；
- 其他节点 Session 历史；
- 完整 Submission Manifest/evidence；
- Runtime 内部事件全集；
- 外层 Pi 完整对话历史。

需要的资产通过 catalog tools 查，需要的提交细节通过 `submission_record` 查。

---

## 14. 可还原的完整请求示例

本节不再把 `common.md`、四类 protocol 和 AgentCard 全文复制四遍。那样虽然“看起来完整”，但会造成 README 与真实文件重复维护，并让读者难以看清结构。

这里采用**可还原完整示例**：所有 IPD 自己生成的动态块、装配顺序、消息顺序、工具集合都具体展开；静态正文用其唯一权威文件名标识。把对应文件正文原样替换进去，即得到真实 Provider 请求。

示例任务：基于 `market-sources.md` 形成一份经过独立评审的市场简报。

### 14.1 Process Selector

```text
SYSTEM PROMPT

<PI_BASE generated by Pi>

<core_rules>
  exact content of prompts/common.md
</core_rules>

<professional_role>
  exact Runtime profile rendered from ipd-process-selector AgentCard
</professional_role>

<process_selection_protocol>
  exact content of prompts/process-selector.md
</process_selection_protocol>

<Skill Catalog>
  process-selection → locked SKILL.md path

Current working directory: /repo/.pi/ipd/runs/run-001/workspace
```

Provider 首条 user message：

```text
<skill name="process-selection" location=".../process-selection/SKILL.md">
  exact locked process-selection SKILL.md body
</skill>

<process_selection_assignment>
Load the process-selection method, evaluate this TaskInput, inspect serious ProcessSpec candidates through the catalog tools, and submit one decision.

TaskInput:
{"schema_version":1,"task_input_id":"request-001","raw_task":{"text":"Create a reviewed market brief from the supplied materials.","source":"external-agent-request"},"objectives":[{"objective_id":"objective-1","statement":{"text":"Produce a concise decision-ready brief.","source":"external-agent-request"}}],"requirements":[{"requirement_id":"requirement-1","statement":{"text":"Use only the supplied evidence for factual claims.","source":"external-agent-request"}},{"requirement_id":"requirement-2","statement":{"text":"The final brief must receive independent review before delivery.","source":"external-agent-request"}}],"materials":[{"material_id":"source-pack","description":"Market source pack","reference":"/repo/input/market-sources.md","media_type":"text/markdown"}],"unresolved_facts":[]}
</process_selection_assignment>
```

Provider tools：

```text
read
search_process_specs
get_process_spec
submit_process_selection
```

典型后续消息：

```text
assistant → search_process_specs
 tool     → <process_spec_search_results>...</process_spec_search_results>
assistant → get_process_spec
 tool     → <process_spec>...</process_spec>
assistant → submit_process_selection
 tool     → <submission_capture_result>...</submission_capture_result>
```

### 14.2 Workflow Designer

```text
SYSTEM PROMPT

<PI_BASE generated by Pi>

<core_rules>
  exact prompts/common.md
</core_rules>

<professional_role>
  exact Runtime profile rendered from Project Shepherd AgentCard
</professional_role>

<workflow_design_protocol>
  exact prompts/workflow-designer.md
</workflow_design_protocol>

<Skill Catalog>
  workflow-design → locked SKILL.md
  market-brief    → locked Run Skill SKILL.md

Current working directory: /repo/.pi/ipd/runs/run-001/workspace
```

第一条 user message：

```text
<skill name="workflow-design" location=".../workflow-design/SKILL.md">
  exact locked workflow-design SKILL.md body
</skill>

<workflow_design_method_request>
Load the workflow design method. Do not submit a Workflow yet.
</workflow_design_method_request>
```

第二条正式设计 user message：

```text
<skill name="market-brief" location=".../market-brief/SKILL.md">
  exact locked Run Skill SKILL.md body
</skill>

<workflow_design_assignment>
Load the task-specific method, then design this Workflow.

TaskInput:
<完整 TaskInput JSON>

ProcessSelection:
{"schema_version":1,"process_selection_id":"run-001:selection","run_id":"run-001","task_input_ref":{"id":"request-001","hash":"<task-hash>"},"process_spec_ref":{"id":"project-reviewed-content-delivery","version":"1.0.0","hash":"<spec-hash>"},"rationale":"The task requires controlled content production and independent review.","task_requirement_refs":["requirement-1","requirement-2"],"process_requirement_refs":["content-development","inspection-validation"],"unresolved_fact_refs":[]}

ProcessSpec:
<选中版本的完整 ProcessSpec JSON>

Available non-employee resources:
<当前 Skills 摘要、Tool IDs、unavailable AgentCards、Mechanical Check schemas>

Search and inspect AgentCards before binding employees.

Compiler diagnostics:
None
</workflow_design_assignment>
```

Provider tools：

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

Compiler 修订时只新增：

```text
<workflow_design_revision>
Draft revision: 6

Compiler diagnostics:
/nodes/1/inputs/0: required approved input is missing an approval review node

Revise the existing draft and submit the corrected revision.
</workflow_design_revision>
```

### 14.3 Execution Node

```text
SYSTEM PROMPT

<PI_BASE generated by Pi>

<core_rules>
  exact prompts/common.md
</core_rules>

<project_context>
  <project_instructions path="/virtual/ipd/write-brief/TASK_SCOPE.md">
    <task_scope>
      # Authoritative Task Scope
      Original request: Create a reviewed market brief from the supplied materials.
      Objective: Produce a concise decision-ready brief.
      Assigned requirements:
      - requirement-1: Use only the supplied evidence for factual claims.
      - requirement-2: The final brief must receive independent review before delivery.
      Task material:
      - source-pack → /repo/input/market-sources.md
      Unresolved facts: None
    </task_scope>
  </project_instructions>

  <project_instructions path="/virtual/ipd/write-brief/NODE_CONTRACT.md">
    <execution_contract>
      # Authoritative Node Contract
      Node: write-brief
      Objective: Produce the evidence-grounded market brief.
      Responsibilities:
      - Synthesize approved source material.
      - Produce the declared brief output.
      Out of scope:
      - Approve the final brief.
      Required input:
      - source-pack (task material, required)
      Declared output:
      - brief / text-bundle / outputs/write-brief
      Acceptance criteria:
      - brief-integrity
      - brief-quality
      Permissions:
      - Read: .
      - Write: outputs/write-brief
      - External actions: false
    </execution_contract>
  </project_instructions>

  <project_instructions path="/virtual/ipd/write-brief/PROFESSIONAL_ROLE.md">
    <professional_role>
      exact Runtime profile rendered from the bound producer AgentCard
    </professional_role>
  </project_instructions>

  <project_instructions path="/virtual/ipd/write-brief/EXECUTION_PROTOCOL.md">
    <execution_protocol>
      exact prompts/execution-node.md
    </execution_protocol>
  </project_instructions>
</project_context>

<Skill Catalog for bound node Skills>

Current working directory: /repo/.pi/ipd/runs/run-001/workspace
```

持久 user message：

```text
<node_round_dispatch>
Begin IPD work round write-brief:round:1.
</node_round_dispatch>
```

每次 Provider 请求临时追加：

```text
<ipd_current_round source="runtime">
{"round_id":"write-brief:round:1","inputs":[],"feedback":[]}
</ipd_current_round>
```

Provider tools：

```text
<Baseline 锁定业务工具，例如 read / write / edit>
submit_artifact
report_node_blocked
```

若业务条件缺失，模型可以正式提交：

```json
report_node_blocked({
  "reason": "The required source pack cannot be read",
  "missing_conditions": ["Readable access to /repo/input/market-sources.md"],
  "affected_requirement_ids": ["requirement-1"],
  "attempted_actions": ["Attempted to read the bound task material"],
  "evidence": [],
  "needed_to_resume": ["Provide readable access to the bound source pack"]
})
```

这会形成正式 business block，而不是不断触发 `submit_artifact` 补正。

### 14.4 Review Node

```text
SYSTEM PROMPT

<PI_BASE generated by Pi>

<core_rules>
  exact prompts/common.md
</core_rules>

<project_context>
  <project_instructions path="/virtual/ipd/review-brief/TASK_SCOPE.md">
    <task_scope>
      exact task-scope projection relevant to review-brief
    </task_scope>
  </project_instructions>

  <project_instructions path="/virtual/ipd/review-brief/REVIEW_CONTRACT.md">
    <review_contract>
      # Authoritative Review Contract
      Node: review-brief
      Review target: write-brief / brief
      Evaluate criteria:
      - brief-quality
      Allowed rework target:
      - write-brief
      Permissions:
      - Read: outputs/write-brief
      - Write: None
      - External actions: false
    </review_contract>
  </project_instructions>

  <project_instructions path="/virtual/ipd/review-brief/PROFESSIONAL_ROLE.md">
    <professional_role>
      exact Runtime profile rendered from the bound reviewer AgentCard
    </professional_role>
  </project_instructions>

  <project_instructions path="/virtual/ipd/review-brief/REVIEW_PROTOCOL.md">
    <review_protocol>
      exact prompts/review-node.md
    </review_protocol>
  </project_instructions>
</project_context>

<Skill Catalog for bound reviewer Skills>

Current working directory: /repo/.pi/ipd/runs/run-001/workspace
```

持久 user message：

```text
<node_round_dispatch>
Begin IPD work round review-brief:round:1.
</node_round_dispatch>
```

动态 current-round：

```text
<ipd_current_round source="runtime">
{
  "round_id":"review-brief:round:1",
  "inputs":[{
    "input_id":"candidate",
    "submission_id":"write-brief:round:1:submission",
    "output_id":"brief",
    "approval_review_node_ids":[],
    "sealed_root":".../write-brief:round:1:submission",
    "submission_record":".../submission.json"
  }],
  "feedback":[]
}
</ipd_current_round>
```

Provider tools：

```text
<Baseline 锁定的只读业务工具>
submit_review
```

`submit_review` 的结构化决策使用：

```text
Overall decision: PASS | REWORK | BLOCKED
Per criterion: PASS | FAIL | BLOCKED
```

Review tool 本身只捕获候选；Approval、返工流转、下游放行仍由 Runtime 决定。

---

## 15. 外层 Pi

外层 Pi 不是上述四类角色的一部分。加载 IPD Extension 后，它多出：

```text
ipd
ipd_get_run
ipd_read_events
ipd_get_result
```

`ipd` 创建 Run 后，内部控制面在后台继续。外层对话是否继续，不是 Run 完成条件。

IPD Tool 的返回文本也使用稳定标签：

```text
<ipd_run_receipt>...</ipd_run_receipt>
<ipd_run_status>...</ipd_run_status>
<ipd_run_events>...</ipd_run_events>
<ipd_run_result>...</ipd_run_result>
```

内部 ProcessSpec、Workflow、AgentCard 和节点 Session 历史不会自动回灌进外层 Pi 对话。

---

## 16. 当前边界

- Process Selector / Workflow Designer 没有 `ipd_current_round`；它们用自己的持续 Session 和控制消息。
- Execution 已有正式 `report_node_blocked` 业务阻塞接口；Review 仍使用 `submit_review` 的 `BLOCKED` 表达评审阻塞。
- 当前进程退出后无法恢复原存活 AgentSession；磁盘状态不等于 Session 连续性。
- Bash 系统级隔离依赖外部 sandbox；Review 已禁止通用 Shell。
- 生产环境当前不永久保存完整 Provider PromptTrace；测试通过 faux Provider 检查最终 `systemPrompt/messages/tools`。

---

## 17. 代码索引

| 内容 | 实现 |
|---|---|
| Pi systemPrompt 顺序 | [system-prompt.ts](../../coding-agent/src/core/system-prompt.ts) |
| Prompt 标签 | [block.ts](../src/prompt/block.ts) |
| 节点 Task Scope / Contract / current round | [node-context.ts](../src/adapter/node-context.ts) |
| 节点 round 派发 | [node-prompts.ts](../src/runtime/node-prompts.ts) |
| AgentCard Runtime / Selection 两种投影 | [render-agent-profile.ts](../src/adapter/render-agent-profile.ts) |
| Session 资源和工具装配 | [pi-node-session-factory.ts](../src/adapter/pi-node-session-factory.ts) |
| 节点 Session 复用 | [node-session-adapter.ts](../src/adapter/node-session-adapter.ts) |
| Selector / Designer Session | [pi-control-roles.ts](../src/control/pi-control-roles.ts) |
| 控制角色派发文本 | [control-role-prompts.ts](../src/control/control-role-prompts.ts) |
| ProcessSpec / AgentCard 目录工具 | [asset-catalog-tools.ts](../src/control/asset-catalog-tools.ts) |
| Workflow Draft 工具 | [workflow-draft-tools.ts](../src/control/workflow-draft-tools.ts) |
| Artifact / Review / Business Block 提交 Schema | [structured-submissions.ts](../src/adapter/structured-submissions.ts) |
| Runtime 补正、评审、返工、business block | [workflow-runtime.ts](../src/runtime/workflow-runtime.ts) |
| 结构化反馈 | [runtime-state.ts](../src/runtime/runtime-state.ts) |
