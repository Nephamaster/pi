# 测试与验收

IPD 测试按“确定性协议 → Runtime 集成 → faux AgentSession → 真实 Skill”分层。普通回归不得依赖真实 Provider、API Key 或付费 Token。

## 1. 测试环境

- Node.js 24；
- 仓库根目录完成 `npm install --ignore-scripts` 或等价安全安装；
- Vitest 使用根 `node_modules`；
- SQLite 使用临时目录或 `:memory:`；
- AgentSession 集成使用 `fauxProvider()`；
- 测试创建的 Workspace、Session 和数据库在 afterEach 清理；
- 不把 `__pycache__` 或 Vitest results cache 作为资产保存。

## 2. 测试分层

### 2.1 Schema 和纯函数单元测试

不启动模型：

- AgentCard 默认值、Hash、Knowledge Base 和权限；
- Workflow Schema 和 Compiler Diagnostic；
- Scope、Hash、DAG；
- Criterion Aggregator；
- Artifact Manifest；
- Workspace Lock。

目标是让不变量失败停留在最小模块。

### 2.2 Repository 测试

使用真实 SQLite：

- Migration；
- 事务和回滚；
- 状态转换；
- 幂等；
- Snapshot；
- 关闭/重新打开；
- Event sequence；
- 一致性验证。

不调用 AgentSession。

### 2.3 Runtime 集成测试

使用 FakeNodeRunner / FakeGateEvaluator：

- fan-out/fan-in；
- Workspace Lock；
- Candidate 可见性；
- 技术重试和质量返工；
- blocked、用户 Command resume、cancel；
- 预算和 Hard Limit；
- 中断恢复。

这样 Scheduler 错误不会被模型或 Review 逻辑掩盖。

### 2.4 Faux AgentSession 测试

使用真实 AgentSessionNodeRunner 和脚本响应：

- 结构化提交 Tool；
- 模型/Skill/Prompt 装配；
- Tool 约束；
- Reviewer 和 Staff Decision；
- Timeout/Abort；
- Workflow Planner 修订；
- Dynamic Gate；
- Extension 四类 Action。

Faux Provider 会生成模拟 Usage，但不访问网络、不消耗真实模型额度。

### 2.5 真实 Skill E2E

使用真实 Skill 文件和真实确定性工具链，但仍可使用 faux 模型完成可重复编排。

领域特定 Workflow、Agent 响应、文件名和 Check 不应进入 `packages/ipd` Core。应放在项目级 `.pi/ipd/e2e/<case>/` 或独立 Eval 包。

验收真实：

- Skill Snapshot；
- AgentCard Asset Loader；
- ST Planner/Compiler；
- Graph 并行和返工；
- Skill 工具真实生成 Artifact；
- Gate 读取实际 review 内容；
- Ledger 和 Session Trace。

领域工具环境缺失时必须记录 limitation，不能用其他工具伪造通过。

### 2.6 真实模型 Eval

可选，必须显式授权：

- 明确 Provider、模型和 thinking level；
- 设置软预算和 Hard Limit；
- 记录真实 Token、成本、时间和 Gate；
- 不与普通回归混跑；
- 不在 CI 默认激活；
- 不把 faux Usage 当真实费用。

## 3. 运行精确测试

从 Package 目录：

```bash
cd packages/ipd
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" \
  --run test/compiler.test.ts
```

多个相关文件：

```bash
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" \
  --run \
  test/agent-card.test.ts \
  test/compiler.test.ts \
  test/workflow-planner.test.ts
```

修改测试文件后必须运行该文件并迭代到通过。

## 4. 仓库回归和 Check

仓库非 E2E 回归使用根脚本：

```bash
./test.sh
```

所有代码修改最终运行：

```bash
npm run check
```

`npm run check` 不运行测试；它执行 Biome、依赖/导入/lock/shrinkwrap 检查、TypeScript noEmit 和 browser smoke。

不要直接运行仓库根全量 Vitest 或 `npm test`：环境中的真实 endpoint/auth 变量可能激活不应运行的 E2E。

## 5. Test Fixture

`test/fixtures.ts` 提供：

- `compileCard()`；
- `createTestCards()`；
- `cardRef()`；
- `createValidWorkflow()`；
- `createCompileContext()`；
- TEST_SKILL 和 Tool Registry。

基础 Workflow 必须始终是当前 Schema 的最小合法实例，包括：

- requiredCapabilities；
- knowledgeBaseRefs；
- 固定 Staff Core；
- 一个或多个文件的 Artifact Contract；
- 机械和语义 Gate；
- 独立 Reviewer；
- Final Gate 覆盖；
- 合法预算。

