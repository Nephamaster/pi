# SQLite Ledger、幂等与恢复

IPD V1 使用 `node:sqlite` 的 `DatabaseSync` 保存单一运行事实源。会话文本、Tool 输出和 Dashboard 都不能反向推断或覆盖 Ledger 状态。

## 1. 数据库位置和初始化

默认 Runtime：

```text
${agentDir}/ipd/ipd.sqlite
```

可通过：

```ts
createDefaultIpdRuntime({ ledgerPath: "..." })
```

覆盖。

打开数据库时执行：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

随后执行未应用 Migration。

## 2. 表结构

| 表 | 作用 |
|---|---|
| `migrations` | 已应用 SQL Migration ID 和时间 |
| `ipd_runs` | Run 当前状态、任务、Skill、预算、WorkflowRef、Failure |
| `run_sequences` | 每个 Run 下一 Event sequence |
| `idempotency_keys` | Run 内写操作的 key、operation、请求 Hash 和返回值 |
| `workflow_versions` | 单 Run 当前 Workflow revision 的运行指针 |
| `workflow_revision_history` | 单 Run 追加式 Workflow revision 历史 |
| `agent_card_snapshots` | 当前编译 AgentCard Pool 的冻结 JSON |
| `node_instances` | 每个 Node Attempt 的编号、状态、Card、Session 和错误 |
| `artifacts` | Artifact Manifest、Manifest Hash 和 candidate/accepted/rejected |
| `gate_runs` | 局部或 Final Gate 的阶段状态与 Decision |
| `reviewer_instances` | Reviewer Card、状态、Session 和完整 Review 结果 |
| `criterion_results` | 机械/语义逐 Criterion 证据和 rationale |
| `decisions` | Workflow、返工、Staff、预算、用户回答等控制 Decision |
| `escalations` | Staff/User 问题、开放状态和回答 |
| `budget_usage` | 每次 AgentSession 的 Token、成本、时长和类别 |
| `ipd_events` | 单 Run 严格递增的不可变事件日志 |

表之间使用外键连接 Run、Attempt、Artifact、Gate 和 Reviewer。数据库保存 Artifact Manifest，不保存业务文件字节。

## 3. 状态表与 Event 表

状态表用于读取当前 Snapshot，例如：

```text
ipd_runs.status
node_instances.status
artifacts.status
gate_runs.status
reviewer_instances.status
```

`ipd_events` 记录每次已提交动作：

```text
run_created
run_status_changed
workflow_frozen
workflow_amended
workflow_planning_started
node_attempt_created
node_status_changed
artifact_recorded
artifact_status_changed
gate_run_created
gate_status_changed
reviewer_created
reviewer_status_changed
criterion_recorded
decision_recorded
escalation_created
escalation_answered
budget_usage_recorded
budget_warning
budget_reached
hard_limit_reached
```

用户专用 `/ipd-resume` 会追加 `user_answer_receipt` Decision；evidence 保存 Escalation ID、`source=user_command` 和接收时间。回答正文仍由 Escalation Record 保存。

状态更新和对应 Event 在同一 SQLite 事务中提交。Event 用于审计和一致性检查，不是第二套可写状态机。

## 4. Event Sequence

每个 Run 有独立的 `run_sequences.next_sequence`。

`appendEvent()`：

1. 读取 Run 和 next sequence；
2. 创建 eventId；
3. 写入 `(run_id, sequence)` 主键记录；
4. 把 next sequence 加 1。

因此单 Run Event 从 1 连续递增。不同 Run 之间不共享 sequence。

Event 继承 Run `trace_id`，并可附带：

```text
nodeId
attemptId
gateRunId
reviewerInstanceId
```

## 5. 事务边界

Repository 写方法使用：

```sql
BEGIN IMMEDIATE;
...
COMMIT;
```

任何异常执行 ROLLBACK。典型事务同时包含：

- 当前状态读取；
- 状态机或关系约束检查；
- 目标行 INSERT/UPDATE；
- Event 追加；
- 幂等记录写入。

Ledger 使用同步 SQLite API，但外层 AgentSession 和文件 I/O 仍是异步；只有已经完成的 Agent 结果才进入事务。

## 6. Idempotency

除 `createRun()` 外，大多数写方法接收：

```text
runId
idempotencyKey
```

Ledger 保存：

```text
operation
request_hash
result_json
```

重复调用规则：

- 相同 key、相同 operation、相同输入 Hash：返回首次保存的结果，不重复写状态或 Event；
- 相同 key 但 operation 或输入不同：抛出 `idempotency_conflict`。

`createRun()` 使用全局唯一 `create_idempotency_key` 和请求 Hash，因为 Run 尚不存在，不能写 Run 内 `idempotency_keys`。

