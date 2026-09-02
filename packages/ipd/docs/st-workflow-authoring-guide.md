# ST Workflow Authoring Guide

状态：V1 框架  
Runtime 版本：`1.0.0`  
运行时资产：`src/staff/workflow-authoring-guide.ts`

本手册定义固定 ST Core 如何把当前任务、Run Skill、通用数字员工池、预算和历史 Workflow Asset 转换为可编译的 `WorkflowDefinition`。它是 IPD 治理资产，不属于某个业务 Skill，也不属于某张 AgentCard。

## 1. 输入

ST Planner 必须同时理解：

- 用户任务、约束和验收目标；
- 当前 V1 强制传入的 Run Skill Snapshot；
- 固定 Staff Core；
- 已加载的通用 AgentCard Pool；
- 全局软预算、可选 Hard Limit 和预期时长；
- 可参考的 Workflow Asset；
- 上一版候选和 Compiler Diagnostic。

## 2. 编排步骤

1. 从最终验收目标识别 Final Artifact。
2. 识别需要独立语义判断的中间业务 Artifact。
3. 围绕业务 Artifact 划分 Execution Node，不为脚本、复制、转换等纯机械动作单独建节点。
4. 建立成功 Artifact DAG，识别并行分支、写范围冲突和汇聚依赖。
5. 根据职责边界、能力、适用场景、原则、提示范式、知识库、模型、Tool、权限和预算选择数字员工，并显式填写 `requiredCapabilities` 与 `knowledgeBaseRefs`。
6. 为每个节点定义输入、primary/review 输出、最小权限、预算和有限返工；Node `readScopes` 必须覆盖被引用知识库的路径。
7. 同时定义机械 Criterion 和语义 Criterion，确保生产者与 Reviewer 独立。
8. 区分技术失败、质量返工、阻塞、预算、耗尽和用户升级路径。
9. 定义 Final Artifact Node 和覆盖全部用户验收目标的 Final Gate。
10. 保留 Runtime 提供的固定 Staff Core 和全局预算，提交完整候选并根据 Compiler Diagnostic 修订。
11. 使用预载模板或上一版候选时，显式删除不再属于新候选的旧 Node，并同步修订依赖、输入、路由与 Final Artifact 引用；不能为了规避不可达诊断而保留无业务价值节点。

## 3. 数字员工选择原则

- AgentCard 是独立员工资产，不属于当前 Skill 或 Workflow。
- Workflow 对 AgentCard 的引用只表示本次任务分配。
- Run Skill 可以分配给本次节点，不应通过员工命名制造永久绑定。
- 优先选择职责专精、非职责互斥并能被其他角色独立校验的员工。
- 实现者不能成为自己的 Reviewer；研究、设计、实现和验证不应合并为一个通用 Agent。
- 权限、Tool 或知识范围不足时必须换人、重划节点或升级，不能依靠 Prompt 要求越权完成。

## 4. Gate 设计原则

- 每个 Execution Node 至少有一个机械 Criterion 和一个语义 Criterion。
- Criterion 在 Workflow 冻结前确定，运行期间不能临时改写。
- 机械检查验证可确定事实；Reviewer 检查实际 Artifact 的语义质量。
- PASS 要求所有 required Criterion 有充分证据。
- 证据不足使用 INCONCLUSIVE；信息、权限或材料缺失使用 BLOCKED。
- 重试耗尽不能转化为 PASS。

## 5. 提交前检查

- 每次 Tool Call 都已对照其暴露的 JSON Schema，必填字段完整，不包含未声明字段，字段位于正确对象层级；
- Workflow 业务 DAG 中只有 Execution Node；
- 所有 AgentCard、Skill、Tool、Check、路由和依赖可解析；
- 每个节点都有 primary 和 reviewable 内容；
- 成功依赖无环，Final Artifact 可达；
- 并行节点 Workspace Scope 不冲突；
- 返工次数有限且目标有效；
- Final Gate 覆盖所有 acceptance criteria；
- `staff.core` 与 Runtime 提供的固定 Staff Core 完全一致；
- `globalBudget` 与 Runtime 提供的预算完全一致。

## 6. Compiler 反馈

Compiler 是确定性裁判。候选被拒绝时，ST 必须根据结构化 Diagnostic 修改 WorkflowDefinition，不得争辩、删除准出标准或绕过不变量。

Tool Schema 校验发生在分段进入 Builder 之前。提交失败时，ST 必须读取 Tool Result 中全部缺失、多余和非法字段，只修正受影响分段后重新提交，不能原样重复无效参数。Runtime 按 Assistant Turn 累计连续失败；同一轮的多个无效 Tool Call 只算一次，以保留模型读取反馈并修正的机会。

后续版本可以继续补充风险裁剪、模板选择、人员成本和历史指标，但不能改变员工、Skill、Workflow 和 Ledger 相互独立的资产边界。
