# Shared Workflow Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `open-codeasier` the reproducible authority for the ten non-session workflow Skills shared with `codex-codeasier`, with byte-preserving generated artifacts and pinned cross-repository CI verification.

**Architecture:** `open-codeasier` stores Markdown templates and two literal platform profiles, and exposes one dependency-free Node.js generator with write and check modes. OpenCode validates its committed generated Skills locally; Codex records the exact merged OpenCode commit, checks out that immutable source in CI, and runs the same generator in read-only check mode before its existing marketplace validation.

**Tech Stack:** Node.js 22 standard library, JSON, Markdown, Vitest 3, npm scripts, GitHub Actions, Git.

---

## Repository And Execution Order

Use these existing checkouts:

- OpenCode authority: `/Users/test1/liuyekang/dev/opencode/open-codeasier`
- Codex consumer: `/Users/test1/liuyekang/dev/opencode/codex-codeasier`

Do not modify `/Users/test1/liuyekang/dev/claude/claude-codeasier` in this plan.

Complete Tasks 1-5 in `open-codeasier`, verify them, and create the OpenCode implementation commit before starting Task 6. Task 6 reads the real full SHA of that commit; never put a placeholder, branch, tag, or abbreviated SHA in the Codex lock file.

The OpenCode checkout already contains unrelated untracked files under `docs/`. Stage only files named by each task. The Claude checkout also contains unrelated user changes and must remain untouched.

## File Map

### OpenCode Authority

- Create `workflow-source/skills/*.md`: ten canonical Markdown templates, preserving current OpenCode bytes after rendering.
- Create `workflow-source/platforms/opencode.json`: OpenCode interaction wording.
- Create `workflow-source/platforms/codex.json`: Codex interaction wording.
- Create `scripts/generate-workflows.mjs`: single rendering, validation, write, and check implementation.
- Create `scripts/check-workflows.mjs`: thin check-mode CLI wrapper.
- Create `tests/workflow-generator.test.ts`: production-CLI tests using isolated temporary roots.
- Modify `package.json`: expose generate/check scripts and include workflow consistency in `npm run check`.
- Modify `.github/workflows/ci.yml`: run the explicit workflow check before package validation.

### Codex Consumer

- Create `workflow-source.lock.json`: immutable OpenCode source reference.
- Modify `scripts/validate.mjs`: validate the lock schema before marketplace validation.
- Modify `.github/workflows/ci.yml`: checkout the pinned OpenCode commit and run its generator in check mode.
- Preserve `plugins/codex-codeasier/skills/*/SKILL.md`: regenerate them, but the first migration must produce no byte changes.

## CLI Contract

The production interface used throughout this plan is:

```bash
node scripts/generate-workflows.mjs \
  --platform <opencode|codex> \
  --target <repository-root> \
  [--source <open-codeasier-root>] \
  [--check]
```

`--source` defaults to the repository containing the generator. `--target` is required. `--check` compares without writing. `scripts/check-workflows.mjs` accepts the same arguments except that it always enables check mode.

### Task 1: Establish Canonical Templates And Profiles

**Files:**
- Create: `workflow-source/skills/docs-governance.md`
- Create: `workflow-source/skills/issue-resolve.md`
- Create: `workflow-source/skills/issue-review.md`
- Create: `workflow-source/skills/issue-submit.md`
- Create: `workflow-source/skills/pr-followup.md`
- Create: `workflow-source/skills/release-prep.md`
- Create: `workflow-source/skills/spec-run.md`
- Create: `workflow-source/skills/spec-write.md`
- Create: `workflow-source/skills/understand-me.md`
- Create: `workflow-source/skills/worktree-clean.md`
- Create: `workflow-source/platforms/opencode.json`
- Create: `workflow-source/platforms/codex.json`

- [ ] **Step 1: Record the current OpenCode and Codex Skill checksums**

Run in `open-codeasier`:

```bash
shasum skills/{docs-governance,issue-resolve,issue-review,issue-submit,pr-followup,release-prep,spec-run,spec-write,understand-me,worktree-clean}/SKILL.md
```

Run in `codex-codeasier`:

```bash
shasum plugins/codex-codeasier/skills/{docs-governance,issue-resolve,issue-review,issue-submit,pr-followup,release-prep,spec-run,spec-write,understand-me,worktree-clean}/SKILL.md
```

Expected: ten checksums from each repository. Save the terminal output for comparison after generation; do not create a repository file for it.

