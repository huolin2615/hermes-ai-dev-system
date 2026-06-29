# Git Rename Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Git 明确认定的重命名与真正删除分流，避免正常重构触发删除审批，同时保持所有删除安全门禁。

**Architecture:** `GitAdapter` 负责把 porcelain `R` 记录解析为结构化 `renamedFiles`，控制器只对 `deletedFiles` 执行删除策略，并把 rename 映射交给 Claude Review。只信任 Git 明确的 `R`，不推断 `D + ??`。

**Tech Stack:** TypeScript 6、Node.js test runner、Git porcelain v1 `-z`、pnpm。

---

### Task 1: Git 状态模型与解析

**Files:**
- Modify: `src/git/adapter.ts`
- Test: `tests/git-adapter.test.ts`

- [ ] **Step 1: 写失败测试，证明 `R` 不再属于删除**

将现有重命名混合测试改为：

```ts
test("separates Git-confirmed renames from deletions", async () => {
  const adapter = new GitAdapter(async (options) =>
    options.argv.includes("status")
      ? result(" D src/legacy.ts\u0000R  src/new.ts\u0000src/old.ts\u0000")
      : result(""),
  );

  const facts = await adapter.collect("/tmp/worktree");

  assert.deepEqual(facts.deletedFiles, ["src/legacy.ts"]);
  assert.deepEqual(facts.renamedFiles, [
    { from: "src/old.ts", to: "src/new.ts" },
  ]);
  assert.deepEqual(facts.changedFiles, [
    "src/legacy.ts",
    "src/new.ts",
    "src/old.ts",
  ]);
});
```

再增加畸形记录测试：

```ts
test("rejects a malformed rename without its source path", async () => {
  const adapter = new GitAdapter(async (options) =>
    options.argv.includes("status")
      ? result("R  src/new.ts\u0000")
      : result(""),
  );

  await assert.rejects(
    adapter.collect("/tmp/worktree"),
    /rename record is missing its source path/,
  );
});
```

- [ ] **Step 2: 运行目标测试并确认 RED**

Run:

```bash
env CI=true pnpm test:compile
```

Expected: TypeScript 因 `GitFacts` 尚无 `renamedFiles` 或断言不匹配而失败。

- [ ] **Step 3: 实现最小数据模型和 parser**

在 `src/git/adapter.ts` 定义：

```ts
export interface GitRename {
  from: string;
  to: string;
}

export interface GitFacts {
  changedFiles: string[];
  deletedFiles: string[];
  renamedFiles: GitRename[];
  diff: string;
}
```

解析 `R` 时读取下一条 NUL 记录作为 `from`，当前记录路径作为 `to`；将二者加入
`changedFiles`，只将真正 `D` 加入 `deletedFiles`。缺少下一条记录时抛出：

```ts
throw new Error(`Git rename record is missing its source path: ${file}`);
```

- [ ] **Step 4: 运行 Git adapter 测试并确认 GREEN**

Run:

```bash
env CI=true pnpm test:compile
node --test .test-dist/tests/git-adapter.test.js
```

Expected: Git adapter 测试全部通过。

- [ ] **Step 5: 提交检查点**

仅当这些文件原本已纳入当前仓库基线时执行：

```bash
git add src/git/adapter.ts tests/git-adapter.test.ts
git commit -m "fix: distinguish git renames from deletions"
```

若文件仍属于用户未提交基线，则保持工作树修改，不擅自纳入部分提交。

### Task 2: 控制器与 Review 证据

**Files:**
- Modify: `src/workflow/controller.ts`
- Test: `tests/task-controller.test.ts`

- [ ] **Step 1: 写失败测试，证明纯重命名不会触发恢复**

为测试依赖记录 Claude prompt，并增加：

```ts
test("allows Git-confirmed renames without deletion approval", async () => {
  const facts = {
    changedFiles: ["src/new.ts", "src/old.ts"],
    deletedFiles: [],
    renamedFiles: [{ from: "src/old.ts", to: "src/new.ts" }],
    diff: "rename diff",
  };
  // Git fake 在每次 collect 时返回 facts。
  // 断言 outcome.status === "completed"、restore === 0，
  // 且 Claude prompt 含 "src/old.ts -> src/new.ts"。
});
```

所有既有 Git fake 增加 `renamedFiles: []`，保证测试事实完整。

- [ ] **Step 2: 运行目标测试并确认 RED**

Run:

```bash
env CI=true pnpm test:compile
```

Expected: Review prompt 尚未包含 rename 映射，新增断言失败。

- [ ] **Step 3: 把 rename 映射加入 Review prompt**

在 `reviewPrompt` 的 Changed files 与 Git diff 之间加入：

```ts
"# Renamed files",
...input.facts.renamedFiles.map(
  (rename) => `${rename.from} -> ${rename.to}`,
),
"",
```

删除门禁继续只读取 `facts.deletedFiles`，不为 rename 新增审批分支。

- [ ] **Step 4: 运行控制器测试并确认 GREEN**

Run:

```bash
env CI=true pnpm test:compile
node --test .test-dist/tests/task-controller.test.js
```

Expected: 控制器测试全部通过，纯重命名完成且未调用恢复。

- [ ] **Step 5: 提交检查点**

遵循 Task 1 的基线判断；不创建包含半套系统的部分提交。

### Task 3: 文档与全量验证

**Files:**
- Modify: `README.md`
- Modify: `docs/operations.md`

- [ ] **Step 1: 更新行为说明**

文档明确写出：

```text
Git 明确识别的 R 重命名不属于删除，无需删除审批；D + ?? 不推断为重命名。
```

- [ ] **Step 2: 执行完整验证**

Run:

```bash
env CI=true pnpm check
node dist/cli.js help
```

Expected: 类型检查通过；全部测试通过；生产构建通过；CLI 帮助退出码为 0；无
error 或 warning。

- [ ] **Step 3: 检查变更边界**

Run:

```bash
git status --short
git diff --stat
```

Expected: 仅本功能相关源码、测试、设计/计划和行为文档发生变化；不包含 push、
merge、清理或外部写入。
