# 预算、阻塞、Escalation 与 Failure

IPD 把预算治理、缺少信息和执行失败分成不同控制路径。它们不会统一转换为“再试一次”。

## 1. Usage 归集

每个独立 AgentSession 完成后记录一条 `budget_usage`：

```text
staff
execution
review
rework
```

字段包括：

```text
input_tokens
output_tokens
cache_read_tokens
cache_write_tokens
total_tokens
cost_usd
duration_ms
provider / model / instanceId details
```

分类：

- Planner、Staff arbitration、Budget Decision、blocked Staff → `staff`；
- 第一次非 interrupted 的业务质量 Attempt → `execution`；
- Dynamic Reviewer → `review`；
- 后续非 interrupted 的质量 Attempt → `rework`；技术中断后的重放不自动改成质量返工。

Tool Result 汇总所有记录，不使用模型自报预算。

## 2. 预算定义

```ts
type BudgetDefinition =
  | { mode: "unbounded"; expectedDurationMs?: number }
  | {
      mode: "bounded";
      tokens: number;
      timeLimitMs: number;
      expectedDurationMs?: number;
      staffTokens: number;
      reviewerTokens: number;
      reworkTokens: number;
      hardTokenLimit?: number;
    };
```

`ipd.start` 的 `ifBudget` 默认是 false，因此默认生成 `mode=unbounded`。该模式仍记录全部 Usage，但 IPD 不执行 Token 或时间预算阻断，也不会回退 AgentCard 默认预算形成隐含限制。

只有用户明确设置 `ifBudget=true` 并同时提供 `tokenBudget` 与 `timeBudgetMs` 时，Runtime 才创建 bounded 预算。此时 `staffTokens/reviewerTokens/reworkTokens` 分别按 15%/20%/15% 预留，Compiler 要求 bounded Node 预算和三类预留不超过软预算。`expectedDurationMs` 只是预估，不是限制。

## 3. BudgetController

GraphEngine 每轮调度前调用：

```ts
BudgetController.assess(runId, workflow, snapshot, staffCore, context)
```

返回：

```text
continue
waiting_user
failed
```

`NoopBudgetController` 只汇总 Usage，不产生治理动作；默认 Runtime 使用 `StaffBudgetController`。当 Workflow 为 unbounded 时，StaffBudgetController 同样只汇总并直接 continue，不产生 80%/100% 阈值。

## 4. 软预算阈值

以下规则只适用于 bounded Workflow。

```text
totalTokens < 80%      → continue
totalTokens >= 80%     → budget_warning
totalTokens >= 100%    → budget_reached
```

每个阈值使用稳定幂等 key，只生成一次信号和一次有效 Staff Decision。

Staff 选择顺序：

1. 固定 Core 中 capability=`budget-governance`；
2. 否则按 ID 排序后的第一张 Staff Card。

允许动作：

### 4.1 `continue_over_budget`

记录 Decision，后续在同一阈值不再唤醒 Staff，Run 继续。

### 4.2 `reduce_future_budget`

Decision evidence 必须包含：

```json
{
  "reviewerTokenBudget": 4000
}
```

值必须是有限正数。实际 Reviewer 上限为：

```text
min(decision reviewerTokenBudget, workflow.globalBudget.reviewerTokens)
```

它只影响后续 Reviewer AgentSession，不修改冻结 Workflow。

### 4.3 `ask_user`

创建用户 Escalation，Run → waiting_user。用户回答并 Resume 后，已记录的预算 Decision 表示本阈值已处理，Run 会继续；当前实现不会把回答再次交给 Budget Staff 做第二次解释。

### 4.4 `fail_run`

Run → failed，Failure Category=`budget_exceeded`。

Staff 调用失败、缺少 Staff 或收缩 Decision 缺少数字证据时，Runtime 创建用户 Escalation。用户回答后，下一次 Budget Staff Decision 会收到 `userAnswer`，并使用新的 instanceId 形成独立 Trace；它可以据此继续、失败或提交带数值的 Reviewer 预算收缩。

## 5. Hard Limit

Hard Limit 检查优先于软预算：

```text
hardTokenLimit 存在
且 totalTokens >= hardTokenLimit
  → hard_limit_reached
  → 创建 user Escalation
  → running → waiting_user
  → 不启动新 Node 或 Final Gate
```

ST 没有继续越过 Hard Limit 的动作。Escalation Context 包含统一 `budget_exceeded` Failure。

如果用户 Resume 后限制没有外部变化，下一轮会创建新的序号 Escalation 并再次 waiting_user，不会绕过限制。

当前 Tool API 没有“修改已冻结 Hard Limit”Action，所以正常处理方式是取消 Run，或由未来受控 API 创建新预算策略。不要把 `/ipd-resume` 描述为可以提高 Hard Limit。

## 6. Blocked

Blocked 表示缺少信息、权限或外部依赖，不等于质量 FAIL 或 Provider Failure。

来源：

- Execution Node 返回 `failure.code=blocked`；
- Mechanical Check 返回 BLOCKED；
- Reviewer 选择失败；
- Reviewer 调用失败生成 BLOCKED Review；
- Criterion 聚合得到 BLOCKED；
- 恢复时副作用状态无法确认。

Node blocked 时先写：

```text
Node status = blocked
error.category = blocked
```

## 7. Blocked 路由

### 7.1 `routes.blocked: fail`

Run failed。

### 7.2 `routes.blocked: user`

创建用户 Escalation，Run → waiting_user。

