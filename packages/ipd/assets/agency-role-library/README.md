# Agency-Agents 专业角色 YAML 库

## 交付范围

42 张角色卡覆盖所查提交的全部 18 个分类。选择从上游实际专业岗位出发，不以旧员工列表或 PPT 场景为边界，不再用通用“产物工程师”“证据审稿员”替代不同专业。查看 `docs/role-catalog.md` 的分类、文件和源文链接。

这是代表性角色库，不是所有子领域已经覆盖的声明。例如物理可靠性、制造验证及法定专业授权仍有真实缺口，设计师不能用相邻岗位强行填充。

## 结构与内容

`agent-cards/` 平铺 42 个 YAML，适配当前 AssetAssembler 只读取直接文件的行为。来源、校验和说明不放进被扫描的资产目录。字段沿用现有严格 AgentCard schema；没有为多装内容偷偷增加会被拒绝的字段。

| 上游内容 | 现有字段 |
|---|---|
| 身份、核心使命、职责 | description / responsibilities / applicableScenarios |
| 专业规则、边界 | principles / nonResponsibilities |
| 工作顺序、技术方法、进阶能力 | promptProfile.approach |
| 成果与报告模板 | deliverables（多行字符串）|
| 专业沟通方式 | promptProfile.communication |
| 质量检查、成功指标参考 | promptProfile.verification |

多行文本不受“只能写短标签”的限制。保留内容不意味着把虚构履历、无证承诺和代码示例一字不差地当成事实；具体调整可查元数据。

## 必要接入

当前上传代码的节点提示仅使用部分字段，控制角色还没有把完整员工画像渲染进提示。只复制 YAML 会让方法/模板等内容部分不生效。`integration/agent-profile-context.patch` 是针对该代码快照的窄补丁：新增确定性画像渲染函数，并在节点、ST、设计师现有系统提示入口调用；继续由 Pi 组装上下文，不管理历史、不自行压缩、不调用模型改写画像。

补丁不自动替换控制角色 ID。默认扩展仍查 `ipd-process-selector` 与 `ipd-workflow-designer`；保留独立 ST 资产，将工作流设计师显式绑定到 Project Shepherd（或发布有来源的控制用途衍生卡）后再运行。详见 `docs/integration.md`。

## 资源与权限

卡片声明的是发布资产的授权上限，节点仍需显式选择实际资源。专业段落里的框架/API/数据库名称不是已注册 Tool。`skills: []` 是无预置授权，不是通配符；需要某 Skill 时解析真实资源及所需工具、发布明确绑定的资产版本。知识库默认为空，不造占位库。

默认文件写权限限在 `outputs`；设计师继续收窄到节点互斥输出根。Code Reviewer 为只读卡；其他角色也可在独立评审节点使用，但必须收窄为只读和相应工具集合。Bash 本身不是沙箱，Node 权限声明不证明真实隔离已经实施。外部行动默认为 false，联网研究、真实广告变更、客户联系、远端测试、采购等需要另外的明确授权及执行边界。

## 验证

见 `docs/validation.md`：包括严格 schema 镜像检查、42 个来源和分类、软件规范能力映射、独立画像渲染测试及补丁适配检查。不宣称通过整个原项目 Compiler 或真实 Pi/模型质量评测。
