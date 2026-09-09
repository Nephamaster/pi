# 执行节点与评审节点的模型输入

IPD 不把所有信息拼成一条普通 Prompt。Pi 每次调用模型时，实际发送三个部分：

```text
systemPrompt
├── Pi 默认角色与当前工具说明
├── common.md
├── 当前员工专业画像
├── Workflow 的 node.system_prompt_addendum
├── execution-node.md
├── NODE_CONTRACT.md
│   ├── 节点目标与职责
│   ├── 输入/输出
│   ├── 准出标准
│   └── 权限
├── 已绑定 Skill 的目录
└── Run workspace 路径

messages
├── 之前轮次和当前轮次的持久会话历史
├── 当前 round 的派发用户消息
├── 当前 round 已发生的工具调用与结果
└── <ipd_current_round>             ← 每次 LLM 请求前临时放在末尾
    ├── run_id / round_id
    ├── 该节点负责的 TaskInput 投影
    ├── 确切输入绑定
    ├── 封存 Submission/manifest/证据
    └── feedback

tools
├── Workflow 分配的工具 Schema
└── submit_artifact Schema
```

Provider 收到的是：

```text
{
  systemPrompt: <一个字符串>,
  messages: <消息数组>,
  tools: <工具定义数组>
}
```

下面逐项说明每一部分的含义、内容和形成方式。

## 1. systemPrompt

systemPrompt 保存节点在整个 AgentSession 生命周期内相对稳定的信息。它在 Session 创建时完成组装，并在每次模型请求中发送。

### 1.1 Pi 默认角色与当前工具说明

这是 Pi 原生生成的基础系统提示，不是 IPD 自己编写的模板。

主要内容包括：

- Pi 的基础身份说明；
- 当前实际启用工具的简要说明；
- 工具注册时提供的 `promptGuidelines`；
- Pi 的通用工作规则和文档位置。

例如，一个获准使用 `read` 和 `bash` 的节点，Pi 生成的这一段大致如下。具体工具说明和路径取决于当前 Pi 版本及实际注册结果：

```text
You are an expert coding assistant operating inside pi, a coding agent harness.
You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read the contents of a file
- bash: Execute bash commands

In addition to the tools above, you may have access to other custom tools
depending on the project.

Guidelines:
- Use bash for file operations like ls, rg, find
- Be concise in your responses
- Show file paths clearly when working with files

Pi documentation (read only when the user asks about pi itself, its SDK,
extensions, themes, skills, or TUI):
- Main documentation: <Pi README 路径>
- Additional docs: <Pi docs 目录>
- Examples: <Pi examples 目录>
```

这里的 `read`、`bash` 只用于举例：没有分配给节点的工具不会出现在列表中。`submit_artifact` 等自定义工具即使没有文本形式的 `promptSnippet`，仍会通过请求的 `tools` 字段把名称、描述和参数 Schema 提供给模型。

形成方式：

1. Workflow 为节点配置工具；
2. Compiler 将工具解析并锁定为 `lockedTools`；
3. `PiNodeSessionFactory` 只启用这些工具，再加入受控提交工具；
4. Pi 根据最终启用的工具调用 `buildSystemPrompt()`。

因此，不同节点的 Pi 默认系统提示可能不同。例如只有生产节点获得 `bash` 时，其他节点不会看到 Bash 的工具说明。

### 1.2 `common.md`

文件：`packages/ipd/prompts/common.md`

使用者：所有 IPD 内部模型角色，包括执行员工、Reviewer、流程规范选择员工和工作流设计师。

内容是所有员工共同遵循的工作边界：

- 当前 Agent 只是流程中的一个员工，不负责控制整个工作流；
- 只能使用 Runtime 提供的任务依据、输入、工具和 Skill；
- 不得修改 TaskInput、ProcessSpec、Workflow、员工绑定或运行状态；
- 必须区分事实、证据支持的判断和未验证事项；
- 正式结果必须通过受控工具提交；
- 不得通过减少交付、降低标准或虚报成功绕过问题。

形成方式：静态读取文件正文，然后追加到 Pi 默认系统提示后面。

### 1.3 当前员工专业画像

来源：Workflow 为当前节点选择的 AgentCard。

当前节点 Worker 只使用 `node.agents[0]` 创建一个 AgentSession；Schema 虽然允许配置多个 `agents`，但多员工节点的调度尚未实现。因此本节所说的“当前员工”特指 `agents[0]`。

实际进入模型的内容包括：

