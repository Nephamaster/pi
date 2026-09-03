# Artifact、Check、Reviewer 与 Gate

Artifact 是节点之间唯一正式业务交接载体；Gate 是 Candidate Artifact 进入下游前必须满足的冻结准出契约。

## 1. Submission 与 Manifest

Execution Agent 通过 `submit_artifact` 提交 `ArtifactSubmission`：

```ts
interface ArtifactSubmission {
  id: string;
  runId: string;
  nodeId: string;
  attemptId: string;
  contractId: string;
  createdAt: number;
  inputs: string[];
  files: Array<{
    path: string;
    mimeType: string;
  }>;
  metadata: JsonValue;
}
```

Submission 是 Agent 声明，尚不能被信任。GraphEngine 调用 `createArtifactManifest()` 读取真实文件并生成：

```ts
interface ArtifactManifestFile {
  path: string;
  mimeType: string;
  sha256: string;
  size: number;
}
```

Manifest 使用实际文件大小和 SHA-256 替换 Agent 声明，并成为 Ledger 中的业务记录。

## 2. 文件路径和完整性

Artifact 文件必须：

- 使用相对 Workspace 文件路径；
- 不能是 `.`；
- 不能是绝对路径；
- 规范化后不能越出 Workspace；
- `realpath()` 后仍位于真实 Workspace 内，符号链接不能逃逸；
- 指向普通文件；
- 同一 Submission 中路径不能重复；
- 至少提交一个文件。

`validateArtifactManifest()` 重新检查：

- Schema；
- Contract ID；
- 规范化路径；
- 文件存在和类型；
- 当前大小等于记录大小；
- 当前 SHA-256 等于 Manifest Hash。

文件在 Manifest 创建后被修改，会得到 `artifact_size_mismatch` 或 `artifact_hash_mismatch`。

## 3. 文件清单与验收含义

Execution Node 可以提交一个或多个文件。Artifact 层不设置 `primary/review/evidence` 角色，也不根据文件数量推断业务意义。

Staff 在冻结 Workflow 时负责：

- 用 Mechanical Criterion 定义必须存在的文件、数量、格式、Schema 或其他确定性要求；
- 用 Semantic Criterion 定义 Reviewer 要检查的实际内容；
- 用 Final Gate 决定最终业务交付包含哪些文件。

Artifact View 只把二进制或结构化文件转换为 Reviewer 可读取的表示，不创建业务角色。文件没有 View Provider 时仍作为 reference 进入 Review Bundle，由 Reviewer 根据冻结 Criterion 判断证据是否充分。

## 4. Artifact 状态

```text
candidate → accepted
          → rejected
```

- Candidate：已登记但尚未通过局部 Gate；
- Accepted：Gate PASS，可成为下游输入；
- Rejected：Gate 未通过或结果无效，保留审计但不能下传。

Accepted 和 Rejected 是终态。

## 5. Mechanical Check

```ts
interface CheckExecutor {
  id: string;
  parameters: TSchema;
  execute(
    parameters: JsonValue,
    context: CheckExecutionContext,
    signal?: AbortSignal,
  ): Promise<{
    result: "PASS" | "FAIL" | "BLOCKED";
    evidence: JsonValue;
    message: string;
  }>;
}
```

Compiler 使用 Check 的 TypeBox Schema 验证 Workflow 参数；Runtime 使用同一个 Registry 找到 Executor。

默认 Runtime 当前只注册：

```text
artifact-integrity
```

它会对当前 Gate 的全部 Artifact 重新执行 Manifest 文件完整性检查。

MechanicalChecker 顺序执行 Criterion：

- 任一 FAIL → 整体 FAIL；
- 没有 FAIL 但存在 BLOCKED → 整体 BLOCKED；
- 全部 PASS → 进入语义阶段。

Check 抛错且不是外部 Abort 时，会转换为 BLOCKED Criterion，而不是假装 FAIL 或 PASS。

## 6. Review Bundle

机械全部 PASS 后，DynamicGateEvaluator 为每个 Artifact 构建 Review Bundle。

```ts
interface ReviewBundle {
  artifactId: string;
  generatedAt: number;
  materials: ReviewMaterial[];
}
```

默认限制：

