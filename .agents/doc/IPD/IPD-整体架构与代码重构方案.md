# IPD 整体架构与代码重构方案

基线：`Nephamaster/pi@07095ad825ef76cd4d9896180233659447d3ca4f`。
范围：架构与代码重构设计，不是已完成的补丁、PR 或集成测试结果。源码依据为固定提交的 GitHub 内容；问题现场依据为 `20260916T065437175Z` 的既有诊断。除特别注明外，目标结构和验收要求是本报告的设计建议，不是声称上游已经实现的 API。

## 1. 核心结论与对前述建议的修正

原先提出持续工作区、精确输入、失败恢复和真实预检，方向是通用的；但若每个问题都在 IPD 再新增独立的重试、超时、上下文管理、检查点和遥测机制，就会继续制造冗余。此前的实施方案没有足够先盘点 Pi 原生能力，也没有同时规定旧机制如何退出，这是需要纠正的地方。

当前问题不是“全部源码都应该删”，而是三个现象同时发生：

1. Pi 已有的机制被外层再次包裹，策略拥有者不唯一。
2. 只有 IPD 知道的业务生命周期没有形成闭环：模型停止、节点暂停、候选提交、质量准出、Run 结束并不是同一件事。
3. 部署资产、工具实际入口和测试使用路径不一致。模块分别通过测试，完整链路仍然失败。

本次采用“复用原生机制、保留治理增量、集中生命周期、收敛执行后端”的方案，不更换 Agent 核心，不新建平台，不以移动目录或压缩行数冒充减重。

按 Git tree blob 的 `size` 字段汇总，`packages/ipd/src` 共 75 个文件、511,910 字节，约 499.91 KiB；包含注释、类型和内嵌前端，排除 assets、prompts、tests、docs 和镜像配方。这不是构建产物大小，也不是代码行数。此规模本身不能证明臃肿；需要删除的是重复机制、无效抽象和不一致入口。明细见 `source-inventory.json`。[P1]

## 2. 业界实践：借鉴职责，不把另一套 Harness 搬进来

### 2.1 Codex

OpenAI 公开的 App Server 设计将核心 Agent 行为集中到 Codex core，由长期存活的宿主进程管理 thread，通过稳定事件对接不同 UI。Thread、Turn、Item 分别承担会话、一次工作和具体输入输出的职责；浏览器不是长任务状态的权威来源。[E1]

对 IPD 的启示是：IPD 应调用 Pi 的核心，而不是另写一个会话循环；执行句柄生命周期不能绑定在网页连接或单次 Promise 上。没有必要因此将当前 Pi 替换成 Codex，也不必立即建立网络 App Server。

### 2.2 Claude Agent SDK 与长程工作

Anthropic 的长程实验强调增量推进、可检查的阶段状态、工作记录及端到端验证，而不是认为压缩上下文即可保证任务完成。该实验主要针对 Web 开发，不能宣称其具体角色配置是所有任务的最佳方案。[E2]

SDK 的文件 checkpoint 只追踪特定编辑工具，不包含任意 Bash 修改；对话恢复和文件回滚也是不同能力。[E3] 因此，IPD 仍需要工作区/WIP/正式成果之间的关联，但不需要重新保存一份 Pi 对话历史。

### 2.3 OpenHands

OpenHands 将 Conversation、Workspace、Condenser 分开：Conversation 负责会话生命周期；Workspace 负责环境中的执行和文件操作；Condenser 生成模型所需的压缩视图，原始事件记录另行保留。[E4–E6]

借鉴这一职责分离即可，不引入整个 Python SDK，不把它的 API 文档当成我们已具备的代码，也不把 LocalWorkspace 的普通进程执行误称为强安全沙箱。

### 2.4 Pi 自己

当前仓库的 `docs/containerization.md` 已经介绍宿主 Agent + 隔离工具和整体容器化两种路线，并提供 Gondolin 示例，覆盖七个内置工具。示例有持续 VM、工具 operations 适配、生命周期清理。它说明 Pi 可以承载这种架构，不代表示例已实现 IPD 的逐输出隔离、审批和父子流程。[P2–P3]

本轮保留已经实施的 Docker 路线，不再切换 QEMU 或同时维护多个新 Provider。Gondolin 的价值首先是现成的集成方法。包括 Shell 启动方式在内的示例细节仍需按目标环境检验，不能盲目复制。