Tool Controller 的 `toolCallId` 幂等与 Ledger 幂等不是一回事：前者当前只在进程内缓存整个 Tool Promise；后者保护已经进入 Ledger 的具体写操作。

## 7. 状态转换校验

状态合法边由 `ledger/state-machine.ts` 定义。Repository 在 UPDATE 前调用对应 assert：

- `assertRunTransition`；
- `assertNodeTransition`；
- `assertArtifactTransition`；
- `assertGateTransition`；
- `assertReviewerTransition`。

相同状态重复写被允许，但仍应使用相同幂等 key；非法边返回 `IpdLedgerError(code="invalid_transition")`。

Ledger 还执行关系约束，例如：

- Attempt Number 必须连续；
- Node Card 必须等于冻结 Workflow 引用；
- Gate 创建时 Attempt 必须在 gate_checking，Artifact 必须是 candidate；
- semantic_reviewing 前机械 Criterion 必须全部 PASS；
- Gate passed 前机械、语义 Criterion 和 Reviewer completed 必须齐全；
- Run succeeded 前 Final Artifact Node 和 Final Gate 必须通过。

## 8. Workflow 和 AgentCard Snapshot

`freezeWorkflow()` 只能在 Run=compiling 时调用，并在一个事务中创建 revision 1：

1. 写 `workflow_versions`；
2. 写当前 `CompiledWorkflow.agentCards` 全部 Card Snapshot；
3. 更新 Run WorkflowRef；
4. compiling → ready；
5. 追加 `workflow_frozen` Event。

`amendWorkflow()` 只能在 Run=replanning 时调用。它追加 `workflow_revision_history`、更新当前 `workflow_versions` 指针并令 Run 回到 ready。旧 revision、Attempt、Gate、Decision 和 Artifact 不会被覆盖。为避免旧执行状态被错误套到新计划：

- 已 succeeded 且有 accepted Artifact 的 Node 只有定义 Hash 完全不变时才能复用；
- 已经尝试但未 succeeded 的 Node 必须由 ST 使用新 Node ID 替换；
- 新候选仍必须完整通过 Compiler；
- Amendment 必须改变 Workflow Hash。

每次 Planner 初始、恢复或 Amendment 调用先追加 `workflow_planning_started`，其中的 planningCycle 使新 AgentSession、Usage 和幂等键不会与中断前的半完成规划冲突。初始规划恢复还会从最后一条 rejected workflow_candidate Decision 恢复合法候选作为下一轮 Builder 基线。

保存完整 Pool 而不只保存生产者，是因为 Dynamic Reviewer 需要在执行期从同一冻结池选人。恢复时不重新读取外部 Card 文件。

Snapshot Card Hash 来自完整规范内容，包括角色边界、Prompt Profile、Knowledge Base、模型、Skill、Tool、权限和预算。

## 9. RunSnapshot

`getRunSnapshot(runId)` 返回：

```ts
interface RunSnapshot {
  run: RunRecord;
  workflow?: WorkflowVersionRecord;
  workflowHistory: WorkflowVersionRecord[];
  agentCards: AgentCardSnapshotRecord[];
  nodes: NodeInstanceRecord[];
  artifacts: ArtifactRecord[];
  gates: GateRunRecord[];
  reviewers: ReviewerInstanceRecord[];
  criteria: CriterionResultRecord[];
  decisions: DecisionRecord[];
  escalations: EscalationRecord[];
  budgetUsage: BudgetUsageRecord[];
  events: IpdEventRecord[];
}
```

所有列表使用稳定 SQL ORDER BY。GraphEngine 每轮重新读取 Snapshot，避免以内存对象作为第二状态真相。

## 10. 一致性验证

`verifyRunConsistency()` 当前检查：

- Event sequence 从 1 连续且 next sequence 正确；
- Event traceId 等于 Run traceId；
- Run WorkflowRef 与 Workflow Snapshot 一致；
- Workflow 内容 Hash 正确；
- 非 planning/compiling Run 有冻结 Workflow；
- AgentCard Snapshot identity 和 Hash 正确；
- Node/Reviewer 引用存在于 Card Snapshot；
- succeeded Node 有 accepted Artifact；
- Artifact Manifest Hash 正确；
- accepted Artifact 有 passed Gate；
- passed Gate 有全 PASS 的机械和语义证据；
- succeeded Run 的 Final Artifact Node succeeded；
- succeeded Run 有 passed Final Gate。

它不重新读取 Artifact 文件，因此文件大小/内容变化需要调用 `validateArtifactManifest()` 检查。

## 11. Session 引用

Node Attempt 和 Reviewer Instance 保存：

```text
session_id
session_file
```

默认 Session 文件目录：

```text
<cwd>/.pi/ipd/runs/<run-id>/sessions/*.jsonl
```