```text
文本/JSON：1,000,000 bytes
图片：10,000,000 bytes
```

### 6.1 默认 View Provider

| Provider | MIME | 输出 |
|---|---|---|
| `builtin-text` | `text/*` | UTF-8 text，超限截断并标记 `truncated` |
| `builtin-json` | `application/json` | 解析后的 JsonValue，超限或非法 JSON 阻塞 |
| `builtin-image` | PNG/JPEG/GIF/WebP | Base64 ImageContent |

不支持的 MIME 会生成 `reference`；Provider 读取失败得到 `artifact_view_failed`。是否因此不能 PASS 由冻结 Semantic Criterion 和 Reviewer 决定，不由文件角色预判。

Bundle 构造前会再次验证 Manifest，因此 Reviewer 不会读取已经改变但仍沿用旧 Hash 的文件。

Manifest 创建阶段同时验证声明 MIME 的最小内容：JSON 必须可解析，`text/*` 必须是无 NUL 的 UTF-8，PPTX 必须具有 OOXML ZIP 文件头。失败返回 `artifact_content_invalid`，不会先登记 Candidate 再等 Review Bundle 报错。

当前精确 Review Bundle 未作为独立 Ledger 对象保存。Ledger 保存 Manifest、Reviewer 结果、Criterion 和 Session；Bundle 可以在文件未变化时从 Manifest 重建，但缺少当时 Bundle 自身的独立 Hash/快照。

## 7. Dynamic Reviewer 选择

ReviewerSelector 输入：

- 冻结 Gate；
- 冻结 AgentCard Pool；
- 被排除的生产者 AgentCardRef。

选择过程：

1. 排除生产者；
2. 排除没有任何 read scope 的 Card；
3. 按 Card ID/version 排序；
4. 把每个 Reviewer Requirement 按 `minCount` 展开为 slot；
5. 用确定性二分匹配求完整的全局互斥分配，一个 Gate Run 中同一 Card 只分配一次；
6. 若通用 slot 抢占了后续专用 Reviewer，分配器会回溯并改配，而不是使用贪心首匹配误报失败；
7. 将 Requirement 能覆盖的 semantic Criterion 分配给这些 Reviewer；
8. 任一 Criterion 未覆盖或数量不足时整体选择失败。

局部 Gate 排除当前生产者。Final Gate 排除 Workflow 全部 Execution AgentCard，因此最终 Reviewer 必须独立于所有生产节点。

Compiler 调用同一分配器，因此无法在编译期形成完整互斥分配的 Workflow 不会被冻结。返工 Gate 会把同一节点之前的 Criterion 结论与证据交给 Reviewer。上一轮 PASS 不是永久锁定，但改判 FAIL 必须引用新版 Artifact 的具体回归证据；已披露风险不能在冻结 Criterion 未要求时无依据升级为阻断项。

## 8. Reviewer AgentSession

每个 Assignment 创建独立 Reviewer AgentSession，输入包括：

- 任务；
- Workflow Hash；
- 分配后的 Gate semantic Criteria；
- 实际 Review Bundle；
- Run Skill；
- Reviewer AgentCard；
- Reviewer Token Budget；
- AbortSignal。

Reviewer 只能通过 `submit_review` 返回：

```ts
interface ReviewSubmission {
  decision: "PASS" | "FAIL" | "INCONCLUSIVE" | "BLOCKED";
  criteria: Array<{
    criterionId: string;
    result: "PASS" | "FAIL" | "INCONCLUSIVE" | "BLOCKED";
    evidence: JsonValue;
    rationale: string;
    requiredRework: string[];
  }>;
  unresolvedRisks: string[];
}
```

NodeRunner 校验：

- Criterion 不重复；
- 不包含未知 Criterion；
- 覆盖分配的全部 Criterion；
- Decision PASS 时不能有非 PASS Criterion。

Reviewer 调用失败会生成 BLOCKED Review，而不是丢失该 Reviewer 的结果。

## 9. 聚合规则

CriterionAggregator 按 Criterion 聚合全部 Reviewer 结果：

```text
结果缺失                         → ARBITRATE
同一 Criterion 出现不同结果      → ARBITRATE
任一 INCONCLUSIVE               → ARBITRATE
无冲突且存在 BLOCKED             → BLOCKED
无冲突且存在 FAIL                → REWORK
全部 Reviewer 全部 PASS          → PASS
```

