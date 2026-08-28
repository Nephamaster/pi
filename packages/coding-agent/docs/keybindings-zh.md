# 键位（Keybindings）

所有键盘快捷键都可以通过 `~/.pi/agent/keybindings.json` 自定义。每个动作可以绑定一个或多个按键。

配置文件使用 pi 内部使用的、也是扩展作者在 `keyHint()` 和注入的 `keybindings` 管理器中使用的同一套带命名空间的键位 id。

使用 `cursorUp` 或 `expandTools` 这类未带命名空间的旧 id 的旧配置会在启动时自动迁移到带命名空间的 id。

编辑 `keybindings.json` 后，在 pi 中运行 `/reload` 即可在不重启会话的情况下应用更改。

## 按键格式

`modifier+key`，修饰键为 `ctrl`、`shift`、`alt`、`super`（可组合），按键为：

- **字母：** `a-z`
- **数字：** `0-9`
- **特殊：** `escape`、`esc`、`enter`、`return`、`tab`、`space`、`backspace`、`delete`、`insert`、`clear`、`home`、`end`、`pageUp`、`pageDown`、`up`、`down`、`left`、`right`
- **功能键：** `f1`-`f12`
- **符号：** `` ` ``、`-`、`=`、`[`、`]`、`\`、`;`、`'`、`,`、`.`、`/`、`!`、`@`、`#`、`$`、`%`、`^`、`&`、`*`、`(`、`)`、`_`、`+`、`|`、`~`、`{`、`}`、`:`、`<`、`>`、`?`

修饰键组合：`ctrl+shift+x`、`alt+ctrl+x`、`ctrl+shift+alt+x`、`super+k`、`ctrl+super+k`、`ctrl+1` 等。

`super` 绑定需要能单独报告该修饰键的终端，通常通过 Kitty 键盘协议实现。在不支持该协议的终端中可能无效。

## 所有动作

### TUI 编辑器光标移动

| 键位 id | 默认 | 说明 |
|--------|---------|-------------|
| `tui.editor.cursorUp` | `up` | 光标上移，在顶部浏览更早的历史 |
| `tui.editor.cursorDown` | `down` | 光标下移，在底部浏览更新的历史 |
| `tui.editor.historyPrevious` | *(无)* | 选择上一条提示历史 |
| `tui.editor.historyNext` | *(无)* | 选择下一条提示历史 |
| `tui.editor.cursorLeft` | `left`、`ctrl+b` | 光标左移 |
| `tui.editor.cursorRight` | `right`、`ctrl+f` | 光标右移 |
| `tui.editor.cursorWordLeft` | `alt+left`、`ctrl+left`、`alt+b` | 按单词左移光标 |
| `tui.editor.cursorWordRight` | `alt+right`、`ctrl+right`、`alt+f` | 按单词右移光标 |
| `tui.editor.cursorLineStart` | `home`、`ctrl+home`、`ctrl+a` | 移到行首 |
| `tui.editor.cursorLineEnd` | `end`、`ctrl+end`、`ctrl+e` | 移到行尾 |
| `tui.editor.jumpForward` | `ctrl+]` | 向前跳转到字符 |
| `tui.editor.jumpBackward` | `ctrl+alt+]` | 向后跳转到字符 |
| `tui.editor.pageUp` | `pageUp`、`ctrl+pageUp` | 向上翻一页 |
| `tui.editor.pageDown` | `pageDown`、`ctrl+pageDown` | 向下翻一页 |

专用历史动作始终改变历史条目，与多行提示中的光标位置无关。主编辑器聚焦时，显式历史绑定优先于应用动作，因此把 `tui.editor.historyPrevious` 绑定到 `ctrl+p` 会在那种上下文中覆盖模型循环切换，而不改变选择器中的 `Ctrl+P`。

### TUI 编辑器删除

