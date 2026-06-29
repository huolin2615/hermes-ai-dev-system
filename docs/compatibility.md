# 兼容性矩阵

当前验证基线：

| 组件 | 基线 | 检查规则 |
|---|---:|---|
| Node.js | 22.23.1 | major >= 22 |
| pnpm | 11.7.0 | 由锁文件固定依赖 |
| Hermes CLI | 0.17.0 | >= 0.17 |
| Codex CLI / Codex App | 0.142.3 | major.minor 与 SDK 一致 |
| `@openai/codex-sdk` | 0.142.3 | major.minor 与 CLI 一致 |
| Claude Code | 2.1.195 | >= 2.1 |
| MCP TypeScript SDK | 1.29.0 | 锁文件固定 |

升级顺序：

1. 在独立分支更新单个组件。
2. 运行 `pnpm check`。
3. 运行 `doctor` 查看兼容结果。
4. 用假 adapter 端到端测试状态机。
5. 经人工允许后，用一个低风险真实任务做 smoke test。
6. 更新此矩阵，再进入常驻 worker。

Hermes external worker lane 和 Codex Runtime 仍按上游 beta 能力对待。只有接口、
权限边界、thread 恢复和失败恢复行为稳定后，才替换当前 adapter。
