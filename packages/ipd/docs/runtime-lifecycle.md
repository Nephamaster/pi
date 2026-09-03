# Runtime 生命周期与状态机

本文描述 `IpdRuntime`、`GraphEngine`、Workspace Lock 和 Ledger 状态机当前实际行为。

## 1. 运行主体

```text
IpdRuntime
  ├─ start：资产准备 → Planner → GraphEngine
  ├─ 内部 resume：由用户专用 `/ipd-resume` Command 调用 → GraphEngine.resume
  ├─ status：只读 Snapshot
  └─ cancel：GraphEngine.cancel

GraphEngine
  ├─ 计算 Ready Attempt
  ├─ 获取 Workspace Lock
  ├─ 调用 NodeRunner
  ├─ 登记 Candidate Artifact
  ├─ 执行局部 Gate / Final Gate
  └─ 处理返工、阻塞、恢复和取消
```

一个 Workflow Node 可以产生多个 `NodeInstanceRecord`。每个记录代表一次 Attempt，而不是同一记录被反复重置。

## 2. Run 状态

```text
planning
  ├─→ compiling
  ├─→ failed
  └─→ cancelled

compiling
  ├─→ ready
  ├─→ failed
  └─→ cancelled

ready
  ├─→ running
  ├─→ failed
  └─→ cancelled

running
  ├─→ waiting_user
  ├─→ replanning
  ├─→ succeeded
  ├─→ failed
  └─→ cancelled

waiting_user
  ├─→ running
  ├─→ replanning
  ├─→ failed
  └─→ cancelled

replanning
  ├─→ ready
  ├─→ failed
  └─→ cancelled
```

`succeeded`、`failed`、`cancelled` 是不可逆终态。

| 转换 | 触发者 | 主要 Ledger Event |
|---|---|---|
| 创建 planning | WorkflowPlanner | `run_created` |
| planning → compiling | WorkflowPlanner | `run_status_changed` |
| compiling → ready | `freezeWorkflow()` | `workflow_frozen` |
| ready → running | GraphEngine | `run_status_changed` |
| running → waiting_user | GraphEngine / BudgetController | `run_status_changed`、`escalation_created` |
| waiting_user → running | 用户 `/ipd-resume` → GraphEngine.resume | `escalation_answered`、`run_status_changed` |
| running/waiting_user → replanning | Staff 或用户请求计划修订 | `decision_recorded`、`run_status_changed` |
| replanning → ready | `amendWorkflow()` | `workflow_amended` |
| running → succeeded | Final Gate PASS | `run_status_changed` |
| 非终态 → failed/cancelled | Runtime 控制路径 | `run_status_changed` |

Tool 对外将 planning、compiling、replanning、ready、running 统一显示为 `running`，但 Ledger 保留内部状态。

## 3. Node Attempt 状态

```text
pending → ready → running
                    ├─→ gate_checking → gate_reviewing → succeeded
                    ├─→ rework_pending → 新 Attempt
                    ├─→ blocked → 新 Attempt / failed / cancelled
                    ├─→ failed
                    ├─→ interrupted → 新 Attempt / failed / cancelled
                    └─→ cancelled

gate_checking / gate_reviewing
  ├─→ rework_pending
  ├─→ blocked
  ├─→ failed
  ├─→ interrupted
  └─→ cancelled
```

`succeeded`、`failed`、`cancelled` Attempt 记录本身不再变化。返工会创建 `attemptNumber + 1` 的新记录。

### 3.1 创建 Attempt

`createReadyAttempts()` 只考虑：

- 没有历史 Attempt 的 Node；
- 最新状态为 `rework_pending`、`blocked` 或 `interrupted` 的 Node。

同时必须满足：

1. 所有 `dependsOn` Node 的最新 Attempt 是 `succeeded`；
2. 每项 Input 都能找到对应生产 Node 的 `accepted` Artifact；
3. 非 interrupted 的质量 Attempt 数没有达到 `rework.maxAttempts`；
4. 当前 Run 仍是 ready/running。

Ledger 强制执行 Attempt Number 连续递增，不能跳号或覆盖旧记录。技术中断会保留旧执行记录并创建新编号，但 interrupted 记录不计入质量返工额度。

### 3.2 执行阶段

Execution Node 输入包括：

- 冻结任务和 Workflow Hash；
- 具体 AgentCard Snapshot；
- Node 分配的 Skill Snapshot；
- accepted 上游 Artifact Manifest；
- 所有针对该 Node 的 `retry_node` Decision rationale；
- Node Token/Timeout Budget；
- Graph AbortSignal。

NodeRunner 返回成功提交或结构化 Failure。Agent 不能直接把 Node 写为 succeeded。

## 4. Artifact 可见性

Execution 成功后，Runtime 根据当前文件创建 Manifest，并登记：

