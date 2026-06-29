# Git 重命名与删除分流设计

## 目标

修复 Git porcelain 中明确的重命名记录被当成文件删除的问题，同时保持现有删除
安全边界不变。

## 行为定义

- Git 明确返回 `R` 时，记录为 `rename_file`，包含 `from` 和 `to`。
- 重命名源路径不进入 `deletedFiles`，因此不触发删除审批或自动恢复。
- `changedFiles` 同时包含重命名前后的路径，供 Review、知识回写和任务摘要使用。
- 一个任务允许多个 Git 明确认定的重命名；它们不属于批量删除。
- `D` 仍是删除，继续执行现有审批、单目标限制和未声明删除恢复。
- `D + ??` 不推断为重命名，仍按删除处理。这样避免内容相似度造成误放行。
- 递归、通配符、目录、批量删除以及 worktree/日志清理规则不变。

## 数据模型

`GitFacts` 增加：

```ts
interface GitRename {
  from: string;
  to: string;
}

interface GitFacts {
  changedFiles: string[];
  deletedFiles: string[];
  renamedFiles: GitRename[];
  diff: string;
}
```

`rename_file` 是 Git 事实分类，不是删除审批的替代品。Codex 计划可以在
`operations` 中声明 `rename_file`，但该操作不进入高风险集合。

## 数据流

1. Git adapter 解析 `git status --porcelain=v1 -z`。
2. 普通 `D` 进入 `deletedFiles`。
3. `R` 的目标路径来自当前记录，源路径来自下一条 NUL 记录；二者组成
   `renamedFiles`，均进入 `changedFiles`。
4. 控制器删除门禁只检查 `deletedFiles`。
5. Claude Review prompt 显式列出重命名映射。
6. Git diff、最终提交和其他状态机行为不变。

## 错误处理

- 缺少源路径的畸形 `R` 记录不能静默降级为删除；Git adapter 应抛出错误并让
  任务进入 worker 错误处理。
- 路径继续按 argv 传递，不经过 shell。
- 不新增暂存操作，也不修改 Git index 来帮助识别重命名。

## 测试

1. `R new\0old\0` 产生一个 `{ from: old, to: new }`，`deletedFiles` 为空。
2. 同时存在普通删除和重命名时，只有普通删除进入 `deletedFiles`。
3. 重命名前后路径均进入 `changedFiles`。
4. 畸形 `R` 缺少源路径时解析失败。
5. 控制器面对纯重命名时不调用 `restoreDeleted`，任务可完成。
6. 现有单文件删除、多文件删除和未声明删除测试继续通过。

## 非目标

- 不用内容哈希或相似度推断 `D + ??`。
- 不改变删除审批、清理队列或 worktree 删除规则。
- 不自动 push、merge 或部署。
