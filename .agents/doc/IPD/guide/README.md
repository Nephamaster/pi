# 基于组织流程的多智能体可控协作实现指导

**合稿审阅版 v0.2 · 第 01—20 章**  
合稿日期：2026-09-22

面向在极简 Agent Harness 上建设受控协作的开发人员与编码 Agent。本稿保留五个部分的论证、工程边界、逻辑契约和验收场景；它是方法与实现指导，不是华为内部 IPD 手册，也不是声称某个现有运行时已经具有全文全部能力。

## 阅读与证据约定

**一条核心主线。** 以适合任务的组织规则明确责任、输入、交付和质量边界，专业成员在授权范围内完成工作，Runtime 以真实记录维护采用、准出、返工、等待和收口。复杂组织是可选的实现方式，不是所有任务的默认负担。

**三个不得混淆的层次。** 正文的目标要求说明应当如何实现；“源码观察”只说明对应固定版本中读到的路径；历史实验和示例测试只证明明确记录的场景。模型自评、测试表格、配置字段或本文成稿，都不替代系统验收和净收益对照。

**正常连续性与灾后恢复。** 正常执行、等待、补正和质量返工保持原活跃 Session。宿主崩溃后，允许在核对执行权、历史、输入、环境与未确定动作后恢复同一逻辑会话的执行实例；不把重新发送原任务当作恢复。此项是用户已确认目标，不是当前代码已实现保证。

**本次编辑范围。** 对五部分全文进行了文本级贯通、关键正反例走查、来源编号消歧与导航合并。只对可由原文后续章节支持的歧义作局部澄清；修改前后和依据在[贯通检查记录](INTEGRATION-REVIEW.md)与[逐项修改表](EDITORIAL-CHANGES.md)中保留。未执行新的真实模型／Harness 系统测试；自研历史逐项 diff 与 PR 讨论的全覆盖审阅尚未完成，详见[历史覆盖边界](history/coverage.md)。

**代码与来源时点。** 第一部分保留原 `1f13b74...` 观察点，后续部分主要固定于 `e737e4b...`；历史 Run 审计依据 `3011e03...`，Run 本身没有可证明的 Git SHA。公开 Jiuwen 文档的版本只代表公开材料，不代表团队内部目标分支。附录中的“本批”“本轮读取”指原撰写批次的记录，不表示本次重新访问了所有网页或重跑了所有历史实验。

**规范性与示例。** “必须／不得”是相应支持范围内的控制要求；“建议”是有条件的实现选择。示例 YAML、类型和函数是逻辑说明，不共同构成一份可直接导入现有仓库的 Schema。它们的字段、配额及日期不是全平台固定标准；应按第 19、20 章实现并验证实际协议。

**引用规则。** 来源采用“原章节组—原编号”，如 `01-S02` 与 `3C-S02`。两者在原稿中曾使用相同短编号却指向不同文件，不能合并为一份证据。附录保留各批真实来源含义、版本和读取范围；重复访问同一资料不计为独立证据。

## 全文导航

**[第一部分　方法原理与使用策略](part-01-method-and-strategy.md#part01)**  
[01 IPD 的借鉴范围与控制机制](part-01-method-and-strategy.md#ch01) ｜ [02 何时使用受控协作，怎样确定治理强度](part-01-method-and-strategy.md#ch02)

**[第二部分　可演进资产体系](part-02-evolvable-assets.md#part02)**  
[03 资产分类、引用、发现与发布](part-02-evolvable-assets.md#ch03) ｜ [04 数字员工与参与者实例](part-02-evolvable-assets.md#ch04) ｜ [05 流程规范与具体工作流资产](part-02-evolvable-assets.md#ch05) ｜ [06 Skill、工具和验证资源](part-02-evolvable-assets.md#ch06)

**[第三部分　控制体系与运行时实现](part-03-runtime-control.md#part03)**  
[07 任务接入与治理准备](part-03-runtime-control.md#ch07) ｜ [08 运行对象、身份与控制权](part-03-runtime-control.md#ch08) ｜ [09 节点内上下文与持续工作](part-03-runtime-control.md#ch09) ｜ [10 工具执行与隔离环境](part-03-runtime-control.md#ch10) ｜ [11 交付、证据与跨节点信息流](part-03-runtime-control.md#ch11) ｜ [12 阶段评审、问题与定点返工](part-03-runtime-control.md#ch12) ｜ [13 调度、并行、汇聚与运行收口](part-03-runtime-control.md#ch13) ｜ [14 错误分类、重试、暂停、取消和恢复](part-03-runtime-control.md#ch14) ｜ [15 团队工作包与受控子 IPD](part-03-runtime-control.md#ch15) ｜ [16 治理团队、评审内部流程与受控变更](part-03-runtime-control.md#ch16)

**[第四部分　效率、稳定性与验证](part-04-efficiency-stability-and-validation.md#part04)**  
[17 可观测性、容量与性能优化](part-04-efficiency-stability-and-validation.md#ch17) ｜ [18 质量验证与故障验证](part-04-efficiency-stability-and-validation.md#ch18)

**[第五部分　最小实现与跨 Harness 落地](part-05-minimal-implementation-and-harness.md#part05)**  
[19 从最小闭环到层级协作](part-05-minimal-implementation-and-harness.md#ch19) ｜ [20 Harness 适配与运维发布](part-05-minimal-implementation-and-harness.md#ch20)

[术语与主要定义定位](appendices.md#terms) ｜ [跨章节实施链](appendices.md#reading-routes) ｜ [来源与原批验证范围](appendices.md#sources)

首次实施可先读第 01—02 章及第 19—20 章，再按能力涉及的第 07—16 章完成协议与反例；验证人员重点结合第 12—16 章和第 17—18 章，不以只读末尾验收表替代上下文。


---

