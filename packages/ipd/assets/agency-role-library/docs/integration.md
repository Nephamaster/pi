# 接入说明

## 安装资产

只将 `agent-cards/*.yaml` 放到 AssetAssembler 的一个明确目录。按分类浏览使用 catalog，不把 YAML 再藏入分类子目录——当前扫描器不递归。保留源许可和元数据供维护者查阅。

这些卡使用新的 `agency-*` ID 与 1.0.0 版本，不覆盖旧 12 个岗位。旧角色是否从搜索目录移除由你决定，但不要让同 ID/版本出现在多个资产目录。没有“自动选最高版本”的保证。

默认扩展写死查找两个控制角色 ID。本包没有假定导入 Project Shepherd 就能自动成为设计师；需明确修改选择配置，或发布由它派生的 `ipd-workflow-designer` 用途卡并只保留期望版本。该实例仍需要现有 `workflow-design` Skill、当前 Run Skill 和私有草稿工具。不要为此把所有 Project Shepherd 实例永久绑定某一个场景 Skill。

## 让专业内容真正生效

上传基线中的：
- `src/runtime/node-prompts.ts` 没有渲染 deliverables、promptProfile 和 applicableScenarios。
- `src/control/pi-control-roles.ts` 传入 agentCard 供资源/模型配置，但组装 selector/designer 系统提示时没有使用完整专业正文。

补丁把两类入口统一调用 `renderAgentProfile`。它只格式化资产，不合并消息、不改历史、不加载未授权资源。旧的职责拼接块被替换而非再次附加，避免重复。

在 IPD 包根目录检查：

```bash
git apply --check /path/to/integration/agent-profile-context.patch
# 审查差异后应用；只针对上传代码基线。
git apply /path/to/integration/agent-profile-context.patch
```

补丁含新增文件，不需要另复制一次 renderer。`patch-baseline.json` 给出两份原文件摘要；源码已变时人工对照三个接入点，不强行套用。随后执行你仓库的类型检查、单测及真实 Pi 节点测试。本次只验证独立渲染函数和补丁能套入上传快照。

## 权限及资源

专业会使用 SQL、浏览器、MCP、CAD 或广告 API 不代表都已经安装。先登记实际工具/Skill/知识库，再按节点绑定；卡片工具列表是上限，未列 Skill 不能理解为任意 Skill。为环境补充资源时发布新资产版本，并确保 Compiler 的完整资源锁定继续生效。

writeScopes=outputs 是员工上限，不是某次节点的写根。review 节点应只有读取确定 Submission 的实际权限；执行节点收窄到自己的输出根。不要因为工具名是 read 就忽略它对宿主其他路径的访问，也不要把 Bash 白名单当系统沙箱。

## 选取与上下文规模

现有 default-ipd-extension 使用 id/version/description/capabilities/skills/tools/permissions 作为员工摘要，可以继续使用。不要改成全库全文拼接。设计师需更深了解角色时，按明确资产 ID 读取相应文件；正式节点仅获得已选画像。角色模板是专业参考，不要求每次交付模板中全部可选内容。
