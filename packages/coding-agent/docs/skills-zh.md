> pi 可以创建技能。让它为你的使用场景构建一个。

# 技能（Skills）

技能是 agent 按需加载的自包含能力包。技能为特定任务提供专门的工作流、设置说明、辅助脚本和参考文档。

Pi 实现了 [Agent Skills 标准](https://agentskills.io/specification)，对大多数违规给出警告但保持宽容。Pi 允许技能名与其父目录不同，尽管标准不允许；该规则对跨多个 agent harness 使用的共享技能目录并不理想。

## 目录

- [存放位置](#locations)
- [技能如何工作](#how-skills-work)
- [技能命令](#skill-commands)
- [技能结构](#skill-structure)
- [Frontmatter](#frontmatter)
- [校验](#validation)
- [示例](#example)
- [技能仓库](#skill-repositories)

## 存放位置

> **安全：** 技能可以指示模型执行任何操作，并可能包含模型调用的可执行代码。使用前请审查技能内容。

Pi 从以下位置加载技能：

- 全局：
  - `~/.pi/agent/skills/`
  - `~/.agents/skills/`
- 项目（仅在项目被信任后）：
  - `.pi/skills/`
  - `cwd` 和祖先目录中的 `.agents/skills/`（直到 git 仓库根，不在仓库中时直到文件系统根）
- 包：`package.json` 中的 `skills/` 目录或 `pi.skills` 条目
- 设置：`skills` 数组，包含文件或目录
- CLI：`--skill <path>`（可重复，即使有 `--no-skills` 也会叠加）

发现规则：
- 在 `~/.pi/agent/skills/` 和 `.pi/skills/` 中，根目录直接放置的 `.md` 文件作为独立技能被发现
- 在所有技能位置中，包含 `SKILL.md` 的目录被递归发现
- 在 `~/.agents/skills/` 和项目 `.agents/skills/` 中，根 `.md` 文件被忽略

用 `--no-skills` 禁用发现（显式的 `--skill` 路径仍然加载）。

### 使用其他 Harness 的技能

要使用 Claude Code 或 OpenAI Codex 的技能，把它们的目录加入设置：

```json
{
  "skills": [
    "~/.claude/skills",
    "~/.codex/skills"
  ]
}
```

对于项目级的 Claude Code 技能，添加到 `.pi/settings.json`：

```json
{
  "skills": ["../.claude/skills"]
}
```

## 技能如何工作

1. 启动时，pi 扫描技能位置并提取名称和描述
2. 系统提示按[规范](https://agentskills.io/integrate-skills)以 XML 格式包含可用技能
3. 当任务匹配时，agent 使用 `read` 加载完整 SKILL.md（模型不总是这样做；用提示或 `/skill:name` 强制）
4. agent 遵循指令，使用相对路径引用脚本和资源

这是渐进式披露：上下文中始终只有描述，完整指令按需加载。

## 技能命令

技能注册为 `/skill:name` 命令：

```bash
/skill:brave-search           # 加载并执行技能
/skill:pdf-tools extract      # 带参数加载技能
```

命令后的参数以 `User: <args>` 附加到技能内容。

交互模式下通过 `/settings` 或在 `settings.json` 中切换技能命令：

```json
{
  "enableSkillCommands": true
}
```

## 技能结构

技能是一个含 `SKILL.md` 文件的目录。其他内容自由组织。

```
my-skill/
├── SKILL.md              # Required: frontmatter + instructions
├── scripts/              # Helper scripts
│   └── process.sh
├── references/           # Detailed docs loaded on-demand
│   └── api-reference.md
└── assets/
    └── template.json
```

### SKILL.md 格式

````markdown
---
name: my-skill
description: What this skill does and when to use it. Be specific.
---

# My Skill

## Setup

Run once before first use:
```bash
cd /path/to/skill && npm install
```

## Usage

```bash
./scripts/process.sh <input>
```
````

从技能目录使用相对路径：

```markdown
See [the reference guide](references/REFERENCE.md) for details.
```

## Frontmatter

按 [Agent Skills 规范](https://agentskills.io/specification#frontmatter-required)：

| 字段 | 必填 | 说明 |
|-------|----------|-------------|
| `name` | 是 | 最多 64 字符。小写 a-z、0-9、连字符。与标准不同，Pi 不要求它与父目录匹配，因为该标准要求对共享技能目录并不理想。 |
| `description` | 是 | 最多 1024 字符。技能做什么、何时使用。 |
| `license` | 否 | 许可证名称或捆绑文件的引用。 |
| `compatibility` | 否 | 最多 500 字符。环境要求。 |
| `metadata` | 否 | 任意键值映射。 |
| `allowed-tools` | 否 | 空格分隔的预批准工具列表（实验性）。 |
| `disable-model-invocation` | 否 | 为 `true` 时，技能从系统提示中隐藏。用户必须使用 `/skill:name`。 |

### 命名规则

- 1-64 字符
- 仅小写字母、数字、连字符
- 不能以连字符开头/结尾
- 不能有连续连字符
Pi 不要求名称与父目录匹配。Agent Skills 标准有该要求，但对多个工具共用的共享技能目录来说并不理想。

有效：`pdf-processing`、`data-analysis`、`code-review`
无效：`PDF-Processing`、`-pdf`、`pdf--processing`

### 描述最佳实践

描述决定 agent 何时加载技能。要具体。

好：
```yaml
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents.
```

差：
```yaml
description: Helps with PDFs.
```

## 校验

Pi 按 Agent Skills 标准校验技能。大多数问题产生警告但仍加载技能：

- 名称超过 64 字符或包含无效字符
- 名称以连字符开头/结尾或有连续连字符
- 描述超过 1024 字符

未知 frontmatter 字段被忽略。

**例外：** 缺少 description 的技能不会被加载。

名称冲突（不同来源的同名）会警告并保留先找到的技能。

## 示例

```
brave-search/
├── SKILL.md
├── search.js
└── content.js
```

**SKILL.md:**
````markdown
---
name: brave-search
description: Web search and content extraction via Brave Search API. Use for searching documentation, facts, or any web content.
---

# Brave Search

## Setup

```bash
cd /path/to/brave-search && npm install
```

## Search

```bash
./search.js "query"              # Basic search
./search.js "query" --content    # Include page content
```

## Extract Page Content

```bash
./content.js https://example.com
```
````

## 技能仓库

- [Anthropic Skills](https://github.com/anthropics/skills) - 文档处理（docx、pdf、pptx、xlsx）、Web 开发
- [Pi Skills](https://github.com/badlogic/pi-skills) - Web 搜索、浏览器自动化、Google API、转录