- [ ] **Step 2: Create the eight platform-identical canonical templates**

For each listed Skill, create `workflow-source/skills/<name>.md` with bytes identical to the current `skills/<name>/SKILL.md`:

```text
docs-governance
issue-resolve
issue-review
pr-followup
release-prep
spec-run
understand-me
worktree-clean
```

Use a byte-preserving filesystem copy for these eight files. Verify immediately:

```bash
mkdir -p workflow-source/skills
for skill in docs-governance issue-resolve issue-review pr-followup release-prep spec-run understand-me worktree-clean; do
  cp "skills/$skill/SKILL.md" "workflow-source/skills/$skill.md"
done
for skill in docs-governance issue-resolve issue-review pr-followup release-prep spec-run understand-me worktree-clean; do
  cmp "skills/$skill/SKILL.md" "workflow-source/skills/$skill.md"
done
```

Expected: exit code `0` and no output.

- [ ] **Step 3: Create the parameterized `issue-submit` template**

Create `workflow-source/skills/issue-submit.md` with exactly:

```markdown
---
name: issue-submit
description: Discover a remote repository's issue templates and submit a confirmed issue.
---

# Issue Submit

Require one `owner/repo`. Use `gh api` to inspect `.github/ISSUE_TEMPLATE`, a legacy `.github/ISSUE_TEMPLATE.md`, and `config.yml`. Present available forms, templates, contact links, and a blank issue when permitted. {{ASK_REQUIRED_FIELDS}}, preserving defaults, labels, and assignees. Preview the complete title and body. Run `gh issue create` only after explicit user confirmation, then return its URL. Never create local files or modify source.
```

- [ ] **Step 4: Create the parameterized `spec-write` template**

Create `workflow-source/skills/spec-write.md` with exactly:

```markdown
---
name: spec-write
description: Create an implementation-ready spec package without changing product code.
---

# Spec Write

Turn a requested change into `specs/<change-id>/spec.md`, `tasks.md`, and `checklist.md`. Inspect existing packages first and update a matching package rather than duplicating it. {{RESOLVE_AMBIGUITY}}. Define motivation, scope, observable requirements, scenarios, impact, exclusions, dependency-ordered tasks, and acceptance checks. Keep tasks concrete and verifiable. Edit only the selected spec package, do not implement code, and finish by showing its path and requesting approval before execution.
```

- [ ] **Step 5: Create literal platform profiles**

Create `workflow-source/platforms/opencode.json`:

```json
{
  "ASK_REQUIRED_FIELDS": "Use the question tool to collect each required field",
  "RESOLVE_AMBIGUITY": "Resolve ambiguity with the question tool"
}
```

Create `workflow-source/platforms/codex.json`:

```json
{
  "ASK_REQUIRED_FIELDS": "Ask the user for each required field one at a time",
  "RESOLVE_AMBIGUITY": "Resolve ambiguity by asking the user one focused question at a time"
}
```

- [ ] **Step 6: Verify the source inventory**

Run:

```bash
test "$(find workflow-source/skills -type f -name '*.md' | wc -l | tr -d ' ')" = 10
test "$(find workflow-source/platforms -type f -name '*.json' | wc -l | tr -d ' ')" = 2
```

Expected: exit code `0` and no output.

- [ ] **Step 7: Commit the canonical source**

```bash
git add workflow-source/skills workflow-source/platforms
git commit -m "feat: add canonical workflow sources"
```

Expected: one commit containing only twelve new source/profile files.

### Task 2: Build The Deterministic Generator With Tests

**Files:**
- Create: `scripts/generate-workflows.mjs`
- Create: `scripts/check-workflows.mjs`
- Create: `tests/workflow-generator.test.ts`

- [ ] **Step 1: Write failing CLI tests for rendering and check mode**

Create `tests/workflow-generator.test.ts` with helpers that copy `workflow-source` into a temporary source root and invoke the real Node CLI:

```ts
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const generator = resolve("scripts/generate-workflows.mjs");
const temporaryRoots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "open-codeasier-workflows-"));
  temporaryRoots.push(root);
  const source = join(root, "source");
  const target = join(root, "target");
  await mkdir(source);
  await mkdir(target);
  await cp("workflow-source", join(source, "workflow-source"), {
    recursive: true,
  });
  return { source, target };
}

async function run(
  source: string,
  target: string,
  platform: "opencode" | "codex",
  check = false,
) {
  return execFileAsync(
    process.execPath,
    [
      generator,
      "--platform",
      platform,
      "--source",
      source,
      "--target",
      target,
      ...(check ? ["--check"] : []),
    ],
    { encoding: "utf8" },
  );
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("workflow generator", () => {
  it("renders OpenCode and Codex wording into platform-native targets", async () => {
    const open = await fixture();
    await run(open.source, open.target, "opencode");
    const openIssue = await readFile(
      join(open.target, "skills/issue-submit/SKILL.md"),
      "utf8",
    );
    expect(openIssue).toContain("Use the question tool to collect each required field");
    expect(openIssue.endsWith("\n")).toBe(true);

    const codex = await fixture();
    await run(codex.source, codex.target, "codex");
    const codexIssue = await readFile(
      join(
        codex.target,
        "plugins/codex-codeasier/skills/issue-submit/SKILL.md",
      ),
      "utf8",
    );
    expect(codexIssue).toContain("Ask the user for each required field one at a time");
    expect(codexIssue).not.toContain("question tool");
  });

  it("reports every stale target in check mode without writing", async () => {
    const { source, target } = await fixture();
    await run(source, target, "opencode");
    const issuePath = join(target, "skills/issue-submit/SKILL.md");
    const specPath = join(target, "skills/spec-write/SKILL.md");
    await writeFile(issuePath, "stale issue\n");
    await writeFile(specPath, "stale spec\n");

    const failure = await run(source, target, "opencode", true).then(
      () => undefined,
      (error: { stderr: string }) => error,
    );
    expect(failure?.stderr).toContain("skills/issue-submit/SKILL.md");
    expect(failure?.stderr).toContain("skills/spec-write/SKILL.md");
    await expect(readFile(issuePath, "utf8")).resolves.toBe("stale issue\n");
    await expect(readFile(specPath, "utf8")).resolves.toBe("stale spec\n");
  });
});
```

- [ ] **Step 2: Run the tests to verify the missing generator failure**

Run:

```bash
npx vitest run tests/workflow-generator.test.ts
```

Expected: FAIL because `scripts/generate-workflows.mjs` does not exist.

- [ ] **Step 3: Implement the production generator**

Create `scripts/generate-workflows.mjs`. The implementation must export `main`, stage and validate all outputs before writing, and use only Node.js standard-library modules:

```js
import { readFile, readdir, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const expectedSkills = [
  "docs-governance",
  "issue-resolve",
  "issue-review",
  "issue-submit",
  "pr-followup",
  "release-prep",
  "spec-run",
  "spec-write",
  "understand-me",
  "worktree-clean",
];

const placeholderPattern = /\{\{([^{}]+)\}\}/g;
const placeholderName = /^[A-Z][A-Z0-9_]*$/;
const targetPrefix = {
  opencode: "skills",
  codex: "plugins/codex-codeasier/skills",
};

function parseArguments(args) {
  const options = { check: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check") {
      options.check = true;
      continue;
    }
    if (!["--platform", "--source", "--target"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }
  if (options.platform !== "opencode" && options.platform !== "codex") {
    throw new Error("--platform must be opencode or codex");
  }
  if (!options.target) throw new Error("--target is required");
  return options;
}

function validateFrontmatter(skill, contents) {
  const match = contents.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) throw new Error(`${skill}: missing YAML frontmatter`);
  const fields = Object.fromEntries(
    match[1]
      .split("\n")
      .map((line) => line.match(/^([a-z_]+):\s*(.+)$/))
      .filter(Boolean)
      .map((line) => [line[1], line[2].trim()]),
  );
  if (fields.name !== skill) {
    throw new Error(`${skill}: frontmatter name must equal ${skill}`);
  }
  if (!fields.description) {
    throw new Error(`${skill}: frontmatter description is required`);
  }
}

function render(skill, template, profile, usedKeys) {
  const unknown = new Set();
  const rendered = template.replace(placeholderPattern, (_, key) => {
    if (!placeholderName.test(key) || !(key in profile) || typeof profile[key] !== "string") {
      unknown.add(key);
      return `{{${key}}}`;
    }
    usedKeys.add(key);
    return profile[key];
  });
  if (unknown.size) {
    throw new Error(`${skill}: missing profile values: ${[...unknown].sort().join(", ")}`);
  }
  if (/\{\{[^{}]+\}\}/.test(rendered)) {
    throw new Error(`${skill}: unresolved placeholder`);
  }
  const normalized = `${rendered.replaceAll("\r\n", "\n").trimEnd()}\n`;
  validateFrontmatter(skill, normalized);
  return normalized;
}

async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const sourceRoot = resolve(options.source ?? ownRoot);
  const targetRoot = resolve(options.target);
  const skillsRoot = join(sourceRoot, "workflow-source", "skills");
  const actualSkills = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name.slice(0, -3))
    .sort();
  if (JSON.stringify(actualSkills) !== JSON.stringify(expectedSkills)) {
    throw new Error(
      `Canonical skills must be exactly: ${expectedSkills.join(", ")}; found: ${actualSkills.join(", ")}`,
    );
  }

  const profilePath = join(
    sourceRoot,
    "workflow-source",
    "platforms",
    `${options.platform}.json`,
  );
  const profile = JSON.parse(await readFile(profilePath, "utf8"));
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error(`${options.platform}: profile must be an object`);
  }

  const usedKeys = new Set();
  const outputs = [];
  for (const skill of actualSkills) {
    const template = await readFile(join(skillsRoot, `${skill}.md`), "utf8");
    const contents = render(skill, template, profile, usedKeys);
    outputs.push({
      displayPath: `${targetPrefix[options.platform]}/${skill}/SKILL.md`,
      path: join(targetRoot, targetPrefix[options.platform], skill, "SKILL.md"),
      contents,
    });
  }

  const profileKeys = Object.keys(profile).sort();
  const unused = profileKeys.filter((key) => !usedKeys.has(key));
  if (unused.length) {
    throw new Error(`${options.platform}: unused profile keys: ${unused.join(", ")}`);
  }

  const mismatches = [];
  for (const output of outputs) {
    let current;
    try {
      current = await readFile(output.path, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (current !== output.contents) mismatches.push(output);
  }

  if (options.check) {
    if (mismatches.length) {
      for (const output of mismatches) {
        console.error(`stale generated workflow: ${output.displayPath}`);
      }
      process.exitCode = 1;
    } else {
      console.log(`Generated ${options.platform} workflows are current`);
    }
    return;
  }

  for (const output of mismatches) {
    await atomicWrite(output.path, output.contents);
  }
  console.log(
    `Generated ${outputs.length} ${options.platform} workflows (${mismatches.length} changed)`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
}
```