`requiredRework` 去重后作为下一 Attempt 的反馈。

这不是多数投票：一个 required Criterion 的 FAIL 不会被更多 PASS 覆盖。

## 10. Staff 仲裁

ARBITRATE 时，从固定 Staff Core 中选择：

1. 排除所有生产者；
2. 优先 capability 包含 `quality-governance`；
3. 否则使用有序 Core 中第一张可用 Card。

允许动作只有：

```text
route_rework
block_gate
fail_run
```

没有 `pass` 动作，因此 ST 不能把 Reviewer 冲突或 INCONCLUSIVE 强制改成 PASS。

Staff Decision、证据、AgentCardRef、Session Trace 和 Usage 会写入 Ledger。

## 11. Gate 最终决策

### 11.1 Mechanical 非 PASS

- FAIL → `mechanical_failed`，局部 Node 进入质量返工；
- BLOCKED → Gate blocked，局部 Node 进入 blocked 路径；
- 不启动 Reviewer。

### 11.2 Semantic 决策

- PASS：Gate passed、Artifact accepted、Attempt succeeded；
- REWORK：Gate failed、Artifact rejected、Attempt rework_pending；
- BLOCKED：Gate blocked、Artifact rejected、执行 Staff/User 路径；
- INCONCLUSIVE/FAIL：局部无法合法 PASS，按当前 Runtime 失败或仲裁结果处理。

GraphEngine 额外拒绝以下非法 GateEvaluator 返回：

- 漏掉 Workflow 中的机械 Criterion；
- 机械通过后漏掉语义 Criterion；
- 机械失败后仍返回语义结果；
- 语义结果没有 Reviewer identity；
- 非全部 PASS 却返回 PASS。

## 12. 局部 Gate 与 Final Gate

局部 Gate：

- 只评估当前节点 Candidate；
- 排除当前生产者；
- PASS 后解锁当前 Artifact；
- 失败可以进入当前 Node 的有限返工。

Final Gate：

- 读取 `finalArtifactNodeIds` 的 accepted Artifact；
- 排除所有 Workflow 生产者；
- Criteria 必须覆盖全部用户 Acceptance Criteria；
- PASS 后 Run succeeded。

当前 Final Gate REWORK/BLOCKED 不会重新打开已经 succeeded 的业务 Node，而是令 Run failed。这与局部 Gate 的返工能力不同，是 V1 当前限制。

## 13. 新增 CheckExecutor

1. 使用 `defineCheckExecutor()` 定义 ID、参数 Schema 和执行函数；
2. 注册到 Runtime 的 `CheckExecutorRegistry`；
3. 把 `checks.list()` 交给 WorkflowPlanner/Compiler；
4. 确保 Check 是确定性或可重复验证的机械判断；
5. 增加参数 Schema、PASS/FAIL/BLOCKED、Abort 和错误转换测试。

默认 Runtime 当前没有配置文件式 Check 插件发现；新增 Executor 需要修改装配代码或使用自定义 Runtime Factory。

## 14. 新增 ArtifactViewProvider

实现：

```ts
interface ArtifactViewProvider {
  id: string;
  mimeTypes: string[];
  create(file, absolutePath, options): Promise<ReviewMaterial>;
}
```

Provider 应：

- 读取 hash-bound 文件；
- 设置正确 MIME；
- 对大小和解析失败显式报错；
- 能解析时返回 text/json/image 内容，不能解析时显式失败；
- 不修改 Artifact。

注册到 `ArtifactViewRegistry` 后，DynamicGateEvaluator 才能使用。

## 15. 对应测试

| 行为 | 测试 |
|---|---|
| Submission/Manifest/路径/Hash | `test/artifact.test.ts` |
| 默认 View 和 Bundle | `test/review-bundle.test.ts` |
| Check 参数与执行 | `test/mechanical-checker.test.ts` |
| Reviewer 选择、聚合、仲裁 | `test/dynamic-gate-evaluator.test.ts` |
| Ledger Gate 准出约束 | `test/ledger.test.ts` |
| 完整局部/Final Gate | `test/gate-pipeline-e2e.test.ts` |
