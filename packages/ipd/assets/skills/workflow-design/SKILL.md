---
name: workflow-design
description: 将保留的 TaskInput 与已选 ProcessSpec 转化为完整工作流；使用 IPD 私有草稿工具逐节点构建、校验并提交，供工作流架构设计师使用。
---

# 工作流设计方法

## 使用前提与边界

本 Skill 只规定设计方法，不授予工具、员工或流程控制权限。准备阶段可以先加载方法；拿到完整 TaskInput、ProcessSelection、ProcessSpec、Run Skill 和可用资产后，才开始任务化设计。缺少其中必要内容时，不提前提交空壳工作流。

你的成果是本 Run 的 Workflow 候选。不得修改任务和选型，不裁剪规范，不产出用户业务文件，不启动执行。通过实际提供的 workflow_draft_* 工具修改草稿，禁止直接写草稿文件。私有工具由主控注入，不将其加入业务员工工具清单。

开始编写前读取 [草稿工具协议](references/draft-tools.md)；配置节点时读取 [工作流契约检查表](references/workflow-contract.md)。工具实时 Schema 是参数形式依据；引用文档与实际接口冲突时报告差异，不猜测未提供的字段或工具。

## 1. 建立需求与资源依据

读用户原文、明确目标、requirement_id、材料和 unresolved_facts，保留事实边界。逐项识别规范的活动、交付物、评审和规则 ID。Run Skill 是方法依据，不取代用户要求，不自动成为每个节点的输入。

检查 available assets 中的员工确定版本、capability、Skill/Tool、权限和机械检查器。节点 Skill 必须来自已注册目录，并按工作包实际需要显式分配；AgentCard.skills 表示员工资产自带的默认专业 Skill，不是节点 Skill 白名单。节点工具仍不得超出员工工具权限；角色声称会研究或制作某格式，不代表环境已具备对应 Skill 或工具。

把“明确要求—负责工作包—交付物—检验依据”整理成可落实的设计。待确认事实若能由获准的调查活动获得，可设计相应工作；不能调查得到且影响任务成立时报告缺口，不能先填一个假设值使流程看似完整。

## 2. 设计职责与交接

从最终交付逆向识别必要中间产物。一个 execution 节点承担一个可交付的工作包；一个 review 节点承担明确的独立验证责任，每节点 agents 数组恰好一个参与者。只有职责、权限或可独立验收的产物确有区别时才拆节点，不按“读文件、写文件、调用工具”拆分。

可独立工作并行，消费者在所需成果过审后汇聚；整合任务由明确的 execution 节点形成新产物。员工按适用职责选择，不为凑齐角色库固定增加管理节点。所有 execution 的写根互不重叠，使用相对共享 workspace 的规范路径，例如 outputs/<node_id>；review 不写产物。

## 3. 先定义标准，再写完整节点

将任务和规范要求转成可观察、可复核的条件；写明对象、合格条件、验证方法及证据。不要把“高质量、完善、生产可用”作为唯一标准，也不要凭空增加数值阈值或任务范围。

每个 execution 输出至少绑定一个已注册 mechanical 标准和一个 semantic 标准。机械检查 ID 与 parameters 必须取自实际目录；artifact-integrity 只证明其真实检查的文件完整性，不证明格式或业务正确性。review.targets 只引用 semantic 标准，且覆盖该输出需要的全部语义标准。

标准以 criterion_id 定义一次，由输出、评审和 coverage 引用。设计稿可在编译前修订，但不得以删减用户要求或规范强制项消除诊断；冻结后不变更验收标准。

## 4. 用工具增量构建

先 open/read 获得草稿身份与 revision，再 set_header、upsert_criterion、逐节点 upsert_node，最后写全量 requirement_coverage 与 completion。每次只提交一组相关改动；upsert_node 替换完整节点，不是字段级 patch。

execution 消费上游时使用 approved，并列出实际负责该输出的 review 节点；review 消费其 target 时使用 submitted。输入绑定是前向依赖唯一来源，不添加 dependsOn、任意 pass 路由或脚本条件。返工只在 review.allowed_rework_node_ids 中声明，不把回边放入前向 DAG。

复制任务与规范 ID，不自造别名。TaskInput/ProcessSelection 的可信引用和 Hash 由工具生成。revision 冲突先 read；响应丢失只用同一 operation_id 重发相同操作，改变内容必须使用新 operation_id。

## 5. 覆盖、校验与提交

逐项覆盖任务 requirements 和规范 activities/deliverables/reviews/rules，使用真实责任节点、相关输出和标准，不能把所有 ID 虚挂到最后一个节点。completion 声明全部必需节点、最终输出以及所需评审，不能遗漏必要分支。

执行 workflow_draft_validate，按 path/message 修正配置和关联引用，在同一草稿、同一 Session 重验。Schema 正确不代表内容设计充分，仍需检查要求覆盖、职责匹配、可用输入、证据是否足够和返工责任是否合理。

只对最近验证通过且未再修改的 revision 调用 workflow_draft_submit。候选捕获不等于执行基线获批；后续 Compiler 诊断继续在原草稿修订。没有合法资源组合、无法表达规范强规则或必需工具缺失时报告具体阻塞，不绕开工具直接写文件、不伪造注册项，也不靠空 coverage 或降低标准提交。
