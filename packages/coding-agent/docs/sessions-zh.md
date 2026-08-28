# 会话（Sessions）

Pi 将对话保存为会话（session），让你可以继续工作、从更早的回合分支、并回看之前的路径。

## 会话存储

会话自动保存到 `~/.pi/agent/sessions/`，按工作目录组织。每个会话是一个具有树结构的 JSONL 文件。

```bash
pi -c                  # 继续最近的会话
pi -r                  # 浏览并选择历史会话
pi --no-session        # 临时模式；不保存
pi --name "my task"    # 启动时设置会话显示名
pi --session <path|id> # 使用特定会话文件或会话 ID 片段
pi --fork <path|id>    # 将会话文件或会话 ID 片段分叉为新会话
```

交互模式下用 `/session` 查看当前会话文件、会话 ID、消息数、token 和成本。

JSONL 文件格式和 SessionManager API 见 [Session Format](session-format.md)。

## 会话命令

| 命令 | 说明 |
|---------|-------------|
| `/resume` | 浏览并选择之前的会话 |
| `/new` | 开始新会话 |
| `/name <name>` | 设置当前会话显示名 |
| `/session` | 显示会话信息 |
| `/tree` | 导航当前会话树 |
| `/fork` | 从之前的用户消息创建新会话 |
| `/clone` | 把当前活动分支复制到新会话 |
| `/compact [prompt]` | 摘要较早的上下文；见 [Compaction](compaction.md) |
| `/export [file]` | 将会话导出为 HTML |
| `/share` | 上传为私有 GitHub gist，附可分享的 HTML 链接 |

## 恢复和删除会话

`/resume` 为当前项目打开交互式会话选择器。`pi -r` 在启动时打开相同的选择器。

在选择器中你可以：

- 输入进行搜索
- Ctrl+P 切换路径显示
- Ctrl+S 切换排序模式
- Ctrl+N 过滤到已命名会话
- Ctrl+R 重命名
- Ctrl+D 删除，然后确认

在有 `trash` CLI 可用时，pi 用它删除而不是永久移除文件。

## 会话命名

用 `/name <name>` 设置人类可读的会话名：

```text
/name Refactor auth module
```

启动时用 `--name` 或 `-n` 设置：

```bash
pi --name "Refactor auth module"
pi --name "CI audit" -p "Review this build failure"
```

已命名会话在 `/resume` 和 `pi -r` 中更容易找到。

## 用 `/tree` 分支

会话以树形式存储。每个条目有 `id` 和 `parentId`，当前位置是活动叶子。`/tree` 让你跳到任意之前的点并从中继续，无需创建新文件。

<p align="center"><img src="images/tree-view.png" alt="树视图" width="600"></p>

示例形状：

```text
├─ user: "Hello, can you help..."
│  └─ assistant: "Of course! I can..."
│     ├─ user: "Let's try approach A..."
│     │  └─ assistant: "For approach A..."
│     │     └─ user: "That worked..."  ← active
│     └─ user: "Actually, approach B..."
│        └─ assistant: "For approach B..."
```

### 树操作

| 按键 | 动作 |
|-----|--------|
| ↑/↓ | 导航可见条目 |
| ←/→ | 上/下翻页 |
| Ctrl+←/Ctrl+→ 或 Alt+←/Alt+→ | 折叠/展开或在分支段之间跳转 |
| Shift+L | 为选中条目设置或清除标签 |
| Shift+T | 切换标签时间戳 |
| Enter | 选择条目 |
| Escape/Ctrl+C | 取消 |
| Ctrl+O | 循环切换过滤模式 |

过滤模式有：default、no-tools、user-only、labeled-only 和 all。在 [Settings](settings.md) 中用 `treeFilterMode` 配置默认值。

### 选择行为

选择用户或自定义消息：

1. 把叶子移到所选消息的父节点。
2. 将所选消息文本放入编辑器。
3. 你可以编辑并重新提交，创建一个新分支。

选择 assistant、工具、压缩或其他非用户条目：

1. 把叶子移到该条目。
2. 编辑器保持为空。
3. 你可以从该点继续。

选择根用户消息会把叶子重置为空对话，并将原始提示放入编辑器。

## `/tree`、`/fork` 和 `/clone`

| 功能 | `/tree` | `/fork` | `/clone` |
|---------|---------|---------|----------|
| 输出 | 同一个会话文件 | 新会话文件 | 新会话文件 |
| 视图 | 完整树 | 用户消息选择器 | 当前活动分支 |
| 典型用途 | 就地探索替代方案 | 从更早的提示开始新会话 | 继续之前复制当前工作 |
| 摘要 | 可选分支摘要 | 无 | 无 |

想保持替代方案在一起时用 `/tree`。想要单独的会话文件时用 `/fork` 或 `/clone`。

## 分支摘要

当 `/tree` 从一个分支切换到另一个时，pi 可以摘要被放弃的分支，并把该摘要附加到新位置。这保留了离开路径上的重要上下文，而无需重放整个分支。

提示时选择：

1. 不摘要
2. 用默认提示摘要
3. 用自定义重点指令摘要

分支摘要的内部机制和扩展钩子见 [Compaction](compaction.md)。

## 会话格式

会话文件是 JSONL，包含消息条目、模型变更、思考级别变更、标签、压缩、分支摘要和扩展条目。

解析器、扩展、SDK 用法和完整的 SessionManager API 见 [Session Format](session-format.md)。