## 3. Pi 复用清单与支持边界

| 能力 | 已有原生机制 | 本轮动作 | 不能误认为 |
|---|---|---|---|
| 模型与工具循环 | Agent、AgentSession、ModelRuntime | 继续直接调用；不引入第二个 ReAct 循环 | 能自动知道 IPD 哪个节点可以准出 |
| 模型重试 | AgentSession 原生退避、错误分类、auto_retry 事件 | 统一为模型重试的唯一拥有者 | 可以重放任意有副作用的整节点 |
| 请求期限 | `retry.provider.timeoutMs`、`httpIdleTimeoutMs` 等 | 通过可信 SettingsManager 配置 | 替代 Run/工作包的业务时限 |
| 上下文管理 | 自动/手动 compaction、`session_before_compact`、context hook | 只注入 IPD 特有的保留信息和当前事实 | 默认压缩会准确保存所有质量判断 |
| 会话历史 | SessionManager 的 create/open、树、label、custom entry | 保存 session 引用和 entry 边界，不再复制消息 | 会自动恢复 Docker 或撤销文件副作用 |
| 工具交互 | 原生 ToolDefinition 和 Operations | 替换 I/O 后端，保留参数、格式、diff、图片和截断行为 | 同名自定义工具自然运行在沙箱里 |
| 正常结束与取消 | terminate、abort、waitForIdle、agent_settled；core safe-turn hook | 在安全边界结束或暂停；复用原生取消链 | 发出 abort 就证明所有外部进程退出 |
| 结构化提交 | 当前 IPD 已用 sequential 工具和 terminate | 保留，不另造提交后中断循环 | 单个 terminate 能无条件终止混合工具批次 |
| 遥测 | pi-telemetry + Session/Provider hooks | 增加 Run/Node 标签和一个轻量导出适配器 | 原生合约已经自动完成所有日志收集 |
| 沙箱 | 原生工具后端接口 + containerization 示例 | 保留窄 Docker 实现并对齐原生接口 | Pi 默认有完整文件/网络/凭证权限系统 |
| 工作流治理 | 不属于 Pi 原生会话职责 | IPD 保留 ProcessSpec、Compiler、Gate、Approval、Rework | 用 SessionManager 能直接替换 RunStore |

具体代码证据：[P4–P11]。当前 IPD 的 `SettingsManager.inMemory({})` 并非关闭自动重试和自动压缩；Pi 默认两者开启。真正缺口在于外层策略再次包装、配置未形成明确的可信会话策略，以及观测与恢复没有接完整。[P5,P12]

Pi 新的 server、durable Session 与 SQLite session backend 也值得观察，但 `packages/server/README.md` 明确标为 experimental。它不是当前稳定 coding-agent SDK 的无成本替代，本轮不进行全量迁移。[P13]

## 4. 目标架构：保留现有四条清晰职责线

```text
IPD 入口 / 看板（请求与只读投影）
                 |
IpdService（Run 生命周期与资源所有者）
                 |
WorkflowRuntime（调度、调用、提交推进）
       |                     |
IPD 纯业务规则          Pi 绑定适配
编译/批准/失效/返工      AgentSession / SessionManager
       |                     |
RunStore / ArtifactStore   原生工具定义
                             |
                   统一 Workspace 后端
                   Docker、文件、命令、进程
```

这些是职责边界，不是要求部署四个服务。

### 4.1 IPD 专有增量必须保留

ProcessSpec 选择与 Workflow 实例化、锁定资产与编译报告、输入版本及依赖、精确输出封存、机械检查、独立评审、批准失效传播、定点返工、最终交付，这些不是重复实现 Pi，不能为减代码而删除。

### 4.2 单一拥有者原则

- 模型重试与消息/压缩生命周期：Pi AgentSession。
- 业务准出、返工和完成：IPD 业务规则。
- Run 是否仍受管理、何时继续/取消/释放：IpdService 的 Run 生命周期。
- 环境内实际读写、命令与进程：Workspace 后端。
- 封存内容与身份：Artifact/SubmissionStore。
- UI：只解释读模型；不猜状态、不推进状态。

