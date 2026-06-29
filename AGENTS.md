# Repository instructions

- Use `pnpm check` as the complete local verification command.
- Write tests before implementation changes and verify the intended failure.
- Never push, merge, deploy, or write to external services without explicit approval.
- Never use wildcard, batch, recursive, or implicit deletion.
- A deletion request must name one exact target and receive explicit one-time approval.
- Do not use `rm -rf`, `rmdir /s`, `rd /s`, `del /s`, or `Remove-Item -Recurse`.
- Keep Codex work inside the task worktree. Claude review is read-only.