测试非法行为时，从合法 Fixture 做最小修改，避免无关 Diagnostic 干扰断言。

## 6. FakeNodeRunner

Graph 测试 Fake 应：

- 记录 nodeId、attemptId、input Artifact、rework instructions、Token Budget；
- 可配置一次技术失败、一次 blocked、延迟和 Barrier；
- 写入真实临时文件，以便 Graph 创建 Manifest；
- 提供零成本 Trace；
- 支持 abort；
- 不调用 Provider。

并行验证不能只看 Workflow 拓扑，应记录 active 数量并确认 `maxActive >= 2`。同时注意广泛 read scope 或 Bash 会让 Workspace Lock 正确串行化。

## 7. FakeGateEvaluator

Scheduler 测试使用可脚本化 Gate：

- 默认 PASS；
- 按 Node/Attempt 返回 REWORK/BLOCKED；
- 返回完整机械和语义 Criterion；
- 语义结果带 Reviewer identity；
- 记录 Reviewer Token Budget；
- 支持 abort。

无 Reviewer identity 的语义 PASS 应由 GraphEngine 拒绝。

## 8. Compiler 测试清单

至少覆盖：

- 合法单链和 fan-out/fan-in；
- Skill name/hash；
- 固定 Staff Core；
- Staff Core 不得生产 Artifact；
- requiredCapabilities；
- knowledgeBase ownership/read scope；
- stale AgentCardRef；
- Tool/Skill/Permission 越权；
- Reviewer capability 和独立性；
- mechanical + semantic Gate；
- Artifact Binding 类型；
- Success DAG cycle；
- unreachable Node；
- Final coverage；
- Budget reserve；
- template/generated source 规则。

Diagnostic 断言优先检查 code 和 path，不依赖完整英文句子，除非测试专门验证 Planner 修订反馈。

## 9. GraphEngine 测试清单

- Ready 条件；
- accepted Artifact 才能下传；
- 非冲突分支并行；
- 冲突 Writer/Bash 串行；
- Gate REWORK 创建新 Attempt；
- retryable technical failure；
- non-retryable failure；
- blocked → Staff → user；
- 错误 escalationId 无状态变化；
- 正确 answer 恢复原 Node；
- cancellation 不启动下游；
- 只读中断自动恢复；
- 副作用中断等待；
- soft budget Decision；
- Reviewer Budget 收缩；
- Hard Limit 阻止新节点。

## 10. Gate 测试清单

- 机械失败不启动 Reviewer；
- Review Bundle 读取实际内容；
- 生产者排除；
- 多 Reviewer；
- required FAIL 不能 PASS；
- 冲突/INCONCLUSIVE 进入质量治理 Staff；
- Staff 不能强制 PASS；
- Final Gate 能发现局部 Gate 遗漏。

## 11. Ledger 一致性验收

每个完成的集成 Run 应执行：

```ts
expect(ledger.verifyRunConsistency(runId)).toEqual({
  ok: true,
  diagnostics: [],
});
```

还应检查：

- Event sequence；
- Workflow/Card Hash；
- accepted Artifact 对应 passed Gate；
- succeeded Attempt 有 accepted Artifact；
- Final Gate 和 Final Node；
- Session File 存在。

## 12. 新增回归测试

修复缺陷时：

1. 先找到最小失败层；
2. 增加会在旧代码失败的测试；
3. 只修改必要实现；
4. 运行精确测试；
5. 运行相邻集成测试；
6. 运行 `npm run check`；
7. 如果改变 Schema、状态、Tool Result 或资产路径，同步更新开发文档。

不要通过删除 intentional behavior、降低 Gate 或跳过证据来修测试。

## 13. 真实 Skill 验收模板

```markdown
# IPD Real-Skill Acceptance

## Environment
- Node/Python/renderer versions
- Skill name/hash/version
- Provider mode: faux or real

## Workflow
- Workflow id/version/hash
- Fixed Staff Core
- Node/AgentCard/capability mapping
- Parallel branches and scopes
- Gate Criteria and routes

## Results
- Run status
- Attempt and rework trace
- Gate status
- Final Artifact and Review Bundle
- Token/cost/duration
- Ledger consistency

## Artifact QA
- File/package validity
- Geometry/content checks
- Render/manual review
- Reproducibility

## Defects
- ID, severity, reproduction, cause, status

## Limitations
- Environment and unexecuted checks
```

验收报告必须区分：

- PASS；
- PASS_WITH_LIMITATIONS；
- FAIL；
- NOT RUN。

## 14. 当前验收状态

本文编写时，IPD 非阶段10全量精确回归为：

```text
18 test files
95 tests passed
```

该数字是开发快照，不是 API 契约。后续以当前测试命令实际输出为准。