Ledger 不解析 JSONL 判断业务状态。Session 用于追溯模型、Prompt、Tool 和回复；业务结论来自结构化 Submission、Manifest、Criterion 和 Decision。

## 12. 进程恢复

V1 不从流式生成的中间 token 位置续传 AgentSession。调用 `resume_run` 后重新进入 `GraphEngine.run()` 且 Run=running 时：

- 活动阶段 Gate → interrupted；
- running/gate_checking/gate_reviewing Attempt → interrupted；
- 新增恢复 Event，不改写旧记录；
- read-only 和 run-workspace-write 节点可从下一执行 Attempt 重放；
- 写节点文件位于当前 Run 的 Attempt Workspace；未通过 Gate 的文件不发布到该 Run 的共享 workspace/accepted；
- 受控 Run Root 内的 write/edit/Bash/PowerShell 不因为工具名称被判为外部副作用；
- external-idempotent、external-non-idempotent 或 Node 声明 `externalActions=true` 时进入 `unknown_outcome` 用户核验，不能盲目重放；
- 恢复单位是完整 AgentSession 执行；被 interrupted 的执行序号会保留，但不消耗 `maxAttempts` 的质量返工额度。

每个 Attempt 的 `attempt_workspace` Decision 记录 Workspace 与 `checkpoint.json` 路径。返工 Attempt 从上一工作副本继续，但下游仍只读取 accepted Artifact。

`pending`、`ready`、`rework_pending`、`blocked`、`interrupted` 等稳定状态由 Graph 调度逻辑继续处理。

## 13. 自动重试与人工确认

可以自动新建 Attempt 的典型情况：

- provider/timeout/missing submission 等 retryable Failure；
- Gate 质量返工；
- 用户回答后的 blocked Node；
- read-only 或 run-workspace-write 中断节点。

需要 Staff/User 决策：

- 缺少信息、权限或外部依赖；
- external action 中断后的结果核验；
- Attempt 耗尽时由 Staff 选择同 Run Amendment、ask_user 或 fail；质量上限不会被技术恢复绕过；
- Hard Limit 达到；
- Staff 无法自动解决阻塞。

## 14. Migration

当前 Migration：

```text
001_initial.sql
002_workflow_revisions.sql
```

Migration Loader 按代码中声明顺序执行。每项 Migration：

1. 检查 `migrations.id`；
2. 未应用时 `BEGIN IMMEDIATE`；
3. 执行 SQL；
4. 写 migration ID 和 ISO 时间；
5. COMMIT，失败则 ROLLBACK。

新增 Migration 时：

- 创建新的递增 SQL 文件，不能修改已发布 Migration 的语义；
- 加入 `loadIpdMigrations()`；
- 保证已有数据库可升级；
- 增加首次创建、重复打开、失败回滚和数据保留测试；
- Package build 需要继续复制 migration SQL 到 `dist/ledger/migrations`。

## 15. 只读检查示例

以下 SQL 用于调试，不应直接 UPDATE 数据库。

### Run 状态

```sql
SELECT id, trace_id, status, workflow_id, workflow_version, workflow_hash,
       failure_json, created_at, updated_at
FROM ipd_runs
WHERE id = 'run-id';
```

### Node Attempt

```sql
SELECT node_id, attempt_number, attempt_id, status,
       agent_card_id, session_file, error_json
FROM node_instances
WHERE run_id = 'run-id'
ORDER BY node_id, attempt_number;
```

### Gate 与 Criterion

```sql
SELECT g.id AS gate_run_id, g.gate_id, g.status,
       c.kind, c.criterion_id, c.result, c.reviewer_instance_id
FROM gate_runs g
LEFT JOIN criterion_results c ON c.gate_run_id = g.id
WHERE g.run_id = 'run-id'
ORDER BY g.created_at, c.created_at;
```

### Escalation

```sql
SELECT id, node_id, target, status, question, answer
FROM escalations
WHERE run_id = 'run-id'
ORDER BY created_at;
```

### Usage

```sql
SELECT category, SUM(total_tokens) AS tokens,
       SUM(cost_usd) AS cost_usd,
       SUM(duration_ms) AS duration_ms
FROM budget_usage
WHERE run_id = 'run-id'
GROUP BY category;
```

### Event Trace

```sql
SELECT sequence, type, node_id, attempt_id, gate_run_id,
       reviewer_instance_id, payload_json
FROM ipd_events
WHERE run_id = 'run-id'
ORDER BY sequence;
```

## 16. 对应测试

- `test/ledger.test.ts`：Migration、事务、幂等、状态约束、Snapshot、重新打开和一致性；
- `test/graph-engine.test.ts`：Attempt 恢复、阻塞、取消和重新调度；
- `test/hash.test.ts`：规范 Hash；
- `test/artifact.test.ts`：Manifest 文件级完整性。
