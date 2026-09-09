# 验证记录

## 实际完成

| 项目 | 结果 |
|---|---|
| AgentCard 严格结构检查 | 42/42 通过；用 Python jsonschema 镜像上传 TypeBox schema，拒绝额外字段 |
| 分类覆盖 | 18/18；research 在所查基线只有一名角色，未虚构补足 |
| 来源与生成文件关联 | 42/42；源提交/路径/登记的 Git blob 标识齐全，生成文件 SHA-256 一致 |
| ProcessSpec 严格结构检查 | 2/2；活动、交付、评审、规则标识及内部引用合法 |
| 软件子型选人 | 14/14 对生产者与独立评审者能力匹配；候选不是同一张卡 |
| 专业画像渲染 | 42 张卡、1,749 个非空文本行均进入渲染结果，无非预期删减、无输入修改、重复渲染一致 |
| 独立 TypeScript 检查 | renderer 文件以 TypeScript 5.8.3、strict、ES2022、NodeNext 通过 |
| 补丁适配 | 对上传 IPD 快照执行 git apply --check 通过；未改动用户原源码 |

本地 YAML 每张约 4.0—6.7 KB、75—96 行，合计 229,915 字节；这是内容规模记录，不是质量评分。原提示较长的示例程序没有当成可执行实现复制；方法、模板和调整记录分别保留。

## 验证边界

测试使用 Node 22.16.0，而原工程声明 Node 24；这里只编译无 Pi 依赖的纯渲染函数，未验证原工程整体类型兼容。Python mirror 按所提供 Schema 手工建立，不等于执行原 TypeBox，也不能替代 Workflow Compiler。

未运行真实 Pi 模型任务、完整 monorepo 单测、专业工具/权限测试或优化前后质量对照。没有声称角色文字更长即可改善实际任务效果；没有把专业上会使用的工具当成环境中可用。源文件标识由检索接口登记，本包不包含完整上游字节镜像，也没有宣称对全部原文件作本地哈希复算。

## 复验方式

在两个解压包目录并列的环境中：

```bash
python validation/validate-assets.py --process ../ipd-ptm-process --output /tmp/ipd-asset-checks.json
```

需要已安装 PyYAML、jsonschema。验证脚本不联网、不修改资产；输出报告仅在指定位置写入。目录不同则显式传入 --roles 和 --process。

独立渲染验证：

```bash
tsc integration/render-agent-profile.ts --strict --target es2022 --module nodenext --moduleResolution nodenext --outDir /tmp/ipd-renderer
cp integration/package.json /tmp/ipd-renderer/package.json
node integration/renderer-test.mjs /tmp/ipd-renderer/render-agent-profile.js validation/renderer-fixtures.json
```

renderer-fixtures.json 是本次 42 张卡的冻结测试输入，不是第二套生产资产；修改卡片后应重新生成测试输入。原始结果与完整限制见 validation/asset-checks.json。
