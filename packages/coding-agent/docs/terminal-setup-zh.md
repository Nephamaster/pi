# 终端设置

Pi 使用 [Kitty 键盘协议](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) 可靠检测修饰键。大多数现代终端支持该协议，但有些需要配置。

## Kitty

开箱即用。

## iTerm2

### 常规 TUI 模式

开箱即用。

### 全屏 TUI 模式

Pi 拥有视口，因此 iTerm2 会发送鼠标滚轮报告而不是滚动其原生回滚区。在 iTerm2 默认的快轨道板（fast-trackpad）行为下，这些报告可能丢失大部分加速滚轮增量，使全屏滚动比常规滚动慢得多。

如果快速鼠标滚轮手势在全屏模式下每次只移动大约一行：

1. 打开 **iTerm2 → Settings → Advanced**。
2. 搜索 **Trackpad scrolls fast?** 并设为 **No**。

这是一个 iTerm2 全局的变通方案，也可能改变原生轨道板滚动。底层行为跟踪在 [iTerm2 issue 9619](https://gitlab.com/gnachman/iterm2/-/work_items/9619)。

## Apple Terminal

Pi 在可用时会启用增强按键报告。如果 Terminal.app 对 `Shift+Enter` 仍发送普通 Return，pi 使用本地 macOS 修饰键回退，把该 Return 当作 `Shift+Enter`。

该回退只在 pi 与 Terminal.app 运行在同一台 Mac 上时有效。它无法检测远程 SSH 上的本地键盘。

## Ghostty

添加到你的 Ghostty 配置（macOS 上为 `~/Library/Application Support/com.mitchellh.ghostty/config`，Linux 上为 `~/.config/ghostty/config`）：

```
keybind = alt+backspace=text:\x1b\x7f
```

旧版 Claude Code 可能添加了这条 Ghostty 映射：

```
keybind = shift+enter=text:\n
```

该映射发送原始换行字节（linefeed）。在 pi 内部，它与 `Ctrl+J` 无法区分，因此 tmux 和 pi 再也看不到真实的 `shift+enter` 按键事件。

如果 Claude Code 2.x 或更新版本是你添加该映射的唯一原因，你可以移除它，除非你想在 tmux 中使用 Claude Code（那里仍然需要该 Ghostty 映射）。

Pi 默认把 `Ctrl+J` 绑定为换行别名，因此通过该重映射，`Shift+Enter` 在 tmux 中无需额外 pi 配置就能继续工作。

### 全屏 TUI 模式

全屏模式下链接仍可点击，但当 pi 捕获鼠标输入时，Ghostty 不显示悬停下划线或左下角 URL 预览。在 macOS 上按住 `Shift+Command`、Linux 上按住 `Shift+Ctrl` 可使用 Ghostty 的原生链接处理。

## WezTerm

WezTerm 通常通过 xterm modifyOtherKeys 开箱即用支持 `Shift+Enter`。要显式使用 Kitty 键盘协议，创建 `~/.wezterm.lua`：

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.enable_kitty_keyboard = true
return config
```

在 macOS 上，WezTerm 默认把 `Option+Enter` 绑定为全屏。要把 `Option+Enter` 用于 pi 的 follow-up 排队，添加这个键位覆盖：

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.keys = {
  {
    key = 'Enter',
    mods = 'ALT',
    action = wezterm.action.SendString('\x1b[13;3u'),
  },
}
return config
```

如果你已有 `config.keys` 表，把条目加进去。

在 WSL 上，WezTerm 可能需要可见的硬件光标来定位 IME 候选窗口。如果 CJK IME 候选不跟随文本光标，在运行 pi 前设置 `PI_HARDWARE_CURSOR=1`，或在设置中把 `showHardwareCursor` 设为 `true`。

## Alacritty

Alacritty 通常对 `Shift+Enter` 开箱即用。在 macOS 上，`Option+Enter` 可能到达时变成了普通 `Enter`。要把 `Option+Enter` 用于 pi 的 follow-up 排队，添加到 `~/.config/alacritty/alacritty.toml`：

```toml
[[keyboard.bindings]]
key = "Enter"
mods = "Alt"
chars = "\u001b[13;3u"
```

修改配置后重启 Alacritty。

## VS Code（集成终端）

VS Code 1.109.5 及更新版本默认在集成终端启用 Kitty 键盘协议，因此 `Shift+Enter` 应开箱即用。

1.109.5 之前的 VS Code 版本需要为 `Shift+Enter` 显式的终端键位绑定。

`keybindings.json` 位置：
- macOS：`~/Library/Application Support/Code/User/keybindings.json`
- Linux：`~/.config/Code/User/keybindings.json`
- Windows：`%APPDATA%\\Code\\User\\keybindings.json`

添加到 `keybindings.json`：

```json
{
  "key": "shift+enter",
  "command": "workbench.action.terminal.sendSequence",
  "args": { "text": "\u001b[13;2u" },
  "when": "terminalFocus"
}
```

## Windows Terminal

添加到 `settings.json`（Ctrl+Shift+, 或 Settings → Open JSON file），转发 pi 使用的带修饰键的 Enter：

```json
{
  "actions": [
    {
      "command": { "action": "sendInput", "input": "\u001b[13;2u" },
      "keys": "shift+enter"
    },
    {
      "command": { "action": "sendInput", "input": "\u001b[13;3u" },
      "keys": "alt+enter"
    }
  ]
}
```

- `Shift+Enter` 插入新行。
- Windows Terminal 默认把 `Alt+Enter` 绑定为全屏。这阻止 pi 收到 `Alt+Enter` 用于 follow-up 排队。
- 把 `Alt+Enter` 重映射为 `sendInput` 可以改为把真实按键组合转发给 pi。

如果你已有 `actions` 数组，把对象加进去。如果旧的全屏行为仍然存在，完全关闭并重新打开 Windows Terminal。

## xfce4-terminal、terminator

这些终端对转义序列的支持有限。`Ctrl+Enter` 和 `Shift+Enter` 这类带修饰键的 Enter 无法与普通 `Enter` 区分，导致 `submit: ["ctrl+enter"]` 这样的自定义键位无法工作。

要获得最佳体验，请使用支持 Kitty 键盘协议的终端：
- [Kitty](https://sw.kovidgoyal.net/kitty/)
- [Ghostty](https://ghostty.org/)
- [WezTerm](https://wezfurlong.org/wezterm/)
- [iTerm2](https://iterm2.com/)
- [Alacritty](https://github.com/alacritty/alacritty)（需要带 Kitty 协议支持编译）

## IntelliJ IDEA（集成终端）

内置终端对转义序列的支持有限。IntelliJ 的终端中 Shift+Enter 无法与 Enter 区分。

如果你想看到硬件光标，在运行 pi 前设置 `PI_HARDWARE_CURSOR=1`（为兼容性默认禁用）。

要获得最佳体验，考虑使用专用终端模拟器。