不同层可以有状态，但不能争夺同一语义。例如 Pi 的 isIdle 不是 IPD 的节点已成功；Environment.ready 不是工作已经通过评审。各层通过稳定 ID 关联，不复制另一层的全部状态。

## 5. 逐模块重构与删除清单

### 5.1 `runtime/node-worker.ts`：去掉整节点模型重试装饰器

当前 `RetryingNodeWorker` 会重试整个 `runExecution/runReview`；底层 `AgentSession.prompt()` 本身已经处理重试。两层可能形成重复等待、重复任务提示和重复尝试。[P5,P14]

重构动作：删除外层针对模型 transient 的自动整轮重试。模型可恢复错误交给 Pi 的原生重试；最终耗尽后上报明确的 interrupted/failed 原因。用户或 Runtime 后续有意识地继续原 Session，不等于重放此前所有工具。

保留两种与模型重试不同的工作：结构化结果不合规则反馈补正；真实质量问题则由 Gate 发出新质量 round。二者不消耗同一个 retry counter。未知外部结果必须先查询/协调，不能盲目重复副作用。

### 5.2 `adapter/node-session-adapter.ts`、`pi-node-worker.ts`、`pi-node-session-factory.ts`：收敛为薄绑定层

当前这些层分别保存 binding、活动 round 和状态；控制角色也维护自己的活动集合。其唯一绑定、并发保护、冻结配置有价值，不应全部删除。[P12,P15]

重构动作：保留一个会话绑定登记处，唯一键为 Run/逻辑节点/参与者；持有真实 AgentSession、sessionFile、当前 IPD round/attempt 引用和订阅清理句柄。Worker 只负责把 NodeWork 转成上下文、绑定环境、等待受控结果；Factory 只负责创建原生会话。删除重复的 active/idle 镜像和不必要的 prompt/abort 逐层转发。

对外不要把 AgentSession 重新封成一个丢失关键能力的类后，又在其他文件补 compact/steer/restore。使用窄的原生类型投影或一次性明确的适配面。ST/Designer 复用同一个会话工厂、设置构造和结果捕获；保留它们不同的业务 Schema、权限与选择/设计逻辑，不做万能 RoleEngine。

正常返工复用 Session。跨进程恢复显式使用 SessionManager 打开原始会话，并核验工作区和执行身份；不把新建实例称为原进程从未死亡。

### 5.3 `node-context.ts`：保留契约投影，删除基于“出现过回答就已消费”的粗糙信息丢弃

当前 `omitConsumedImages` 是局部视图剪裁，不是通用 compaction；不能从“之后存在成功 assistant 消息”推导出图像内容已经沉淀为可恢复检查结论。[P16]

重构动作：由 Pi 负责上下文容量、压缩和历史存储；IPD 只提供稳定契约/当前输入/未完成义务，必要时通过原生 compaction hook 补充保留要求。大结果使用可重读文件引用和已有原生截断、图片规范化，不直接删除原始 Session 日志。

视觉检查方法留在具体 Skill：按对象批次写出可追溯观察和待修项，再压缩对应上下文。这不是创建 PPT 专属 Runtime。

注意：Pi `compact()` 会先 abort，手动 compact 不会自动继续被中断的工作。应在原生自动流程或安全空闲边界调用，不能从任意定时器直接触发。[P6]

### 5.4 `environment/*`：完善一条后端，不再扩展成沙箱平台

保留 Docker，但统一普通命令、完整日志命令、受管进程、能力探针的启动契约。Profile 承诺的 PATH/解释器/环境变量必须在这些入口一致；使用显式 argv，不依赖登录脚本偷偷修改环境。当前真实 Skill 探针必须使用与业务相同的工具路径，而不是另外一条看起来相似的命令。[P17]

原生工具参数和展示行为继续由 Pi 维护。文件、图片、grep/find、命令与日志只替换 I/O；不复制第二套编辑器、搜索语义和结果格式。

宿主 UID、镜像身份、bridge 版本、权限、目录、日志上限等属于执行配置。基础镜像与项目依赖分层，合法项目依赖安装在私有 workspace/cache。cwd、文件访问、导出范围已经分离的正确行为保持不变，不再改路径名称以制造新迁移。

