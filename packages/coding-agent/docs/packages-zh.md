> pi 可以帮助你创建 pi 包。让它把你的扩展、技能、提示模板或主题打包。

# Pi 包（Pi Packages）

Pi 包把扩展、技能、提示模板和主题打包，让你可以通过 npm 或 git 分享。包可以在 `package.json` 的 `pi` 键下声明资源，或使用约定目录。

## 目录

- [安装和管理](#install-and-manage)
- [包来源](#package-sources)
- [创建 Pi 包](#creating-a-pi-package)
- [包结构](#package-structure)
- [依赖](#dependencies)
- [包过滤](#package-filtering)
- [启用和禁用资源](#enable-and-disable-resources)
- [作用域和去重](#scope-and-deduplication)

## 安装和管理

> **安全：** Pi 包以完整系统权限运行。扩展执行任意代码，技能可以指示模型执行任何操作（包括运行可执行文件）。安装第三方包前请审查源码。

```bash
pi install npm:@foo/bar@1.0.0
pi install git:github.com/user/repo@v1
pi install https://github.com/user/repo  # raw URLs work too
pi install /absolute/path/to/package
pi install ./relative/path/to/package

pi remove npm:@foo/bar
pi list                     # 显示设置中已安装的包
pi update                   # 只更新 pi
pi update --all             # 更新 pi、更新包，并校准已固定 git ref
pi update --extensions      # 只更新包并校准已固定 git ref
pi update --models          # 只刷新模型目录
pi update --self            # 只更新 pi
pi update --self --force    # 即使已是最新也重新安装 pi
pi update npm:@foo/bar      # 更新一个包
pi update --extension npm:@foo/bar
```

这些命令管理 pi 包，`pi update` 可以更新 pi CLI 安装。要卸载 pi 本身，见 [Quickstart](quickstart.md#uninstall)。

默认情况下，`install` 和 `remove` 写入用户设置（`~/.pi/agent/settings.json`）。用 `-l` 改为写入项目设置（`.pi/settings.json`）。项目设置可以与团队共享，项目被信任后 pi 会在启动时自动安装缺失的包。

要试装而不安装一个包，使用 `--extension` 或 `-e`。这只安装到临时目录供当前运行使用：

```bash
pi -e npm:@foo/bar
pi -e git:github.com/user/repo
```

## 包来源

Pi 在设置和 `pi install` 中接受三种来源类型。

### npm

```
npm:@scope/pkg@1.2.3
npm:pkg
```

- 带版本号的规格被固定，包更新（`pi update --extensions`、`pi update --all`）会跳过它们。
- 用户安装位于 `~/.pi/agent/npm/` 下。
- 项目安装位于 `.pi/npm/` 下。
- 在 `settings.json` 中设置 `npmCommand`，可以把 npm 包查找和安装操作固定到特定包装命令，如 `mise` 或 `asdf`。

示例：

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

### git

```
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- 不带 `git:` 前缀时，只接受协议 URL（`https://`、`http://`、`ssh://`、`git://`）。
- 带 `git:` 前缀时，接受简写格式，包括 `github.com/user/repo` 和 `git@github.com:user/repo`。
- HTTPS 和 SSH URL 都支持。
- SSH URL 自动使用你配置的 SSH key（遵循 `~/.ssh/config`）。
- 非交互运行（例如 CI）中，可以设置 `GIT_TERMINAL_PROMPT=0` 禁用凭据提示，并设置 `GIT_SSH_COMMAND`（例如 `ssh -o BatchMode=yes -o ConnectTimeout=5`）快速失败。
- Ref 是固定的 tag 或 commit。`pi update --extensions` 和 `pi update --all` 不会把它们移到更新的 ref，但会把已有 clone 校准到配置的 ref。
- 用 `pi install git:host/user/repo@new-ref` 更新设置并把已有包移到新的固定 ref。
- 克隆到 `~/.pi/agent/git/<host>/<path>`（全局）或 `.pi/git/<host>/<path>`（项目）。
- 当校准改变 checkout 时，pi 会重置并清理 clone，然后如果存在 `package.json` 就运行 `npm install`。

**SSH 示例：**
```bash
# git@host:path shorthand (requires git: prefix)
pi install git:git@github.com:user/repo

# ssh:// protocol format
pi install ssh://git@github.com/user/repo

# With version ref
pi install git:git@github.com:user/repo@v1.0.0
```

### 本地路径

```
/absolute/path/to/package
./relative/path/to/package
```

本地路径指向磁盘上的文件或目录，添加到设置时不做复制。相对路径相对于其所在的设置文件解析。如果路径是文件，它作为单个扩展加载。如果是目录，pi 按包规则加载资源。

## 创建 Pi 包

在 `package.json` 中添加 `pi` 清单，或使用约定目录。为可发现性包含 `pi-package` 关键字。

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

路径相对于包根目录。数组支持 glob 模式和 `!排除项`。

### 画廊元数据

[包画廊](https://pi.dev/packages) 显示打了 `pi-package` 标签的包。添加 `video` 或 `image` 字段以显示预览：

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

- **video**：仅 MP4。在桌面上悬停自动播放。点击打开全屏播放器。
- **image**：PNG、JPEG、GIF 或 WebP。显示为静态预览。

两者都设置时，video 优先。

## 包结构

### 约定目录

没有 `pi` 清单时，pi 从这些目录自动发现资源：

- `extensions/` 加载 `.ts` 和 `.js` 文件
- `skills/` 递归查找含 `SKILL.md` 的目录，并把顶层 `.md` 文件作为技能加载
- `prompts/` 加载 `.md` 文件
- `themes/` 加载 `.json` 文件

## 依赖

第三方运行时依赖属于 `package.json` 的 `dependencies`。不注册扩展、技能、提示模板或主题的依赖也属于 `dependencies`。当 pi 从 npm 或 git 安装包时，它会运行 `npm install`，所以这些依赖会自动安装。

Pi 为扩展和技能内置了核心包。如果你导入其中任何一个，在 `peerDependencies` 中用 `"*"` 范围列出它们，不要捆绑：`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox`。

其他 pi 包必须捆绑到你的 tarball 中。把它们加入 `dependencies` 和 `bundledDependencies`，然后通过 `node_modules/` 路径引用其资源。Pi 以独立的模块根加载包，所以独立的安装不会冲突或共享模块。

示例：

```json
{
  "dependencies": {
    "shitty-extensions": "^1.0.1"
  },
  "bundledDependencies": ["shitty-extensions"],
  "pi": {
    "extensions": ["extensions", "node_modules/shitty-extensions/extensions"],
    "skills": ["skills", "node_modules/shitty-extensions/skills"]
  }
}
```

## 包过滤

在设置中使用对象形式过滤包加载的内容：

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```

`+path` 和 `-path` 是相对于包根目录的精确路径。

- 省略某个键以加载该类型全部。
- 用 `[]` 以不加载该类型任何。
- `!pattern` 排除匹配。
- `+path` 强制包含一个精确路径。
- `-path` 强制排除一个精确路径。
- 过滤叠加在清单之上。它们收窄已经允许的内容。

## 启用和禁用资源

使用 `pi config` 启用或禁用来自已安装包和本地目录的扩展、技能、提示模板和主题。`pi config` 从全局设置（`~/.pi/agent/settings.json`）开始；按 Tab 在全局和项目本地模式间切换。用 `pi config -l` 从项目覆盖（`.pi/settings.json`）开始，继承的全局资源显示为暗淡。

## 作用域和去重

包可以同时出现在全局和项目设置中。如果同一个包出现在两者中，项目条目胜出，除非项目条目是 `autoload: false`，此时它作为增量应用到全局条目之上。身份由以下决定：

- npm：包名
- git：不带 ref 的仓库 URL
- 本地：解析后的绝对路径
