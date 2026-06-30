# V1.1.1 投产冒烟验收

验收日期：2026-06-30。最终验收以 `t_1d696b4b` 和 `t_5a77bc82` 为准；它们在
answer digest、Claude 调用指标和 Hermes run lease 证明补齐并重新构建 worker
之后执行。两项任务均从已完成但未合并的本地 Todo 基线提交 `acd31c8` 创建独立
分支，以保持 `main` 不变。示例仓库没有 Git remote；整个验收未执行 push、PR、
merge 或 deploy。

## Final Smoke A：统计已完成事项

- 任务：`t_1d696b4b`
- Codex thread：`codex://threads/019f163a-006b-7a01-b75c-2cf2083e201a`
- worktree：`/Users/huolin/Documents/知识库搭建/demo/simple-todo-web/.worktrees/t_1d696b4b`
- 分支：`codex/simple-todo-web-v111-final-a-count-completed`
- 控制器本地提交：`a83153ecff89e7186d4c2a282aeb7a37ed2f91f3`
- 提交作用域：`src/todos.js`、`tests/todos.test.js`
- 验证：`node --test` 17/17；`node --check src/app.js` 退出 0
- Claude Review：PASS，0 blockers，风险 low
- 状态：revision 7、`completed`、repair attempts 0、active errors 0
- 审计：`{"ok":true,"taskId":"t_1d696b4b","stateRevision":7,"violations":[]}`

| 阶段 | 毫秒 |
| --- | ---: |
| context_preparing | 183 |
| planning | 128081 |
| implementing | 180829 |
| verifying | 288 |
| reviewing | 11758 |
| knowledge | 230 |
| finalizing | 268 |
| 合计 | 321637 |

操作员等待为 0 ms。Codex usage 为 input 1244197、cached input 1170432、
output 11191、reasoning 5021 tokens。Claude calls 1、normalizations 0，
verification duration 288 ms。计划仅涉及 2 个文件，没有请求审批，也没有 retry、
reprepare、rereview、知识审批或清理审批。

## Final Smoke B：判断全部完成

- 任务：`t_5a77bc82`
- Codex thread：`codex://threads/019f163f-d9ef-70c0-a7d0-ef72c84b2fc5`
- worktree：`/Users/huolin/Documents/知识库搭建/demo/simple-todo-web/.worktrees/t_5a77bc82`
- 分支：`codex/simple-todo-web-v111-final-b-all-completed`
- 控制器本地提交：`8b5a5b3306b590a709f3563928b69e2bffa71c05`
- 提交作用域：`src/todos.js`、`tests/todos.test.js`
- 验证：`node --test` 16/16；`node --check src/app.js` 退出 0
- Claude Review：PASS，0 blockers，风险 low
- 状态：revision 7、`completed`、repair attempts 0、active errors 0
- 审计：`{"ok":true,"taskId":"t_5a77bc82","stateRevision":7,"violations":[]}`

| 阶段 | 毫秒 |
| --- | ---: |
| context_preparing | 172 |
| planning | 73708 |
| implementing | 157960 |
| verifying | 282 |
| reviewing | 19072 |
| knowledge | 276 |
| finalizing | 347 |
| 合计 | 251817 |

操作员等待为 0 ms。Codex usage 为 input 1034376、cached input 966144、
output 11291、reasoning 6202 tokens。Claude calls 1、normalizations 0，
verification duration 282 ms。计划仅涉及 2 个文件，没有请求审批，也没有 retry、
reprepare、rereview、知识审批或清理审批。

## 最终交叉验收

- 两项 Final Smoke 各有 7 个 UUID 事件，事件 ID 交集为空。
- 两项任务的 `audit` 均退出 0，完成态不存在待处理命令或活动错误。
- Final Smoke B 完成后，`doctor` 退出 0，仓库租约为 `available`，无保留期告警。
- 主动执行与操作员等待分别统计；两项任务预算状态均为 `ok`。
- 每个任务在自己的分支上新增一个控制器提交，且提交只包含获准的两个文件。
- `main` 未改变；示例仓库 `git remote -v` 为空，不存在远程写入目标。