修复 process bridge 漏传参数后，将协议改为一个有版本的结构化请求，父子调用使用同一序列化入口。启动成功必须有初始化握手；PID 不是服务 ready。编译后的镜像 bridge 来自同一份协议实现，禁止双份手工维护字段。

基础能力检验包括真实 read/write/edit/Bash/图片/搜索入口、实际 Skill 依赖、服务 start/log/stop，以及真实生成→渲染→验证→导出。代码 Profile 和 Office Profile 都要跑，不能只针对当前故障建立一个路径例外。

Workspace 实现应不依赖 ProcessSpec、Review、Approval 等业务概念。先用普通 Pi SDK fixture 和 IPD 两个消费者证明这一边界，届时可将其整理为独立私有 workspace 包；仅移动源码不计作优化。现有 native 工具适配帮助函数能复用的直接复用，不引入通用 IoC 或插件平台。

### 5.5 Legacy 路径退出

`adapter/node-sandbox.ts` 与 `node-file-scope.ts` 不能永久和 Docker 路径共同承担主流程权限真相。迁移期间仅通过显式 legacy 选项启用；默认 Docker 失败不得降级到宿主执行。

Docker 能力验收通过后，将 legacy adapter 和其 sandbox-runtime 依赖隔离到可选兼容入口；不再让默认包为了旧路径强制安装全部依赖。移除前先验证源码与安装态的依赖图，不能删掉仍被调用的路径。[P18]

### 5.6 `IpdService` 与 `WorkflowRuntime`：修复生命周期，而不是再添一套管理器

当前活动 Promise 集合不等于资源所有权集合；后台调用结束后删除登记导致 blocked 状态失去管理。用一个受管理 Run 记录承接 runtime、参与者 Session 引用、lease 引用、状态和暂停/终止原因；运行中的 Promise 只是可选字段，不决定对象是否还应被管理。[P19]

统一的生命周期：running 可因外部条件进入 blocked、因可恢复技术中断进入 paused，或进入终态 succeeded/failed/cancelled。具体 enum 可兼容映射，关键是状态具有不同继续和释放语义。

- blocked/paused：保留清晰所有权，停止继续派发，停止或登记在途进程；可查询、继续、放弃。
- resume：核验 Baseline、输入批准、Session 和 lease 身份；增加执行代际，保留正常业务 round 的含义；不修改冻结任务。
- cancel：先关闭提交资格，再取消 Pi 和环境，等待有界清理；也能取消已暂停/阻塞的 Run。
- terminal：完成所需证据保存后幂等释放。清理失败需要记录并可重试，不能吞掉后删除全部线索。

只新增 IPD 真正需要的工作包级截止策略。模型请求和 idle timeout 用 Pi 原生设置；命令 timeout 由 Workspace 执行；工作包软期限在安全 turn 边界请求保存工作，硬期限撤销提交代际并有界取消。不要给每个模块再放一组独立 watchdog。

原生 core 的 shouldStopAfterTurn 是可复用语义，但当前 SDK 并未直接暴露为创建选项；不能虚构参数、替换原生私有 hook 或破坏 compaction。优先利用 steer、现有 terminate 与空闲边界；确实需要额外安全停止 hook 时，单独做一个组合式 SDK 扩展点并测试原生行为。[P4,P7,P8]

### 5.7 工作进度：只建立引用与收口，不发明第二种会话历史

一个可恢复工作点需要关联：Baseline、逻辑节点和执行代际、Pi sessionFile/entry 边界、输入版本、workspace/WIP 版本，以及仍待完成的事项。

对话由 SessionManager 保存；工作文件由环境保存；正式成果由 SubmissionStore 保存。IPD 仅保存关联和有效性。普通持续执行无需每个 token 做全目录快照。需要导出 WIP 时，复用现有稳定导出路径，但标为未批准，不能触发下游准出。

历史恢复不是副作用回滚。原始 Bash 修改、数据库和外部请求可能需要额外确认；不能因为会话已恢复就无条件重跑上一条工具。若环境状态不可恢复，要明确给出状态，不能新建空环境伪装继续。

### 5.8 `runtime-state.ts`、`workflow-runtime.ts`：集中纯业务迁移，保持调度器简单

复用已经修正的批准依赖、失效传播和返工定位规则。整理为几个明确业务操作：就绪判断、候选提交、评审应用、依赖失效、返工完成、最终完成判断。

