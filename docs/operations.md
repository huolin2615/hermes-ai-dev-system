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
未更新视为 stale，并检查 CLI、SDK、Node、项目配置、仓库租约和保留期。
未启动 worker，或 `idle`、`completed`、`stopped` 的旧心跳只作为运行状态提示，
不令兼容检查失败；陈旧的 `starting`/`running` 心跳和明确的 `error` 会阻断。
Codex 单轮默认 30 分钟超时，可用项目配置的 `codex.turn_timeout_seconds`
调整；外部命令超时后先发 SIGTERM，宽限期后强制结束。

每个任务的 `metrics.json` 分开记录主动执行和操作员等待耗时、修复轮次、预算
状态、Claude 调用次数、normalization 次数和 verification duration。不可变阶段
明细位于 `metrics/stages/`，其中包含 Codex usage；等待明细位于
`metrics/waits/`。Claude CLI 当前结构化 Review 输出没有稳定 token usage 字段，
因此不估算 Claude tokens。

错误写入 `errors/<uuid>.json`，解决记录写入 `errors/resolutions/`；旧
`error.json` 不再视为活动错误。使用 `status` 查看活动错误与预算状态：

```bash
node dist/cli.js status \
  --project simple-todo-web \
  --task <task-id>
```

任务完成后执行不变量审计：

```bash
node dist/cli.js audit \
  --project simple-todo-web \
  --task <task-id>
```

只有 `ok=true` 时命令退出 0。审计会核对状态与事件版本、完成工件、待处理命令、
活动错误、删除审批、Git 提交与 changed files，以及预算汇总。

## 恢复与仓库租约

每个项目同一时间只有一个任务持有仓库写租约。worker 在 claim 前获取租约，并在
完成、阻塞或失败后释放。`doctor` 只诊断租约，不自动回收；只有确认原 PID 已
退出、Hermes run 不活跃且 owner task 精确匹配后，才可显式执行：

```bash
node dist/cli.js lease-reclaim \
  --project simple-todo-web \
  --owner-task <task-id> \
  --by <operator>
```

状态机可从 planning、implementing、verifying、reviewing、knowledge 和
finalizing 重启。操作员命令先写不可变 application 凭据，再持久化状态和结果；
崩溃重放不会重复推进 revision。

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

系统不会自动清理。使用以下命令查看 retained、warning 和 expired 工件：

```bash
node dist/cli.js retention-status --project simple-todo-web
```

保留期只产生提示，不创建或执行 cleanup request。由人工为每一个目标分别建立
请求；审批和执行是两个独立动作。请求只允许：

- 一个绝对路径文件；或
- 一个明确的 Git worktree 路径。

目录、通配符、批量列表和递归删除全部拒绝。
