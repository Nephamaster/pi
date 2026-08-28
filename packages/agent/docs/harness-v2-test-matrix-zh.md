# Harness v2 提升测试矩阵（Harness v2 promotion test matrix）

QA1 清单：被 `44289550a feat(agent): promote durable harness API` 移除的测试。

本文档把每个移除的测试用例映射到以下 QA1 结果之一：

- **Covered（已覆盖）** — 该行为已被 v4 一致性（conformance）或其他当前测试覆盖。
- **Ported（已移植）** — 该用例已在 v4 API 下重写，或移到了 SQLite 包。
- **Inapplicable（不适用）** — 旧 API、实现细节或兼容路径被有意删除。
- **Uncovered（未覆盖）** — 该行为可能仍被需要，但在指定的实现包落地前无法移植。QA 之后会重新审视；实现包从设计派生自己的测试，不使用本矩阵。

QA1 不包含任何生产或测试变更。

## 摘要

| 领域 | 移除用例数 | 状态 |
|---|---:|---|
| Harness 运行时与流行为 | 37 | 在 `AgentHarness` 脚手架化期间，按设计大部分未覆盖；分配给 H/L/I/C/N 包。脚手架安全的配置由 F0 覆盖。 |
| 分支查询与损坏行为 | 6 | 核心查询语义已覆盖；有界 SQLite 验证缺口由 QA2 移植，JSONL 损坏行为由 J3 覆盖。 |
| 压缩辅助行为 | 2 | 由当前压缩/上下文测试覆盖。 |
| Memory/SQLite v4 一致性入口 | 3 | 已移植到 `packages/agent/test/harness/session/*` 和 `packages/session-backends/sqlite-node/test/conformance.test.ts`。 |
| 仓库/后端生命周期与 JSONL 行为 | 38 | Format-4 生命周期和崩溃/损坏行为由 v4 一致性和 J0–J3 覆盖；format-3 规范化和转换仍分配给 J4–J5。 |
| 会话聚合/上下文行为 | 17 | 由 v4 一致性加上当前上下文测试覆盖。 |
| SQLite 搜索 | 1 | 已移植到 SQLite 包搜索测试；旧扫描后端不适用。 |

## Harness 运行时与流测试

移除的文件：

- `packages/agent/test/harness/agent-harness-stream.test.ts`
- `packages/agent/test/harness/agent-harness.test.ts`

提升有意用 v2 脚手架替换了行为完备的遗留 harness。运行时操作方法必须拒绝并抛 `HarnessNotImplemented`，直到其所属包落地；见 `harness-v2.md` 第 20 节的公共方法所有权表。