- 员工名称和岗位定位；
- responsibilities；
- nonResponsibilities；
- applicableScenarios；
- principles；
- `promptProfile.approach`；
- deliverables；
- `promptProfile.communication`；
- `promptProfile.verification`。

形成方式：Compiler 先解析并锁定 AgentCard，`renderAgentProfile()` 再把上述字段确定性渲染为 Markdown。

它不是模型临时生成的角色摘要，也不会因当前对话而变化。

AgentCard 的 Hash、来源路径和模型路由配置不会作为专业画像正文发送给模型。模型配置用于选择实际 Provider/Model，而不是用于告诉模型“你是谁”。

### 1.4 `node.system_prompt_addendum`

来源：Workflow 中当前节点的员工配置：

```text
node.agents[0].system_prompt_addendum
```

用途：补充只有当前节点才需要长期遵循的限制。

例如：

- 只建立需求基线，不开展研究或制作 PPT；
- 不得修改被评审文件；
- 必须实际使用联网工具，不能只依赖模型记忆；
- 最终成品必须运行指定检查。

形成方式：Workflow Designer 在设计工作流时写入，Compiler 校验 Workflow 后冻结。Runtime 不会在执行过程中改写它。

### 1.5 `execution-node.md`

文件：`packages/ipd/prompts/execution-node.md`

使用者：所有 `kind=execution` 的节点员工。

它规定执行员工如何工作：

- 只完成自己的节点职责；
- 使用冻结输入和绑定 Skill；
- 只写自己的输出目录；
- 大产物按结构增量落盘；
- 提交前检查输出和证据；
- 使用 `submit_artifact` 提交；
- 收到补正或返工后在原 Session 修改，不降低标准。

形成方式：静态读取文件正文，并放在员工画像和 `system_prompt_addendum` 后面。

### 1.6 `NODE_CONTRACT.md`

它不是磁盘中的普通文件，而是 Runtime 根据冻结节点配置生成的只读虚拟 Context File：

```text
/virtual/ipd/<node_id>/NODE_CONTRACT.md
```

Pi 把它包装为：

```xml
<project_context>
  <project_instructions path="/virtual/ipd/<node_id>/NODE_CONTRACT.md">
    <节点契约正文>
  </project_instructions>
</project_context>
```

然后直接放进 systemPrompt。

#### 节点目标与职责

来自：

```text
node.contract.objective
node.contract.responsibilities
node.contract.non_responsibilities
node.contract.work_requirements
node.contract.constraints
```

含义：告诉员工本节点为什么存在、必须完成什么、不得承担什么、执行时遵循哪些要求。

#### 输入/输出

输入来自 `node.inputs`，描述本节点允许消费哪些任务材料或上游输出，以及是否要求上游已经获得指定 Gate 批准。

输出来自 `node.outputs`，描述：

- output_id；
- artifact_type；
- 交付物说明和业务用途；
- 输出目录；
- 应提供的证据；
- 关联的准出标准。

这里提供的是输入/输出契约，不是本轮实际输入文件。实际绑定到哪一次 Submission，由 `<ipd_current_round>` 提供。

#### 准出标准

来自 Compiler 为当前节点解析出的 `node.criteria`。

包括：

- mechanical criteria：由代码执行的自动检查；
- semantic criteria：由独立 Reviewer 判断的专业标准；
- 每项标准要求的证据。

执行员工能够提前看到交付物将按什么标准验收，但不能自行批准。

#### 权限

虚拟契约会列出 `node.agents[]` 中所有员工配置的：

```text
permissions.read_paths
permissions.write_paths
permissions.external_actions
```

权限会写入节点说明，让模型理解边界。当前真正运行的是 `agents[0]`，文件工具的权限检查也使用 `agents[0].permissions`。Runtime 和工具适配层只执行当前已经实现的限制；提示文字本身不是权限实施机制。

### 1.7 已绑定 Skill 的目录

来源：Workflow 为当前节点配置的 `agent.skills`，经 Compiler 解析为 `lockedSkills`。

默认进入 systemPrompt 的只是目录；标记了 `disable-model-invocation: true` 的 Skill 不出现在该目录中，只能由 `/skill:<name>` 显式调用：

```xml
<available_skills>
  <skill>
    <name>pptx</name>
    <description>...</description>
    <location>/.../pptx/SKILL.md</location>
  </skill>
</available_skills>
```

它告诉模型“可以使用哪些 Skill、Skill 在哪里”，但不代表 Skill 正文已经进入上下文。

Skill 正文进入 messages 的方式有两种：