```text
Artifact status = candidate
```

Candidate 不满足下游 Input 条件。只有局部 Gate PASS 后：

```text
candidate → accepted
Node Attempt → succeeded
```

Gate REWORK、BLOCKED、失败或无效结果会把 Candidate 标记为 `rejected`。Rejected 文件可以留在工作区用于审计，但不会作为正式输入。

## 5. Gate 状态

```text
pending
  → mechanical_checking
       ├─→ mechanical_failed
       ├─→ blocked
       ├─→ interrupted
       └─→ semantic_reviewing
              ├─→ passed
              ├─→ failed
              ├─→ inconclusive
              ├─→ blocked
              └─→ interrupted
```

当前 Ledger 不允许终态 Gate 再迁移。返工后的新 Attempt 会创建新的 Gate Run。

Gate PASS 还受到 Ledger 事务检查：

- 至少有机械和语义 Criterion；
- 所有 Criterion 都是 PASS；
- 每条语义结果关联 Reviewer Instance；
- Reviewer 已是 completed。

## 6. Reviewer 状态

```text
pending → running → completed
                  ├─→ failed
                  ├─→ cancelled
                  └─→ interrupted
```

DynamicGateEvaluator 当前把 Reviewer 调用失败转换为 BLOCKED Review Submission，GraphEngine 通常仍登记该 Reviewer 为 completed，并在结果中保存 BLOCKED 内容。Repository 仍支持 failed/cancelled/interrupted 状态，供其他调用路径和未来 Adapter 使用。

## 7. 调度循环

GraphEngine 主循环按以下顺序执行：

```text
检查 Abort
  → 读取最新 Snapshot
  → BudgetController.assess
  → 若全部 Node succeeded：执行 Final Gate并返回
  → 计算所有 Ready Attempts
  → 并行 executeAttempt
  → 读取状态
  → waiting/failed/cancelled 时停止
  → 否则进入下一轮
```

如果没有 Ready Attempt、仍有未成功 Node 且没有明确失败，Run 以 `workflow_stalled` 失败。

## 8. Fan-out 与 Fan-in

成功依赖由 `dependsOn` 和 typed Artifact Input 决定。

```text
           ┌─ B ─┐
A accepted ┤     ├─ D
           └─ C ─┘
```

B、C 依赖 A，A Gate PASS 后可同时 Ready。D 只有在 B、C 都 succeeded 且两个 accepted Artifact 都存在时才 Ready。

GraphEngine 使用 `Promise.all()` 启动同一轮 Ready Attempts；真正是否重叠还取决于 Workspace Lock。

## 9. Workspace Lock

Lock Request 包含：

```ts
interface WorkspaceLockRequest {
  ownerId: string;
  readScopes: string[];
  writeScopes: string[];
  usesBash?: boolean;
}
```

冲突规则：

- read/read 不冲突；
- write/write 范围重叠时冲突；
- write/read 范围重叠时冲突；
- Scope 父子包含也算重叠；
- 队列避免后来的冲突请求越过更早等待者；
- Abort 会移除等待请求。

### 9.1 Bash 为什么保守

如果 Node Tool 包含 `bash`，Lock Manager 将请求规范化为：

```text
readScopes = ["."]
writeScopes = ["."]
```

因此 Bash Node 会与所有工作区读写 Node 串行。这是因为当前 Runtime 无法从任意 Shell 命令静态推导真实文件副作用。

仅使用 read/write/edit 等已知 Tool 且声明不冲突的精确 Scope，才能获得并行执行。

## 10. 技术失败与重试

NodeRunFailure 会转换为统一 IpdFailure，并带 `retryable`：

- provider、timeout、missing/invalid submission 可重试；
- configuration、auth 等默认不可重试；
- blocked 使用独立路径；
- aborted 进入取消。

可重试且剩余 Attempt 时：

```text
running → rework_pending
记录 gate_rework / retry_node Decision
下一轮创建新 Attempt
```

不可重试或已耗尽时：

```text
Attempt → failed
按 node.routes.exhausted：Staff 决策 / user replan / fail
```

Artifact 文件构建或 Manifest 校验失败使用 `artifact_error`，也可以在剩余 Attempt 内重试。

## 11. 质量返工

机械或语义 Gate 返回 REWORK 时：

```text
Candidate → rejected
Attempt → rework_pending
Decision(type=gate_rework, action=retry_node)
下一 Attempt 收到 Reviewer feedback
```

质量 Failure Category 是 `quality_failure`，与 Provider/Tool 技术失败分开保存。

当前 Final Gate 非 PASS 会直接令 Run failed。虽然 Final Gate Schema 仍有 `routes.rework`，GraphEngine 尚未把已经 succeeded 的目标 Node 重新打开；这是当前限制，不应在文档中描述为已支持的 Final Gate 局部返工。

