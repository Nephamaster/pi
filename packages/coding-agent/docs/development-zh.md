# 开发

更多指南见 [AGENTS.md](https://github.com/earendil-works/pi-mono/blob/main/AGENTS.md)。

## 环境搭建

```bash
git clone https://github.com/earendil-works/pi-mono
cd pi-mono
npm install
npm run build
```

从源码运行：

```bash
/path/to/pi-mono/pi-test.sh
```

该脚本可以从任意目录运行。Pi 会保留调用方的当前工作目录。

## Fork / 重新品牌

通过 `package.json` 配置：

```json
{
  "piConfig": {
    "name": "pi",
    "configDir": ".pi"
  }
}
```

为你的 fork 修改 `name`、`configDir` 和 `bin` 字段。会影响 CLI 横幅、配置路径和环境变量名。

## 路径解析

三种运行模式：npm 安装、独立二进制、从源码用 tsx。

**包资源始终使用 `src/config.ts`**：

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

永远不要直接使用 `__dirname` 来定位包资源。

## 调试命令

`/debug`（隐藏）会写入 `~/.pi/agent/pi-debug.log`：
- 带 ANSI 代码的已渲染 TUI 行
- 最近发送给 LLM 的消息

## 测试

```bash
./test.sh                         # 运行非 LLM 测试（不需要 API key）
npm test                          # 运行全部测试
npm test -- test/specific.test.ts # 运行特定测试
```

## 项目结构

```
packages/
  ai/           # LLM provider 抽象
  agent/        # Agent 循环和消息类型
  tui/          # 终端 UI 组件
  coding-agent/ # CLI 和交互模式
```
