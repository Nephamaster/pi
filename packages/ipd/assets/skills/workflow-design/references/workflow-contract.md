# WorkflowDefinition 契约检查表

这份文件只负责说明“具体配置应该怎样填写”。IPD、ProcessSpec、节点、依赖、并行和返工等概念先阅读 [设计概念与判断原则](design-concepts.md)。实际字段以草稿工具暴露的当前 Schema 为准；不要将本文整段复制进节点提示词。

## 1. Header、身份和资源

Header 仅包含 `schema_version=2`、`workflow_id`、`workflow_version`、`name`。最终配置的 `task_input_ref`、`process_selection_ref` 由草稿管理器填入，不由设计师计算可信 Hash。

自定义 node、criterion、output、participant ID 应稳定且以字母开头，只使用字母、数字、点、下划线和连字符；引用 TaskInput、ProcessSpec、AgentCard 等既有 ID 时原样复制。

每个节点当前只绑定一个员工。参与者对象包含：`participant_id`、`agent_ref(id/version)`、`required_capabilities`、`skills`、`tools`、`knowledge_bases`、`permissions`。

Skill/Tool 引用使用目录中的真实 ID；AgentCard/Knowledge Base 使用确定版本。不要填写 Schema 中不存在的 model、Hash 或自由文本提示词旁路字段。模型由员工资产和 Run 配置解析。

AgentCard 中的默认专业 Skill 不等于节点自动加载全部 Skill。节点实际需要的方法仍应显式绑定；Tool 和 Knowledge Base 也必须存在，并且不突破员工资产声明的边界。

## 2. 节点工作契约

| 字段 | 应表达的内容 |
|---|---|
| objective | 这个工作包最终要达到什么结果，能够判断完成与否。 |
| responsibilities | 该节点必须承担的具体责任。 |
| non_responsibilities | 与它相邻但明确不由它承担的工作，防止职责漂移。 |
| work_requirements | 对输入处理、作业方式、交付、自检的任务特有要求。 |
| constraints | 来源于任务和规范的范围、事实、权限、证据等硬约束。 |

节点特有要求只进入 `contract.work_requirements` 或 `contract.constraints`，不要另建自由文本 Prompt 旁路。员工通用专业原则也不能自动变成节点验收标准。

## 3. 输入、输出与目录

### Task material

使用 `kind=task_material`，填写 `input_id`、`material_id`、`required`。`material_id` 必须来自 TaskInput.materials。只有 ID 而没有可读取来源的必需材料不能视为已经满足。

### Node output input

使用 `kind=node_output`，填写：

- `input_id`；
- `source.node_id / source.output_id`；
- `required`；
- `availability`；
- `approval_review_node_ids`。

execution 消费正式受控上游成果时使用 `approved`，并精确列出负责该输出准出的 review；review 读取自己的评审对象时使用 `submitted`，不能要求自己先批准才能启动。

不要为了避免阻塞把真正必需的输入改成 `required=false`。

### Execution outputs

每项输出填写：

- `output_id`；
- `artifact_type`；
- `description`；
- `business_purpose`；
- `path_prefix`；
- `evidence_requirements`；
- `process_evidence_requirement_refs`；
- `criterion_refs`。

`process_evidence_requirement_refs` 只引用该输出实际承接的 ProcessSpec `evidence_requirement_id`。ProcessSpec 要求的证据不能只改写成另一段自然语言而失去映射。

`path_prefix` 是共享 Run workspace 下的相对路径，不是 Submission 封存目录。使用规范相对路径，无 `..`、无尾 `/`。建议 execution 节点拥有独立 `outputs/<node_id>` 根，不同 execution 的写根不得相同或互为父子。

review `write_paths=[]`、`external_actions=false`。需要生成测试、渲染、缓存或审查衍生物时，由具备写权限的 execution 负责，而不是临时扩权 Reviewer。

## 4. Criterion、Review 与返工

### Mechanical criterion

字段包括 `criterion_id`、`description`、`check_id`、`parameters`、`evidence_requirements`。`check_id` 和参数 Schema 必须来自实际机械检查目录。

机械检查只承担它真实实现的验证范围。例如 `artifact-integrity` 不能被写成“证明内容正确、视觉合理或业务完成”。

### Semantic criterion

字段包括 `criterion_id`、`description`、非空 `evidence_requirements` 和 `process_criterion_refs`。标准应明确：

- 判断对象；
- 合格条件；
- 必要的核验方式；
- 所需证据。

标准只定义一次，再由 output、review 和 coverage 引用，避免出现多个措辞略有不同的“同一标准”。

`process_criterion_refs` 显式说明该标准细化了哪些 ProcessSpec `process_criterion_id`。任务特有且不源自规范的 semantic criterion 可以使用空数组；规范的每项标准则必须被对应 Review target 实际覆盖。

### Review

`review.targets` 精确引用 `node_id/output_id` 及该输出需要判断的 semantic criteria。每项 semantic criterion 都必须有实际 Reviewer 覆盖。

`allowed_rework_node_ids` 只包含真正有责任修复被评缺陷的 execution 节点。不要添加投票、动态 Reviewer 替换、预算阈值或任意脚本路由作为首版流程控制。

## 5. Requirement coverage

`requirement_coverage` 的 `source` 只能是：

- `task_requirement`；
- `process_activity`；
- `process_deliverable`；
- `process_review`；
- `process_rule`。

每条 coverage 应真实填写：

- `requirement_id`；
- `responsible_node_ids`；
- `output_refs`；
- `criterion_refs`。

ProcessSpec 的 required activity 应由能力符合的 execution 承担；required deliverable 应对应真实输出；required review 应有符合专业能力和独立性要求的 review。自然语言质量要求必须被任务化为实际 criterion，不能只让规范 ID 出现在 coverage 中。

## 6. Completion 与用户交付

`completion` 包含四类非空引用：

- `required_node_ids`：Run 成功必须完成的必要节点；
- `final_outputs`：工作流内部必须形成并达到要求的终局成果；
- `delivery_outputs`：真正交给用户的输出，必须是 final_outputs 的子集；
- `required_review_node_ids`：最终成功必须取得的评审；对每个 final output，这组 Gate 必须完整覆盖它的全部 semantic criteria。

内部证据、来源记录、设计规范、检查报告可以是必要 final output，但只有用户实际要求收到的文件才进入 delivery outputs。

用户限制最终文件数量或类型时，严格遵守该限制。不要同时交付某个成品以及另一个包含该成品副本的“完整交付包”，也不要以“流程要求留痕”为理由扩大用户最终文件集合。