If ESLint reports an implementation defect, correct the production or test code rather than weakening lint rules.

- [ ] **Step 4: Create the thin check wrapper**

Create `scripts/check-workflows.mjs`:

```js
import { main } from "./generate-workflows.mjs";

main([...process.argv.slice(2), "--check"]).catch((error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
```

- [ ] **Step 5: Run focused tests and fix only production-path defects**

Run:

```bash
npx vitest run tests/workflow-generator.test.ts
```

Expected: PASS with two tests. The stale-target test must capture one rejected process and assert that the same `stderr` contains both stale paths.

- [ ] **Step 6: Add validation-failure tests**

Append these tests inside the existing `describe` block in `tests/workflow-generator.test.ts`:

```ts
  it("rejects missing and unused profile values", async () => {
    const missing = await fixture();
    await writeFile(
      join(missing.source, "workflow-source/platforms/opencode.json"),
      JSON.stringify({ RESOLVE_AMBIGUITY: "Resolve ambiguity" }),
    );
    await expect(run(missing.source, missing.target, "opencode")).rejects.toMatchObject({
      stderr: expect.stringContaining("missing profile values: ASK_REQUIRED_FIELDS"),
    });

    const unused = await fixture();
    const profilePath = join(
      unused.source,
      "workflow-source/platforms/opencode.json",
    );
    const profile = JSON.parse(await readFile(profilePath, "utf8"));
    profile.UNUSED = "unused";
    await writeFile(profilePath, JSON.stringify(profile));
    await expect(run(unused.source, unused.target, "opencode")).rejects.toMatchObject({
      stderr: expect.stringContaining("unused profile keys: UNUSED"),
    });
  });

  it("rejects unknown skills and invalid rendered frontmatter", async () => {
    const unknown = await fixture();
    await writeFile(
      join(unknown.source, "workflow-source/skills/extra.md"),
      "---\nname: extra\ndescription: Extra.\n---\n",
    );
    await expect(run(unknown.source, unknown.target, "opencode")).rejects.toMatchObject({
      stderr: expect.stringContaining("Canonical skills must be exactly"),
    });

    const invalid = await fixture();
    await writeFile(
      join(invalid.source, "workflow-source/skills/issue-review.md"),
      "---\nname: wrong\ndescription: Review.\n---\n",
    );
    await expect(run(invalid.source, invalid.target, "opencode")).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "issue-review: frontmatter name must equal issue-review",
      ),
    });
  });

  it("produces deterministic LF-terminated output", async () => {
    const { source, target } = await fixture();
    await run(source, target, "codex");
    const first = await readFile(
      join(target, "plugins/codex-codeasier/skills/spec-write/SKILL.md"),
    );
    await run(source, target, "codex");
    const second = await readFile(
      join(target, "plugins/codex-codeasier/skills/spec-write/SKILL.md"),
    );
    expect(second).toEqual(first);
    expect(first.includes(Buffer.from("\r\n"))).toBe(false);
    expect(first.at(-1)).toBe(10);
    expect(first.at(-2)).not.toBe(10);
  });
```

