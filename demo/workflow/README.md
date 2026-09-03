# IPD Workflow 演示页

本目录展示 Workflow Asset：

```text
~/.pi/ipd/workflow/agent-harness-strategy-deck/1.0.0/c0b78627fa64d80ce3afc68214f100eb0094915a86e443675beb23542cf27519.json
```

`index.html` 已内嵌该资产的完整冻结配置、当前 Run 的 12 份 AgentCard Snapshot、样式和交互逻辑。只复制或打开这一个文件即可离线浏览，不需要 `workflow-data.js`、网络、构建或安装依赖。`workflow-data.js` 仅保留为生成页面时使用的原始展示快照，页面不会加载它。

交互方式：

- 点击执行节点：用递归配置树查看员工、目标、输入、交付物、工具、权限和返工配置；
- 点击节点下方 Gate：查看机械标准、语义标准、Reviewer 和 PASS/REWORK/BLOCKED 路由；对象与数组字段可逐层展开；
- 点击 Final Gate：查看整体交付验收；
- 点击 Gate 中的 Reviewer：查看当前 Run 冻结的 Reviewer AgentCard 完整配置；
- 点击底部 ST Core：查看治理成员的完整 AgentCard 配置；
- 点击“全部字段说明”：逐项查看每个字段的完整路径、当前值和简短解释；
- 使用右上角按钮缩放画布，按 Escape 返回总览。