业务迁移在同一模块内测试，Scheduler 负责认领工作、调用参与者执行、提交迁移，不在 Service、UI、Worker 各自重写相同判断。不要为了纯函数把它扩成万能事件语言或自制 durable workflow 平台。

编译形成不可变索引：nodeById、outputByRef、消费者、负责 Review、criterion 对应关系。运行态只更新必要状态，避免每轮反复从整个历史计算所有静态关系。是否需要更复杂的增量调度，以宽图和多轮返工测量为准，不凭节点数猜性能收益。

### 5.9 Store 和 Artifact：本轮不引入第二套数据库迁移

继续使用现有 RunStore 接口与已经测试的原子落盘方式；保留业务状态与对应审计事实的一致性。固定 Baseline/锁定资产用不可变引用，运行快照不复制大段会话、文件、base64 或重复的静态资产。通过派生读模型保持对外 getRun 的兼容表示。

当前没有证据证明数据库是这次 30 分钟任务的主瓶颈。因此本轮不同时迁移 SQLite/Postgres，不自制一套快照+日志的崩溃回放协议。需要多进程一致性时应使用成熟事务存储，但应作为单独决策，不能假装 Pi 的 Session SQLite backend 能直接替代 IPD 的业务 RunStore。

成果路径保持：环境稳定视图→私有 staging→Manifest 校验→提交登记→独立评审。控制层只在当前执行代际和输入仍有效时登记成果。中断造成的未登记 staging 由明确清理策略处理；不要声称文件系统、模型服务和业务状态之间存在自动的全局事务。

### 5.10 资产、模板与配置

保留专业员工的有用内容，不通过压缩 YAML 文案降低代码量。技能和流程是数据，不应按源码行数批判。

Schema、类型与文档尽量从同一正式定义派生；模型输入验证、资产边界验证、提交内容验证是不同信任边界，不能为了“去重”删掉其中一层。真正应消除的是同一事实的多次独立实现，例如工具清单、基础路径、版本比较、角色生命周期、工具错误到节点错误映射。

Profile 选择按已锁定 Skill 需求进行；部署时按用到的 Profile 准备，避免一个纯文本任务因无关 Office 镜像缺失无法创建服务。缓存键包括真正影响行为的配置与资产哈希，不能在已创建的 Run 内静默热换版本。

模板声明可检查的适用前提和能力需求。无材料但任务必须研究时，应配置真实可用的授权检索，或进入已有 Designer 做显式适配；不能把用户任务偷偷改成“证据缺口列表”。Compiler 不可能仅靠结构检查证明自然语言目标完成，最终 Review 必须回到原始任务检验成果适足性。这不要求恢复已删除的大型 TaskInput.requirements 结构。

### 5.11 遥测与前端

`pi-telemetry` 作为统一记录合约；为原生 Session、模型请求和工具事件关联 Run/Node/Round/Attempt/ToolCall 标识。IPD 自身只新增调度、Gate、封存等领域事件。提供一个轻量本地导出适配器，默认仅记录必要元数据，凭证和完整私密输入不入日志。[P9]

当前模型请求 hooks 已有 before_provider_request 和 after_provider_response，可记录脱敏的形状、状态和允许名单中的 request ID，不必改所有 Provider 或保存思维链。[P10]

前端从同一个版本化读模型渲染，实时与 HTML 快照共用 renderer。将 dashboard-page.ts 中的内联程序变成可独立类型检查的客户端 TS/CSS，构建时用仓库已有 esbuild 内嵌进 HTML，保持离线单文件导出。不是增加 React 工程，也不再手写多层模板字符串转义。[P20]

轮询可以保留，但按业务 revision/游标更新，只读摘要，不每秒读取全部历史和静态资产。不为解决显示更新再引入另一套前端状态真相。

### 5.12 构建与依赖治理

当前 root build/build:offline 列表不含 ipd，而 IPD 包导出 dist。需让统一构建明确覆盖 IPD，并验证源码开发入口和安装后 dist 入口的行为一致；不能只在直接执行 TS 时正确。[P20,P21]

根 package.json 中已经有 pptxgenjs、React、react-icons、sharp 等。逐项核查真实 import/entry graph：仅服务某个制作 Skill 的运行时依赖应进入相应 Profile 或技能工具包；若核心确有消费者则保留或放到真正拥有者包内。不要未经查证批量删除，也不要继续让宿主全局安装掩盖镜像缺依赖。