## 12. Blocked 路径

NodeRunner 或 Gate 返回 BLOCKED 时，Attempt 进入 blocked。

路由：

- `fail`：Run failed；
- `user`：直接创建用户 Escalation；
- `staff`：调用固定 Core 中优先具备 `delivery-governance` 的成员。

Staff 可返回：

- `retry_node`：保留 blocked，下一轮创建新 Attempt；
- `ask_user`：创建 user Escalation，Run → waiting_user；
- `fail_run`：Attempt 和 Run failed。

Staff 调用失败时，Runtime 降级为用户 Escalation，并保存失败原因。

## 13. Attempt 耗尽

当非 interrupted 的质量 Attempt 数达到 `maxAttempts`：

- `routes.exhausted: fail` → 使用最后 Attempt 的真实 Failure 终止 Run；
- `routes.exhausted: staff` → 调用 Delivery Staff，只允许 `request_replan`、`ask_user`、`fail_run`；`request_replan` 令同一 Run 进入 replanning；
- `routes.exhausted: user` → 创建带 `reason=attempts_exhausted` 的用户 Escalation；用户回答后同一 Run 进入 replanning。

Runtime 在 replanning 中重新调用 ST Planner。新候选必须通过 Compiler 和 `amendWorkflow()` 兼容性检查，随后作为新的 revision 回到 ready。旧 revision 与执行历史保留；只有用户目标发生实质变化才创建新 Run。

`target=staff` Escalation 不能由用户 `/ipd-resume`，也不会作为公开 question 返回。

### 13.1 Attempt Workspace

有写范围的 Attempt 在以下目录运行：

```text
<cwd>/.pi/ipd/runs/<run-id>/work/<node-id>/attempt-<n>/workspace/
```

- 非写入顶层路径通过只读链接访问原工作区；
- 写范围所在顶层目录复制到 Attempt 空间；
- 返工 Attempt 从上一 Attempt 的工作副本继续；
- Gate 在 Attempt 空间检查 Candidate；
- PASS 后仅把 Manifest 文件发布到当前 Run 的 `workspace/` 和 `accepted/<node-id>/<artifact-id>/`；失败文件不覆盖已验收工作区；
- Final Gate PASS 后把最终 Artifact 文件发布到当前 Run 的 `final/<node-id>/`；
- 新 Run 不复制项目旧 `outputs/`，避免其他 Run 的未验收结果进入当前上下文；
- `writeScopes: ["."]` 无法证明隔离，Runtime 直接拒绝，ST 必须收窄写范围。

## 14. Cancel 与 AbortSignal

活动 Run 有独立 AbortController。`start` 返回 Run receipt 后，后台 Planner/Graph 与该次 Tool Signal 解耦；显式 `cancel` 才终止后台 Run。用户 Command 触发的同步恢复路径仍使用调用上下文 Signal。

取消时：

1. abort Graph Controller；
2. 调用所有 active Attempt 的 `NodeRunner.abort()`；
3. 调用所有 active Gate 的 `GateEvaluator.abort()`；
4. 将仍处于 ready/running/gate 状态的 Attempt 标记 cancelled；
5. 将 Run 标记 cancelled。

如果 Run 已终态，cancel 返回当前 Snapshot，不改变状态。

## 15. 进程中断恢复

进程退出后，外层使用 `resume_run {runId}` 接管非终态 Run。`run()` 读取到状态为 running 的旧 Run 时执行 `recoverInterruptedWork()`：

- mechanical_checking / semantic_reviewing Gate → interrupted；
- running / gate_checking / gate_reviewing Attempt → interrupted；
- read-only 与 run-workspace-write 节点可以创建下一执行 Attempt；
- 受控 Run Root 内的 write/edit/Bash/PowerShell 可恢复，不按工具名称直接判为危险；
- Tool effect 为 external-idempotent/external-non-idempotent，或 Node 声明 externalActions 时，创建 `unknown_outcome` 用户 Escalation；
- 不从 AgentSession 流中间位置续传；恢复单位是完整 Attempt，但返工可继承上一 Attempt Workspace 和 `checkpoint.json`。

用户回答会成为该 Node 的 `retry_node` Decision 并进入下一 Session 上下文。恢复动作追加新 Event，不改写中断前记录，也不把 interrupted 执行计入质量返工额度。

## 16. 对应测试

| 行为 | 测试 |
|---|---|
| fan-out/fan-in、Lock、返工、取消、恢复 | `test/graph-engine.test.ts` |
| Workspace Scope 冲突、公平和 Abort | `test/workspace-locks.test.ts` |
| 状态转换和事务约束 | `test/ledger.test.ts` |
| blocked/resume/预算 | `test/graph-engine.test.ts` |
| Final Gate 与真实 Dynamic Gate | `test/gate-pipeline-e2e.test.ts` |