| 移除的测试 | 分类 | 覆盖 / 后续 |
|---|---|---|
| snapshots stream options before provider request hooks | Uncovered | I1/I4/L3 之后的 H1/H4：assistant 请求执行必须快照流选项并运行请求钩子。 |
| chains provider request patches and supports deletion semantics | Uncovered | I1 + I4 拥有钩子聚合/效果适配器；H1 覆盖运行集成。 |
| uses updated stream options for save-point snapshots without mutating the active request | Uncovered | H3/H4/H6：检查点/延迟配置行为和工具续接快照。 |
| chains provider payload hooks | Uncovered | I1 + I4，然后是 H1 请求集成。 |
| constructs directly and exposes queue modes | Covered / Inapplicable | 直接构造被 `AgentHarness.create()` 有意替换。队列模式防御性配置由 `agent-harness-scaffold.test.ts` 覆盖（`keeps scaffold-safe configuration as defensive copies`）。 |
| rejects waiting before shutdown is requested | Inapplicable | 遗留 shutdown API 被删除。`waitForIdle` 属于 H5，目前由 F0 脚手架测试拒绝。 |
| shuts down active work permanently and idempotently | Uncovered | H5 拥有 close/abort/wait 结算。 |
| allows a hook to request shutdown without deadlocking its operation | Uncovered | I1/I2 之后的 H5 拥有从钩子/事件 close/abort 结算。 |
| allows a subscriber to request shutdown without deadlocking its operation | Uncovered | I2 之后的 H5 拥有被动监听器结算。 |
| does not start a provider request when shutdown occurs during before_agent_start | Uncovered | I1 之后的 H1/H5：run 前钩子取消/关闭行为。 |
| aborts and awaits active compaction without persisting its result | Uncovered | H5 + C1：压缩的中止协调（abort reconciliation）。 |
| aborts and awaits active tree navigation without moving the session leaf | Uncovered | H5 + N1：导航的中止协调。 |
| does not treat concurrent mutations as active operations | Uncovered | I3 lane 变更行和 H4 延迟写入/配置。 |
| awaits concurrent idle session mutations before shutdown resolves | Uncovered | I3/H5：close 前的变更行结算。 |
| shuts down an idle harness without modifying its durable session | Covered / Uncovered | F0 覆盖脚手架 `close()` 和无记录 create。H5 必须覆盖无写入的持久运行时关闭。 |
| drains one queued steering message at a time and emits queue updates | Uncovered | H3 队列/检查点/事件。 |
| appends before_agent_start messages and persists them | Uncovered | H1 `before_run` 初始消息捕获。 |
| abort clears steer and follow-up queues but preserves next-turn messages | Uncovered | H5 持久中止队列排空；H3 拥有队列状态。 |
| drains follow-up messages one at a time after the agent would otherwise stop | Uncovered | H3 检查点完成边界条件。 |
| settles thrown hook failures with persisted assistant error messages | Uncovered | I1 钩子隔离 + H1/H2 终止失败条目。 |
| refreshes model, thinking level, resources, system prompt, and active tools at save points | Uncovered | H3/H4/H6 检查点和延迟配置行为。 |
| orders pending listener session writes after agent-emitted messages | Uncovered | H4 延迟写入加上 I2 监听器投递。 |
| waitForIdle waits for external run settlement and awaited listeners | Uncovered | I2 之后的 H5。 |
| runs tool_call and tool_result hooks through the direct loop | Uncovered | L2/L3 工具阶段、I1 钩子、H6 持久工具事件。 |
| passes a static application context to harness tools | Uncovered | I4 效果上下文传递和 H6 工具执行。 |
| resolves async tool context providers for each turn snapshot | Uncovered | I4/H6。 |
| persists generated compaction usage | Uncovered | C1 手动压缩操作。 |
| persists hook-provided compaction usage | Uncovered | C1 加 I1 钩子。 |
| retries transient compaction errors and emits retry events | Uncovered | C1/C3 重试和事件集成。 |
| does not retry non-retryable compaction errors | Uncovered | C1/C3。 |
| exhausts transient compaction retries after maxRetries failures | Uncovered | C1/C3。 |
| retries transient branch summary errors and emits retry events | Uncovered | N1 导航/分支摘要恢复和重试行为。 |
| persists generated branch summary usage | Uncovered | N1。 |
| persists hook-provided branch summary usage | Uncovered | N1 加 I1 钩子。 |
| preserves app tool types for getters and update events | Covered / Uncovered | getter 防御性拷贝由 F0 脚手架测试覆盖。持久化的活跃工具选择和更新事件属于 H4/O1。 |
| validates constructor tool names | Uncovered | H4 拥有工具注册表加上持久化活跃工具验证。 |
| preserves app resource types for getters and update events | Covered / Uncovered | getter 防御性拷贝由 F0 脚手架测试覆盖。资源更新事件属于 O1/H0 事件接线。 |

## 分支查询与损坏测试

移除的文件：`packages/agent/test/harness/branch-query.test.ts`。

| 移除的测试 | 分类 | 覆盖 / 后续 |
|---|---|---|
| provides identical in-memory query semantics | Covered | v4 后端一致性：`supports bounded filtered and cursor-based queries`；内存一致性运行器。 |
| rejects corrupt parent chains in array-backed readers | Covered / Inapplicable | 旧的数组后端 reader 类型被删除。v4 JSONL 等价物由 `jsonl.test.ts` 覆盖：`rejects an imported entry that references a missing parent` 覆盖缺失父级重放，`rejects a lane-bound entry that does not chain to the lane leaf` 覆盖 lane 尾部父级链接。v4 JSONL 重放的环一致性不适用，因为顺序重放期间条目不能引用未来的父级。 |
| provides identical JSONL query semantics | Covered | J1/J2 JSONL v4 存储/仓库测试加后端一致性覆盖正常有界分支查询。 |
| does not decode SQLite branch entries outside query bounds | Covered | 移植到 `packages/session-backends/sqlite-node/test/branch-query.test.ts`：`does not decode entries outside bounded branch queries` 损坏越界 payload 和分支缓存成员，证明有界读取只解码请求的行，并证明无界读取仍拒绝断裂的链。 |
| validates SQLite entries before filtering and limiting branch results | Covered | 移植到 `packages/session-backends/sqlite-node/test/branch-query.test.ts`：`validates entries before branch query filters and limits` 证明窗口内损坏条目在 `type`、`customType` 和 `limit` 过滤能掩盖它们之前被拒绝。 |
| does not validate SQLite ancestors beyond newest-first stop bounds | Covered | 移植到 `packages/session-backends/sqlite-node/test/branch-query.test.ts`：`does not validate ancestors beyond newest-first stop bounds` 证明 `stopAtId` 和 `stopAtType` 读取可以返回有效后缀，而无界读取仍拒绝缺失父级和环形祖先前缀的损坏。 |