## 6. 清晰代码的具体约束

1. 用已有 entry-graph 检查脚本加入边界规则：领域规则不能导入 AgentSession、Docker、HTTP；Workspace 不能导入 Review/ProcessSpec；UI 不能调用状态迁移；Pi 核心不得出现 IPD 特定枚举。
2. 接管一种职责的 PR 必须同时说明旧实现的删除或退役位置。不能只新增 Manager 包装原 Manager。
3. 类型收敛到真实可表达的状态。错误保留 code、cause、retryability 和操作上下文；不能靠多个 regex 把任意异常归为 transient，也不能让 catch-all 返回 false 把环境丢失冒充文件不存在。
4. 配置由边界校验一次后成为可信内部类型；跨进程、模型输入、文件导入和提交仍各自验证。不要层层 JSON stringify/parse 或 `as any` 掩盖契约不一致。
5. 可复制的适配代码可以抽取小函数；不要为了消除十行重复引入 BaseManager、插件总线、反射或复杂类型体操。
6. 没有独立责任的文件不必存在，但不以任意“单文件200行”作为质量标准。较大的静态模板/Schema 与复杂控制流不是一种复杂度。
7. 不以删除测试、缩短专业角色内容、移动源码到新包或压缩排版来统计收益。重构前后统计整个新增代码路径与运行依赖。
8. 注释解释不变量、兼容边界和失败语义，不重复代码字面含义；清理日志中对无法验证的外部动作的成功措辞。

## 7. 实施批次与退出标准

### PR 1：先建立原生复用和行为基线

确认当前 revision，记录依赖图、模型 settings、正常/失败/取消链；为现有正确行为建立 characterization tests。固定原生重试、压缩、提交 terminate、文件/图片工具行为和阶段 Gate 测试。

输出应包括“保留/合并/删除”对应表。第一批不迁移数据库、不切换沙箱、不开放多 Agent。

### PR 2：会话策略减法

删除重复模型重试，统一可信会话设置与事件接入；保留补正和质量返工；收敛控制/执行角色会话适配；替换粗糙图像消费判定。验证 Pi 自身用户会话和普通 SDK 使用无回归。

### PR 3：Run 生命周期与恢复闭环

修正活动任务与资源所有权关系，补同 Session/同 lease 的暂停继续和阻塞取消，统一执行代际和有界取消，保存 WIP 关联；通过故障注入验证任何位置中断不会失管或被当成准出。

### PR 4：执行后端收敛

统一启动策略与 bridge 协议，真实 Skill 预检，工具 I/O 和部署图一致；两个 Profile、服务和图片场景通过真实 Docker 验证。旧路径显式隔离，禁止自动弱化安全；完成后再物理整理公共 workspace 代码。

### PR 5：治理代码、观察与构建整理

集中业务迁移和静态索引；瘦运行快照和摘要读模型；前端构建复用 esbuild；修统一构建覆盖与任务依赖归属；验证预置模板的资源前提和最终任务适足性。

每个 PR 必须带实际测试命令、结果、未验证范围和旧代码去向。没有 Docker 或完整依赖就不能宣称真实集成通过；可形成 Draft，但不以 mock 替代验收。

## 8. 必过验证矩阵

| 范围 | 必过行为 |
|---|---|
| Pi 原生回归 | 单一模型重试策略；自动压缩后继续；手动压缩语义不变；提交 terminate 正常结束；图片/编辑/截断输出保持 |
| 真实环境 | 普通命令、日志命令、后台进程与探针使用同一环境；依赖和IPC可用；不继承宿主秘密；无自动 fallback |
| 生命周期 | prepare/模型/tool/export/等待评审期间取消；blocked 可查询/继续/释放；同ID不同节点不共享私有状态 |
| 治理 | 精确输入、不可变提交、联合批准失效、定点返工、必需评审、最终文件集合不变 |
| 完整任务 | PPT从真实Skill生成到验收；代码任务安装依赖/构建/测试/本地服务/修改回归；两类任务共用同一个Runtime |
| 包装与前端 | dist消费测试；源码/安装态一致；浏览器状态实际更新；快照可离线打开且无后端依赖 |