| 键位 id | 默认 | 说明 |
|--------|---------|-------------|
| `tui.editor.deleteCharBackward` | `backspace` | 向后删除字符 |
| `tui.editor.deleteCharForward` | `delete`、`ctrl+d` | 向前删除字符 |
| `tui.editor.deleteWordBackward` | `ctrl+w`、`alt+backspace` | 向后删除单词 |
| `tui.editor.deleteWordForward` | `alt+d`、`alt+delete` | 向前删除单词 |
| `tui.editor.deleteToLineStart` | `ctrl+u` | 删除到行首 |
| `tui.editor.deleteToLineEnd` | `ctrl+k` | 删除到行尾 |

### TUI 输入

| 键位 id | 默认 | 说明 |
|--------|---------|-------------|
| `tui.input.newLine` | `shift+enter`、`ctrl+j` | 插入新行 |
| `tui.input.submit` | `enter` | 提交输入 |
| `tui.input.tab` | `tab` | Tab / 自动补全 |

### TUI Kill Ring

| 键位 id | 默认 | 说明 |
|--------|---------|-------------|
| `tui.editor.yank` | `ctrl+y` | 粘贴最近删除的文本 |
| `tui.editor.yankPop` | `alt+y` | yank 后在已删除文本间循环 |
| `tui.editor.undo` | `ctrl+-` | 撤销最后一次编辑 |

### TUI 剪贴板和选择

| 键位 id | 默认 | 说明 |
|--------|---------|-------------|
| `tui.input.copy` | `ctrl+c` | 复制选区 |
| `tui.select.up` | `up` | 选择项上移 |
| `tui.select.down` | `down` | 选择项下移 |
| `tui.select.pageUp` | `pageUp` | 列表中上翻页 |
| `tui.select.pageDown` | `pageDown` | 列表中下翻页 |
| `tui.select.confirm` | `enter` | 确认选择 |
| `tui.select.cancel` | `escape`、`ctrl+c` | 取消选择 |

### TUI 全屏视口

当交互模式使用 `--tui-mode fullscreen` 时，这些动作生效，目标是主转录滚动区域。双指轨道板和鼠标滚轮输入滚动指针下方的区域，回退到固定编辑器/状态/页脚坞上方的转录。点击 OSC 8 超链接会在默认处理器中打开它。用主鼠标按钮拖拽选择文本并复制到剪贴板；在转录顶部或底部边缘按住会自动滚动到屏幕外内容。终端特定的鼠标和轨道板行为见 [Terminal setup](terminal-setup.md)。

全屏转录绑定优先于编辑器绑定。因此默认不带修饰键的导航键在全屏模式下控制转录，而它们的 `ctrl` 变体继续控制编辑器。全屏模式之外，两种变体都控制编辑器。

| 按键 | 默认模式 | 全屏模式 |
|-----|--------------|-----------------|
| `home`、`end` | 编辑器 | 转录 |
| `ctrl+home`、`ctrl+end` | 编辑器 | 编辑器 |
| `pageUp`、`pageDown` | 编辑器 | 转录 |
| `ctrl+pageUp`、`ctrl+pageDown` | 编辑器 | 编辑器 |

该路由仍可通过普通动作绑定配置。例如，`"tui.altScreen.pageUp": "ctrl+pageUp"` 让全屏模式下 `pageUp` 控制编辑器、`ctrl+pageUp` 控制转录。绑定 `tui.altScreen.halfPageUp` 和 `tui.altScreen.halfPageDown` 实现半页步进，或绑定 `tui.altScreen.lineUp` 和 `tui.altScreen.lineDown` 实现单行步进。设置 `"tui.altScreen.pageUp": []` 可完全禁用该转录快捷键。用户绑定替换该动作的默认值。