1. 模型使用 `read` 或 `bash` 读取 `SKILL.md`，正文作为 tool result 进入历史；
2. 用户消息以 `/skill:<name>` 开头，Pi 将其展开成完整 `<skill>...</skill>` 用户消息。

普通执行节点的 Runtime 派发消息不会自动展开 Skill；`execution-node.md` 要求员工需要时主动读取。

### 1.8 Run workspace 路径

Pi 在 systemPrompt 末尾写入：

```text
Current working directory: <project_root>/.pi/ipd/runs/<run_id>/workspace
```

它告诉工具和模型当前相对路径从哪里解析。

所有节点共享这个 workspace。`read`、`write`、`edit` 的路径会按节点配置检查；Reviewer 的配置必须没有写路径和外部动作。当前 Pi 没有为 Bash 提供系统级沙箱，因此 Bash 是否遵守这些路径边界仍依赖节点提示和运行环境，而不是该文件权限扩展。

## 2. messages

messages 保存持续变化的工作过程。一个节点可能在一次 round 中调用模型多次，每次请求都会带上当前有效历史。

### 2.1 之前轮次和当前轮次的持久会话历史

在同一个 `PiNodeWorker` 生命周期内，同一节点使用同一个 AgentSession，绑定键是：

```text
run_id + node_id + participant_id
```

因此历史可以包含：

- 前一轮派发消息；
- 模型此前的分析和回复；
- 工具调用；
- 工具结果；
- 已经执行过的检查；
- 此前的提交调用；
- 后续补正或返工过程。

因此，当前进程内的正式返工不会创建一个失去历史的新 Agent，而是向原 AgentSession 发送新一轮消息。Session 消息会写入 Run 的 `sessions` 目录，但进程重启后当前工厂使用 `SessionManager.create()` 创建新 Session，尚未按既有会话文件自动重新绑定。

当上下文接近模型窗口限制时，Pi 会压缩历史。稳定 systemPrompt 不参与压缩；Runtime 还会在每次调用前重新注入当前轮次信息，因此当前状态不依赖历史摘要完整保留。

### 2.2 当前 round 的派发用户消息

Runtime 每次开始执行节点 round 时发送：

```text
Begin IPD work round <round_id>.
Use the Runtime-provided current-round context,
the virtual node contract,
and the exact sealed input references.

<首次交付或处理返工的要求>
```

这条消息的动态部分包括：

- 当前 round_id；
- `feedback` 是否为空。

如果 feedback 为空，末尾要求完成任务并提交。

如果 feedback 非空，末尾要求先处理列出的返工问题再重新提交。

这条派发消息会进入持久会话历史。

### 2.3 当前 round 已发生的工具调用与结果

模型调用工具后，Pi 把两类消息加入历史：

```text
assistant: toolCall
toolResult: 工具结果或错误
```

例如：

- `read` 返回文件内容；
- `bash` 返回命令输出；
- `write` 返回写入成功；
- 工具参数 Schema 不合法时返回明确诊断；
- `submit_artifact` 成功时返回候选已被捕获。

如果模型继续执行，同一 round 的下一次模型请求会看到这些调用和结果。

### 2.4 `<ipd_current_round>`

这是 Runtime 每次调用模型前动态生成的当前状态快照。

它作为一条临时用户消息放在 messages 最后：

```xml
<ipd_current_round source="runtime">
{
  "run_id": "...",
  "round_id": "...",
  "task_context": {...},
  "input_bindings": [...],
  "input_submissions": [...],
  "feedback": [...]
}
</ipd_current_round>
```

它不会永久追加到 Session JSONL；下次调用时 Runtime 会根据当前状态重新生成。

#### `run_id / round_id`

`run_id` 标识本次完整 IPD Run。

`round_id` 标识当前节点的工作轮次，例如：

```text
exec-content:round:1
exec-content:round:2
```

模型可据此区分首次交付和后续正式返工。

#### 该节点负责的 TaskInput 投影

字段为 `task_context`，由 `taskContextForNode()` 生成：

```text
rawTask          完整用户原始任务
objectives       全部任务目标
requirements     requirement_coverage 指定由本节点负责的要求
materials        node.inputs 明确引用的任务材料
unresolvedFacts  TaskInput 中全部未确认事实
```

这里不是把整个 TaskInput 不加区分地复制给每个节点。requirements 和 materials 会按当前节点职责过滤。

当前实现中 `unresolvedFacts` 未过滤，会整体进入每个执行/评审节点的动态上下文。

#### 确切输入绑定

字段为 `input_bindings`。

每项说明：

