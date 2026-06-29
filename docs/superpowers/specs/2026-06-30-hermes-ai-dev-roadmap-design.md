# Hermes AI 开发调度系统后续路线设计

**日期：** 2026-06-30  
**状态：** 已确认  
**基线：** `172afec feat: implement hermes ai development v1`

## 1. 目标与演进策略

系统继续采用本地优先、单用户优先的演进方式：

1. V1.1.1 投产硬化
2. V1.2 GitHub PR 与 Actions
3. V1.3 知识索引与质量评测
4. V1.4 可配置工作流、模型路由与并发
5. V2 多人、多机控制平面

选择逐层验收的纵向演进，不采用以下方案：

- 不先搭完整平台再补可靠性：这会让状态、权限和恢复问题扩散到 GitHub 与远程 worker。
- 不提前实现 GitHub App、PostgreSQL 或事件队列：当前仍是单机单用户，缺少支撑团队控制面的真实需求。
- 不先引入向量数据库：当前没有固定检索评测集，无法证明向量检索优于词法基线。

所有阶段继续遵守以下不变量：

- Hermes 是任务入口与调度器。
- TypeScript 控制器拥有工作流状态。
- Codex SDK 负责规划、实现与修复；Codex App 负责观察和人工接管。
- Claude Code 只负责只读 Review。
- 不自动 merge、deploy、force push。
- 不执行未审批的外部写入。
- 不执行批量、递归或通配符删除。
- 每个任务使用独立 worktree。
- 暂不采用 beta Hermes Codex Runtime。

## 2. 真实 smoke 证据

`simple-todo-web/t_45d8a6dd` 最终完成，但不是无干预完成：

- 总耗时约 104 分钟。
- Codex plan 使用约 19 万 input tokens。
- Codex implementation 报告约 426 万 input tokens，其中约 410 万为缓存输入。
- Claude 首次返回了无法通过 schema 的字符串，需要人工触发多次 re-review。
- Claude 最终返回 `PASS_WITH_COMMENTS`，但同时包含两个 blockers，语义互相矛盾。
- Git diff 最初以 worktree `HEAD` 为基线，任务内已有 commit 后 `diff.patch` 为空。
- 相对 `main` 存在的 `.gitignore` 被误判为任务删除，任务在 finalizing 阶段阻塞。
- `events.jsonl` 中出现重复 sequence 5。
- 任务完成后 `error.json` 仍保存历史错误，无法区分 active 与 resolved。
- Codex 尝试创建计划内 commit，但 SDK sandbox 无法写主仓库 `.git/worktrees/...`；提交职责边界不清晰。

当前工作树已有针对 Git 基线和 Claude 输出兼容的未提交修复。V1.1.1 必须以这些修改为输入继续，不得覆盖或恢复其他用户改动。

## 3. V1.1.1：投产硬化

### 3.1 Codex 与控制器职责

Codex 只修改 worktree 文件，不执行：

- `git add`
- `git commit`
- `git push`
- merge、deploy
- 知识库写入

TypeScript 控制器负责一个任务的最终本地 commit。V1.1.1 固定为每任务一个控制器 commit；分阶段 commit 留到后续显式 Git 策略，不允许 Codex 自行决定。

Codex plan v2 使用类型化字段：

```ts
interface CodexPlanV2 {
  version: 2;
  summary: string;
  assumptions: string[];
  files: string[];
  tests: string[];
  capabilities: {
    network: boolean;
    dependencyInstall: boolean;
    externalWrite: boolean;
  };
  fileDeletions: string[];
  questions: Array<{
    id: string;
    prompt: string;
    required: true;
  }>;
  knowledgeNeeds: string[];
}
```

约束：

- `fileDeletions` 最多一个相对路径。
- `externalWrite=true` 在 V1.1.1 永远阻塞，不能通过 plan approval 解锁。
- push、merge、deploy 不作为 Codex capability；以后由独立 publisher adapter 控制。
- required questions 必须在审批记录中逐题回答。
- plan approval 绑定 plan digest 与 answer map digest。

Claude Review 语义归一化：

- `blockers.length > 0` 时 verdict 必须归一为 `BLOCK`。
- `PASS_WITH_COMMENTS` 只允许 suggestions，不允许 blockers。
- 无法解析的输出最多进行一次结构化 normalization。
- normalization 仍失败时保存原始脱敏证据并阻塞，不伪造 Review。

### 3.2 状态、事件与 operator command

`WorkflowState` 升级为 version 2：