## 压缩辅助测试

提升期间从 `packages/agent/test/harness/compaction.test.ts` 移除的用例。

| 移除的测试 | 分类 | 覆盖 / 后续 |
|---|---|---|
| falls back to firstKeptEntryId when a compaction has no retained tail | Covered | 当前 `session/context.test.ts` 覆盖空 `retainedTail` 上下文行为；当前压缩测试覆盖切点和保留尾部准备。 |
| prepares custom and branch summary entries for summarization | Covered | 当前 `compaction.test.ts` 覆盖跨 custom、compaction 和 branch-summary 角色的 token 估算；`session/context.test.ts` 覆盖 custom 投影和分支摘要上下文。 |

## v4 一致性入口测试

移除/重命名的文件：

- `packages/agent/test/harness/experimental/session/memory.test.ts`
- `packages/agent/test/harness/experimental/session/sqlite.test.ts`

| 移除的测试 | 分类 | 覆盖 / 后续 |
|---|---|---|
| experimental memory conformance dynamic cases | Ported | `packages/agent/test/harness/session/memory.test.ts` 运行当前 v4 后端一致性套件。 |
| uses one injectable id generator across lane views | Covered | `packages/agent/test/harness/session/memory.test.ts` 保留这个聚焦的 v4 内存用例。 |
| experimental SQLite conformance dynamic cases | Ported | `packages/session-backends/sqlite-node/test/conformance.test.ts` 运行当前 v4 后端一致性套件。 |

## 仓库/后端生命周期与 JSONL 测试

移除的文件：

- `packages/agent/test/harness/repo.test.ts`
- `packages/agent/test/harness/session-backends.test.ts`