- 当前 node input 对应哪个 submission_id；
- 消费该 Submission 中的哪个 output_id；
- 该输入要求哪些 Reviewer Approval。

它解决的是“本轮到底使用上游哪一版”的问题。模型不需要从工作区或历史消息中猜测有效版本。

#### 封存 Submission、manifest 和证据

字段为 `input_submissions`。

每项包含：

- submission_id；
- 当前状态；
- 本节点被允许消费的 outputs；
- 每个 output 的 sealed_root；
- manifest：文件路径、媒体类型、SHA-256、大小，以及 `attemptId`（当前写入来源 `round_id`）；
- 上游提交时提供的 evidence。

Runtime 只投影当前 node.inputs 实际绑定的 output。上游 Submission 中未绑定的其他输出不会一起提供。

模型看到 sealed_root 后，可以通过获准的读取工具访问不可变快照，而不是读取上游节点可能继续变化的 workspace 文件。

#### `feedback`

这是当前员工需要处理的补正或返工信息。

正式 Gate 返工时，它来自：

```text
Reviewer criteria[].required_rework
```

机械检查失败时，它来自对应检查器的失败消息。

同一 round 的提交结构补正或可重试技术错误，也会把错误文字加入 feedback，再次派发给原 AgentSession。

需要区分：

- `unresolvedFacts`：任务开始时尚未确认的事实；
- `feedback`：当前这轮必须处理的补正或返工信息；
- Reviewer 的 `unresolved_issues`：Reviewer 认为仍无法解决或需要披露的问题。

当前正式返工主要使用 `required_rework`，不是 `unresolvedFacts`。`unresolved_issues` 当前只用于校验 BLOCKED 报告必须说明未决问题，既不会生成返工 feedback，也没有写入持久化的 `ReviewRecord`。

### 2.5 首轮、补正和返工时 messages 的区别

| 场景 | AgentSession | round_id | feedback | 新增消息 |
|---|---|---|---|---|
| 首轮交付 | 首次创建 | `round:1` | 空 | 首次派发消息 |
| 工具调用参数不合法 | 原 Session | 不变 | 不变 | 工具诊断作为 toolResult |
| Artifact 结构补正 | 原 Session | 不变 | `Submission correction: ...` | 再次派发当前 round |
| 可重试技术错误 | 原 Session | 不变 | 原始错误文字 | 再次派发当前 round |
| Gate 正式返工 | 原 Session | `round:2/3...` | Reviewer `required_rework` | 新 round 派发消息和最新输入版本 |

## 3. tools

tools 是独立于 systemPrompt 和 messages 的工具定义数组。

### 3.1 Workflow 分配的工具 Schema

来源：

```text
node.agents[0].tools
```

Compiler 检查：

- 工具是否已经注册；
- AgentCard 是否允许该工具；
- Review 节点是否错误获得 write/edit 等写工具。

创建 AgentSession 时，`PiNodeSessionFactory` 只启用 Compiler 锁定的工具。

模型实际收到的工具定义包括：

- name；
- description；
- 参数 JSON Schema。

工具的 `promptSnippet` 和 `promptGuidelines` 还可能影响 Pi 默认 systemPrompt，但参数 Schema 不需要复制进文本提示。

### 3.2 `submit_artifact` Schema

每个执行节点无论业务工具如何配置，都会额外获得 `submit_artifact`。

它要求模型提交：

```text
summary
outputs[]
  output_id
  files[]
    path
    media_type
evidence[]
  description
  reference
  output_id（可选）
  criterion_id（可选）
metadata
```

成功调用只表示本轮候选已被捕获。之后 Runtime 还会检查：

- 是否提交了节点声明的全部 output；
- 文件是否位于对应 path_prefix；
- 文件是否真实存在；声明为 JSON 或文本的文件是否通过相应基础内容检查；
- manifest 是否稳定；
- mechanical criteria 是否通过。

因此模型不能仅靠文字声称“已经完成”。

## 4. Review 节点有哪些不同

Review 节点沿用同样的三部分请求结构，只替换与评审职责相关的内容。

```text
systemPrompt
├── Pi 默认角色与当前获准审查工具说明
├── common.md
├── 当前 Reviewer 专业画像
├── Workflow 的 reviewer.system_prompt_addendum
├── review-node.md
├── NODE_CONTRACT.md
│   ├── 评审目标
│   ├── targets
│   ├── criterion_refs
│   ├── allowed_rework_node_ids
│   └── 只读权限
├── 已绑定 Skill 的目录
└── Run workspace 路径

messages
├── Reviewer 自己的持续会话历史
├── 当前 review round 派发消息
├── 本轮读取文件、图片和检查证据的工具记录
└── <ipd_current_round>
    ├── 当前 review round
    ├── Reviewer 负责的 TaskInput 投影
    ├── 被评候选的确切 Submission
    ├── 已批准的背景输入
    └── 本轮补正 feedback

tools
├── Workflow 分配的审查工具 Schema
└── submit_review Schema
```

