# 草稿工具协议

本说明对应本次提供代码的 workflow_draft 工具。私有工具由主控注入；Skill 的 frontmatter 不声明这些名称为普通 allowed-tools，以免资产装配阶段把尚未注册的私有工具当成缺失依赖。无相应工具时不要使用 Bash 或 write 代替。

## 调用顺序与参数

| 工具 | 输入 | 结果及注意点 |
|---|---|---|
| workflow_draft_open | `{}` | 创建或读取本 Run 唯一草稿，取得 draftId、revision；不要另开第二份草稿。 |
| workflow_draft_read | `{}` | 获取当前完整草稿和 revision，用于恢复上下文、核对修改或处理冲突。 |
| workflow_draft_apply | draft_id、expected_revision、operation_id、非空 operations | 原子提交一组操作。使用返回的最新 revision；不要假定失败请求已经保存。 |
| workflow_draft_validate | expected_revision | 不修改草稿，返回 valid 和 diagnostics；每条诊断包括 path/message。 |
| workflow_draft_submit | expected_revision | 再校验并捕获候选交给主控，不直接启动执行或准出。 |

open/read 的返回字段是 draftId，apply 参数是 draft_id；复制同一个值，不能混淆大小写。expected_revision 使用实际返回的整数，不根据模型调用次数猜测。

## operations 的完整集合

| kind | 对应负载 | 更新语义 |
|---|---|---|
| set_header | header | 设置 schema_version、workflow_id、workflow_version、name；没有 task_input_ref 或 process_selection_ref。 |
| upsert_criterion | criterion | 按 criterion_id 整项新增或替换。 |
| upsert_node | node | 按 node_id 整项新增或替换；必须提供完整节点。 |
| remove_node | node_id | 只删除节点，调用方还需同步修订其输入、review target、coverage 与 completion 引用。 |
| set_requirement_coverage | coverage | 替换整个数组，不是追加。 |
| set_completion | completion | 替换完整完成条件。 |

不存在 set_edge、append_skill、patch_node、remove_criterion 等工具操作。不要发出未定义 kind。删除或替换节点后检查遗留 criterion 的必要性；确需移除当前接口不支持的内容时报告接口限制，不改磁盘草稿绕过管理器。

## 小批量操作示例

下例只示范 header 编辑，不是完整工作流；draft_id 和 expected_revision 必须替换为 open/read 的真实返回值，工作流名称也应对应当前任务。

```json
{
  "draft_id": "<open 返回的 draftId>",
  "expected_revision": 0,
  "operation_id": "design-header-001",
  "operations": [
    {
      "kind": "set_header",
      "header": {
        "schema_version": 1,
        "workflow_id": "task-delivery",
        "workflow_version": "1.0.0",
        "name": "任务交付工作流"
      }
    }
  ]
}
```

operation_id 由设计师为该次逻辑编辑命名，作用域是本草稿。一次已保存编辑的重发必须保持相同 ID 和相同 operations；即使拿到的 revision 已变化，也先读取实际结果，不重复生成同一编辑。需要改内容时使用新 ID 和当前 revision。出现 operation ID conflict 时检查先前请求，不能换 ID 盲目重放不明状态的操作。

验证未通过不改变草稿。修改之后必须重新 validate，只有对应最新 revision 的通过结果才能作为 submit 的依据。工具 Schema、Compiler 诊断与文档出现差异时，以实际接口为形式约束并明确报告差异，不把冲突解释成修改任务或规范的授权。