| 键位 id | 默认 | 说明 |
|--------|---------|-------------|
| `tui.altScreen.pageUp` | `pageUp` | 转录向上翻一页 |
| `tui.altScreen.pageDown` | `pageDown` | 转录向下翻一页 |
| `tui.altScreen.halfPageUp` | *(无)* | 转录向上翻半页 |
| `tui.altScreen.halfPageDown` | *(无)* | 转录向下翻半页 |
| `tui.altScreen.lineUp` | *(无)* | 转录上移一行 |
| `tui.altScreen.lineDown` | *(无)* | 转录下移一行 |
| `tui.altScreen.previousPrompt` | `ctrl+shift+up` | 跳转到上一个标记的消息 |
| `tui.altScreen.nextPrompt` | `ctrl+shift+down` | 跳转到下一个标记的消息 |
| `tui.altScreen.search` | `ctrl+shift+f` | 搜索已渲染的转录 |
| `tui.altScreen.searchNext` | `enter`、`ctrl+g` | 搜索时选择下一个匹配 |
| `tui.altScreen.searchPrevious` | `shift+enter`、`ctrl+shift+g` | 搜索时选择上一个匹配 |
| `tui.altScreen.searchClose` | `escape` | 关闭转录搜索 |
| `tui.altScreen.top` | `home` | 滚动到转录开头 |
| `tui.altScreen.bottom` | `end` | 滚动到转录末尾并跟随新输出 |

### 应用

| 键位 id | 默认 | 说明 |
|--------|---------|-------------|
| `app.interrupt` | `escape` | 取消 / 中止 |
| `app.clear` | `ctrl+c` | 清除编辑器（第一次）/ 退出（第二次） |
| `app.exit` | `ctrl+d` | 退出（编辑器为空时） |
| `app.suspend` | `ctrl+z`（Windows 上无） | 挂起到后台 |
| `app.editor.external` | `ctrl+g` | 在外部编辑器中打开（`externalEditor`、`$VISUAL`、`$EDITOR`、Windows 上是 Notepad，其他系统是 `nano`） |
| `app.clipboard.pasteImage` | `ctrl+v`（Windows 上是 `alt+v`） | 从剪贴板粘贴图片或文本 |

### 会话

| 键位 id | 默认 | 说明 |
|--------|---------|-------------|
| `app.session.new` | *(无)* | 开始新会话（`/new`） |
| `app.session.tree` | *(无)* | 打开会话树导航器（`/tree`） |
| `app.session.fork` | *(无)* | 分叉当前会话（`/fork`） |
| `app.session.resume` | *(无)* | 打开会话恢复选择器（`/resume`） |
| `app.session.togglePath` | `ctrl+p` | 切换路径显示 |
| `app.session.toggleSort` | `ctrl+s` | 切换排序模式 |
| `app.session.toggleNamedFilter` | `ctrl+n` | 切换仅已命名过滤 |
| `app.session.rename` | `ctrl+r` | 重命名会话 |
| `app.session.delete` | `ctrl+d` | 删除会话 |
| `app.session.deleteNoninvasive` | `ctrl+backspace` | 查询为空时删除会话 |

### 模型和思考

| 键位 id | 默认 | 说明 |
|--------|---------|-------------|
| `app.model.select` | `ctrl+l` | 打开模型选择器 |
| `app.model.cycleForward` | `ctrl+p` | 循环到下一个模型 |
| `app.model.cycleBackward` | `shift+ctrl+p` | 循环到上一个模型 |
| `app.thinking.cycle` | `shift+tab` | 循环思考级别 |
| `app.thinking.toggle` | `ctrl+t` | 折叠或展开思考块 |

### 显示和消息队列

| 键位 id | 默认 | 说明 |
|--------|---------|-------------|
| `app.tools.expand` | `ctrl+o` | 折叠或展开工具输出 |
| `app.message.copy` | `ctrl+x` | 复制最后一条 assistant 消息，或 `/tree` 中选中的消息 |
| `app.message.followUp` | `alt+enter` | 排队 follow-up 消息 |
| `app.message.dequeue` | `alt+up` | 把已排队消息恢复到编辑器 |