### 4.1 `review-node.md`

文件：`packages/ipd/prompts/review-node.md`

它要求 Reviewer：

- 只判断指定版本是否满足固定语义标准；
- 读取实际交付物和证据，不照抄执行者总结；
- 不修改被评审文件；
- 区分 PASS、REWORK 和 BLOCKED；
- 每项判断提供可定位证据；
- 返工只能指向 Workflow 预先允许的执行节点；
- 不额外增加个人偏好或“必须找问题”的标准。

### 4.2 Review 的 `NODE_CONTRACT.md`

Review 契约不包含 execution outputs，而是包含：

- `targets`：评审哪个节点的哪个 output；
- `criterion_refs`：针对该 output 判断哪些标准；
- `allowed_rework_node_ids`：REWORK 时可以打回哪些执行节点；
- Reviewer 的只读权限配置。

Compiler 会拒绝 Reviewer 的写路径、外部动作以及原生 `write`/`edit` 工具。Reviewer 可以为检查目的获得 Bash，但当前没有系统级 Bash 沙箱；`review-node.md` 明确禁止用 Bash 绕过只读边界。

### 4.3 `submit_review` Schema

模型需要提交：

```text
decision: PASS | REWORK | BLOCKED

criteria[]
  criterion_id
  result: PASS | FAIL | BLOCKED
  evidence[]
  rationale
  required_rework[]

rework_node_ids[]
unresolved_issues[]
```

Runtime 校验结构后：

- PASS：为指定 Submission/output/criteria 建立 Approval；
- REWORK：使目标执行节点进入新 round，并传递 `required_rework`；
- BLOCKED：将 Review 节点标记为 blocked；各 criterion 的 rationale 和 evidence 会保留，但当前提交中的 `unresolved_issues` 不会写入 `ReviewRecord`。

## 5. 模型默认看不到什么

普通执行员工或 Reviewer 默认不会收到：

- 完整 Workflow；
- 全部节点运行状态；
- 其他员工的会话历史；
- 未绑定的上游输出；
- 完整 ProcessSpec；
- 完整 Run Skill；
- 未分配给本节点的 Skill、工具和知识库；
- Runtime 调度队列和全局账本。

它获得的是完成当前职责所需的局部视图：

```text
稳定角色与节点契约
+ 当前有效输入版本
+ 当前工作轮次
+ 当前返工信息
+ 实际可调用工具
```

全局流程状态由 Runtime 维护，不交给节点模型自行判断或修改。

## 6. `packages/ipd/prompts` 文件对应关系

| 文件 | 使用者 | 在模型输入中的位置 |
|---|---|---|
| `common.md` | 所有 IPD 内部模型角色 | IPD 追加 systemPrompt 的第一段 |
| `execution-node.md` | 所有执行节点员工 | 员工画像和节点 addendum 之后 |
| `review-node.md` | 所有 Reviewer | Reviewer 画像和节点 addendum 之后 |
| `process-selector.md` | 流程规范选择员工 | common + 选择员工画像之后 |
| `workflow-designer.md` | 工作流设计师 | common + Project Shepherd 画像之后 |

其中 `process-selector.md` 和 `workflow-designer.md` 服务于工作流准备阶段，不会进入普通执行/评审节点上下文。

提示文件由 `loadPrompt()` 读取并执行 `trim()`。执行/评审节点使用的 `common.md`、`execution-node.md`、`review-node.md` 在模块加载时缓存，因此修改后需要重启加载 IPD Extension 的 Pi 进程；已经创建的 AgentSession 不会热更新 systemPrompt。

## 7. 当前审计边界

Run 会持久化 AgentSession 消息，但没有保存每次 Provider 请求最终形成的完整：

```text
systemPrompt + transformed messages + tools
```

原因是：

- `<ipd_current_round>` 是每次请求前临时追加；
- Pi 可能在请求前压缩历史；
- Tool Schema 通过独立 `tools` 字段发送；
- Pi Extension 仍可以在 Provider 请求前调整上下文。

当前可以依据冻结 Baseline 和代码重建 systemPrompt、节点契约和当前轮次数据，但不能把重建结果声称为某次历史 Provider 请求的字节级原始副本。
