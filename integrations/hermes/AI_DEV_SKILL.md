---
name: ai-dev-dispatch
description: Dispatch repository implementation tasks through the local Hermes AI development controller.
---

# AI development dispatch

Use `ai_dev_submit` for repository implementation work after the requirement and target
project are clear. The controller creates one isolated worktree for the full task.

After submission:

1. Return the Hermes task id and branch.
2. Use `ai_dev_status` for progress, Codex thread, worktree, and artifact links.
3. If the task is blocked on a plan, summarize the plan and risks before asking the
   user. Only call `ai_dev_approve_plan` after explicit approval.
4. Use `ai_dev_pause` when the user wants to inspect or take over.

Never claim that push, merge, deploy, GitHub Actions, or cleanup happened. Those
operations are outside this MCP toolset. Never substitute a direct Codex call for the
controller workflow.
