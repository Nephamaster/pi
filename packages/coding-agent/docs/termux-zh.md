# Termux（Android）设置

Pi 通过 [Termux](https://termux.dev/) 在 Android 上运行，这是一个 Android 终端模拟器和 Linux 环境。

## 前提条件

1. 从 GitHub 或 F-Droid 安装 [Termux](https://github.com/termux/termux-app#installation)（不要从 Google Play 安装，该版本已弃用）
2. 从 GitHub 或 F-Droid 安装 [Termux:API](https://github.com/termux/termux-api#installation)，用于剪贴板和其他设备集成

## 安装

```bash
# 更新包
pkg update && pkg upgrade

# 安装依赖
pkg install nodejs termux-api git

# 安装 pi
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# 创建配置目录
mkdir -p ~/.pi/agent

# 运行 pi
pi
```

## 剪贴板支持

在 Termux 中运行时，剪贴板操作使用 `termux-clipboard-set` 和 `termux-clipboard-get`。这些功能需要安装 Termux:API 应用。

Termux 不支持图片剪贴板（`ctrl+v` 粘贴图片功能不可用）。

## Termux 的 AGENTS.md 示例

创建 `~/.pi/agent/AGENTS.md`，帮助 agent 理解 Termux 环境：

````markdown
# Agent Environment: Termux on Android

## Location
- **OS**: Android (Termux terminal emulator)
- **Home**: `/data/data/com.termux/files/home`
- **Prefix**: `/data/data/com.termux/files/usr`
- **Shared storage**: `/storage/emulated/0` (Downloads, Documents, etc.)

## Opening URLs
```bash
termux-open-url "https://example.com"
```

## Opening Files
```bash
termux-open file.pdf          # Opens with default app
termux-open --chooser image.jpg      # Choose app
```

## Clipboard
```bash
termux-clipboard-set "text"   # Copy
termux-clipboard-get          # Paste
```

## Notifications
```bash
termux-notification -t "Title" -c "Content"
```

## Device Info
```bash
termux-battery-status         # Battery info
termux-wifi-connectioninfo    # WiFi info
termux-telephony-deviceinfo   # Device info
```

## Sharing
```bash
termux-share -a send file.txt # Share file
```

## Other Useful Commands
```bash
termux-toast "message"        # Quick toast popup
termux-vibrate                # Vibrate device
termux-tts-speak "hello"      # Text to speech
termux-camera-photo out.jpg   # Take photo
```

## Notes
- Termux:API app must be installed for `termux-*` commands
- Use `pkg install termux-api` for the command-line tools
- Storage permission needed for `/storage/emulated/0` access
````

## 限制

- **无图片剪贴板**：Termux 剪贴板 API 只支持文本
- **无原生二进制**：某些可选的原生依赖（如剪贴板模块）在 Android ARM64 上不可用，安装时会跳过
- **存储访问**：要访问 `/storage/emulated/0`（下载等）中的文件，运行一次 `termux-setup-storage` 授权

## 故障排查

### 剪贴板不工作

确认两个应用都已安装：
1. Termux（来自 GitHub 或 F-Droid）
2. Termux:API（来自 GitHub 或 F-Droid）

然后安装 CLI 工具：
```bash
pkg install termux-api
```

### 共享存储权限被拒绝

运行一次以授予存储权限：
```bash
termux-setup-storage
```

### Node.js 安装问题

如果 npm 失败，尝试清除缓存：
```bash
npm cache clean --force
```