### 树导航

| 键位 id | 默认 | 说明 |
|--------|---------|-------------|
| `app.tree.foldOrUp` | `ctrl+left`、`alt+left` | 折叠当前分支段，或跳转到上一段开头 |
| `app.tree.unfoldOrDown` | `ctrl+right`、`alt+right` | 展开当前分支段，或跳转到下一段开头或分支末尾 |
| `app.tree.editLabel` | `shift+l` | 编辑选中树节点的标签 |
| `app.tree.toggleLabelTimestamp` | `shift+t` | 切换树中标签的时间戳 |
| `app.tree.filter.default` | `ctrl+d` | 把树过滤设为默认视图 |
| `app.tree.filter.noTools` | `ctrl+t` | 切换隐藏工具结果的树过滤 |
| `app.tree.filter.userOnly` | `ctrl+u` | 切换只显示用户消息的树过滤 |
| `app.tree.filter.labeledOnly` | `ctrl+l` | 切换只显示带标签条目的树过滤 |
| `app.tree.filter.all` | `ctrl+a` | 切换显示全部条目的树过滤 |
| `app.tree.filter.cycleForward` | `ctrl+o` | 向前循环树过滤 |
| `app.tree.filter.cycleBackward` | `shift+ctrl+o` | 向后循环树过滤 |

### 作用域模型选择器

用于作用域模型选择器内部（通过 `/scoped-models` 打开）。

| 键位 id | 默认 | 说明 |
|--------|---------|-------------|
| `app.models.save` | `ctrl+s` | 把当前模型选择保存到设置 |
| `app.models.enableAll` | `ctrl+a` | 启用所有模型（或所有匹配当前搜索的） |
| `app.models.clearAll` | `ctrl+x` | 清除所有模型（或所有匹配当前搜索的） |
| `app.models.toggleProvider` | `ctrl+p` | 切换当前 provider 的所有模型 |
| `app.models.reorderUp` | `alt+up` | 在循环顺序中上移选中模型 |
| `app.models.reorderDown` | `alt+down` | 在循环顺序中下移选中模型 |

## 自定义配置

创建 `~/.pi/agent/keybindings.json`：

```json
{
  "tui.editor.historyPrevious": "ctrl+p",
  "tui.editor.historyNext": "ctrl+n",
  "tui.editor.deleteWordBackward": ["ctrl+w", "alt+backspace"]
}
```

每个动作可以是单个按键或按键数组。用户配置覆盖默认值。

在原生 Windows 上，`app.suspend` 没有默认绑定，因为 Windows 终端不支持 Unix 作业控制。如果你手动绑定它，pi 会显示状态消息而不是挂起。在 WSL 中，正常的 Linux `ctrl+z`/`fg` 行为仍然适用。

### Emacs 示例

```json
{
  "tui.editor.historyPrevious": "ctrl+p",
  "tui.editor.historyNext": "ctrl+n",
  "tui.editor.cursorLeft": ["left", "ctrl+b"],
  "tui.editor.cursorRight": ["right", "ctrl+f"],
  "tui.editor.cursorWordLeft": ["alt+left", "alt+b"],
  "tui.editor.cursorWordRight": ["alt+right", "alt+f"],
  "tui.editor.deleteCharForward": ["delete", "ctrl+d"],
  "tui.editor.deleteCharBackward": ["backspace", "ctrl+h"],
  "tui.input.newLine": ["shift+enter", "ctrl+j"]
}
```

### Vim 示例

```json
{
  "tui.editor.cursorUp": ["up", "alt+k"],
  "tui.editor.cursorDown": ["down", "alt+j"],
  "tui.editor.cursorLeft": ["left", "alt+h"],
  "tui.editor.cursorRight": ["right", "alt+l"],
  "tui.editor.cursorWordLeft": ["alt+left", "alt+b"],
  "tui.editor.cursorWordRight": ["alt+right", "alt+w"]
}
```
