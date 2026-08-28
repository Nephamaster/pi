# Shell 别名（Shell Aliases）

Pi 以非交互模式（`bash -c`）运行 bash，该模式默认不展开别名。

要启用你的 shell 别名，请在 `~/.pi/agent/settings.json` 中添加：

```json
{
  "shellCommandPrefix": "shopt -s expand_aliases\neval \"$(grep '^alias ' ~/.zshrc)\""
}
```

根据你的 shell 配置调整路径（`~/.zshrc`、`~/.bashrc` 等）。