| 移除的测试 | 分类 | 覆盖 / 后续 |
|---|---|---|
| opens, deletes, and forks by metadata (memory) | Covered | v4 一致性：`creates lists and opens sessions`、`deletes sessions idempotently`、fork 用例。 |
| delegates full-session fork selection without opening the source | Inapplicable | 旧仓库优化被删除；v4 fork 行为由一致性覆盖。 |
| retains the opened aggregate instead of reloading for scoped reads | Inapplicable | 旧聚合缓存细节随遗留仓库被删除。 |
| builds context from the branch storage without loading complete history | Inapplicable / Covered | 旧分支存储优化被删除；v4 上下文行为由 `session/context.test.ts` 覆盖。 |
| rejects repository operations and session writes after disposal | Covered / Inapplicable | v4 核心 `SessionRepo` 契约没有可处置状态，内存/JSONL 仓库不实现永久处置。SQLite 处置是资源释放而非仓库毒化；`packages/session-backends/sqlite-node/test/repository.test.ts` 在 `closes active sessions when the repository is disposed` 中覆盖剩余适用行为，证明仓库处置后活跃会话写入被拒绝。 |
| supports lexical ownership with await using | Inapplicable | 旧测试覆盖被删除的内存仓库上的永久处置。v4 核心 `SessionRepo` 契约没有可处置表面，memory/JSONL 仓库不实现词法所有权。SQLite `await using` 是资源清理而非仓库毒化；活跃会话关闭由 `packages/session-backends/sqlite-node/test/repository.test.ts` 中的 `closes active sessions when the repository is disposed` 覆盖。 |
| serializes conflicting create and fork destinations | Covered | JSONL 测试覆盖针对同一目标并发的 create/create、create/fork 和 fork/fork 操作，加上失败操作后的预留释放。 |
| encodes custom session IDs used in filenames | Covered | J2 JSONL 仓库生命周期验证文件安全 id；`jsonl.test.ts` 拒绝无效的 coding-agent 文件名。 |
| allows appends to different sessions to run concurrently | Covered | J2/v4 仓库一致性和 JSONL 并发写测试覆盖被接受的并发写，不带旧 keyed 队列。 |
| caps concurrent operations across JSONL sessions at four by default | Inapplicable | 旧 JSONL keyed 操作队列实现细节被删除。 |
| allows overriding the JSONL concurrency limit | Inapplicable | 旧 JSONL keyed 操作队列实现细节被删除。 |
| rejects invalid JSONL concurrency limits | Inapplicable | 旧 `maxConcurrentOperations` 配置随 JSONL keyed 操作队列被删除。 |
| releases JSONL concurrency capacity after an operation fails | Inapplicable | 旧 JSONL keyed 操作队列实现细节被删除。 |
| serializes appends to the same session | Covered | v4 单写者/会话变更一致性和 JSONL 共享序列测试。 |
| uses listing as a barrier between accepted session operations | Inapplicable | 旧测试覆盖被删除的 JSONL `KeyedOperationQueue.enqueueBarrier()` 行为。V4 JSONL 有意不在仓库中保留已创建/打开的存储，也不序列化仓库操作；`harness-v2.md` 说明调用方必须等待有顺序依赖的操作，所以不应恢复列表屏障。替代的序列化不变量是按已打开会话存储的，已由后端一致性 `linearizes concurrent writes across two lanes` 加 JSONL 特定的 `persists concurrent cross-lane writes in shared sequence order` 覆盖。 |
| waits for every accepted session operation during disposal | Inapplicable | 旧测试覆盖被删除的 JSONL 后端级处置和 `KeyedOperationQueue.drain()` 行为。V4 JSONL 仓库不可处置，不保留已打开的存储，所以没有仓库级已接受操作集合可排空。替代的每会话追加序列化已由后端一致性 `linearizes concurrent writes across two lanes` 和 JSONL 特定的 `persists concurrent cross-lane writes in shared sequence order` 覆盖；harness close/恢复语义由 H5/O3 拥有，不是仓库处置。 |
| waits for accepted appends before disposal and rejects later writes | Inapplicable | 旧测试覆盖被删除的 JSONL 仓库处置：排空已接受追加，进入永久 disposed 状态，然后拒绝之后通过现有会话的写入。V4 JSONL 仓库不可处置，不保留已打开的存储，没有仓库级 closed 状态。每会话追加序列化仍由后端一致性 `linearizes concurrent writes across two lanes` 和 JSONL 特定的 `persists concurrent cross-lane writes in shared sequence order` 覆盖；close/排空/close 后拒绝语义属于 harness H5/O3，不是 `SessionRepo` 处置。 |
| parses once when opened and retains state across appends | Inapplicable | 旧 JSONL 内存聚合实现细节；v4 正确性由 reopen/共享序列测试覆盖。 |
| collects sessions below encoded cwd directories and lists by cwd | Covered | J2 元数据生命周期和列表测试覆盖 v4 JSONL 元数据和 cwd 过滤。 |
| fails loudly when listing a malformed session file | Inapplicable / Covered | 第 13 节现在要求尽力而为的列表：格式错误的头被跳过，不打开或重放会话。JSONL 测试覆盖跳过格式错误文件同时保留有效结果；直接 `open()` 仍拒绝它。 |
| rejects a missing active leaf when opened | Covered | JSONL 和 SQLite 测试覆盖缺失引用拒绝。 |
| opens, deletes, and forks by metadata (JSONL) | Covered | J2 JSONL 仓库一致性。 |
| persists header metadata through create, list, and fork | Covered | J0 codec 和 J2 仓库元数据测试。 |
| repository disposal closes its owned storage | Covered / Inapplicable | 旧内存仓库处置不适用，因为 v4 memory/JSONL 仓库不可处置，不拥有返回会话存储的生命周期。SQLite 是唯一可处置的仓库，因为它拥有 DB/租约资源；活跃会话关闭由 `closes active sessions when the repository is disposed` 覆盖，DB 关闭行为由现有 SQLite 连接生命周期测试覆盖。 |
| owns leaf navigation, labels, names, stats, and branch traversal | Covered | v4 一致性覆盖 lanes、最新 facts、标签、统计和分支查询。 |
| serializes concurrent appends into one parent chain | Covered | v4 一致性 `linearizes concurrent writes across two lanes`；JSONL 存储共享序列测试。 |
| includes assistant and summary usage in statistics | Covered | v4 一致性 `keeps latest-value facts and computes ledger statistics across lanes`、JSONL 存储和 SQLite 仓库统计测试。 |
| stops branch traversal at retained-tail compaction | Covered / Inapplicable | 分支查询停止语义在上下文投影之外仍被需要，由后端一致性 `supports bounded filtered and cursor-based queries` 通过跨 memory、JSONL 和 SQLite 的 `findEntriesOnBranch({ stopAtType: "compaction" })` 显式覆盖。保留尾部物化由上下文测试 `starts at the latest compaction and materializes its retained tail` 覆盖。旧的隐式 `getBranch()` 在保留尾部压缩处自动停止行为不适用，因为 v4 使用显式分支界限加上下文投影。 |
| writes headers and entries and reopens the aggregate | Covered | J1/J2 JSONL 存储/仓库测试。 |
| fails loudly for malformed headers and entries | Covered | 直接 JSONL 打开拒绝格式错误的头，不修改文件就拒绝完成但无效的变更；只有撕裂的最终 JSON 片段被修复。列表按第 13 节要求单独跳过格式错误的头。 |
| enforces entry uniqueness and does not recreate deleted files | Covered | v4 一致性拒绝重复 id；J2 生命周期覆盖删除/重新打开行为。 |
| scopes entry uniqueness to the session path | Covered | v4 仓库/会话隔离一致性。 |
| rejects non-object header metadata | Covered | Format-4 打开拒绝非对象头元数据，而列表跳过该格式错误文件。Format-3 规范化仍分配给 J4。 |