- [ ] **Step 7: Run focused tests, lint, and formatting**

Run:

```bash
npx prettier --write scripts tests/workflow-generator.test.ts
npx vitest run tests/workflow-generator.test.ts
npx eslint scripts tests/workflow-generator.test.ts
npx prettier --check scripts tests/workflow-generator.test.ts workflow-source
```

Expected: all commands exit `0`.

- [ ] **Step 8: Commit the generator and tests**

```bash
git add scripts/generate-workflows.mjs scripts/check-workflows.mjs tests/workflow-generator.test.ts
git commit -m "feat: generate platform workflow skills"
```

Expected: one commit containing only the generator, check wrapper, and focused tests.

### Task 3: Prove Byte-Preserving OpenCode Generation

**Files:**
- Verify only: `skills/docs-governance/SKILL.md`
- Verify only: `skills/issue-resolve/SKILL.md`
- Verify only: `skills/issue-review/SKILL.md`
- Verify only: `skills/issue-submit/SKILL.md`
- Verify only: `skills/pr-followup/SKILL.md`
- Verify only: `skills/release-prep/SKILL.md`
- Verify only: `skills/spec-run/SKILL.md`
- Verify only: `skills/spec-write/SKILL.md`
- Verify only: `skills/understand-me/SKILL.md`
- Verify only: `skills/worktree-clean/SKILL.md`

- [ ] **Step 1: Check current OpenCode artifacts before writing**

Run:

```bash
node scripts/check-workflows.mjs --platform opencode --target .
```

Expected: `Generated opencode workflows are current`. A failure here means a template/profile does not preserve current bytes; fix the canonical source or profile, not the generated Skill.

- [ ] **Step 2: Exercise write-mode idempotence**

Run twice:

```bash
node scripts/generate-workflows.mjs --platform opencode --target .
node scripts/generate-workflows.mjs --platform opencode --target .
```

Expected on both runs: `Generated 10 opencode workflows (0 changed)`.

- [ ] **Step 3: Confirm no Skill bytes changed**

Run:

```bash
git diff --exit-code -- skills
```

Expected: exit code `0` and no output.

- [ ] **Step 4: Add a source-versus-artifact parity test**

Append to `tests/workflow-generator.test.ts` outside the temporary-fixture assertions but inside the `describe` block:

```ts
  it("keeps committed OpenCode workflows generated from the canonical source", async () => {
    await expect(
      run(resolve("."), resolve("."), "opencode", true),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining("Generated opencode workflows are current"),
    });
  });
```

- [ ] **Step 5: Run the complete test suite**

Run:

```bash
npm test
```

Expected: all existing and workflow-generator tests pass.

- [ ] **Step 6: Commit the parity test**

```bash
git add tests/workflow-generator.test.ts
git commit -m "test: enforce generated workflow parity"
```

Expected: one test-only commit. There must be no staged `skills/` changes.

### Task 4: Integrate OpenCode Commands And CI

**Files:**
- Modify: `package.json:27-35`
- Modify: `.github/workflows/ci.yml:18-20`

- [ ] **Step 1: Add package scripts**

Modify the `scripts` object in `package.json` to contain:

```json
{
  "build": "tsc -p tsconfig.json",
  "check": "npm run workflows:check && npm run format:check && npm run lint && npm run typecheck && npm test && npm run build",
  "format": "prettier --write .",
  "format:check": "prettier --check .",
  "lint": "eslint .",
  "test": "vitest run",
  "typecheck": "tsc -p tsconfig.json --noEmit",
  "workflows:generate": "node scripts/generate-workflows.mjs --platform opencode --target .",
  "workflows:check": "node scripts/check-workflows.mjs --platform opencode --target ."
}
```

