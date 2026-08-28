> pi 可以创建主题。让它为你的环境构建一个。

# 主题（Themes）

主题是定义 TUI 颜色的 JSON 文件。

## 目录

- [存放位置](#locations)
- [选择主题](#selecting-a-theme)
- [创建自定义主题](#creating-a-custom-theme)
- [主题格式](#theme-format)
- [颜色令牌](#color-tokens)
- [颜色值](#color-values)
- [技巧](#tips)

## 存放位置

Pi 从以下位置加载主题：

- 内置：`dark`、`light`
- 全局：`~/.pi/agent/themes/*.json`
- 项目：`.pi/themes/*.json`（仅在项目被信任后）
- 包：`themes/` 目录或 `package.json` 中的 `pi.themes` 条目
- 设置：`themes` 数组，包含文件或目录
- CLI：`--theme <path>`（可重复）

用 `--no-themes` 禁用发现。

## 选择主题

通过 `/settings` 或在 `settings.json` 中选择主题：

```json
{
  "theme": "my-theme"
}
```

首次运行时，pi 检测终端背景并默认使用 `dark` 或 `light`。

### 初始主题

不更改已保存设置，为一次交互运行指定主题：

```bash
pi --use-theme light
```

要跟随终端外观，使用 `lightTheme/darkTheme` 语法：

```bash
pi --use-theme light/dark
```

CLI 值是那次运行的初始主题。之后在 `/settings` 中另选主题会立即应用
并正常保存。

## 创建自定义主题

1. 创建主题文件：

```bash
mkdir -p ~/.pi/agent/themes
vim ~/.pi/agent/themes/my-theme.json
```

2. 用所有必需颜色定义主题（见 [颜色令牌](#color-tokens)）：

```json
{
  "$schema": "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  "name": "my-theme",
  "vars": {
    "primary": "#00aaff",
    "secondary": 242
  },
  "colors": {
    "accent": "primary",
    "border": "primary",
    "borderAccent": "#00ffff",
    "borderMuted": "secondary",
    "success": "#00ff00",
    "error": "#ff0000",
    "warning": "#ffff00",
    "muted": "secondary",
    "dim": 240,
    "text": "",
    "thinkingText": "secondary",
    "selectedBg": "#2d2d30",
    "scrollbarThumb": "#555566",
    "searchMatchBg": "#2d2d30",
    "searchMatchText": "",
    "userMessageBg": "#2d2d30",
    "userMessageText": "",
    "customMessageBg": "#2d2d30",
    "customMessageText": "",
    "customMessageLabel": "primary",
    "toolPendingBg": "#1e1e2e",
    "toolSuccessBg": "#1e2e1e",
    "toolErrorBg": "#2e1e1e",
    "toolTitle": "primary",
    "toolOutput": "",
    "mdHeading": "#ffaa00",
    "mdLink": "primary",
    "mdLinkUrl": "secondary",
    "mdCode": "#00ffff",
    "mdCodeBlock": "",
    "mdCodeBlockBorder": "secondary",
    "mdQuote": "secondary",
    "mdQuoteBorder": "secondary",
    "mdHr": "secondary",
    "mdListBullet": "#00ffff",
    "toolDiffAdded": "#00ff00",
    "toolDiffRemoved": "#ff0000",
    "toolDiffContext": "secondary",
    "syntaxComment": "secondary",
    "syntaxKeyword": "primary",
    "syntaxFunction": "#00aaff",
    "syntaxVariable": "#ffaa00",
    "syntaxString": "#00ff00",
    "syntaxNumber": "#ff00ff",
    "syntaxType": "#00aaff",
    "syntaxOperator": "primary",
    "syntaxPunctuation": "secondary",
    "thinkingOff": "secondary",
    "thinkingMinimal": "primary",
    "thinkingLow": "#00aaff",
    "thinkingMedium": "#00ffff",
    "thinkingHigh": "#ff00ff",
    "thinkingXhigh": "#ff0000",
    "thinkingMax": "#ff0088",
    "bashMode": "#ffaa00"
  }
}
```

3. 通过 `/settings` 选择主题。

**热重载：** 当你编辑当前活动的自定义主题文件时，pi 会自动重新加载它以提供即时视觉反馈。

## 主题格式

```json
{
  "$schema": "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  "name": "my-theme",
  "vars": {
    "blue": "#0066cc",
    "gray": 242
  },
  "colors": {
    "accent": "blue",
    "muted": "gray",
    "text": "",
    ...
  }
}
```

- `name` 必填，必须唯一，且不能包含 `/`。
- `vars` 可选。在这里定义可复用颜色，然后在 `colors` 中引用。
- `colors` 必须定义全部 51 个必需令牌。`thinkingMax`、`scrollbarThumb` 和两个搜索高亮令牌是可选的，使用下列回退值。

`$schema` 字段启用编辑器自动补全和校验。

## 颜色令牌

每个主题必须定义全部 51 个必需颜色令牌。可选令牌为兼容现有主题而保留：`thinkingMax` 回退到 `thinkingXhigh`，`scrollbarThumb` 和 `searchMatchBg` 回退到 `selectedBg`，`searchMatchText` 回退到 `text`。其他搜索匹配使用 `searchMatchBg` 上的 `searchMatchText` 加下划线；当前匹配反转该前景/背景对并使用粗体文本。

### 核心 UI（11 个颜色）

| 令牌 | 用途 |
|-------|---------|
| `accent` | 主强调色（logo、选中项、光标） |
| `border` | 普通边框 |
| `borderAccent` | 高亮边框 |
| `borderMuted` | 低调边框（编辑器） |
| `success` | 成功状态 |
| `error` | 错误状态 |
| `warning` | 警告状态 |
| `muted` | 次要文本 |
| `dim` | 第三级文本 |
| `text` | 默认文本（通常是 `""`） |
| `thinkingText` | 思考块文本 |

### 背景和内容（11 个必需，3 个可选）

| 令牌 | 用途 |
|-------|---------|
| `selectedBg` | 选中行背景 |
| `scrollbarThumb` | 全屏滚动条滑块背景；可选，回退到 `selectedBg` |
| `searchMatchBg` | 转录搜索匹配背景和当前匹配文本；可选，回退到 `selectedBg` |
| `searchMatchText` | 转录搜索匹配文本和当前匹配背景；可选，回退到 `text` |
| `userMessageBg` | 用户消息背景 |
| `userMessageText` | 用户消息文本 |
| `customMessageBg` | 扩展消息背景 |
| `customMessageText` | 扩展消息文本 |
| `customMessageLabel` | 扩展消息标签 |
| `toolPendingBg` | 工具框（等待中） |
| `toolSuccessBg` | 工具框（成功） |
| `toolErrorBg` | 工具框（错误） |
| `toolTitle` | 工具标题 |
| `toolOutput` | 工具输出文本 |

### Markdown（10 个颜色）

| 令牌 | 用途 |
|-------|---------|
| `mdHeading` | 标题 |
| `mdLink` | 链接文本 |
| `mdLinkUrl` | 链接 URL |
| `mdCode` | 行内代码 |
| `mdCodeBlock` | 代码块内容 |
| `mdCodeBlockBorder` | 代码块围栏 |
| `mdQuote` | 引用文本 |
| `mdQuoteBorder` | 引用边框 |
| `mdHr` | 水平线 |
| `mdListBullet` | 列表符号 |

### 工具 Diff（3 个颜色）

| 令牌 | 用途 |
|-------|---------|
| `toolDiffAdded` | 添加的行 |
| `toolDiffRemoved` | 删除的行 |
| `toolDiffContext` | 上下文行 |

### 语法高亮（9 个颜色）

| 令牌 | 用途 |
|-------|---------|
| `syntaxComment` | 注释 |
| `syntaxKeyword` | 关键字 |
| `syntaxFunction` | 函数名 |
| `syntaxVariable` | 变量 |
| `syntaxString` | 字符串 |
| `syntaxNumber` | 数字 |
| `syntaxType` | 类型 |
| `syntaxOperator` | 运算符 |
| `syntaxPunctuation` | 标点 |

### 思考级别边框（6 个必需，1 个可选）

表示思考级别的编辑器边框颜色（视觉层次从低调到醒目）：

| 令牌 | 用途 |
|-------|---------|
| `thinkingOff` | 思考关闭 |
| `thinkingMinimal` | 最小思考 |
| `thinkingLow` | 低思考 |
| `thinkingMedium` | 中思考 |
| `thinkingHigh` | 高思考 |
| `thinkingXhigh` | 超高思考 |
| `thinkingMax` | 最大思考；可选，回退到 `thinkingXhigh` |

### Bash 模式（1 个颜色）

| 令牌 | 用途 |
|-------|---------|
| `bashMode` | bash 模式（`!` 前缀）下的编辑器边框 |

### HTML 导出（可选）

`export` 部分控制 `/export` HTML 输出的颜色。省略时，颜色从 `userMessageBg` 派生。

```json
{
  "export": {
    "pageBg": "#18181e",
    "cardBg": "#1e1e24",
    "infoBg": "#3c3728"
  }
}
```

## 颜色值

支持四种格式：

| 格式 | 示例 | 说明 |
|--------|---------|-------------|
| 十六进制 | `"#ff0000"` | 6 位十六进制 RGB |
| 256 色 | `39` | xterm 256 色调色板索引（0-255） |
| 变量 | `"primary"` | 对 `vars` 条目的引用 |
| 默认 | `""` | 终端的默认颜色 |

### 256 色调色板

- `0-15`：基础 ANSI 颜色（取决于终端）
- `16-231`：6×6×6 RGB 立方体（R、G、B 为 0-5 时的 `16 + 36×R + 6×G + B`）
- `232-255`：灰度梯度

### 终端兼容性

Pi 使用 24 位 RGB 颜色。大多数现代终端支持（iTerm2、Kitty、WezTerm、Windows Terminal、VS Code）。对于仅支持 256 色的旧终端，pi 回退到最近的近似值。

检查 truecolor 支持：

```bash
echo $COLORTERM  # Should output "truecolor" or "24bit"
```

## 技巧

**深色终端：** 使用高对比度的明亮饱和颜色。

**浅色终端：** 使用低对比度的深色柔和颜色。

**颜色和谐：** 从一个基础调色板（Nord、Gruvbox、Tokyo Night）开始，在 `vars` 中定义，并一致地引用。

**测试：** 用不同消息类型、工具状态、markdown 内容和长换行文本检查你的主题。

**VS Code：** 把 `terminal.integrated.minimumContrastRatio` 设为 `1` 以获得准确颜色。

## 示例

见内置主题：
- [dark.json](../src/modes/interactive/theme/dark.json)
- [light.json](../src/modes/interactive/theme/light.json)