## 会话聚合与上下文测试

移除的文件：`packages/agent/test/harness/session.test.ts`。

| 移除的测试 | 分类 | 覆盖 / 后续 |
|---|---|---|
| appends messages and builds context in order | Covered | v4 一致性按父级/序列顺序追加条目；`session/context.test.ts` 覆盖上下文投影。 |
| reads entries forward from the requested sequence | Covered | v4 一致性 `supports bounded filtered and cursor-based queries`。 |
| tracks model and thinking level changes | Covered | 当前 `compaction.test.ts` 的 built-context 用例覆盖模型/思考变更；R2 reducer 测试覆盖有效配置。 |
| supports branching by moving the leaf and appending a new branch | Covered | v4 一致性 lane 隔离和 lane 移动用例。 |
| supports moving the leaf to root | Covered | v4 一致性 lane 生命周期/目标。 |
| reconstructs compaction summaries in context | Covered | `session/context.test.ts` 从最新压缩开始并物化保留尾部。 |
| supports moving with branch summary entries in context | Covered | `session/context.test.ts` 包含分支摘要上下文行为。 |
| persists compaction usage | Covered | v4 一致性统计加 JSONL/SQLite 统计测试。 |
| persists branch summary usage | Covered | v4 一致性统计加 JSONL/SQLite 统计测试。 |
| supports custom message entries in context | Covered | `session/context.test.ts` custom 投影覆盖。 |
| keeps custom entries in context entries but omits them from messages by default | Covered | `session/context.test.ts` custom 投影/默认省略覆盖。 |
| projects custom entries with configured custom-entry projectors | Covered | `session/context.test.ts` custom projector 覆盖。 |
| applies context entry transforms after default compaction selection | Covered | `session/context.test.ts` 压缩边界后的 transform 覆盖。 |
| normalizes session names | Covered | v4 一致性最新值 facts；JSONL 元数据测试覆盖名字元数据。 |
| supports labels and session info entries without affecting context | Covered | v4 一致性 facts/标签加 `session/context.test.ts` 上下文投影。 |
| rejects labels for missing entries | Covered | v4 一致性 `keeps latest-value facts and computes ledger statistics across lanes` 包含缺失标签拒绝。 |
| persists leaf changes and appended entries through the backend | Covered | v4 一致性 lane 移动，跨 memory/SQLite/JSONL 的 reopen/list/fork 用例。 |

## SQLite 搜索测试

从 `packages/agent/test/harness/sqlite-node.test.ts` 移除的用例。

| 移除的测试 | 分类 | 覆盖 / 后续 |
|---|---|---|
| searches canonical session entries by scanning | Ported / Inapplicable | 搜索移到使用 FTS5 的 `packages/session-backends/sqlite-node/test/search.test.ts`。旧扫描搜索后端被有意删除。 |

## 最终 QA 通过前的实现前提

这些包必须在 QA3 能重新评估上面未覆盖的行之前落地。它们不把本矩阵当作测试计划。

- **QA2**：完成存储/查询审计和有界查询损坏/验证行为、仓库/会话处置生命周期、列表/处置屏障、上下文投影之外的分支查询保留尾部语义的移植。
- **J3**：完成 JSONL 格式错误文件、撕裂尾部、缺失引用和生命周期/并发覆盖。
- **J4/J5**：v3 只读规范化和首次写入转换；包含格式错误的 v3/头元数据用例。
- **I1/I2/I3/I4/L1-L3**：运行时 harness 测试能返回之前所需的钩子/事件/变更/效果/循环原语覆盖。
- **H1-H8**：持久 run、队列、配置、wait/abort、工具、恢复和延迟 provider 运行时行为，原先由遗留 `agent-harness*.test.ts` 覆盖。
- **C1-C3/N1**：持久压缩和导航运行时行为，原先由遗留 harness 压缩/分支摘要测试覆盖。
- **O1/O2**：围绕恢复操作路径的完整事件/监视快照和运行时遥测。