- [ ] **Step 2: Run the new package-level check**

Run:

```bash
npm run workflows:check
```

Expected: `Generated opencode workflows are current`.

- [ ] **Step 3: Add an explicit CI workflow check**

In `.github/workflows/ci.yml`, insert this step after `npm ci` and before `npm run check`:

```yaml
      - run: npm run workflows:check
```

This explicit step makes the generated-source boundary visible in CI logs even though `npm run check` also enforces it locally.

- [ ] **Step 4: Run the complete OpenCode verification**

Run:

```bash
npm run check
```

Expected: formatting, lint, typecheck, all tests, and build pass. Confirm `git diff -- skills` remains empty.

- [ ] **Step 5: Commit OpenCode integration**

```bash
git add package.json .github/workflows/ci.yml
git commit -m "ci: verify generated workflow skills"
```

Expected: one commit containing only package scripts and CI integration.

### Task 5: Finalize The OpenCode Authority Commit

**Files:**
- Verify: all OpenCode files created or modified in Tasks 1-4

- [ ] **Step 1: Inspect repository state and intended diff**

Run:

```bash
git status --short
git diff HEAD~4..HEAD -- workflow-source scripts tests/workflow-generator.test.ts package.json .github/workflows/ci.yml
git log --oneline -10
```

Expected: the implementation history contains the four focused commits from Tasks 1-4. Unrelated untracked `docs/` files may still appear but must not be staged or modified.

- [ ] **Step 2: Run final OpenCode verification**

Run:

```bash
npm run check
git diff --exit-code -- skills
```

Expected: both commands exit `0`.

- [ ] **Step 3: Record the immutable OpenCode source SHA**

Run:

```bash
git rev-parse HEAD
```

Expected: one 40-character lowercase hexadecimal SHA. Save it as `OPEN_CODEASIER_WORKFLOW_SHA` for Task 6. Do not amend or add commits to OpenCode after recording it; if OpenCode changes, rerun verification and record the new SHA.

### Task 6: Add And Validate The Codex Upstream Lock

**Files:**
- Create: `workflow-source.lock.json`
- Modify: `scripts/validate.mjs:1-49`

- [ ] **Step 1: Create the lock with the real OpenCode SHA**

In `codex-codeasier`, create `workflow-source.lock.json`, replacing only the SHA value below with the exact value recorded in Task 5:

```json
{
  "repository": "codeasier/open-codeasier",
  "commit": "OPEN_CODEASIER_WORKFLOW_SHA",
  "generator": "scripts/generate-workflows.mjs"
}
```

Before continuing, run:

```bash
node -e 'const x=require("./workflow-source.lock.json"); if(!/^[0-9a-f]{40}$/.test(x.commit)) process.exit(1)'
```

Expected: exit code `0`. The literal text `OPEN_CODEASIER_WORKFLOW_SHA` must not remain in the file.

- [ ] **Step 2: Establish a failing lock-validation case**

Temporarily set the lock commit to `main` and run:

```bash
node scripts/validate.mjs
```

Expected before implementation: the existing validator still passes, proving it does not validate the lock. Restore the real SHA before editing the validator.

- [ ] **Step 3: Add lock validation to `scripts/validate.mjs`**

After the existing `expectFields` function and before marketplace parsing, add:

```js
let workflowSourceLock;
try {
  workflowSourceLock = JSON.parse(
    await readFile(join(root, "workflow-source.lock.json"), "utf8"),
  );
} catch (error) {
  fail(`cannot parse workflow source lock: ${error.message}`);
}

if (
  typeof workflowSourceLock !== "object" ||
  workflowSourceLock === null ||
  Array.isArray(workflowSourceLock)
) {
  fail("workflow source lock must be an object");
} else {
  expectFields("workflow source lock", workflowSourceLock, {
    repository: "codeasier/open-codeasier",
    generator: "scripts/generate-workflows.mjs",
  });
  if (!/^[0-9a-f]{40}$/.test(workflowSourceLock.commit ?? "")) {
    fail("workflow source lock commit must be a full lowercase commit SHA");
  }
  const expectedLockFields = ["commit", "generator", "repository"];
  const actualLockFields = Object.keys(workflowSourceLock).sort();
  if (JSON.stringify(actualLockFields) !== JSON.stringify(expectedLockFields)) {
    fail(`workflow source lock fields must be exactly: ${expectedLockFields.join(", ")}`);
  }
}
```

