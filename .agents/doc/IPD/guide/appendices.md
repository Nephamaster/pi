# 附录与来源

## 附录目录

- [附录 A　术语与主要定义定位](#terms)
- [附录 B　跨章节实施链](#reading-routes)
- [附录 C　来源与各原批验证范围](#sources)

---

<a id="terms"></a>

# 附录 A　术语与主要定义定位

本表只为查阅建立入口，不增加第二套字段协议。相同含义在不同 Harness 中可有不同 API 名称；引用章节是完整条件的来源。

| 术语 | 查阅提示 | 主要定义 |
|---|---|---|

| IPD 方法 / ProcessSpec | 组织治理依据 / 一类任务必须保留的责任与质量关系 | [§1.2、1.3、5.2](part-01-method-and-strategy.md#s01-03) |

| WorkflowTemplate / WorkflowDefinition / ExecutionBaseline | 可复用结构 / 当前任务设计 / 解析锁定后的执行依据 | [§5.1、5.5、7.10](part-02-evolvable-assets.md#s05-01) |

| AgentCard / Participant | 专业角色资产 / 实际承担工作职责的成员 | [§4.1、4.3、8.1](part-02-evolvable-assets.md#s04-01) |

| Node / WorkUnit | 持续交付或判断责任，不按模型调用次数划分 | [§8.1、15.2](part-03-runtime-control.md#s08-01) |

| Logical Session / 物理实例 | 责任和历史连续性 / 当前承载会话的执行对象 | [§8.10、14.12、16.13](part-03-runtime-control.md#s08-10) |

| WorkRound / Attempt / 模型 request attempt | 业务轮次 / 实际成员派发 / 请求内部技术尝试 | [§8.4、14.3](part-03-runtime-control.md#s08-04) |

| revision / 内容摘要 | 并发编辑冲突 / 内容身份核对；均不自动撤销执行 | [§8.3、8.5](part-03-runtime-control.md#s08-03) |

| control_epoch / scope_epoch | 控制者或全局资格代际 / 当前责任范围代际；环境代际另行关联 | [§8.3、13.4、14.8](part-03-runtime-control.md#s14-08) |

| operation_id / dispatch intent | 稳定业务意图 / 一次可确认和对账的派发 | [§8.5、13.4](part-03-runtime-control.md#s13-04) |

| ArtifactVersion / Submission | 不可变成果版本 / 有责任与输入依据的正式候选记录 | [§11.2—11.4](part-03-runtime-control.md#s11-02) |

| 内容相同 / 获准采用 | 前者不证明来源、权限、输入相容或质量批准相同 | [§11.5、11.10、15.12](part-03-runtime-control.md#s11-05) |

| StageScope / ReviewBundle | 阶段内使用与出口边界 / 本次评审的确定成果组合 | [§12.2、12.3](part-03-runtime-control.md#s12-02) |

| Assessment / Finding / ReleaseCertificate | 专业判断 / 待闭环问题 / 按冻结条件登记的准出 | [§12.4、12.9](part-03-runtime-control.md#s12-04) |

| 修复 / 失效影响 / 复验 | 责任、结果与判断、待执行验证三类集合；不能互换 | [§12.10—12.14、17.7](part-03-runtime-control.md#s12-10) |

| TeamPlan / Child Run | 已知分工的局部组织 / 独立局部治理生命周期 | [§15.1—15.3](part-03-runtime-control.md#s15-01) |

| result_ready / adoption / release | 子结果就绪 / 父级采用 / 责任释放；不得互相等待成环 | [§15.11、15.12](part-03-runtime-control.md#s15-11) |

| ChangeSet / continuation mapping | 差异与激活计划 / 保留无关在途责任的明确续接资格 | [§16.10—16.12](part-03-runtime-control.md#s16-10) |

| FAIL / ERROR / BLOCKED | 实际不符合 / 检查或执行失败 / 条件不足无法判断或推进 | [§10.8、12.5、14.1](part-03-runtime-control.md#s14-01) |

| EngineCapabilities / 运行配置 | 已支持并验证的语义画像 / 本次具体参数 | [§19.2、20.4](part-05-minimal-implementation-and-harness.md#s19-02) |

| 权威审计 / 性能遥测 / 调试材料 | 正式事实 / 可测成本 / 受控复现；各有可靠性与访问边界 | [§17.2、17.3](part-04-efficiency-stability-and-validation.md#s17-02) |

| trial / conformance 场景 | 完整任务评测重复 / 要求实现的控制验收；不是技术 Attempt | [§18.1、18.9](part-04-efficiency-stability-and-validation.md#s18-01) |


<a id="reading-routes"></a>

# 附录 B　跨章节实施链

本表连接已有章节，不引入新的职责或验收标准。实现和评测必须同时观察错误处置与未受影响对象。

| 路径 | 已有章节构成的闭环 | 必须保留的反例 |
|---|---|---|
| 从原任务到正式交付 | 01—02 选治理强度 → 03—06 资产绑定 → 07 准备与编译 → 08 身份采用 → 09—10 执行 → 11—12 交接评审 → 13 收口 | 模板执行不冒称自动设计；文件存在不冒称正式交付 |
| A 出错、B 真实依赖、D 独立 | 11 类型化依据 → 12 Finding 与三类集合 → 13 局部资格 → 14 原 Session 恢复 → 17 无关重产计量 | 不撤销或重建 D；B 若实际依赖错误前提则不能漏更新 |
| 只有 J 集成错误 | 11 贡献与证据 → 12 根因和责任定位 → 13 J/R 的必要活动 | 正确 A/B/D 与子成果不陪跑 |
| 暂停、未知动作与灾后接管 | 08 稳定意图 → 10 真正工具停止 → 13 持久命令 → 14 对账、检查点和逻辑恢复 → 20 原生探针 | 不把超时当未执行，不新建根 Run 冒充恢复 |
| 团队和父子工作 | 08 参与者 → 13 资源与等待 → 15 委派和采用 → 16 专业意见与有限变更 | 父等待释放活动槽；子结果就绪不等于责任立刻销毁 |
| 局部 replan 保留 D | 07 义务 → 12 实际影响 → 16 候选、局部停止、激活与续接 → 08 按映射采用 | 不默认拒绝全部旧基线结果，也不默认接受任何旧结果 |
| 跨 Harness 与效率验证 | 17 分项观测 → 18 分层验证与对照 → 19 最小纵向切片 → 20 同语义适配 | 底层 Leader 不争夺正式状态，有限示例测试不冒称系统验收 |

各章节验收行保持原编号。P07/P08 与后续 P、T 前缀均表示原稿验收要求标识，不表示其成熟度或已经通过。完整检索表见 [acceptance-index.json](checks/acceptance-index.json)；是否执行必须另有对应环境、版本、证据和结果。


---

<a id="sources"></a>

# 附录 C　来源与各原批验证范围

以下保留各原批来源定义、读取范围、日期和验证限制。编号已加入原作用域，历史措辞不代表本轮重访或重测。源文件正文与哈希在 source-snapshots 和输入清单中保存。本轮新增检查另见 [VALIDATION.md](VALIDATION.md)。


## 来源组 01

正文 `[Sxx]` 表示项目材料，`[Wxx]` 表示公开资料，`[Gxx]` 表示固定代码参考；编号沿用材料基线，新增公开资料使用新的编号。来源说明只覆盖实际使用内容，不代表已完成全仓历史或全部文献审阅。

#### 项目依据

<a id="ref-01-f00"></a>
- **[01-F00]** 《材料与决策基线 v0.1》与《写作与验收地图》，2026-09-18，尤其 D01—D28。最新确认：正常作业保持持续 Session，宿主崩溃后允许恢复同一逻辑会话的执行实例；没有总纲之外的新架构硬约束。两份不可读取的 stage 分享对话未作为已读证据。
<a id="ref-01-s01"></a>
- **[01-S01]** 《极简 Agent 设计方案》，3 页：第 1 页模块边界与整体图，第 2—3 页工具、Skill、上下文和 IPD 入口。引用其方法目标，不强制复刻探索性 API 与布局。
<a id="ref-01-s02"></a>
- **[01-S02]** 《基于组织流程控制的多智能体长程任务范式》，3 页：第 1 页问题与愿景，第 2 页流程适配与专业职责，第 3 页并行和评审示意。属于方法设想，不是本项目实验效果报告。
<a id="ref-01-s04"></a>
- **[01-S04]** `what_is_ipd.md`，尤其 §2—§5：规范、节点、工作流、执行与会话的定位。本部分延续核心概念；公开来源性论断通过 W01—W05 重新核对。
<a id="ref-01-s07"></a>
- **[01-S07]** `Agency-Agents分析.md`，历史基线 `ebe9c99`，尤其 §3.1、§3.4、§4：角色资产、交接与软指令的边界。本部分不引用其旧角色数、预设指标或首版规模建议为通用事实。
<a id="ref-01-s08"></a>
- **[01-S08]** `Edict三省六部制分析.md`，历史基线 `14a2075`，尤其 §4—§6：控制权、证据、共同盲点与流程税。这里只吸收历史工程分析，不对今天的上游项目成熟度重新定性。
<a id="ref-01-s09"></a>
- **[01-S09]** `project-reviewed-content-delivery@2.0.0`，`required_reviews` 与 `workflow_rules`：用于说明已有版本的明确义务不能被静默删减。它自述为项目衍生规范，不是华为正式模板。
<a id="ref-01-s11"></a>
- **[01-S11]** `IPD-Run-and-Portability-Audit.md` 及其指标和证据索引，对象为 `20260917T150740223Z`。本部分只引用已记录的运行负担和中断现象；未重新执行复算脚本、未检查缺失的最终 PPT，也不外推多 Agent 的普遍净收益。

#### 公开资料

<a id="ref-01-w01"></a>
- **[01-W01] Huawei，2013，*Cyber Security Perspectives: Making cyber security a part of a company’s DNA*.** 本轮核对 §7.5、§7.5.1，并查看图 4、5 的页面渲染：PDF 第 24、26 页，印刷页 20、22。用于来源、阶段和配置管理说明，不是内部流程全集。  
  <https://www-file.huawei.com/-/media/corporate/pdf/cyber-security/hw-cyber-security-wp-2013-en.pdf>
<a id="ref-01-w02"></a>
- **[01-W02] 华为云 CodeArts TestPlan，《测试生命周期管理》。** 本轮读取正文及术语表；页面标注更新于 2025-12-12。用于 IPD、TR、DCP 等区别，不照搬具体产品测试阶段为通用 Agent 流程。  
  <https://support.huaweicloud.com/usermanual-testman/cloudtest_01_1502.html>
<a id="ref-01-w03"></a>
- **[01-W03] Stanley M. Sutton Jr.，2011，*Concepts in the definition of an enterprise development process*.** 本轮读取 IBM Research 官方摘要，未取得完整会议论文。用于高层治理与低层作业的区分，不据此推导本项目 Runtime 的确定性协议。  
  <https://research.ibm.com/publications/concepts-in-the-definition-of-an-enterprise-development-process>
<a id="ref-01-w04"></a>
- **[01-W04] 2024，*New product development paradigm from the perspective of consumer innovation: A case study of Huawei’s integrated product development*.** *Journal of Innovation & Knowledge*, 9(2), 100482。使用本轮取得的 DOI 检索页正文中摘要、讨论及 Limitations；出版社直接正文链接未成功打开，未核对全文 PDF 图表，故不使用图表和企业效果数字。  
  <https://doi.org/10.1016/j.jik.2024.100482>
<a id="ref-01-w05"></a>
- **[01-W05] IBM，*Integrated Product Development (IPD)*，公开培训材料。** 本轮读取相关段落并查看第 3、12 页：跨职能组织、IPMT/PDT、DCP 的决定与资源承诺。材料由 PMI Central Virginia 网站提供，用于 IBM 方法说明，不当作华为现行内部模板。  
  <https://pmicv.org/static/uploaded/Files/Documents/2011%20Presentations/IBM_Corporate_IPD_Process_PMI-CV_Sept_14_2011.pdf>
<a id="ref-01-w06"></a>
- **[01-W06] 华为云 CodeArts Req，《创建已基线需求的变更评审》。** 本轮读取流程说明；页面标注更新于 2025-12-09。用于专家意见、审批决定与修改生效的区别，不把页面中的人物或工具配置作为本项目组织要求。  
  <https://support.huaweicloud.com/intl/zh-cn/bestpractice-projectman/codeartsreq_practice_1044.html>
<a id="ref-01-w07"></a>
- **[01-W07] Anthropic，*Building effective agents*.** 本轮读取 “When (and when not) to use agents” 及相关模式说明；仅引用简单优先、按需要增加复杂度与衡量代价的工程原则，不采用具体框架、模型型号或宣传指标为本项目事实。  
  <https://www.anthropic.com/engineering/building-effective-agents>

#### 固定实现参考

<a id="ref-01-g01"></a>
- **[01-G01] `Nephamaster/pi@1f13b74e3bdc56150a0a89e2884d328db43620e5`，`packages/ipd/README.md`，Runtime flow 与 Interactive launch。** 本轮通过 GitHub 连接读取相应段落，用于说明已有人工选择、模板复用与自动设计入口。它是固定版本能力声明，不是本轮端到端验证，也不意味着目标中的多人和完整子流程已经上线。  
  <https://github.com/Nephamaster/pi/blob/1f13b74e3bdc56150a0a89e2884d328db43620e5/packages/ipd/README.md>


## 来源组 02

编号沿用第一部分及材料基线；新增 `[02-G10](#ref-02-g10)` 起为本轮资产主题的代码核对，`[02-W08](#ref-02-w08)` 起为补充公开接口／格式资料。**建议契约与规范性要求是本方法的工程设计，不等于引用项目已经完整实现。** 本轮未修改仓库、未运行当前仓库全套测试、未完成全部自研提交／PR 历史审阅；不可访问的 stage 分享对话未作为已读材料。

#### 项目依据

<a id="ref-02-f00"></a>
- **[02-F00]** `00-materials-and-decisions.md`、`01-writing-map.md` 与已确认用户口径。已回读资产、持续会话、恢复、阶段协作和跨 Harness 边界。正常返工使用原 Session；宿主崩溃后允许恢复同一逻辑会话的执行实例。第二部分对应写作地图第 03—06 章。
<a id="ref-02-s01"></a>
- **[02-S01]** 《极简 Agent 设计方案》，3 页。使用第 1 页模块分工和第 2—3 页 Skill／Tool 检索与加载的已提供正文、页图；不把其中探索性实现方式写成唯一宿主接口。
<a id="ref-02-s02"></a>
- **[02-S02]** 《基于组织流程控制的多智能体长程任务范式》，3 页。使用角色专精、流程与角色解耦、资产积累的设计目标；未将其愿景性收益表述当成实验结论。
<a id="ref-02-s04"></a>
- **[02-S04]** `what_is_ipd.md`，§2—§5：规范、节点、模板、工作流、Run 和持续责任的分层。本文延续概念；具体资产协议仍是项目工程约定。
<a id="ref-02-s05"></a>
- **[02-S05]** `ipd-v2-reconstruction-plan.md`，尤其 D-001、D-011、D-012、D-014。作为版本引用、Skill 与 Tool 分工、全包锁定的历史决策依据；旧共享工作区、单成员和图表达限制不作为永久方法要求。
<a id="ref-02-s07"></a>
- **[02-S07]** `Agency-Agents分析.md`，历史基线 `ebe9c99`，§3.1、§3.8、§4。使用角色资产化、单一来源和谨慎转化方法；不声称本轮重新审阅了 Agency 当前全库，也不采用历史角色数、宣传数字或固定首版规模。
<a id="ref-02-s09"></a>
- **[02-S09]** 已提供的资产样本。本部分直接使用 `project-reviewed-content-delivery@2.0.0` 的适用边界、活动、交付、评审与来源说明，以及 `huawei-public-ipd-ptm-product@1.0.0` 关于公开映射范围和物理验证能力的限制。后者的旧版引擎指令不被提升为当前规范。没有声称全部历史压缩包都已按本轮源码逐文件重新验证。
<a id="ref-02-s11"></a>
- **[02-S11]** `IPD-Run-and-Portability-Audit.md` 及其指标／证据索引。引用来源混淆、结构化诊断与检查结果表达的已记录经验；本轮没有重新执行完整 Run，也未取得缺失的最终 PPT 来评判成品质量。

#### 本轮固定源码

以下文件均通过 GitHub 连接按确切提交读取。单个模块有相应检查，不代表端到端安全性、容灾或任务质量已被本轮验证。

<a id="ref-02-g10"></a>
- **[02-G10]** `Nephamaster/pi@e737e4b18ff65704a12e38b18142fca55492cedd`，分支及提交身份。已核对其为上游合并，第一父提交为 `1f13b74e3bdc56150a0a89e2884d328db43620e5`；只用于固定本部分资产代码，不展开上游历史。  
  <https://github.com/Nephamaster/pi/commit/e737e4b18ff65704a12e38b18142fca55492cedd>
<a id="ref-02-g11"></a>
- **[02-G11]** `packages/ipd/src/contracts/agent-card.ts`。完整读取角色字段、编译后卡片和引用结构；字段存在不表示对应资源全部可执行。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/contracts/agent-card.ts>
<a id="ref-02-g12"></a>
- **[02-G12]** `packages/ipd/src/registry/asset-assembler.ts`。完整读取默认来源、受信任项目目录、重复检查、Skill 依赖处理、员工不可用记录和 Tool 摘要范围。只将其描述为当前装配行为，不把建议的故障隔离或实现身份锁定写成已实现。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/registry/asset-assembler.ts>
<a id="ref-02-g13"></a>
- **[02-G13]** `packages/ipd/src/registry/skill-package.ts`。完整读取全包内容摘要、排除项、符号链接拒绝、暂存复制、摘要核对及只读快照；未运行并发、文件系统或故障注入测试。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/registry/skill-package.ts>
<a id="ref-02-g14"></a>
- **[02-G14]** `packages/ipd/src/adapter/render-agent-profile.ts`。完整读取选人和运行投影字段；只说明实际投影分工，不声称任何删减都已被任务效果验证。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/adapter/render-agent-profile.ts>
<a id="ref-02-g15"></a>
- **[02-G15]** `packages/ipd/src/control/asset-catalog-tools.ts`。完整读取四个查询工具、关键词评分、员工能力／工具过滤、数量上限与精确版本读取。未开展检索召回率评测。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/control/asset-catalog-tools.ts>
<a id="ref-02-g16"></a>
- **[02-G16]** `packages/ipd/src/registry/workflow-asset-store.ts`。完整读取版本文件保存、同内容复用、不同内容冲突和结构读取；不据此声称模板已完成业务验证。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/registry/workflow-asset-store.ts>
<a id="ref-02-g17"></a>
- **[02-G17]** `packages/ipd/src/contracts/process-spec.ts`。完整读取 ProcessSpec v2 的活动、交付、证据、评审标准、规则和选择契约；本部分没有声称它已支持全部阶段／组合／团队语义。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/contracts/process-spec.ts>
<a id="ref-02-g18"></a>
- **[02-G18]** `packages/ipd/src/compiler/validate-node-agent.ts`。完整读取角色资源、伴随工具、Skill 必需能力、路径和评审环境检查；特别核对 `knowledge_base_unsupported`，未把知识库结构误报为可执行能力。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/compiler/validate-node-agent.ts>
<a id="ref-02-g19"></a>
- **[02-G19]** `packages/ipd/src/contracts/baseline.ts`。完整读取 EffectiveParticipant、LockedSkill、LockedTool、基线和图索引，作为当前锁定表示的参考；正文更完整的来源／实现身份记录是目标建议。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/contracts/baseline.ts>
<a id="ref-02-g20"></a>
- **[02-G20]** `packages/ipd/src/control/control-plane.ts`，第 1—420 行。核对显式选型、staffing 检查、成功编译后的资产保存分支、模板哈希检查、任务引用重绑定和重新编译。未把它推断为通用模板参数化或完整运行恢复协议。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/control/control-plane.ts>
<a id="ref-02-g21"></a>
- **[02-G21]** `packages/ipd/src/registry/check-executor-registry.ts`。完整读取检查器参数、执行实现、结果和注册校验；本文的“执行状态与质量判定分开”逻辑样例是建议契约，不是当前原样结果 Schema。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/registry/check-executor-registry.ts>

#### 本轮补充公开资料

<a id="ref-02-w08"></a>
- **[02-W08] Agent Skills，Specification。** 2026-09-21 读取目录结构、frontmatter、正文、资源和渐进披露说明；用于可移植的 Skill 包组织及 `allowed-tools` 的实验性边界。规范的行数／token 建议不作为本方法统一阈值，Pi 的 `required-tools` 等扩展也不冒充跨平台标准。  
  <https://agentskills.io/specification>
<a id="ref-02-w09"></a>
- **[02-W09] Anthropic，*Equipping agents for the real world with Agent Skills*，2025-10-16。** 读取方法入口、按需资源、代码使用、评估迭代和安全考虑；作为工程组织参考，不把供应商的效果措辞当作本项目证据。本方法的发布、锁定和任务授权仍需独立实现。  
  <https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills>
<a id="ref-02-w10"></a>
- **[02-W10] Model Context Protocol，Tools，2025-11-25 版本。** 读取工具定义、发现与调用及 annotations 的信任限制。只借鉴接口和信任边界，不将协议页面的交互建议自动变成本项目首版 HITL 要求，也不声称已经完整实现该协议版本。  
  <https://modelcontextprotocol.io/specification/2025-11-25/server/tools>
<a id="ref-02-w11"></a>
- **[02-W11] RFC 8785，JSON Canonicalization Scheme。** 读取规范化规则、输入限制与实现说明，用于跨语言摘要一致性的设计参考；不声称当前 Pi 的 `canonicalJson` 就是完整 JCS 实现。它是 Informational RFC，不在本文被表述为必须采用的互联网标准。  
  <https://www.rfc-editor.org/rfc/rfc8785.html>


## 来源组 3A

以下保留原批来源说明；本合稿编号已增加作用域。`[3A-G22](#ref-3a-g22)` 起是本批新增的固定代码观察，`[3A-W12](#ref-3a-w12)` 起是补充工程资料。规范性契约、身份模型和验收情形是本指导的设计要求，不因旁边存在源码引用就被描述为当前仓库已完整实现。

本批完成了对应文件的定点源码核对与既有章节回读；**没有修改仓库、运行当前仓库全套测试、执行新的真实 Run，或完成全部自研提交／PR 历史的审查**。文中的测试表是需实现的验收条件，不是已全部通过的报告。

#### 已有项目依据与章节

<a id="ref-3a-f00"></a>
- **[3A-F00]** `00-materials-and-decisions.md`、`01-writing-map.md` 及用户明确确认：正常作业持续原 Session；宿主崩溃后允许恢复同一逻辑会话的执行实例；两份总纲之外没有新增架构硬约束。本批遵循地图第 07、08 章，不重新定义前两部分资产体系。
<a id="ref-3a-s01"></a>
- **[3A-S01]** 《极简 Agent 设计方案》，已提供的正文与页图。采用模块职责明确、复用宿主原生能力的设计取向，不将其探索性技术细节视为必须复制的实现。
<a id="ref-3a-s04"></a>
- **[3A-S04]** `what_is_ipd.md`，尤其规范与 IR 区分、固定准备流程与任务图区分、节点责任与 Session 连续性。旧版具体范围依最终用户确认解释，不将其作为当前源码证明。
<a id="ref-3a-s05"></a>
- **[3A-S05]** `ipd-v2-reconstruction-plan.md`，作为输入绑定唯一事实源、可信引用、增量草稿和 stop/release 区分的历史决策资料。旧共享工作区、单成员范围、早期计数阈值不成为通用标准。
<a id="ref-3a-s08"></a>
- **[3A-S08]** `edict` 历史分析，§4.2、§4.5、§6.2。引用其中关于 Prompt 驱动事务、看板与正式状态混淆的工程分析，不声称本批重新验证了 edict 当前实现或全部历史问题。
<a id="ref-3a-s09"></a>
- **[3A-S09]** `project-reviewed-content-delivery@2.0.0`，需求依据、未决事实、版本一致和交付完整性条目。它自述为项目衍生规范，不是华为正式模板；七阶段和逐阶段评审不被强制推广到所有任务。
<a id="ref-3a-s11"></a>
- **[3A-S11]** `IPD-Run-and-Portability-Audit.md` 及既有指标／证据索引。采用已记录的诊断丢失、约束来源混淆和尝试时长问题作为经验；本批没有重新执行原实验、重新审阅最终成品或复算全部指标。
- **前两部分正文**：`part-01-method-and-strategy.md`、`part-02-evolvable-assets.md`。本批回读术语、章节边界、软件接口变更示例、资产与设计决定的来源规则；例子仍是方法说明，不是实际成功 Run。

#### 本批固定源码

所有代码观察固定于 `e737e4b18ff65704a12e38b18142fca55492cedd`。行号范围为 GitHub 源文件范围，不是聊天工具包装结果的行号。

<a id="ref-3a-g10"></a>
- **[3A-G10]** 分支身份已再次核对，仍为前两部分记录的固定提交；不展开上游合并历史。  
  <https://github.com/Nephamaster/pi/commit/e737e4b18ff65704a12e38b18142fca55492cedd>
<a id="ref-3a-g20"></a>
- **[3A-G20]** `control/control-plane.ts`，本批回读第 95—361 行：接入、选择来源、staffing、设计修订、模板重绑定、成功编译后的资产保存及阶段处置。该段未证明通用持久准备恢复。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/control/control-plane.ts#L95-L361>
<a id="ref-3a-g22"></a>
- **[3A-G22]** `contracts/task-input.ts`，完整读取：TaskInput v2 的原始任务、材料与未决事实，没有旧版 objectives/requirements。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/contracts/task-input.ts>
<a id="ref-3a-g23"></a>
- **[3A-G23]** `control/workflow-draft.ts`，完整读取：可信引用、修订、幂等编辑、操作替换语义、validate/submit 和文件写入；没有将实例内队列描述为完整多设计者事务系统。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/control/workflow-draft.ts>
<a id="ref-3a-g24"></a>
- **[3A-G24]** `contracts/runtime.ts`，完整读取：现行状态、RoundRecord 的 generation/attempt、提交与评审记录、工作保留引用。本文独立 Attempt 与逻辑 Session 恢复关系是目标设计，不是照抄当前字段就已满足。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/contracts/runtime.ts>
<a id="ref-3a-g25"></a>
- **[3A-G25]** `runtime/governance-transitions.ts`，完整读取：事务内候选和评审转换、Run/generation/round/input 检查、批准和返工记录；未进行本轮竞态或故障注入。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/runtime/governance-transitions.ts>
<a id="ref-3a-g26"></a>
- **[3A-G26]** `compiler/compiler.ts`，第 1—270 行：源对象和摘要校验、关系与覆盖检查、资源和环境绑定。只据已读路径说明当前行为，不声称完成完整 Compiler 审计。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/compiler/compiler.ts#L1-L270>
<a id="ref-3a-g27"></a>
- **[3A-G27]** `compiler/validate-workflow.ts`，第 1—195 行：前提、节点唯一性、单成员限制、输出标准、路径及初步评审关系。后续阶段和团队协议是建议扩展，没有用此片段证明它们已经可执行。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/compiler/validate-workflow.ts#L1-L195>
<a id="ref-3a-g28"></a>
- **[3A-G28]** `adapter/node-session-adapter.ts`，第 1—255 行：参与者绑定、原生句柄、活动派发互斥、stop/release、事件与错误处理；未将创建现有 Session 的接口推断为完整灾后恢复。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/adapter/node-session-adapter.ts#L1-L255>
<a id="ref-3a-g29"></a>
- **[3A-G29]** `runtime/run-store.ts`，第 1—210 行：操作幂等、串行与写者锁入口、状态／事件／回执写入、通知失败隔离及快照编码。没有据此宣称跨主机锁、安全清理残留锁、完整持久命令和事件重放已经通过验证。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/runtime/run-store.ts#L1-L210>

#### 本批补充公开资料

<a id="ref-3a-w12"></a>
- **[3A-W12] Amazon Builders’ Library，Malcolm Featonby，Making retries safe with idempotent APIs。** 2026-09-21 读取请求意图、幂等标识、参数冲突、原子处理和重复响应相关段落。只用于幂等操作的一般工程依据，本指导的 Run／Attempt／准出协议仍是项目设计；不继承“任何错误都可安全重试”的泛化假设。  
  <https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/>
<a id="ref-3a-w13"></a>
- **[3A-W13] LangChain 官方文档，Persistence。** 2026-09-21 读取线程检查点与应用 Store 的作用域区分，以及内存检查点的重启限制。这里只作持久信息分层参考，不采用文档中的后端选型作为本项目强制依赖，也不以检查点存在证明持续 Agent 恢复。  
  <https://docs.langchain.com/oss/python/langgraph/persistence>


## 来源组 3B

以下保留原批来源说明；本合稿编号已增加作用域。`[3B-G30](#ref-3b-g30)` 起为新增代码定位，`[3B-W14](#ref-3b-w14)` 起为补充公开工程资料。本文提出的上下文视图、请求准入、诊断与验收，是目标实现指导，不是对某个外部框架功能的转述，也不意味着当前 Pi 已经满足每项要求。

本批回读了第二部分、第三部分第一批、写作安排和最近一次 Run 的既有审计，并定点读取以下固定源码与公开资料。**没有修改 GitHub 仓库、执行新的真实模型 Run、读取缺失的最终 PPT、完成全仓安全审计或运行全部系统验收用例。** 历史统计只用于保留已经发现的故障机制，不外推为所有任务的性能结论。

#### 项目依据与前文

<a id="ref-3b-f00"></a>
- **[3B-F00]** 用户确认与 `00-materials-and-decisions.md`：正常作业持续原 Session；宿主崩溃后允许恢复同一逻辑会话；没有新增架构硬约束。本轮明确补充：返工指向实际负责节点，不无差别影响其他节点。
<a id="ref-3b-s01"></a>
- **[3B-S01]** 《极简 Agent 设计方案》，第 1—3 页：模块职责、原生 Agent 工作循环、按需工具与 Skill、原件保存及历史聚合。采用其方向，不将固定历史轮数或示意小 Agent 变成必须新增的模块。
<a id="ref-3b-s04"></a>
- **[3B-S04]** `what_is_ipd.md`，尤其节点责任、持续 Session、确定版本评审与无关分支不受局部 Gate 阻塞的关系。使用方法定义，不把旧接口或早期部署约束当作当前事实。
<a id="ref-3b-s11"></a>
- **[3B-S11]** `IPD-Run-and-Portability-Audit.md`，§1、§3—§5 及其 `metrics.json`、`evidence-index.md`。历史对象为 `20260917T150740223Z`：请求字节故障、长工作历史、诊断丢失、标准来源混淆和 Shell 结果解释。原审计基于 `3011e03` 核对源码，Run 本身没有 Git SHA；本批不声称已重新复算全部原始日志。
- **前文章节**：`part-02-evolvable-assets.md` 的 §4.4、§5.4、§6.1—§6.7；`part-03a-governance-and-runtime-core.md` 的第 07、08 章。资产定位、职责、Attempt／Round／代际和 I-01— I-10 不在本批重新定义。

#### 固定源码观察

以下文件固定在 `e737e4b18ff65704a12e38b18142fca55492cedd`；源文件行号不是聊天工具包装结果的行号。适配能力的存在不等于所有组合故障已经实测。

<a id="ref-3b-g10"></a>
- **[3B-G10]** 再次核对 `main`，仍为前文固定提交；不展开上游合并历史。  
  <https://github.com/Nephamaster/pi/commit/e737e4b18ff65704a12e38b18142fca55492cedd>
<a id="ref-3b-g30"></a>
- **[3B-G30]** `adapter/pi-node-session-factory.ts`，完整读取：原生 Session 服务、锁定资源、禁止未绑定自动发现、明确环境后端、可信外部服务、Skill 路径投影与生效配置记录。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/adapter/pi-node-session-factory.ts>
<a id="ref-3b-g31"></a>
- **[3B-G31]** `adapter/node-context.ts`，完整读取：任务与契约、专业画像、当前轮次和具体反馈、环境布局，以及真实派发时更新 system section 的机制。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/adapter/node-context.ts>
<a id="ref-3b-g32"></a>
- **[3B-G32]** `adapter/structured-submissions.ts`，完整读取：候选捕获、工具诊断、原生结果扩展与 `terminate: true`。未据此声称并行 Tool 与所有后台进程在提交时已经完成一致性验证。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/adapter/structured-submissions.ts>
<a id="ref-3b-g33"></a>
- **[3B-G33]** `environment/manager.ts`，完整读取：成员租约、环境准备、轮次绑定与 generation、保留工作、恢复核对及释放。该实现具有进程内状态，本批不将其描述为完整跨宿主恢复系统。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/environment/manager.ts>
<a id="ref-3b-g34"></a>
- **[3B-G34]** `environment/tool-backend.ts`，分段读取完整文件：文件、目录、搜索、图像读取和 Bash 接入同一 Provider，受管进程及日志接口、探测执行路径。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/environment/tool-backend.ts>
<a id="ref-3b-g35"></a>
- **[3B-G35]** `environment/paths.ts`，读取第 1—205 行：逻辑根、输入物化、路径及文件类型检查、内容身份入口。未读取部分不作为完整路径安全结论的依据。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/environment/paths.ts#L1-L205>
<a id="ref-3b-g36"></a>
- **[3B-G36]** `environment/docker-provider.ts`，读取第 100—290 行：镜像身份、非 root 条件、挂载、资源和安全参数、容器创建结果核对。未声称执行了真实容器逃逸、网络和终止测试。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/environment/docker-provider.ts#L100-L290>
<a id="ref-3b-g37"></a>
- **[3B-G37]** `adapter/external-read-results.ts`，完整读取：Session 内检索回执、来源与文件验证、PDF 文本物化、环境代际检查。其插件名称和返回文案属于特定适配，不作为通用接口。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/adapter/external-read-results.ts>

#### 补充公开工程资料

以下网页于 2026-09-21 读取。仅使用与本章直接相关的机制说明；不据此宣称所有模型／云平台具有相同限制，也不把外部实践中的效果数字当作本方法的实验结果。

<a id="ref-3b-w10"></a>
- **[3B-W10] Model Context Protocol，Tools，2025-11-25 版本。** 回读工具结果、错误与安全相关定义；这里只作为协议层与执行错误分开的依据，不把工具标注当作实际授权。  
  <https://modelcontextprotocol.io/specification/2025-11-25/server/tools>
<a id="ref-3b-w14"></a>
- **[3B-W14] Anthropic，Effective context engineering for AI agents。** 使用按需检索、工作笔记与压缩的总体区分，以及过度压缩存在信息损失的提醒；本文的版本、准出和反馈协议不是该文章定义。  
  <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
<a id="ref-3b-w15"></a>
- **[3B-W15] Claude Platform Docs，Prompt caching。** 读取缓存前缀与工具／系统／消息结构。缓存 TTL、具体模型、价格和优惠比例不作为本方法的固定参数。  
  <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
<a id="ref-3b-w16"></a>
- **[3B-W16] Claude Platform Docs，Vision。** 读取图像编码、尺寸和请求限制相关说明；本方法要求实际 Provider 参数化，不将其数值推广到其他接口。  
  <https://platform.claude.com/docs/en/build-with-claude/vision>
<a id="ref-3b-w17"></a>
- **[3B-W17] Claude Platform Docs，Context editing。** 作为服务侧管理旧工具内容的一种实现参考；不宣称它适用于任何 Provider 或能自动解决全部图片与请求体问题。  
  <https://platform.claude.com/docs/en/build-with-claude/context-editing>
<a id="ref-3b-w18"></a>
- **[3B-W18] Docker Docs，Bind mounts。** 使用宿主目录关联和只读挂载语义，区分只读权限与不可变内容。  
  <https://docs.docker.com/engine/storage/bind-mounts/>
<a id="ref-3b-w19"></a>
- **[3B-W19] Docker Docs，Docker Engine security。** 使用 namespace、cgroup、能力与 daemon 安全的分层说明；Docker 不是本方法唯一后端，也不构成绝对安全保证。  
  <https://docs.docker.com/engine/security/>
<a id="ref-3b-w20"></a>
- **[3B-W20] GNU Bash Reference Manual，Pipelines。** 核对默认管道状态和 `pipefail`；手册页面直开失败时，使用官方搜索索引及同一手册全文中的对应段落核对。  
  <https://www.gnu.org/software/bash/manual/html_node/Pipelines.html>  
  <https://www.gnu.org/s/bash/manual/bash.html>
<a id="ref-3b-w21"></a>
- **[3B-W21] Docker Docs，Resource constraints。** 使用默认不施加相应资源约束、必须配置与核对实际限制的说明；具体配额由部署条件决定。  
  <https://docs.docker.com/engine/containers/resource_constraints/>


## 来源组 3C

正文的范式定位和持续责任要求沿用前文；新增逻辑契约、阶段内候选、ReviewBundle、Finding 生命周期、影响计算和验收场景属于本方法的目标设计。它们不是对华为公开工具的原样复制，也不是声称当前 Pi 已完整实现。

本批回读第三部分前两批、分批写作安排以及上下文中提供的项目资料，重新核对 `main` 并定点读取以下固定代码和公开资料。**没有修改 GitHub 仓库，没有执行新的真实模型 Run，没有完成全仓安全审计或运行本文全部系统验收场景。** 文档中的纯逻辑示例与检查不等同于生产 Runtime 测试。

#### 本批文档与示例校验

已检查章节编号、代码围栏、引用标识和本地前文链接；6 组 YAML 示例可解析，影响计算伪代码通过 Python 语法检查，并在 10 个内存构造关系案例中检查了独立产物保留、内容与批准依赖区别、采用前提的继续传播、重复种子、顺序一致性与未知关系拒绝。

这些构造检查的前提是输入索引按示例正确提供。它们不证明真实索引已经完整，不测试存储事务、进程取消、并发竞争或模型归因，也不等同于 Pi 原型已实现本文目标。第 11、12 章的 42 项表格仍然是需要实施后逐项兑现的系统验收要求。

#### 项目依据与前文

<a id="ref-3c-f00"></a>
- **[3C-F00]** 用户的连续确认：正常工作、补正和质量返工使用原持续 Session；宿主崩溃后允许恢复同一逻辑会话；多人、阶段评审和受控子 IPD 属于目标设计；不因局部返工无差别影响其他节点。旧首版限制不作为永久规范。
<a id="ref-3c-s02"></a>
- **[3C-S02]** 《Agency-Agents 可借鉴设计分析》，§3.4、§4.3—§4.6：结构化交接、原始产物定位、不以缺陷配额驱动评审，以及角色和全文交接的成本。本文沿用历史分析中的方法启发，未重新审计 Agency 当前仓库或采用其宣传数字。
<a id="ref-3c-s04"></a>
- **[3C-S04]** `what_is_ipd.md`，尤其§四、§五：规范、工作流与 Runtime 分工；节点责任和 Session 区分；多目标评审；确定版本；只阻塞真实依赖而非无关分支。它是项目研究与设计记录，不是华为原始技术规范。
<a id="ref-3c-s11"></a>
- **[3C-S11]** `IPD-Run-and-Portability-Audit.md` 的既有结论：交付包膨胀、反复读取与约束来源混淆。本批只作历史故障机制引用，未重新复算整个 `20260917T150740223Z` Run，也不把单次未完成测试当作完整质量实验。
<a id="ref-3c-s12"></a>
- **[3C-S12]** 用户提供的 `project-reviewed-content-delivery.yaml`，`schema_version: 2`、`version: 2.0.0`。其第 10—13 行说明项目衍生性质；第 168—202 行规定验证、修订、复验和正式交付；第 204—337 行给出必需评审；第 339—363 行规定来源、版本和交付完整性。相同内容的重复文件不作为独立证据。版本一致性与受影响内容复验分别见该文件第 168—184、350—363 行。
- **前文章节**：[第 07、08 章](part-03-runtime-control.md#ch07)定义依据、身份、控制权和 I-01— I-10；[第 09、10 章](part-03-runtime-control.md#ch09)定义反馈投影、持续工作、请求容量、私有环境和导出。本文不另建第二套会话或权限体系。

#### 固定源码观察

以下源码固定于 `e737e4b18ff65704a12e38b18142fca55492cedd`。源文件行号与聊天工具包装内容的行号不同。使用实际函数和所读取区间说明观察，不将函数存在等同于所有组合场景已验证。

<a id="ref-3c-g10"></a>
- **[3C-G10]** 再次核对 `main`，仍为该提交；只固定本批观察点，不展开上游合并历史。  
  <https://github.com/Nephamaster/pi/commit/e737e4b18ff65704a12e38b18142fca55492cedd>
<a id="ref-3c-g38"></a>
- **[3C-G38]** `runtime/submission-store.ts`，完整读取。逐输出封存根、manifest 核对、完整提交、限定清单、重复内容比较及暂存发布。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/runtime/submission-store.ts>
<a id="ref-3c-g39"></a>
- **[3C-G39]** `artifact/manifest.ts`，读取第 1—250 行。文件路径、类型、JSON／UTF-8 基础内容检查、摘要生成与 `ArtifactValidationError.diagnostics`；未将未读剩余代码作为全量完整性验证依据。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/artifact/manifest.ts#L1-L250>
<a id="ref-3c-g40"></a>
- **[3C-G40]** `runtime/runtime-state.ts`，分段读取输入解析、批准判定、反馈与问题状态辅助函数、`invalidateFromNode()`、批准登记与完成判定。观察点包括实际版本绑定、来源 Review 有效性、Submission 粒度传播和当前节点／输出级返工关联。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/runtime/runtime-state.ts>
<a id="ref-3c-g41"></a>
- **[3C-G41]** `runtime/review-validation.ts`，完整读取。逐标准覆盖、总决策、证据关联、标准 target 与允许返工名单的联合校验。不能据此声称证据语义或根因已自动证明。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/runtime/review-validation.ts>
<a id="ref-3c-g42"></a>
- **[3C-G42]** `compiler/validate-workflow.ts`，本批读取第 165—430 行，并参照前批已核对的前段。重点是多目标标准歧义、待审输入、execution 的 approved 限制、前向拓扑、必需 Review／最终输出和完成依赖闭包。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/compiler/validate-workflow.ts#L165-L430>
- **前文源码定位 [3A-G25](#ref-3a-g25)／[3B-G32](#ref-3b-g32)**：`runtime/governance-transitions.ts` 的事务内采用边界和 `adapter/structured-submissions.ts` 的候选捕获，沿用第 07—10 章已有核对，不声称本批重新运行了其集成测试。

#### 补充公开资料

以下资料于 2026-09-21 核对。引用限定在本文对应的机制说明，不使用外部效果数字，也不将外部协议的全部义务引入本方法。

<a id="ref-3c-w22"></a>
- **[3C-W22] W3C，PROV-DM: The PROV Data Model，2013 Recommendation。** 使用实体、活动、责任与派生关系的区分，以及§2.1.2 对“使用不自动等于派生影响”的说明。本文中的当前依据失效不是要求按 PROV 定义销毁原始实体，也不要求完整 RDF 实现。  
  <https://www.w3.org/TR/prov-dm/>
<a id="ref-3c-w23"></a>
- **[3C-W23] Bazel，Remote Caching。** 使用内容寻址、执行条件与缓存正确性，以及 Known issues 中输入并发修改、环境和未跟踪工具的限制；不将语言模型任务普遍视为确定性构建。  
  <https://bazel.build/remote/caching>
<a id="ref-3c-w24"></a>
- **[3C-W24] 华为云 CodeArts Req，新建和审批通用评审（GR）。** 核对评审专家、审批人、关联对象与文件的区分；这是一项公开产品使用说明，不是完整华为内部 IPD 模板。  
  <https://support.huaweicloud.com/intl/zh-cn/usermanual-projectman/codeartsreq_01_6079.html>
<a id="ref-3c-w25"></a>
- **[3C-W25] SLSA v1.2，Verification Summary Attestation。** 使用验证者、对象、政策与相关验证依据绑定的思想；供应链等级、签名系统和该标准全文并非本方法最小必需依赖。  
  <https://slsa.dev/spec/v1.2/verification_summary>
<a id="ref-3c-w26"></a>
- **[3C-W26] SLSA v1.2，Build: Provenance。** 使用产物、构建者、构建定义、依赖和来源声明的分离；来源可信与任务业务正确是不同保证。  
  <https://slsa.dev/spec/v1.2/build-provenance>

另尝试读取华为云“跟踪与闭环评审意见”相关页面，但本批未稳定取得其正文，因此不据此扩展具体产品行为；Finding 的生命周期以本方法需求、既有记录和本批设计为依据。


## 来源组 3D

#### 依据边界

本批是方法实施指导，不是当前 Pi 的使用手册，也不是对华为内部 IPD 运行软件的复刻。节点与 Session 的持续责任、允许灾后恢复同一逻辑会话、阶段评审和定点返工来自用户已确认目标与前文。命令、等待、作用域资格、确切收口和恢复记录是本批提出的逻辑协议。

固定源码用于说明现有工程起点；公开工作流和并发资料用于核对具体机制。本文没有用它们的产品名称替代本系统自己的责任语义，也没有采用外部性能数字作为承诺。旧设计中的共享工作区、全局重试和单成员限制仅在明确历史背景下使用，不作为永久规范。

#### 本批文档与逻辑示例校验

已检查章节连续编号、代码围栏、来源标识和本地前文链接；7 组 YAML 示例通过解析与重复键检查，2 段 Python 纯逻辑示例通过语法检查及 28 个内存构造用例。用例覆盖确切收口依据、未满足义务、取消／所有权变化、准备包未验证、局部与全局撤销、输入失效、旧 Attempt，以及无关 revision 不改变资格。

这些检查以调用方已经正确构造当前依据和资格为前提，不验证这些事实如何从真实系统取得；**不能证明真实仓库的事务、进程、网络、原生 Session 恢复已经通过测试**。第 13、14 章的 58 项验收表仍是目标实现要求，不是已通过的系统测试清单。

本批没有修改 GitHub 仓库，没有运行完整 Pi 测试，没有启动真实模型任务，没有执行宿主崩溃、远端副作用或多进程故障实验。恢复与收口协议应在实际目标 Harness 上按本文边界验收。

#### 项目依据与前文

<a id="ref-3d-f00"></a>
- **[3D-F00]** 用户已确认：正常作业、补正和质量返工使用原持续 Session；宿主崩溃后允许恢复同一逻辑会话的物理执行实例；局部问题只影响真实责任与依赖，不无差别让其他节点返工。没有两份总纲之外的新架构硬约束。
<a id="ref-3d-s01"></a>
- **[3D-S01]** 《极简 Agent 设计方案》。其“模块划分明确，不额外增加功能”、复用原生模型／工具循环与分层上下文的方向，是本批不另建平行 Harness、不强制分布式基础设施的边界。未将其中早期简化示例当作完整安全实现。
<a id="ref-3d-s04"></a>
- **[3D-S04]** `what_is_ipd.md`，§四、§五：IPD Tool 为入口，规范、Compiler 与 Runtime 分工；前向依赖与返工闭环分开；只阻塞真实依赖，持续 Session 承担责任。它是项目研究记录，不是华为正式技术规范。
<a id="ref-3d-s05"></a>
- **[3D-S05]** 《IPD Tool V2 重构计划》，尤其依赖唯一来源、候选捕获、持续 Session、交付封存和早期真实试验记录。本批不继承其已被后续决定替换的单成员、旧工作区和不允许灾后重建等首版限制，也不将其历史测试数字作为本批结果。
<a id="ref-3d-s08"></a>
- **[3D-S08]** 《edict 未成功原因与 IPD 经验教训分析》，§4.2—§4.7、§6：控制不应依赖模型连续手工写状态，次数耗尽不强制准出，通知与账本不能分裂，不能同时维护两套事实。本批沿用历史研究启发，未重新审计 edict 当前版本。
<a id="ref-3d-s11"></a>
- **[3D-S11]** `IPD-Run-and-Portability-Audit.md`，既有 `20260917T150740223Z` Run 分析：请求体容量故障、恢复后原样再次失败、通用错误丢失定位信息，以及暂停与活动耗时区别。本批没有重新解包和复算原始 Run，不把历史观测冒充新的运行结果。
<a id="ref-3d-s12"></a>
- **[3D-S12]** 用户提供的 `project-reviewed-content-delivery.yaml@2.0.0`，重点为第 168—202、350—363 行的实际检查、修订复验、版本和完整交付要求。这里引用的是项目衍生规范，不是要求所有任务采用同一组内容开发评审。
- **前文**：[第 07、08 章](part-03-runtime-control.md#ch07)定义对象、身份、控制权和 I-01—I-10；[第 09、10 章](part-03-runtime-control.md#ch09)定义请求准入、持续工作、工具与环境；[第 11、12 章](part-03-runtime-control.md#ch11)定义交付、Finding、有类型失效与定点返工。本文引用这些定义，不重新生成第二套规则。

#### 固定源码观察

以下内容在本批通过仓库连接读取，固定于 `e737e4b18ff65704a12e38b18142fca55492cedd`。源码实际行号与工具 JSON 包装行号不同，定位以文件和函数为准。除下列范围外，不声称已经重新审阅整仓或所有历史提交。

<a id="ref-3d-g10"></a>
- **[3D-G10]** 再次读取 `main` 元数据，仍指向本批固定提交。不展开上游合并历史。  
  <https://github.com/Nephamaster/pi/commit/e737e4b18ff65704a12e38b18142fca55492cedd>
<a id="ref-3d-g43"></a>
- **[3D-G43]** `runtime/workflow-runtime.ts`，分段读取调度、最终投影、Run 暂停／恢复／取消、启动认领、超时、候选补正和检查登记路径。重点核对 `drive()`、`performSuspend()`、`resume()`、`runNode()`、`runRoundWithTimeout()`、`blockRound()` 与 `runExecution()`；尾部一次返回截断，未将未取得内容作为完整审计依据。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/runtime/workflow-runtime.ts>
<a id="ref-3d-g44"></a>
- **[3D-G44]** `runtime/ipd-service.ts`，读取第 1—355 行，核对内存请求去重／managed 所有权、原 Runtime 恢复、取消、清理、只读查询和后台执行入口。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/runtime/ipd-service.ts#L1-L355>
<a id="ref-3d-g45"></a>
- **[3D-G45]** `runtime/node-worker.ts`，完整读取。模型重试归属原生 Session；错误的 `retryable` 不授权整 round 重放；Worker 的停止、保留、恢复验证与结构化工作接口。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/runtime/node-worker.ts>
<a id="ref-3d-g46"></a>
- **[3D-G46]** `runtime/final-submission.ts`，完整读取。按交付输出解析批准、暂存复制、摘要校验、路径碰撞和最终目录替换。存在这些机制不等于已经验证全部并发收口条件。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/runtime/final-submission.ts>
<a id="ref-3d-g47"></a>
- **[3D-G47]** `runtime/run-snapshot.ts`，完整读取。静态对象内容寻址、摘要验证、缓存及存储版本；不将其当作原生 Session 与全部环境的检查点。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/runtime/run-snapshot.ts>
<a id="ref-3d-g29"></a>
- **[3D-G29]** `runtime/run-store.ts`，本批重新完整读取。单 Run 串行事务、writer lock、状态／事件／操作共同写入、文件同步与 rename、通知处理。执行所有权和可恢复投递需要额外协议。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/runtime/run-store.ts>
<a id="ref-3d-g28"></a>
- **[3D-G28]** `adapter/node-session-adapter.ts`，本批读取第 175—365 行，核对 dispatch、stop、pause、release、检查点提醒以及 lost／released 边界。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/adapter/node-session-adapter.ts#L175-L365>
<a id="ref-3d-g40"></a>
- **[3D-G40]** `runtime/runtime-state.ts`，本批读取第 1—220 行及第 400 行至文件末尾，核对确切输入、批准来源有效性、就绪和完成条件；细粒度影响分析沿用前一批来源，不声称本批再次执行其集成测试。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/runtime/runtime-state.ts>

#### 补充公开资料

以下资料于 2026-09-21 核对。引用只支撑标明的机制，不能替代本项目实际测试；产品自有的全部语义、部署组件和参数不自动成为本方法义务。

<a id="ref-3d-w27"></a>
- **[3D-W27] AWS Prescriptive Guidance，Transactional outbox pattern。** 核对状态与事件双写问题、同事务保存待发记录及重复消费处理；本文将其简化为可置于 RunStore 中的持久意图，不要求部署 AWS 服务或消息队列。  
  <https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html>
<a id="ref-3d-w28"></a>
- **[3D-W28] Amazon Builders’ Library，Timeouts, retries, and backoff with jitter。** 本批可读取的官方葡萄牙语版本；使用限时、重试放大、单层重试与抖动的原则，不采用其业务示例数字。  
  <https://aws.amazon.com/pt/builders-library/timeouts-retries-and-backoff-with-jitter/>
<a id="ref-3d-w12"></a>
- **[3D-W12] Amazon Builders’ Library，Making retries safe with idempotent APIs。** 本批重新核对请求身份、相同 ID 的意图一致性及语义等价回执；本地操作登记不自动提供远端 exactly-once。  
  <https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/>
<a id="ref-3d-w29"></a>
- **[3D-W29] Temporal，Activity Execution。** 核对异步完成、执行尝试和协作取消；它提供的是运行机制参考，不是本方法的 AgentSession 或质量准出协议。  
  <https://docs.temporal.io/activity-execution>
<a id="ref-3d-w30"></a>
- **[3D-W30] Temporal，Detecting Activity failures。** 核对不同作用范围的超时与 heartbeat。本文没有把心跳等同于业务进度，也没有把 timeout 当作远端动作未发生。  
  <https://docs.temporal.io/encyclopedia/detecting-activity-failures>
<a id="ref-3d-w31"></a>
- **[3D-W31] LangGraph，Checkpointers。** 核对 pending writes、checkpoint／replay 与 `exit/async/sync` 的恢复保证差异。本文不要求采用 super-step 屏障，也不把 replay 当成无副作用的历史重建。  
  <https://docs.langchain.com/oss/python/langgraph/checkpointers>
<a id="ref-3d-w32"></a>
- **[3D-W32] Python 3.13，Coroutines and Tasks。** 核对 Task cancellation、TaskGroup 和 gather 的失败传播语义；迁移时以目标 Python／框架版本为准。  
  <https://docs.python.org/3.13/library/asyncio-task.html>


## 来源组 3E

#### 依据边界

本批是本方法的目标设计和工程指导，不是当前 Pi 的完整功能说明，也不是华为内部组织制度或 IPD 软件的逐项复刻。源材料支持角色专精、责任分离、版本交付和流程治理；TeamPlan、Contribution、DelegationContract、子结果采用／责任保留、ChangeSet 与续接映射是为了兑现本项目已确认目标而提出的逻辑协议。

当前源码仍限制单成员，具有持久草稿和保守 replan 校验；这不代表本文的全部团队、子任务和在线迁移已经实现。本文也没有把其他框架“支持子图／迁移”的声明当作本方法语义已经得到验证。

#### 本批文档与逻辑示例校验

本批的结构、引用、本地链接和代码围栏经过检查；8 组 YAML 示例通过解析、重复键检查和部分跨示例引用核对；2 段 Python 纯逻辑示例通过语法检查与 44 个内存构造用例。用例分别检查子流程深度／作用域／累计创建／驻留配额与授权条件，以及基线切换的确切候选、旧依据、授权、映射、停止和未确定动作守卫。

这些函数假定输入事实已经由可信组件正确产生，不验证自然语言范围包含关系、真实存储原子性、权限后端、远端动作、进程停止、成员会话或灾后恢复。**54 项实施验收表是后续必须兑现的要求，不是当前系统已通过的测试报告。** 本批未修改 GitHub 仓库，未运行完整 Pi／Jiuwen 测试，也未执行真实模型、多进程或嵌套任务压力实验。

#### 项目依据与前文

<a id="ref-3e-f00"></a>
- **[3E-F00]** 用户确认的目标与边界：节点可由多人承担，允许受限的内部 IPD 委派、阶段评审与定点返工；正常工作维持原 Session，宿主崩溃后允许恢复同一逻辑会话；没有两份总纲之外新增的架构硬约束。本文据此区分目标能力与首版限制。
<a id="ref-3e-s01"></a>
- **[3E-S01]** 《极简 Agent 设计方案》，关于模块职责明确、复用模型／工具循环和按需资源披露的总体方向。本批未从其中推导出完整的子 Run 或多人状态 Schema；不将其早期安全提示示例当作实际权限机制。
<a id="ref-3e-s02"></a>
- **[3E-S02]** 《Agency-Agents 可借鉴设计分析》，§3.4—§3.8、§4.3—§4.6：专业资产、结构化交接、协作拓扑、避免偏置化评审和无收益角色。沿用此前项目研究，不声称重新验证 Agency 当前源码或其宣传指标。
<a id="ref-3e-s04"></a>
- **[3E-S04]** `what_is_ipd.md`，§四、§五：固定准备过程与任务图的区别，节点责任与多 Session、独立 Gate、确切版本、只影响真实依赖及持续责任。它是项目对公开方法的转译记录，不是华为正式模板。
<a id="ref-3e-s08"></a>
- **[3E-S08]** 《edict 未成功原因与 IPD 经验教训分析》，§4、§5、§6：不让模型承担流程事务、不强制末轮通过、不形成双架构和双重状态真相。只引用历史分析的设计启发，不在本批宣称重新审计 edict 当前运行。
<a id="ref-3e-s12"></a>
- **[3E-S12]** `project-reviewed-content-delivery.yaml@2.0.0`，第 204—337 行的必需评审及第 339—363 行的追溯、来源、版本和完整交付规则；第 10—13 行明确项目衍生性质。重复的同内容附件不作为多份独立证据。引用用于说明规范不能被团队或 replan 静默架空，不推广其全部活动为所有任务的必需项。
- **前文**：[第 07、08 章](part-03-runtime-control.md#ch07)规定任务依据、对象、身份和正式控制权；[第 09、10 章](part-03-runtime-control.md#ch09)规定上下文、工具、环境和持续工作；[第 11、12 章](part-03-runtime-control.md#ch11)规定交付、Finding、有类型依赖与定点返工；[第 13、14 章](part-03-runtime-control.md#ch13)规定调度、持久等待、确切收口和分类恢复。本批只组合这些基础，不另造一套宽松的内部协议。

#### 固定源码观察

本批通过 GitHub 连接读取以下路径，固定于 `e737e4b18ff65704a12e38b18142fca55492cedd`。以文件和函数定位为准，连接器结果的 JSON 行号不等于源码行号。没有据此宣称通读全部历史、分支、PR 或运行测试。

<a id="ref-3e-g10"></a>
- **[3E-G10]** 重新确认 `main` 仍指向上述提交；不展开上游自身的开发历史。  
  <https://github.com/Nephamaster/pi/commit/e737e4b18ff65704a12e38b18142fca55492cedd>
<a id="ref-3e-g23"></a>
- **[3E-G23]** `control/workflow-draft.ts`，本批读取第 1—260 行返回内容，核对 revision、operation ID、实例内队列、整项替换、validate／submit 和可信引用。它提供受控增量草稿，不等于多作者语义合并协议。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/control/workflow-draft.ts>
<a id="ref-3e-g26"></a>
- **[3E-G26]** `compiler/compiler.ts`，本批完整读取。核对规范／任务引用、冻结基线、节点到角色映射、资源和环境绑定；`agentByNode` 与 `agents[0].permissions` 仍体现单成员前提。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/compiler/compiler.ts>
<a id="ref-3e-g27"></a>
- **[3E-G27]** `compiler/validate-workflow.ts`，本批读取第 1—100 行，明确的 `multi_agent_node_unsupported` 和首成员映射。未用此范围证明全部阶段关系或复杂团队已可执行。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/compiler/validate-workflow.ts#L1-L100>
<a id="ref-3e-g48"></a>
- **[3E-G48]** `runtime/replan.ts`，完整读取。`validateReplan()` 限制任务、规范、标准、标准绑定和已启动责任参与者变化；它是校验函数，不能单独证明原子激活、在途迁移或父子变更已实现。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/runtime/replan.ts>
<a id="ref-3e-g49"></a>
- **[3E-G49]** `control/pi-control-roles.ts`，读取第 1—230、245—435 行返回内容，核对单 ST、单 Designer、原 Session 修订、角色资源、资产查询、正式提交与阻塞接口。没有将现有单角色生命周期概括为目标治理团队实现。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/control/pi-control-roles.ts>
<a id="ref-3e-g50"></a>
- **[3E-G50]** `adapter/pi-node-worker.ts`，读取第 80—240 行，核对环境准备、输入绑定、Skill／工具和导出路径对首成员的依赖。本批不将未读取部分描述为新的完整 Worker 审计。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/adapter/pi-node-worker.ts#L80-L240>

#### 补充公开资料

以下资料于 2026-09-22 核对，只用于标明的机制。产品默认值、完整组织流程、效果数字和运行依赖不自动成为本方法的要求。

<a id="ref-3e-w33"></a>
- **[3E-W33] Temporal，Child Workflows。** 核对子执行具有独立生命周期、启动确认与父关闭策略，以及不应仅为组织方便而增加子工作流的成本提醒。本方法另行定义子质量结果与父级责任验收。  
  <https://docs.temporal.io/child-workflows>
<a id="ref-3e-w34"></a>
- **[3E-W34] Temporal TypeScript，Child Workflows。** 核对 `startChild` 的启动确认与 `executeChild` 的结果等待区别；本文不直接复制其 API、默认关闭策略或所有执行语义。  
  <https://docs.temporal.io/develop/typescript/workflows/child-workflows>
<a id="ref-3e-w35"></a>
- **[3E-W35] LangGraph，Subgraphs。** 核对父子状态映射、私有历史、不同持久化模式及子图并发／命名空间限制。它提供适配注意事项，不证明本方法 Session 连续性和权限已经自动成立。  
  <https://docs.langchain.com/oss/python/langgraph/use-subgraphs>
<a id="ref-3e-w36"></a>
- **[3E-W36] Anthropic，How we built our multi-agent research system。** 使用明确委派、独立上下文、并行收益与协调开销的工程经验；不把文章内部实验数字作为本方法的净收益证明。  
  <https://www.anthropic.com/engineering/multi-agent-research-system>
<a id="ref-3e-w37"></a>
- **[3E-W37] 华为云 CodeArts Req，创建已基线需求的变更评审。** 使用其对评审专家、审批决策及实际变更步骤的分工。该页面的投票和人工操作属于具体产品实践，本文没有原样用于质量判定或强制人工审批。  
  <https://support.huaweicloud.com/intl/zh-cn/bestpractice-projectman/codeartsreq_practice_1044.html>
<a id="ref-3e-w38"></a>
- **[3E-W38] Camunda 8.9，Process instance migration。** 核对源目标映射、运行中元素迁移和状态保留的限制。本文建议的 ChangeSet、局部屏障及续接资格是本项目工程设计，不是该产品对任意 Agent 工作的保证。  
  <https://docs.camunda.io/docs/components/concepts/process-instance-migration/>


## 来源组 04

**项目材料。** 下列材料按其性质使用，不把历史设计或报告当作今天全部功能已经实现的证明。

<a id="ref-04-s01"></a>
- **[04-S01]** 《极简 Agent 设计方案》，第 1 页的模块边界与极简原则、第 2—3 页的按需检索和历史管理。本文只转用方向，不照搬“保留 K 轮”等早期示意参数。
<a id="ref-04-s02"></a>
- **[04-S02]** 《Agency-Agents 可借鉴设计分析》，§3.4、§3.7、§4.3—4.6、§5：交接、观测、避免偏置化评审与未经验证指标。历史研究，不声称本批重新审计 Agency 当前仓库。
<a id="ref-04-s08"></a>
- **[04-S08]** 《edict 未成功原因与 IPD 经验教训分析》，§4.8、§5、§8：区分演示、机制和真实质量，并进行有成本意识的对照。只引用历史分析的工程启发。
<a id="ref-04-s12"></a>
- **[04-S12]** `project-reviewed-content-delivery@2.0.0`：来源字段明确它是项目衍生规范；验证记录和版本规则要求定位、复验、披露未验证项。用于说明正式规范不能为加速被静默削弱，不推广其具体活动到全部任务。
<a id="ref-04-s13"></a>
- **[04-S13]** `IPD-Run-and-Portability-Audit.md`、`metrics.json`、`events.csv`，原审查对象 `20260917T150740223Z`，原 Pi 核对提交 `3011e03...`。本批读取已保存材料并复算活动区间，未重演业务。指标支持本章历史示例，不支持无对照的多 Agent 收益结论。支持包保存了此次使用的最小历史数据摘要与来源摘要。
- **前文**：第 08 章对象和权威；第 09—10 章上下文、容量与环境；第 11—12 章三类返工集合；第 13—16 章等待、恢复、团队和变更。本章只定义测量与验证，不另造控制规则。

**固定源码。** GitHub 连接确认 Pi `main` 仍为 `e737e4b18ff65704a12e38b18142fca55492cedd`。以下为定点读取，不是全仓或全历史验收。

<a id="ref-04-g51"></a>
- **[04-G51]** `runtime/telemetry.ts`，完整读取：原生事件投影、input/output 字段、独立 NDJSON、异常隔离和异步写队列。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/runtime/telemetry.ts>
<a id="ref-04-g52"></a>
- **[04-G52]** `runtime/run-store.ts`，读取第 1—225 行：外层 span、实例内队列、写锁、codec、原子替换、mutation metric 和提交后通知。未据此声明已经测试宿主断电与持久性。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/runtime/run-store.ts#L1-L225>

**本批新增公开资料。** 于 2026-09-22 核对，限于注明的机制。本文的大部分指标和实验契约为项目设计，不是对外部文献的复写。

<a id="ref-04-w39"></a>
- **[04-W39] OpenTelemetry GenAI semantic conventions，Metrics。** 原网站已提示迁往 `semantic-conventions-genai`；本批通过 GitHub 读取 `docs/gen-ai/gen-ai-metrics.md` 前 100 行，blob `1740a4bf11be874b4b85fb24d0143f02dfc7e98b`。确认 Development 状态和不同操作层级；未将全部字段视为稳定规范。  
  <https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md>
<a id="ref-04-w40"></a>
- **[04-W40] Google SRE，Monitoring Distributed Systems。** 引用延迟、流量、错误、饱和度和可行动监控的原则，不要求照搬其基础设施。  
  <https://sre.google/sre-book/monitoring-distributed-systems/>
<a id="ref-04-w41"></a>
- **[04-W41] 华为云 CodeArts TestPlan，测试评估流程与实践。** 页面说明测试报告侧重被测产品质量，执行过程总结用于阶段回顾；用于区分结果与过程评估。非华为内部完整模板。  
  <https://support.huaweicloud.com/usermanual-testman/cloudtest_01_1506.html>
<a id="ref-04-w42"></a>
- **[04-W42] Anthropic，Building effective agents。** 引用按需要增加组织复杂度和工具接口清晰的工程原则，不采用文章中的具体效果数字。  
  <https://www.anthropic.com/engineering/building-effective-agents>
<a id="ref-04-w43"></a>
- **[04-W43] Anthropic，Demystifying evals for AI agents。** 2026-01-09 发布。引用任务／trial／outcome 区分、独立评分、环境隔离、回归与能力评测以及多次尝试口径；不复用其 benchmark 分数或客户收益。  
  <https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents>
<a id="ref-04-w44"></a>
- **[04-W44] Hypothesis，Stateful tests。** 引用规则生成、参考状态模型与序列比较方法，不意味着本文已经运行 Hypothesis 状态机。  
  <https://hypothesis.readthedocs.io/en/latest/stateful.html>
<a id="ref-04-w45"></a>
- **[04-W45] SciPy，`scipy.stats.bootstrap`。** 引用 paired 索引共同重采样及区间方法限制；任务聚类与缺失处理为本文实验设计要求。未在本批执行真实任务的统计推断。  
  <https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.bootstrap.html>

**接续。** [第五部分](part-05-minimal-implementation-and-harness.md#part05)把这些测量和验收嵌入最小版本的开发顺序与跨 Harness 发布，避免“架构设计完，再考虑怎么测试和迁移”。


## 来源组 05

#### 项目依据与前文

<a id="ref-05-f00"></a>
- **[05-F00]** 用户确认的目标与边界：支持可控多成员和子流程的演进；正常返工原 Session；宿主崩溃后允许恢复同一逻辑会话；无总纲之外新增硬约束。没有把预算、HITL 或分布式部署设为最小版强制依赖。
<a id="ref-05-s01"></a>
- **[05-S01]** 《极简 Agent 设计方案》，第 1—3 页关于模块职责、工具入口、按需加载和历史管理的方向。本文采用其极简边界，不将其示意图当作完整安全或恢复实现。
<a id="ref-05-s08"></a>
- **[05-S08]** 《edict 未成功原因与 IPD 经验教训分析》，§4.2、§4.6—4.8、§6：避免 Prompt 承担状态事务、宿主安装路径强耦合、双架构和演示代替验证。历史研究，不是对 edict 最新版本的重新结论。
- **前文**：[第二部分](part-02-evolvable-assets.md#part02)是资产协议来源；[第三部分](part-03-runtime-control.md#part03)是治理与运行规则来源；[第四部分](part-04-efficiency-stability-and-validation.md#part04)是测量与验证口径来源。本文的接口和任务路线是这些要求的实现分解，不是新一套宽松规则。

#### 固定源码与目标侧文档

<a id="ref-05-g52"></a>
- **[05-G52]** Pi `runtime/run-store.ts`，本批读取第 1—225 行，固定提交 `e737e4b18ff65704a12e38b18142fca55492cedd`。核对 codec、文件事务和写锁；未运行持久化故障测试。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/runtime/run-store.ts#L1-L225>
<a id="ref-05-g53"></a>
- **[05-G53]** 同提交 `adapter/node-session-adapter.ts`，本批读取第 1—195 行，核对原生 Session 能力集合、参与者键、创建和事件转发。未把这段阅读当作所有 stop／restore 语义验证。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/src/adapter/node-session-adapter.ts#L1-L195>
<a id="ref-05-g54"></a>
- **[05-G54]** 同提交 `packages/ipd/package.json`，完整读取，核对依赖、Node 要求、构建和分发资源清单。不证明本环境已执行 build／test。  
  <https://github.com/Nephamaster/pi/blob/e737e4b18ff65704a12e38b18142fca55492cedd/packages/ipd/package.json>
<a id="ref-05-g55"></a>
- **[05-G55]** 公开 `openJiuwen-ai/jiuwenswarm` 默认分支与基线查询，本轮固定 `develop@31caa3314e01f1586b5bb2e2facc3cb60369ccb3`；不是用户团队内部极简仓库版本。  
  <https://github.com/openJiuwen-ai/jiuwenswarm/commit/31caa3314e01f1586b5bb2e2facc3cb60369ccb3>
<a id="ref-05-g56"></a>
- **[05-G56]** 该提交 `docs/en/AgentTeam.md`，读取第 1—195 行，只使用其公开的 Leader—Teammate 组织说明和入口；未检查完整实现，未断言某个底层能力必然具备或缺失。  
  <https://github.com/openJiuwen-ai/jiuwenswarm/blob/31caa3314e01f1586b5bb2e2facc3cb60369ccb3/docs/en/AgentTeam.md#L1-L195>

#### 补充公开资料

<a id="ref-05-w46"></a>
- **[05-W46] RFC 8785，JSON Canonicalization Scheme。** 用于跨语言规范化和摘要的一致性边界；Informational RFC。本批受限测试向量不等于完整 JCS 实现。  
  <https://datatracker.ietf.org/doc/html/rfc8785>
<a id="ref-05-w47"></a>
- **[05-W47] SQLite，Write-Ahead Logging。** 核对并行读写、单写者与同宿主限制。文件／SQLite／分布式的选择表是本项目建议，未进行存储基准测试。  
  <https://sqlite.org/wal.html>

#### 文档与示例验证

两份正文的结构、链接、引用编号、YAML 示例和重复键已经纳入本批检查；计量参考代码与跨语言受限向量的实际结果见[验证记录](source-snapshots/step-04-support/validation-report.md)。这些检查不覆盖真实模型、目标 Harness、文件权限、跨进程事务、网络、容器或灾后执行。T19／T20 为实施验收场景，未声称已由 Pi 或 Jiuwen 通过。
