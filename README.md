# Hermes AI 开发调度系统

这是一个本地优先的开发任务调度器：Hermes 管理任务与 worktree，TypeScript
控制器通过 Codex SDK 规划和实现，Claude Code 只读审查，Codex App 用于查看
thread、diff、进度和人工接管。

当前交付的是可运行的 V1 本地闭环，以及 V1.1 的操作与稳定性基础。GitHub
Actions、远程 worker、团队权限和 PostgreSQL 尚未伪装成已完成能力，见
[路线状态](docs/roadmap-status.md)。

## 安全边界

- 每张任务卡显式绑定 `worktree:<仓库绝对路径>`。
- Codex 规划阶段是 `read-only`，实现阶段是 `workspace-write`。
- Claude Review 使用 `--safe-mode`、`dontAsk` 和只读工具。
- 不执行自动 push、merge、deploy。
- 计划中的网络、迁移、权限、依赖、CI 和删除操作先阻塞等待审批。
- 计划审批绑定计划 SHA-256，不能复用到被修改后的计划。
- 未声明的删除按明确路径逐个恢复，然后阻塞任务；一次只允许一个获批删除。
- 清理必须经过请求、审批、执行三个独立命令；不支持目录、通配符和批量目标。
- 所有外部命令均使用 argv 调用，不经过 shell。

## 快速开始

环境要求：Node.js 22+、pnpm、Hermes CLI、Codex CLI/Codex App、Claude Code。

```bash
pnpm install
pnpm check
pnpm build
```

将 [项目配置样例](config/projects/example.yaml.disabled) 复制为
`config/projects/<project>.yaml`，填写仓库和 Obsidian Vault 的绝对路径。样例
使用 `.disabled` 后缀，不会被 worker 自动加载。

检查环境：

```bash
node dist/cli.js doctor \
  --config-dir config/projects \
  --runtime-dir .ai-dev
```

启动一次轮询：

```bash
node dist/cli.js worker --once \
  --config-dir config/projects \
  --runtime-dir .ai-dev
```

启动常驻 worker：

```bash
node dist/cli.js worker \
  --config-dir config/projects \
  --runtime-dir .ai-dev \
  --poll-seconds 30
```

## 常用操作

提交任务：

```bash
node dist/cli.js submit \
  --project my-project \
  --title "实现订单筛选" \
  --requirement-file /absolute/path/to/requirement.md \
  --idempotency-key my-project-order-filter-v1
```

查看状态会返回 Codex thread 深链、worktree 和日志目录：

```bash
node dist/cli.js status --project my-project --task t_123
```

审批计划会写入不可变命令队列，并让 Hermes 重新进入 ready。计划包含问题时，
通过绝对路径 JSON 文件提交答案：

```bash
node dist/cli.js approve-plan \
  --project my-project --task t_123 --by huolin \
  --note "已核对计划和删除目标" \
  --answers-file /absolute/path/to/answers.json
```

命令返回 `{ "commandId": "...", "status": "queued" }`；worker 在下一状态
边界应用或拒绝命令，并永久保留命令和结果文件。

可用人工操作：

```text
approve-plan  approve-knowledge  pause  resume
retry         reprepare          rereview
```

清理是严格三步流程：

```bash
node dist/cli.js cleanup-request \
  --task t_123 --target-type file \
  --target-path /absolute/path/to/one-file.log \
  --reason "已过保留期"

node dist/cli.js cleanup-approve --request <request-id>
node dist/cli.js cleanup-execute --request <request-id>
```

## Hermes 与 Codex App

Hermes 可通过 [MCP 配置样例](integrations/hermes/mcp-config-snippet.yaml) 调用
`ai_dev_submit`、`ai_dev_status`、`ai_dev_approve_plan` 和 `ai_dev_pause`。MCP
接口故意不暴露清理执行。

任务创建后，`status` 和 Hermes 评论中会出现 `codex://threads/<thread-id>`。
在安装 Codex App 的 Mac 上点击该链接即可查看同一个 SDK thread，并可在
worktree 中检查 diff 或补充指令。

更完整的运行说明见 [运维手册](docs/operations.md) 和
[架构说明](docs/architecture.md)。