```ts
interface WorkflowStateV2 {
  version: 2;
  revision: number;
  taskId: string;
  projectId: string;
  stage: WorkflowStage;
  codexThreadId?: string;
  repairAttempts: number;
  maxFixCycles: number;
  blockedReason?: string;
  blockedFrom?: WorkflowStage;
  updatedAt: string;
}
```

每次状态写入将 revision 加一。version 1 状态在读取时迁移为 version 2，不重写历史工件，直到下一次合法状态转换。

事件记录改为：

```ts
interface WorkflowEventRecord {
  eventId: string;
  timestamp: string;
  actor: "worker" | "operator" | "hermes";
  stateRevision: number;
  type: string;
  payload: Record<string, unknown>;
}
```

不再把 sequence 当作唯一键。事件通过 `eventId` 去重，通过 `timestamp + eventId` 稳定排序。

Operator CLI 不再直接修改 `state.json`。所有 pause、resume、retry、reprepare、rereview 和 approval 都追加为不可变 command。worker 是唯一状态写入者：

```ts
interface OperatorCommand {
  commandId: string;
  type:
    | "approve_plan"
    | "approve_knowledge"
    | "pause"
    | "resume"
    | "retry"
    | "reprepare"
    | "rereview";
  requestedBy: string;
  requestedAt: string;
  payload: Record<string, unknown>;
}
```

worker 处理后写独立 result 工件，不删除 command。

### 3.3 错误、指标与预算

错误采用追加式历史：

```ts
interface TaskErrorRecord {
  errorId: string;
  stage: WorkflowStage;
  code: string;
  message: string;
  occurredAt: string;
  resolvedAt?: string;
  resolution?: string;
}
```

`status` 只展示没有 `resolvedAt` 的 active errors。

指标按阶段记录：

- active duration
- operator wait duration
- Codex input、cached input、output、reasoning tokens
- Claude 调用与 normalization 次数
- verification duration
- repair 次数

项目配置增加：

```yaml
budgets:
  max_active_minutes: 60
  max_codex_input_tokens: 5000000
  max_codex_output_tokens: 50000
  warning_ratio: 0.8
```

达到 warning ratio 时写告警并评论 Hermes；超过预算后在阶段边界阻塞。已开始的单个 Codex turn 仍由 `turn_timeout_seconds` 控制。

### 3.4 仓库 lease 与保留策略

默认同一仓库最多一个写任务。lease 使用同一目录内的原子 rename：

```text
repo.lease.available
→ repo.lease.<task-id>.<pid>
→ repo.lease.available
```

正常释放不删除文件。进程崩溃后保留 owner 文件；doctor 只有在 PID 不存在且任务 run 不活跃时才报告 stale，不自动回收。回收需要明确 operator command。

默认保留策略：

```yaml
retention:
  task_artifacts_days: 30
  warn_before_days: 7
```

系统只生成到期提示和单目标 cleanup request；不会自动执行 cleanup。

### 3.5 V1.1.1 验收门

- fake adapter chaos test 在每个阶段中断并恢复。
- 相同 command 不会被执行两次。
- 每个事件 ID 唯一，state revision 严格递增。
- 完成任务没有 active error、pending command 或未授权删除。
- base branch diff 在任务内已有 commit 时仍完整。
- `PASS_WITH_COMMENTS + blockers` 必须进入 fixing。
- 真实 `simple-todo-web` 连续完成两次，除 plan approval 外不需要人工修复。
- 本地模式没有 push、PR、merge 或 deploy。

## 4. V1.2：GitHub PR 与 Actions

### 4.1 配置

```yaml
schema_version: 2

publish:
  mode: github_pr
  remote: origin
  draft_pr: true
  approval: every_commit

ci:
  mode: github_actions
  required_checks:
    - test
    - typecheck
  poll_interval_seconds: 15
  max_poll_interval_seconds: 60
  discovery_timeout_seconds: 300
  completion_timeout_seconds: 1800
```

`github_actions` 至少配置一个 required check。每个新 commit 都需要新的 publish approval。

### 4.2 状态流

```text
implementing
→ local_verifying
→ checkpointing
→ awaiting_publish_approval
→ publishing
→ ci_waiting
→ reviewing
→ knowledge
→ finalizing
→ completed
```

CI 或 Review 失败：

```text
ci_waiting/reviewing
→ fixing
→ local_verifying
→ checkpointing
→ 新 SHA 的 publish approval
→ publishing
→ ci_waiting
```

修复继续使用原 Codex thread。

### 4.3 GitHub adapter