以下两项为最终修正前的预验收，保留用于证明计划审批路径和 answer file 流程。

## 预验收 Smoke A：清除已完成事项

- 任务：`t_bd73b870`
- Codex thread：`codex://threads/019f161b-bf2d-75f3-8380-2b62e17f69b5`
- worktree：`/Users/huolin/Documents/知识库搭建/demo/simple-todo-web/.worktrees/t_bd73b870`
- 分支：`codex/simple-todo-web-smoke-a-clear-completed`
- 控制器本地提交：`b562bf33e558ad0f8177a8e08a090aa128385ae5`
- 验证：`node --test` 15/15；`node --check src/app.js` 退出 0
- Claude Review：PASS，0 blockers，风险 low
- 状态：revision 8、`completed`、repair attempts 0、active errors 0
- 审计：`{"ok":true,"taskId":"t_bd73b870","stateRevision":8,"violations":[]}`

阶段主动耗时：

| 阶段 | 毫秒 |
| --- | ---: |
| context_preparing | 175 |
| planning | 112822 |
| implementing | 201943 |
| verifying | 279 |
| reviewing | 27613 |
| knowledge | 216 |
| finalizing | 252 |
| 合计 | 343300 |

操作员等待为 54133 ms。Codex usage 为 input 1903336、cached input
1683456、output 15813、reasoning 7068 tokens。Claude Code 使用配置模型
`sonnet`；CLI 结构化输出没有稳定 usage 字段，因此不估算。

计划因涉及 7 个文件请求一次审批。审批命令
`50b6628c-3975-4227-9491-0c8555e28314` 绑定 plan digest
`8c732965f59ad963c92d7aeb97e527417b9aba9f1cd03ca2bd76eb74798e31fe`；
计划问题为 0，答案文件为 `{}`。没有 retry、reprepare、rereview、知识审批或
清理审批。

## 预验收 Smoke B：切换全部完成状态

- 任务：`t_6cb02a44`
- Codex thread：`codex://threads/019f1623-4a15-7900-8b47-d4be2fdf364a`
- worktree：`/Users/huolin/Documents/知识库搭建/demo/simple-todo-web/.worktrees/t_6cb02a44`
- 分支：`codex/simple-todo-web-smoke-b-toggle-all`
- 控制器本地提交：`ee9c03775e88038682c21e6945f126b6aa255e06`
- 验证：`node --test` 16/16；`node --check src/app.js` 退出 0
- Claude Review：PASS，0 blockers，风险 low
- 状态：revision 8、`completed`、repair attempts 0、active errors 0
- 审计：`{"ok":true,"taskId":"t_6cb02a44","stateRevision":8,"violations":[]}`

阶段主动耗时：

| 阶段 | 毫秒 |
| --- | ---: |
| context_preparing | 170 |
| planning | 120091 |
| implementing | 292495 |
| verifying | 295 |
| reviewing | 33635 |
| knowledge | 227 |
| finalizing | 263 |
| 合计 | 447176 |

操作员等待为 48202 ms。Codex usage 为 input 2549324、cached input
2374144、output 21904、reasoning 10784 tokens。Claude Code usage 同样不可用，
未作估算。

计划因涉及 7 个文件请求一次审批。审批命令
`d85b0756-c7e4-419d-ad0e-499312a1a73f` 绑定 plan digest
`a4a4ce8e0888cb0eba4c1c2b943a1b19119c65079e2c5291d948045dfc6239d3`；
计划问题为 0，答案文件为 `{}`。没有 retry、reprepare、rereview、知识审批或
清理审批。

## 预验收交叉证据

- 两项任务各有 8 个 UUID 事件，事件 ID 交集为空。
- 两项任务的 `audit` 均退出 0，完成态不存在待处理命令或活动错误。
- 第二项任务完成后，`doctor` 退出 0，仓库租约为 `available`，无保留期告警。
- 主动执行与操作员等待分别统计；两项任务预算状态均为 `ok`。
- 每个任务在自己的分支上新增一个控制器提交；`main` 未改变。
- 示例仓库 `git remote -v` 为空，因此不存在远程写入目标。