性能记录至少包括：模型调用次数和耗时、原生重试/压缩次数、环境冷热准备、工具实际耗时、落盘耗时、暂停恢复耗时、重复读取和无效工作量。不要承诺未测量的50%代码缩减或10倍提速。当前最新Run已完成生成与渲染，第一次terminated根因仍未明，不能以“上下文一定溢出”代替诊断。[R1]

## 9. 为下一阶段保留什么，不提前实现什么

保留 Node/Participant/Session/Workspace 的明确身份边界；输入输出引用不绑定宿主路径；Review 的判断对象仍是明确版本成果；普通质量轮次与技术执行尝试分开；依赖和批准来自同一规则。

暂不开放多人节点、递归IPD、评审团子流程、共享可变工作区、自演进或投资预算。未来扩展的是责任组织方式，不应该再修改模型重试、文件访问或基础取消机制。

也不在本轮换用 LangGraph/Temporal。成熟工作流框架提供持久化与恢复机制，但不自动保存 live Pi Session、容器进程或 IPD 的批准语义。先完成当前明确边界，未来确有分布式调度需求时再单独比较，不能用替换图引擎掩盖工具与会话整合问题。[E7]

## 10. 资料索引与证据边界

P1. 固定提交下 `packages/ipd/src` 的 Git tree；统计只使用 blob size，明细另附。
P2. `README.md`、`packages/coding-agent/docs/containerization.md`。
P3. `packages/coding-agent/examples/extensions/gondolin/index.ts`。
P4. `packages/coding-agent/docs/sdk.md`。
P5. `packages/coding-agent/docs/settings.md`、`src/core/agent-session.ts` 的自动重试。
P6. `src/core/agent-session.ts` 的 compact、自动压缩与 hooks。
P7. `packages/agent/README.md` 的 tool terminate、shouldStopAfterTurn 和事件语义。
P8. `packages/coding-agent/src/core/sdk.ts` 的创建选项与实际 Agent 构造。
P9. `packages/telemetry/README.md`。
P10. `packages/coding-agent/src/core/sdk.ts` 的请求/响应 hooks。
P11. `packages/ipd/src/adapter/structured-submissions.ts`。
P12. `packages/ipd/src/adapter/pi-node-session-factory.ts`、`node-session-adapter.ts`、`pi-node-worker.ts`。
P13. `packages/server/README.md`；其 experimental 状态不能忽略。
P14. `packages/ipd/src/runtime/node-worker.ts`。
P15. `packages/ipd/src/control/pi-control-roles.ts`。
P16. `packages/ipd/src/adapter/node-context.ts`。
P17. `packages/ipd/src/environment/docker-provider.ts`、Profile 和 bridge。
P18. `packages/ipd/package.json` 与两个 legacy adapter。
P19. `packages/ipd/src/runtime/ipd-service.ts`、`workflow-runtime.ts`。
P20. 根 `package.json`、`packages/ipd/src/visualization/*`。
P21. `packages/ipd/package.json` 的 dist 导出与本地构建。

以上仓库来源统一固定在：
https://github.com/Nephamaster/pi/tree/07095ad825ef76cd4d9896180233659447d3ca4f

E1. OpenAI, Unlocking the Codex harness: how we built the App Server.
https://openai.com/index/unlocking-the-codex-harness/
E2. Anthropic, Effective harnesses for long-running agents.
https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
E3. Claude Agent SDK, Rewind file changes with checkpointing.
https://code.claude.com/docs/en/agent-sdk/file-checkpointing
E4. OpenHands SDK, Workspace.
https://docs.openhands.dev/sdk/arch/workspace
E5. OpenHands SDK, Conversation.
https://docs.openhands.dev/sdk/arch/conversation
E6. OpenHands SDK, Condenser.
https://docs.openhands.dev/sdk/arch/condenser
E7. LangGraph, Persistence.
https://docs.langchain.com/oss/javascript/langgraph/persistence
R1. 用户提供的最新Run诊断及日志摘录，`20260916T065437175Z`。

本报告没有运行完整仓库构建、真实Docker或新架构端到端测试。它给出的是基于源码与一手工程资料的重构设计，性能收益、代码删除量和原生行为兼容性必须由上述测试确认。
