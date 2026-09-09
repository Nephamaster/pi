# WorkflowDefinition 契约检查表

这是配置填写参考，不是新的 Schema。实际字段以草稿工具暴露的当前 Schema 为准。不要将此文档直接整段复制为节点提示词。

## 1. Header、身份和资源

Header 仅包含 schema_version=1、workflow_id、workflow_version、name。最终配置的 task_input_ref、process_selection_ref 由草稿管理器填入。自定义节点、标准、输出、参与者 ID 应稳定且以字母开头，仅含字母、数字、点、下划线、连字符；引用既有任务/规范 ID 时原样复制。

每节点的 agents 恰好一个对象：participant_id、agent_ref（id/version）、required_capabilities、system_prompt_addendum、skills、tools、knowledge_bases、permissions。Skill/Tool 引用为 `{ "id": "目录中的名称" }`，AgentCard/知识库引用还需确定 version；不自填 Hash，不加入 Schema 中没有的 model 字段，模型由所选员工资产及 Run 配置解析。

Skill 必须在目录中存在，且由设计师按节点工作需要显式绑定；AgentCard.skills 是员工资产自带的默认专业 Skill，不是授权白名单。工具和 knowledge_bases 仍不得突破员工声明。普通节点不继承 Run Skill；需要它的方法时，明确绑定该 Skill，并配齐实际必要的工具。权限不足时选择另一位符合职责的员工或报告资源缺口，不假装名称匹配就可执行。

## 2. 节点工作契约

| 字段 | 应写什么 |
|---|---|
| objective | 一个可判断是否完成的节点目标。 |
| responsibilities | 本节点负责的具体工作。 |
| non_responsibilities | 容易越界、但明确不由本节点承担的工作。 |
| work_requirements | 对输入处理、执行方法、交付和自检的具体要求；不用复制完整 Skill。 |
| constraints | 从任务和规范落实的范围、内容、权限、证据等约束。 |

system_prompt_addendum 只补本节点确有必要的稳定限制，不复制所有契约、全局规范或上游历史。数字员工专业原则不能擅自变成节点验收门槛。

## 3. 输入、输出与目录

任务材料输入：kind=task_material、input_id、material_id、required。material_id 必须来自 TaskInput.materials；只有登记 ID 而无可用来源不能视为材料已就绪。

上游输入：kind=node_output、input_id、source（node_id/output_id）、required、availability、approval_review_node_ids。execution 使用 approved，批准列表非空并精确对应评审该输出的节点；review 的每个 target 必须有对应 submitted 输入，通常批准列表为空，不能要求自己先批准再启动。真正必需的输入保持 required=true，不因阻塞或编译问题改为可选。

execution.outputs 每项填写 output_id、artifact_type、description、business_purpose、path_prefix、evidence_requirements、criterion_refs。path_prefix 是共享 workspace 内的相对路径，不是封存目录。使用无尾斜杠、无 `..` 的规范路径；建议每节点拥有 outputs/<node_id>，多个输出可用其不同子目录。

参与者 permissions.read_paths/write_paths 不超出员工授权。不同 execution 的 write_paths 不得相等或互为父子；默认不要把整个 outputs 授给单个节点。review.write_paths=[]、external_actions=false。需写代码、测试、临时依赖、缓存或审查衍生物时，由有写权限的 execution 在自己拥有的根目录完成，不能写宿主仓库或别的节点目录。

## 4. 标准、评审和正常返工

mechanical：criterion_id、description、check_id、parameters、evidence_requirements。check_id 与参数 Schema 只能来自实际机械检查目录；例如目录明确包含 artifact-integrity 且参数为空对象时才可用 `{}`。不把格式、内容和视觉正确性写成此检查器已经能够证明的能力。

semantic：criterion_id、description、非空 evidence_requirements。定义“针对哪个对象、什么条件为合格、怎样核验、证据在哪里”，复用固定 ID，避免输出标准和评审标准出现两套措辞。

review.targets 精确引用 node_id/output_id 与该输出所需的 semantic criterion_refs；每项语义标准都有对应 Reviewer。allowed_rework_node_ids 只包含与缺陷修复有责任关系的 execution 节点，至少包含被评交付的责任生产者。不要用新建员工、投票、动态仲裁或预算阈值作为首版路由。

Fan-in 是多个精确输入共同就绪，不是额外的管理 Agent；局部返工只重做受影响产物，未修改的输入版本仍需可追溯。配置应明确这些关系；是否正确调度和撤销批准由 Runtime 执行，提示词不能替代机制。

## 5. 覆盖和最终完成

requirement_coverage 每项写 source、requirement_id、responsible_node_ids、output_refs、criterion_refs。source 只能是 task_requirement、process_activity、process_deliverable、process_review、process_rule。相关数组应真实关联责任和验证，不为了填满引用而挂到无关节点。

规范的 required_activity 应由具有所需能力的 execution 承担；required_deliverable 应有实际匹配输出；required_review 应有符合能力及独立性要求的 review。规范中的自然语言标准也必须被具体化，而不是只有 ID 出现在 coverage 中。

completion 包含 required_node_ids、final_outputs、delivery_outputs、required_review_node_ids，四个数组都非空。final_outputs 列出工作流完成必须批准的内部终局输出；delivery_outputs 必须是其子集，只列真正交给用户的输出。列明所有必要执行/评审节点及其必经 Gate；只填最后一个节点、仅凭某个输出获批或让 Agent 自报完成，都不足以表达端到端完成条件。

Run 内部支撑资产不等于用户可见最终交付。用户限制最终文件数量或类型时，delivery_outputs 只引用文件组成与该限制一致的输出；不要同时交付某个成品及包含其副本的下游交付包。流程规范要求保留的来源、证据、版本与限制信息可以作为非交付输出、提交证据或最终文件内信息保存，不能借“完整交付包”扩大用户明确限定的文件集合。
