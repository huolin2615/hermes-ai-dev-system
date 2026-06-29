# 路线实施状态

后续完整演进方案见
[2026-06-30 Hermes AI 开发调度系统后续路线设计](superpowers/specs/2026-06-30-hermes-ai-dev-roadmap-design.md)。
下一阶段施工单见
[V1.1.1 投产硬化实施计划](superpowers/plans/2026-06-30-v1-1-1-production-hardening.md)。

## 已实现：V1

- Hermes Kanban 任务、显式仓库 worktree、claim/heartbeat/block/complete。
- TypeScript 控制器与可恢复状态机。
- Codex SDK 只读规划、同 thread workspace-write 实现与修复。
- Codex App thread 深链、worktree 和工件路径。
- 本地 argv 验证、Claude 只读 Review、共享两轮修复预算。
- Obsidian 项目词法检索、任务日志、知识提案审批。
- 仅本地 commit；没有 push、merge、deploy。
- 精确目标删除审批、未声明删除恢复、三步清理队列。

## 已实现：V1.1 基础

- 可选 launchd 用户服务安装器。
- worker 健康文件、30 秒心跳、stale 检查、任务耗时和 Codex usage。
- `status` 返回 Codex thread、worktree、branch 和日志目录。
- pause、resume、retry、reprepare、rereview。
- CLI/SDK/Node 兼容检查与书面矩阵。

保留周期目前只提供人工提示和审批队列，不自动清理。

## 预留但未宣称完成

### V1.2 GitHub 与远程 CI

当前配置故意拒绝 `ci.mode=github_actions`。下一阶段需实现 GitHub adapter、
push/PR 独立审批、Actions webhook/轮询和精确失败日志回送。人工 merge 门禁
保持不变。

### V1.3 知识增强

当前是确定性词法排序，不是完整 BM25，也没有增量索引、wikilink 图、去重和
命中评测。应先建立检索基线与回写命中指标，再决定是否加入向量检索。

### V1.4 可配置工作流

状态机和 adapter 已解耦，但 Feature/Bugfix/Refactor/Docs 模板、模型路由、
同仓库并发写锁和任务成果引用尚未实现。

### V2 团队能力

远程 worker、集中密钥、身份权限、PostgreSQL、事件队列、GitHub App、配额和
团队通知均未实现。只有出现真实多人需求后再引入。
