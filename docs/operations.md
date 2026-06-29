# 运维手册

## 启动前检查

1. 仓库必须已有初始 commit，且 Hermes 能从配置路径识别 Git 根目录。
2. Hermes board 和 `ai-dev` assignee 必须存在。
3. Codex CLI 与 `@openai/codex-sdk` 的 major.minor 必须一致。
4. Claude Code 已登录，并可使用配置中的只读 Review 模型。
5. Obsidian 项目路径可写；`Proposals` 不参与上下文检索。
6. 运行 `pnpm check` 和 `node dist/cli.js doctor ...`。

## 健康与卡死判断

worker 每 30 秒刷新 `<runtime>/worker-health.json`。`doctor` 默认将超过 5 分钟
未更新视为 stale，并检查 CLI、SDK、Node、项目配置和 worker 状态。
Codex 单轮默认 30 分钟超时，可用项目配置的 `codex.turn_timeout_seconds`
调整；外部命令超时后先发 SIGTERM，宽限期后强制结束。

每个任务的 `metrics.json` 包含总耗时、修复轮次和 Codex usage。Claude CLI
当前结构化 Review 输出没有稳定 usage 字段，因此明确记录为不可用，不估算。

## 人工接管

1. 执行 `pause`。worker 在下一个阶段边界停止。
2. 执行 `status`，打开 Codex thread 和 worktree。
3. 在 Codex App 检查 diff 或补充指令。
4. 需要继续原阶段时执行 `resume`；重新取上下文和规划用 `reprepare`；只重跑
   Review 用 `rereview`；显式再给一次修复机会用 `retry`。

操作不会删除旧工件。重新执行时同名 `latest.json` 更新，带 attempt 编号的证据
继续保留。

## macOS 用户服务

先构建，再显式指定唯一 plist 路径安装：

```bash
node dist/cli.js service-install \
  --plist-path /Users/huolin/Library/LaunchAgents/com.huolin.hermes-ai-dev-worker.plist \
  --node-path /Users/huolin/.local/bin/node \
  --cli-path "/Users/huolin/Documents/知识库搭建/dist/cli.js" \
  --config-dir "/Users/huolin/Documents/知识库搭建/config/projects" \
  --runtime-dir "/Users/huolin/Documents/知识库搭建/.ai-dev" \
  --working-dir "/Users/huolin/Documents/知识库搭建" \
  --log-dir "/Users/huolin/Documents/知识库搭建/.ai-dev/logs"
```

安装器使用 `writeFile(..., flag: "wx")`，不会覆盖已有 plist。它只执行
`launchctl bootstrap`，不提供隐式卸载或目录清理。

## 清理与保留

系统不会自动清理。建议由人工定期查看完成时间并为每一个目标分别建立
cleanup request。审批和执行是两个独立动作；请求只允许：

- 一个绝对路径文件；或
- 一个明确的 Git worktree 路径。

目录、通配符、批量列表和递归删除全部拒绝。