- [ ] **Step 4: Verify valid and invalid locks**

Run with the real lock:

```bash
node scripts/validate.mjs
```

Expected:

```text
Validation passed: marketplace codex-codeasier, plugin codex-codeasier, 10 skills
```

Then temporarily change `commit` to `main` and run again.

Expected: non-zero exit and:

```text
error: workflow source lock commit must be a full lowercase commit SHA
```

Restore the real SHA and rerun validation successfully.

- [ ] **Step 5: Commit the lock contract**

```bash
git add workflow-source.lock.json scripts/validate.mjs
git commit -m "feat: pin canonical workflow source"
```

Expected: one commit containing only the lock and its local validation.

### Task 7: Verify Byte-Preserving Codex Generation

**Files:**
- Verify only: `plugins/codex-codeasier/skills/*/SKILL.md`

- [ ] **Step 1: Check out the pinned authority into an approved temporary directory**

Read the SHA and clone the authority:

```bash
OPEN_CODEASIER_WORKFLOW_SHA=$(node -p 'require("./workflow-source.lock.json").commit')
git clone --no-checkout https://github.com/codeasier/open-codeasier.git /var/folders/44/mmqfw4_j1mq02hggc798tfy80000gn/T/opencode/open-codeasier-workflow-source
git -C /var/folders/44/mmqfw4_j1mq02hggc798tfy80000gn/T/opencode/open-codeasier-workflow-source checkout --detach "$OPEN_CODEASIER_WORKFLOW_SHA"
```

Expected: detached checkout at the exact locked SHA. If the implementation commit has not been pushed and GitHub cannot resolve it, use the local OpenCode checkout for this local verification only; do not proceed to Codex CI or claim remote reproducibility until the commit exists on GitHub.

- [ ] **Step 2: Run the pinned generator in Codex check mode**

Run from `codex-codeasier`:

```bash
node /var/folders/44/mmqfw4_j1mq02hggc798tfy80000gn/T/opencode/open-codeasier-workflow-source/scripts/check-workflows.mjs \
  --platform codex \
  --source /var/folders/44/mmqfw4_j1mq02hggc798tfy80000gn/T/opencode/open-codeasier-workflow-source \
  --target .
```

Expected: `Generated codex workflows are current`. A failure means the source/profile does not preserve existing Codex bytes; fix and recommit OpenCode, update the lock to the new SHA, and repeat. Do not manually edit Codex generated Skills to hide a mismatch.

- [ ] **Step 3: Exercise Codex write-mode idempotence**

Run:

```bash
node /var/folders/44/mmqfw4_j1mq02hggc798tfy80000gn/T/opencode/open-codeasier-workflow-source/scripts/generate-workflows.mjs \
  --platform codex \
  --source /var/folders/44/mmqfw4_j1mq02hggc798tfy80000gn/T/opencode/open-codeasier-workflow-source \
  --target .
git diff --exit-code -- plugins/codex-codeasier/skills
```

Expected: generator reports `0 changed`, and Git reports no Skill diff.

- [ ] **Step 4: Run existing Codex validation**

Run:

```bash
node scripts/validate.mjs
```

Expected: existing marketplace validation passes and still forbids OpenCode and session terms.

### Task 8: Add Pinned Cross-Repository Codex CI

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add the pinned source checkout and generation check**

Replace `.github/workflows/ci.yml` with:

```yaml
name: CI

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - id: workflow-source
        name: Read workflow source lock
        run: |
          node scripts/validate.mjs
          echo "commit=$(node -p 'require("./workflow-source.lock.json").commit')" >> "$GITHUB_OUTPUT"
      - name: Check out pinned workflow source
        uses: actions/checkout@v4
        with:
          repository: codeasier/open-codeasier
          ref: ${{ steps.workflow-source.outputs.commit }}
          path: .workflow-source/open-codeasier
          persist-credentials: false
      - name: Verify generated workflows
        run: |
          node .workflow-source/open-codeasier/scripts/check-workflows.mjs \
            --platform codex \
            --source .workflow-source/open-codeasier \
            --target .
      - run: node scripts/validate.mjs
```

The first validator run rejects a malformed or mutable lock before its value reaches `actions/checkout`. `persist-credentials: false` prevents the authority checkout from retaining a token. The generator runs with `--check` and cannot write target files.

- [ ] **Step 2: Confirm the pinned commit is remotely reachable**

Run:

```bash
OPEN_CODEASIER_WORKFLOW_SHA=$(node -p 'require("./workflow-source.lock.json").commit')
git ls-remote https://github.com/codeasier/open-codeasier.git | grep "$OPEN_CODEASIER_WORKFLOW_SHA"
```

Expected: one matching line. If there is no match, push or merge the OpenCode implementation through the normal repository workflow before committing Codex CI. Do not replace the SHA with `main`.

- [ ] **Step 3: Simulate the CI generation command locally**

Run from `codex-codeasier`, reusing the temporary checkout from Task 7:

```bash
node /var/folders/44/mmqfw4_j1mq02hggc798tfy80000gn/T/opencode/open-codeasier-workflow-source/scripts/check-workflows.mjs \
  --platform codex \
  --source /var/folders/44/mmqfw4_j1mq02hggc798tfy80000gn/T/opencode/open-codeasier-workflow-source \
  --target .
node scripts/validate.mjs
```

Expected: both checks pass.

- [ ] **Step 4: Commit Codex CI integration**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: verify workflows against pinned source"
```

Expected: one CI-only commit.

### Task 9: End-To-End Verification And Documentation Check

**Files:**
- Verify: both repositories
- Modify only if inaccurate: `README.md` in either repository

- [ ] **Step 1: Run complete OpenCode verification**

Run in `open-codeasier`:

```bash
npm run check
git diff --exit-code -- skills
git status --short
```

Expected: checks pass, generated Skills have no diff, and only pre-existing unrelated untracked files may remain.

- [ ] **Step 2: Run complete Codex verification**

Run in `codex-codeasier`:

```bash
node scripts/validate.mjs
node /var/folders/44/mmqfw4_j1mq02hggc798tfy80000gn/T/opencode/open-codeasier-workflow-source/scripts/check-workflows.mjs \
  --platform codex \
  --source /var/folders/44/mmqfw4_j1mq02hggc798tfy80000gn/T/opencode/open-codeasier-workflow-source \
  --target .
git diff --exit-code -- plugins/codex-codeasier/skills
git status --short
```

Expected: all checks pass and generated Codex Skills have no diff.

- [ ] **Step 3: Confirm the initial extraction has no behavioral text change**

Compare the current implementation against the commits preceding this plan:

```bash
git -C /Users/test1/liuyekang/dev/opencode/open-codeasier diff 4b09b09..HEAD -- skills
git -C /Users/test1/liuyekang/dev/opencode/codex-codeasier diff 78856d1..HEAD -- plugins/codex-codeasier/skills
```

Expected: both commands produce no output. If either produces a Skill diff, stop and separate that behavioral change from the extraction.

- [ ] **Step 4: Check public documentation for inaccurate maintenance claims**

Read both `README.md` files and verify that neither tells contributors to maintain the ten shared Skill files independently. If no statement is inaccurate, make no documentation change. If a statement is inaccurate, add one concise contributor note:

```markdown
The ten non-session repository workflows are generated from the canonical sources in `codeasier/open-codeasier`; do not edit their generated `SKILL.md` files independently.
```

Run the relevant repository validation after any README edit, and commit that edit separately with:

```bash
git add README.md
git commit -m "docs: explain canonical workflow source"
```

- [ ] **Step 5: Inspect final histories and worktrees**

Run:

```bash
git -C /Users/test1/liuyekang/dev/opencode/open-codeasier log --oneline -10
git -C /Users/test1/liuyekang/dev/opencode/open-codeasier status --short
git -C /Users/test1/liuyekang/dev/opencode/codex-codeasier log --oneline -10
git -C /Users/test1/liuyekang/dev/opencode/codex-codeasier status --short
```

Expected: focused commits, no generated Skill drift, no staged unrelated files, and all pre-existing user files preserved.

## Completion Criteria

- The ten templates and two profiles live only in the OpenCode authority.
- OpenCode generation produces the existing ten OpenCode Skill files byte-for-byte.
- Codex generation produces the existing ten Codex Skill files byte-for-byte.
- OpenCode tests cover successful rendering, check mode, source/profile failures, frontmatter, determinism, line endings, and committed parity.
- OpenCode `npm run check` and CI enforce local generated parity.
- Codex validates an exact lock schema containing a remotely reachable full OpenCode commit SHA.
- Codex CI checks out only that SHA and runs the dependency-free generator without installing upstream dependencies.
- Existing Codex marketplace and forbidden-term validation still passes.
- OpenCode `session-review`, OpenCode commands, manifests, runtimes, installers, and all Claude files remain outside the extraction.
