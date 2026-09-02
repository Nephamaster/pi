# Preset AgentCard Pool

这些 AgentCard 是与具体 Skill 和 Workflow 解耦的通用数字员工资产。文件名、ID、职责和 capability 描述长期专业角色，不表示员工归属于某项 Skill。

## Fixed Staff Core

- `staff-workflow-architect`：Workflow 设计与组织边界；
- `staff-delivery-governor`：资源、预算、阻塞和升级治理；
- `staff-quality-governor`：Reviewer 组织、证据仲裁和最终质量治理。

默认 Runtime 将所有带 `staff-core` capability 的 Card 固定为 ST Core，并要求其中存在 `workflow-planning` 成员。ST 生成的 Workflow 不能替换这组引用。

## Specialist Employees

- `research-synthesist`：研究范围、来源评估和证据综合；
- `narrative-architect`：论证结构、信息层级和受众转译；
- `visual-system-designer`：视觉系统、Token、层级和品牌连续性；
- `data-visualization-engineer`：数据验证、可视化和可复现图形交接；
- `implementation-engineer`：受约束的软件与配置实现；
- `verification-engineer`：与实现职责互斥的测试和回归验证；
- `artifact-production-engineer`：依据 Run Skill 确定性构建最终格式化 Artifact；
- `evidence-reviewer`：只读、Criterion 级证据评审；
- `accessibility-reviewer`：只读、媒介相关的可访问性评审。

## Asset Boundary

```text
AgentCard  定义谁能做什么以及不能做什么
Skill      定义某类工作的方法与工具链
Workflow   在一次任务中分配员工、Skill、Artifact 和 Gate
Ledger     记录这次运行实际发生了什么
```

AgentCard 的 `skills` 缺省为空。本次 Run Skill 可以由 Workflow 分配给任何权限和能力适合的员工；只有确属员工长期固有授权的附加 Skill 才应写入 Card。

每张预置 Card 都应保留以下专业信息：

- 角色定位和适用场景；
- 职责与非职责；
- capability 和工作原则；
- 典型交付物；
- promptProfile；
- knowledgeBases；
- 模型规格、Tool、权限和预算。

员工职责应尽可能互斥，并通过独立角色相互校验。例如 `implementation-engineer` 负责实现，`verification-engineer` 负责挑战和复现，二者均不得审批自己的 Artifact。