### 7.3 `routes.blocked: staff`

Runtime 从固定 Core 中优先选择 `delivery-governance`，允许动作：

```text
retry_node
ask_user
fail_run
```

- retry_node：保留 Decision，Graph 下一轮创建新 Attempt；
- ask_user：创建 user Escalation；
- fail_run：Attempt 和 Run failed；
- Staff 调用失败：降级到 user Escalation。

## 8. Escalation

```ts
interface EscalationRecord {
  id: string;
  runId: string;
  nodeId?: string;
  status: "open" | "answered" | "cancelled";
  target: "staff" | "user";
  question: string;
  context: JsonValue;
  answer?: string;
}
```

Graph 路径使用：

```text
<runId>:escalation:<nodeId|run>:<attemptId|none>
```

预算路径使用带阈值和递增序号的 ID，允许用户回答后限制仍未解决时创建下一条开放记录。

## 9. 用户专用 Resume

模型 Tool Schema 不包含 `resume`、`answer` 或 `escalationId`。用户输入 `/ipd-resume <runId> <escalationId>` 后，Pi UI 采集回答并二次确认，再调用内部 Resume，并以 `user_answer_receipt/source=user_command` 记录来源。前置条件：

1. answer 非空；
2. Run 状态是 waiting_user；
3. escalationId 属于同一 Run；
4. Escalation 状态是 open；
5. Escalation `target=user`；
6. 当前 Pi Context 中存在与 Run 冻结 name+hash 一致的 Skill Snapshot。

成功时：

```text
Escalation open → answered
若关联且未耗尽的 blocked Node：记录 user_answer / retry_node Decision
若 reason=attempts_exhausted：记录 workflow_amendment_request，同一 Run → replanning
若 reason=unknown_outcome：把核验答案记录为 retry_node Decision，再从 Checkpoint 开始新 Session
若属于软预算：下一次 Budget Staff Context 接收 userAnswer，并以新 instanceId 再决策
其他合法恢复：Run waiting_user → running，Graph 从原阻塞点继续
```

错误 ID 在回答和状态写入前被拒绝，因此不会部分恢复。

## 10. IpdFailure

```ts
interface IpdFailure {
  code: string;
  category: IpdFailureCategory;
  message: string;
  retryable: boolean;
  runId: string;
  traceId: string;
  nodeId?: string;
  attemptId?: string;
  gateRunId?: string;
  reviewerInstanceId?: string;
  cause?: JsonValue;
  evidence?: EvidenceReference[];
}
```

Category：

```text
validation_error
compile_error
auth_error
provider_error
tool_error
timeout
artifact_error
quality_failure
blocked
budget_exceeded
cancelled
internal_error
```

不是每个 Category 当前都有 NodeRunner 直接来源。`tool_error` 已在统一类型中预留，但当前 NodeRunFailure 没有独立 `tool_error` 代码；普通 Tool/Session 异常通常落入 configuration_error 或 provider_error。

## 11. NodeRunFailure 映射

| NodeRunFailure | Category | retryable |
|---|---|---|
| `configuration_error` | `validation_error` | false |
| `auth_error` | `auth_error` | false |
| `provider_error` | `provider_error` | true |
| `blocked` | `blocked` | false，走 blocked 路径 |
| `missing_submission` | `validation_error` | true |
| `invalid_submission` | `validation_error` | true |
| `timeout` | `timeout` | true |
| `aborted` | `cancelled` | false |

Artifact 文件或 Manifest 失败由 GraphEngine 创建 `artifact_error`，在剩余 Attempt 内可重试。

## 12. 不同失败轨迹

### 12.1 Provider 短暂失败

```text
running
  → provider_error(retryable)
  → rework_pending
  → Attempt 2
```

### 12.2 配置错误

```text
running
  → validation_error(non-retryable)
  → Attempt failed
  → exhausted route
```

### 12.3 质量失败

```text
Gate semantic FAIL
  → Artifact rejected
  → quality_failure
  → rework_pending
  → Reviewer feedback 注入 Attempt 2
```

### 12.4 缺少用户信息

```text
Node BLOCKED
  → Delivery Staff ask_user
  → Escalation open
  → waiting_user
  → exact /ipd-resume
  → Attempt 2
```

### 12.5 Hard Limit

```text
调度前 Usage >= Hard Limit
  → 不启动新节点
  → hard_limit_reached
  → waiting_user
```

## 13. 当前路由限制

- Final Gate 非 PASS 当前直接令 Run failed，不会重新打开目标 Node；
- Hard Limit 的用户回答不会修改冻结限制；软预算回答会重新交给 Budget Staff 解释；
- Tool API 没有在原 Run 上修改 Hard Limit 的 Action；
- Attempt Staging 不覆盖 Run Root 外的远程/文件副作用；此类中断进入 unknown_outcome，不盲目重放。

这些行为应按代码理解，不能从 Route 字段推断尚未实现的在线控制能力。

## 14. 对应测试

- `test/graph-engine.test.ts`：blocked、错误/正确 Resume、技术/质量路由、Hard Limit、Staff Budget；
- `test/dynamic-gate-evaluator.test.ts`：BLOCKED、冲突仲裁和质量治理 Staff；
- `test/ledger.test.ts`：Escalation、Failure JSON 和状态合法性；
- `test/agent-session-node-runner.test.ts`：Failure、Timeout、Abort；
- `test/ipd-extension-e2e.test.ts`：Tool 层 waiting、用户 Command resume 和 cancel。