- 使用本机 `gh` 登录态，不读取或记录 token。
- preflight 检查 auth、remote、repository、base branch 与权限。
- publish approval 绑定 repository、remote、base、branch 和 commit SHA。
- push 使用明确 SHA/ref，禁止 force push。
- PR 按 head/base 查找，存在则复用，不存在才创建。
- 创建 PR 时显式传入 `--head`、`--base`、`--title`、`--body-file` 和 `--draft`。官方说明 `--head` 可避免 `gh pr create` 自行选择 fork 或 push 路径：
  <https://cli.github.com/manual/gh_pr_create>
- 不使用 `gh pr create --dry-run` 作为安全预览，因为官方说明它仍可能 push。

### 4.4 Actions 轮询

- `gh pr checks --json` 返回稳定的 `pass/fail/pending/skipping/cancel` bucket：
  <https://cli.github.com/manual/gh_pr_checks>
- `gh run list --commit <SHA>` 定位当前 commit 的 run：
  <https://cli.github.com/manual/gh_run_list>
- `gh run view <id> --log-failed` 提取失败日志：
  <https://cli.github.com/manual/gh_run_view>
- 日志脱敏、限长并保存 run/job URL。
- GitHub 无法返回完整日志时阻塞，不生成推测性错误。
- CI 全部通过后才执行 Claude Review。
- 永远不调用 `gh pr merge`。

### 4.5 V1.2 验收门

- 重试 publish 不创建重复 PR。
- approval 绑定的 SHA 改变后立即失效。
- queued、running、success、failure、cancelled、timeout、缺失 check 均有确定状态。
- CI 失败日志回送同一 Codex thread。
- 默认测试使用 fake `gh`；真实 sandbox repository 测试需要单独人工审批。

## 5. V1.3：知识索引与质量评测

- 在 `.ai-dev/index/<project>` 建立增量持久化索引。
- 源笔记继续使用 Obsidian Markdown，不修改原笔记作为索引状态。
- 实现 BM25，并加入有限的标题、项目范围、验证时间和 wikilink 权重。
- 解析 wikilink 正向、反向关系。
- 规范化内容 hash 用于精确去重；近似重复只报告，不自动合并或删除。
- frontmatter 增加 `source`、`applicable_projects`、`verified_at`、`valid_until`、`rule_id`、`supersedes`。
- 同一 `rule_id` 存在多个有效且没有 supersedes 关系的规则时报告冲突。
- Codex plan 返回实际使用的 knowledge IDs。
- 记录 retrieved、cited、later_reused、human_useful 四级信号。
- 提供 `knowledge-audit` 与 `knowledge-feedback`。
- 只有固定评测集证明 BM25 不足时，才设计向量检索。

验收：增量索引与全量重建一致；排序稳定；过期、冲突、去重和命中统计可复现。

## 6. V1.4：工作流模板、模型路由与并发

- 内置 Feature、Bugfix、Refactor、Docs 四类模板，不实现任意工作流 DSL。
- Bugfix 要求复现证据和回归测试。
- Refactor 要求行为基线，未审批时不得改变公开契约。
- Docs 可跳过代码构建，但必须运行配置的文档验证。
- 规划模型由项目固定；实现模型根据批准计划的文件数、风险、问题数和上下文规模确定性路由。
- 默认每仓库一个写任务、两个只读规划任务。
- 不同仓库可以并发。
- 任务依赖继续使用 Hermes 原生 DAG。
- 跨任务引用使用 `taskId + artifactPath + sha256`。

验收：四类模板均有端到端测试；相同输入得到相同路由；并发任务不会争用 Git 元数据或覆盖工件。

## 7. V2：远程与团队能力

只有出现至少两名用户、两台执行机或集中审批要求后启动：

- 控制平面与 worker 分离。
- PostgreSQL 作为状态和审计事件源。
- 事件队列负责投递和租约。
- GitHub App 替代个人 `gh` 登录态。
- 集中密钥管理与短期凭据。
- 用户、项目、审批角色与审计导出。
- 远程 worker 注册、能力标签、心跳和重投。
- 团队通知、成本配额和优先级。

Hermes Desktop 与 Codex App 继续作为主要界面，不提前建设复杂 Web UI。

## 8. 兼容与迁移

- Project config version 1 继续读取并补默认值。
- 新增能力只通过 version 2 写出。
- Workflow state version 1 在内存迁移为 version 2。
- 历史工件不删除、不批量改写。
- Codex、Claude、Hermes、GitHub 和 knowledge 均继续通过 adapter 接入。
- Hermes external worker lane 与 Codex Runtime 只有在脱离 beta且权限、恢复和 thread 行为稳定后才重新评估。
