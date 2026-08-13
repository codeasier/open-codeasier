import { execFile } from "node:child_process";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("workflow generator", () => {
  it("can be imported when process.argv[1] is absent", async () => {
    await expect(
      execFileAsync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `process.argv.splice(1); await import(${JSON.stringify(pathToFileURL(generator).href)});`,
        ],
        { encoding: "utf8" },
      ),
    ).resolves.toMatchObject({ stdout: "", stderr: "" });
  });

  it("can be imported when process.argv[1] cannot be canonicalized", async () => {
    const missingEntry = join(
      tmpdir(),
      `missing-workflow-generator-${process.pid}-${Date.now()}.mjs`,
    );
    await expect(
      execFileAsync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `process.argv[1] = ${JSON.stringify(missingEntry)}; await import(${JSON.stringify(pathToFileURL(generator).href)});`,
        ],
        { encoding: "utf8" },
      ),
    ).resolves.toMatchObject({ stdout: "", stderr: "" });
  });

  it("runs when invoked through a symlinked generator path", async () => {
    const { source, target } = await fixture();
    const linkedGenerator = join(target, "linked-generator.mjs");
    await symlink(generator, linkedGenerator);

    await expect(
      execFileAsync(
        process.execPath,
        [
          linkedGenerator,
          "--platform",
          "opencode",
          "--source",
          source,
          "--target",
          target,
        ],
        { encoding: "utf8" },
      ),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining("Generated 13 opencode workflows"),
    });
    await expect(
      readFile(join(target, "skills/issue-submit/SKILL.md"), "utf8"),
    ).resolves.toContain(
      "Use the question tool to collect each required field",
    );
  });

  it("renders OpenCode and Codex wording into platform-native targets", async () => {
    const open = await fixture();
    const openResult = await run(open.source, open.target, "opencode");
    expect(openResult.stdout).toContain("Generated 13 opencode workflows");
    const openIssue = await readFile(
      join(open.target, "skills/issue-submit/SKILL.md"),
      "utf8",
    );
    expect(openIssue).toContain(
      "Use the question tool to collect each required field",
    );
    expect(openIssue.endsWith("\n")).toBe(true);
    const openHandoff = await readFile(
      join(open.target, "skills/handoff/SKILL.md"),
      "utf8",
    );
    expect(openHandoff).toContain("# Handoff");
    expect(openHandoff).toContain(".agent/handoff/<name>/HANDOFF.md");
    expect(openHandoff).toContain("Wait for explicit user confirmation");
    expect(openHandoff).toContain("^[a-z0-9]+(?:-[a-z0-9]+)*$");
    expect(openHandoff).toContain(
      "Each history entry must include a timestamp, status, and material progress",
    );
    expect(openHandoff).toContain(
      "report the failed operation and whether the document changed",
    );
    for (const heading of [
      "## Objective",
      "## Current State",
      "## Decisions",
      "## Changes",
      "## Verification",
      "## Remaining Work",
      "## Risks And Unknowns",
      "## Resume Instructions",
      "## Handoff History",
    ]) {
      expect(openHandoff).toContain(heading);
    }
    const openRelease = await readFile(
      join(open.target, "skills/release-prep/SKILL.md"),
      "utf8",
    );
    expect(openRelease).toContain("When a target version is supplied");
    expect(openRelease).toContain("remote default branch");
    expect(openRelease).toContain("latest applicable tag");
    expect(openRelease).toContain("comparison range");
    expect(openRelease).toContain(
      "Wait for explicit user confirmation before using the recommendation",
    );
    const openCrossReview = await readFile(
      join(open.target, "skills/cross-review/SKILL.md"),
      "utf8",
    );
    expect(openCrossReview).toContain(
      "Treat a first argument of `init` or `setup`, or a natural-language request",
    );
    expect(openCrossReview).toContain("Run `opencode models`");
    expect(openCrossReview).toContain(
      "treat its output as the authoritative list",
    );
    expect(openCrossReview).toContain("Show the complete discovered list");
    expect(openCrossReview).toContain(
      "recommend a reviewer set and an optional judge drawn only from that list",
    );
    expect(openCrossReview).toContain(
      "If any are unavailable, stop immediately; do not use the legacy blocking",
    );
    expect(openCrossReview).toContain("Call `cross_review_start` once");
    expect(openCrossReview).toContain("Poll with `cross_review_status`");
    expect(openCrossReview).toContain("Call `cross_review_finalize`");
    expect(openCrossReview).toContain("Use `cross_review_cancel`");
    expect(openCrossReview).toContain("`--reviewer-timeout-ms`");
    expect(openCrossReview).toContain(
      ".opencode/.open-codeasier/installed-assets.json",
    );
    expect(openCrossReview).toContain(
      "opencode plugin open-codeasier@<packageVersion> --global --force",
    );
    expect(openCrossReview).toContain("restart OpenCode afterward");
    expect(openCrossReview).not.toContain("provider/...` placeholder");
    expect(openCrossReview).toContain(
      "read it first and detect its reviewer format",
    );
    expect(openCrossReview).toContain(
      "an existing `reviewers` array, a flat `reviewModels` list, a config without any reviewer key",
    );
    expect(openCrossReview).toContain(
      "the model-free `{}` created by `init`, or only non-reviewer keys such as `agents`, `judgeModel`, or `maxConcurrency`",
    );
    expect(openCrossReview).toContain(
      "For a new destination, an existing config without a reviewer key, or an existing `reviewers` destination, collect an optional focus for each reviewer",
    );
    expect(openCrossReview).toContain(
      "preserve its detected `reviewers` or `reviewModels` format",
    );
    expect(openCrossReview).toContain(
      "never write `reviewers` alongside an existing `reviewModels`",
    );
    expect(openCrossReview).toContain(
      "ask the user which of `reviewers` and `reviewModels` to retain, then write that key only, dropping the other while keeping every remaining key such as `agents`, `judgeModel`, and `focus`",
    );
    expect(openCrossReview).toContain(
      "for an existing `reviewModels` destination, collect the flat model list plus one optional shared `focus`",
    );
    expect(openCrossReview).not.toContain(
      "then collect an optional focus for each reviewer and max concurrency",
    );
    const openAgent = await readFile(
      join(open.target, "agents/cross-reviewer.md"),
      "utf8",
    );
    expect(openAgent).toContain(
      "description: Code/change review and cross-review judging only.",
    );
    expect(openAgent).toContain(
      "Invoke proactively only for explicit review intent or cross-review orchestration; never use for routine self-checks, reports, or documentation verification.",
    );
    expect(openAgent).toContain(
      "Accept only code/change review or cross-review judging tasks with explicit review intent.",
    );
    expect(openAgent).toContain(
      "Do not act as a general-purpose verifier for reports, documentation, analysis, or routine self-checks.",
    );
    expect(openAgent).toContain("mode: subagent");
    expect(openAgent).toContain("edit: deny");
    expect(openAgent).toContain("bash: deny");
    expect(openAgent).toContain("task: deny");

    const codex = await fixture();
    await run(codex.source, codex.target, "codex");
    const codexIssue = await readFile(
      join(
        codex.target,
        "plugins/codex-codeasier/skills/issue-submit/SKILL.md",
      ),
      "utf8",
    );
    expect(codexIssue).toContain(
      "Ask the user for each required field one at a time",
    );
    expect(codexIssue).not.toContain("question tool");
    const codexHandoff = await readFile(
      join(codex.target, "plugins/codex-codeasier/skills/handoff/SKILL.md"),
      "utf8",
    );
    const codexRelease = await readFile(
      join(
        codex.target,
        "plugins/codex-codeasier/skills/release-prep/SKILL.md",
      ),
      "utf8",
    );
    expect(codexRelease).toBe(openRelease);
    expect(codexHandoff).toBe(openHandoff);
    expect(codexHandoff).not.toMatch(/OpenCode|question tool|session_review/);
    await expect(
      readFile(
        join(
          codex.target,
          "plugins/codex-codeasier/skills/cross-review/SKILL.md",
        ),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
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

  it
    .skipIf(process.platform === "win32")
    .each([
      "target root",
      "platform prefix",
      "skill directory",
      "workflow leaf",
    ] as const)(
    "rejects a symlinked %s in write and check modes",
    async (kind) => {
      for (const check of [false, true]) {
        const fixtureRoot = await fixture();
        const outside = join(
          dirname(fixtureRoot.target),
          `outside-${kind.replaceAll(" ", "-")}-${check}`,
        );
        await mkdir(outside);
        let protectedPath = join(outside, "SKILL.md");

        if (kind === "target root") {
          await rm(fixtureRoot.target, { recursive: true });
          await symlink(outside, fixtureRoot.target);
          protectedPath = join(outside, "skills/docs-governance/SKILL.md");
        } else if (kind === "platform prefix") {
          await symlink(outside, join(fixtureRoot.target, "skills"));
          protectedPath = join(outside, "docs-governance/SKILL.md");
        } else if (kind === "skill directory") {
          await mkdir(join(fixtureRoot.target, "skills"));
          await symlink(
            outside,
            join(fixtureRoot.target, "skills/docs-governance"),
          );
        } else {
          await mkdir(join(fixtureRoot.target, "skills/docs-governance"), {
            recursive: true,
          });
          await writeFile(protectedPath, "outside sentinel\n");
          await symlink(
            protectedPath,
            join(fixtureRoot.target, "skills/docs-governance/SKILL.md"),
          );
        }

        await expect(
          run(fixtureRoot.source, fixtureRoot.target, "opencode", check),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining("symlinked workflow target"),
        });
        if (kind === "workflow leaf") {
          await expect(readFile(protectedPath, "utf8")).resolves.toBe(
            "outside sentinel\n",
          );
        } else {
          await expect(readFile(protectedPath, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      }
    },
  );

  it("rejects missing and unused profile values", async () => {
    const missing = await fixture();
    await writeFile(
      join(missing.source, "workflow-source/platforms/opencode.json"),
      JSON.stringify({
        CROSS_REVIEW_CONFIG: "Read cross-review configuration",
        CROSS_REVIEW_ORCHESTRATION: "Orchestrate reviews",
        MODEL_NAMING: "Validate models",
        RESOLVE_AMBIGUITY: "Resolve ambiguity",
      }),
    );
    await expect(
      run(missing.source, missing.target, "opencode"),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "missing profile values: ASK_REQUIRED_FIELDS",
      ),
    });

    const unused = await fixture();
    const profilePath = join(
      unused.source,
      "workflow-source/platforms/opencode.json",
    );
    const profile = JSON.parse(await readFile(profilePath, "utf8"));
    profile.UNUSED = "unused";
    await writeFile(profilePath, JSON.stringify(profile));
    await expect(
      run(unused.source, unused.target, "opencode"),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("unused profile keys: UNUSED"),
    });
  });

  it("reports malformed profile JSON with platform and profile context", async () => {
    const { source, target } = await fixture();
    await writeFile(
      join(source, "workflow-source/platforms/codex.json"),
      '{"ASK_REQUIRED_FIELDS":',
    );

    await expect(run(source, target, "codex")).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "codex profile workflow-source/platforms/codex.json: invalid JSON",
      ),
    });
  });

  it("rejects unknown skills and invalid rendered frontmatter", async () => {
    const unknown = await fixture();
    await writeFile(
      join(unknown.source, "workflow-source/skills/extra.md"),
      "---\nname: extra\ndescription: Extra.\n---\n",
    );
    await expect(
      run(unknown.source, unknown.target, "opencode"),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Canonical skills must be exactly"),
    });

    const invalid = await fixture();
    await writeFile(
      join(invalid.source, "workflow-source/skills/issue-review.md"),
      "---\nname: wrong\ndescription: Review.\n---\n",
    );
    await expect(
      run(invalid.source, invalid.target, "opencode"),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "issue-review: frontmatter name must equal issue-review",
      ),
    });
    await expect(
      readFile(join(invalid.target, "skills/docs-governance/SKILL.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsupported and duplicate frontmatter fields", async () => {
    const malformed = await fixture();
    await writeFile(
      join(malformed.source, "workflow-source/skills/issue-review.md"),
      "---\nname: issue-review\nunsupported YAML\ndescription: Review.\n---\n",
    );
    await expect(
      run(malformed.source, malformed.target, "opencode"),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "issue-review: unsupported frontmatter line: unsupported YAML",
      ),
    });

    const duplicate = await fixture();
    await writeFile(
      join(duplicate.source, "workflow-source/skills/issue-review.md"),
      "---\nname: issue-review\nname: issue-review\ndescription: Review.\n---\n",
    );
    await expect(
      run(duplicate.source, duplicate.target, "opencode"),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "issue-review: duplicate frontmatter key: name",
      ),
    });
  });

  it("rejects frontmatter values outside the restricted plain-scalar format", async () => {
    for (const value of [
      "[unterminated",
      '"quoted"',
      "'quoted'",
      "| block",
      "> block",
      "*alias",
      "!tagged",
      "%directive",
      "Review {draft}",
      "Review # comment",
      "Review: details",
      "Review:",
      "true",
      "FALSE",
      "null",
      "~",
      "123",
      "12.34",
      "1.2e3",
      ".Inf",
      ".NaN",
      "0xFF",
      "1_000",
      "2026-07-19",
      "Review\u0007control",
    ] as const) {
      const { source, target } = await fixture();
      await writeFile(
        join(source, "workflow-source/skills/issue-review.md"),
        `---\nname: issue-review\ndescription: ${value}\n---\n`,
      );

      await expect(run(source, target, "opencode")).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "issue-review: unsupported frontmatter value for description",
        ),
      });
    }
  });

  it("renders ordinary literal single braces unchanged without balancing", async () => {
    for (const literal of [
      "Use an object shaped like { name: value }.",
      "A single opening brace { is literal.",
      "A single closing brace } is literal.",
    ] as const) {
      const { source, target } = await fixture();
      const templatePath = join(
        source,
        "workflow-source/skills/docs-governance.md",
      );
      await writeFile(
        templatePath,
        `${await readFile(templatePath, "utf8")}\n${literal}\n`,
      );

      await run(source, target, "opencode");

      await expect(
        readFile(join(target, "skills/docs-governance/SKILL.md"), "utf8"),
      ).resolves.toContain(literal);
    }
  });

  it("rejects unknown placeholders and invalid placeholder names", async () => {
    const unknown = await fixture();
    const issuePath = join(
      unknown.source,
      "workflow-source/skills/issue-submit.md",
    );
    await writeFile(
      issuePath,
      `${await readFile(issuePath, "utf8")}{{UNKNOWN_PLACEHOLDER}}\n`,
    );
    await expect(
      run(unknown.source, unknown.target, "opencode"),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "missing profile values: UNKNOWN_PLACEHOLDER",
      ),
    });

    for (const placeholder of [
      "{{lowercase}}",
      "{{_LEADING_UNDERSCORE}}",
    ] as const) {
      const invalid = await fixture();
      const invalidPath = join(
        invalid.source,
        "workflow-source/skills/issue-submit.md",
      );
      await writeFile(
        invalidPath,
        `${await readFile(invalidPath, "utf8")} ${placeholder}\n`,
      );
      await expect(
        run(invalid.source, invalid.target, "opencode"),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("invalid placeholder name"),
      });
    }
  });

  it("rejects malformed placeholder constructs", async () => {
    for (const placeholder of [
      "{{{ASK_REQUIRED_FIELDS}}}",
      "{{ASK_REQUIRED_FIELDS}}}",
      "{{ASK_REQUIRED_FIELDS}}x}",
      "{{ASK_REQUIRED_FIELDS",
      "ASK_REQUIRED_FIELDS}}",
    ] as const) {
      const malformed = await fixture();
      const templatePath = join(
        malformed.source,
        "workflow-source/skills/issue-submit.md",
      );
      await writeFile(
        templatePath,
        `${await readFile(templatePath, "utf8")} ${placeholder}\n`,
      );
      await expect(
        run(malformed.source, malformed.target, "opencode"),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("malformed or unresolved placeholder"),
      });
    }
  });

  it("rejects double-brace syntax introduced by profile values", async () => {
    for (const injected of [
      "Ask for {{UNKNOWN}}",
      "Ask for {{UNKNOWN",
      "Ask for UNKNOWN}}",
    ] as const) {
      const { source, target } = await fixture();
      const profilePath = join(
        source,
        "workflow-source/platforms/opencode.json",
      );
      const profile = JSON.parse(await readFile(profilePath, "utf8"));
      profile.ASK_REQUIRED_FIELDS = injected;
      await writeFile(profilePath, JSON.stringify(profile));

      await expect(run(source, target, "opencode")).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "cross-review: malformed or unresolved placeholder",
        ),
      });
    }
  });

  it("normalizes CRLF and lone CR into deterministic LF-terminated output", async () => {
    const { source, target } = await fixture();
    const issueTemplate = join(
      source,
      "workflow-source/skills/issue-submit.md",
    );
    const specTemplate = join(source, "workflow-source/skills/spec-write.md");
    await writeFile(
      issueTemplate,
      (await readFile(issueTemplate, "utf8")).replaceAll("\n", "\r\n"),
    );
    await writeFile(
      specTemplate,
      (await readFile(specTemplate, "utf8")).replaceAll("\n", "\r"),
    );

    await run(source, target, "codex");
    const firstIssue = await readFile(
      join(target, "plugins/codex-codeasier/skills/issue-submit/SKILL.md"),
    );
    const firstSpec = await readFile(
      join(target, "plugins/codex-codeasier/skills/spec-write/SKILL.md"),
    );
    await run(source, target, "codex");
    const secondIssue = await readFile(
      join(target, "plugins/codex-codeasier/skills/issue-submit/SKILL.md"),
    );
    const secondSpec = await readFile(
      join(target, "plugins/codex-codeasier/skills/spec-write/SKILL.md"),
    );
    expect(secondIssue).toEqual(firstIssue);
    expect(secondSpec).toEqual(firstSpec);
    expect(firstIssue.includes(13)).toBe(false);
    expect(firstSpec.includes(13)).toBe(false);
    expect(firstIssue.at(-1)).toBe(10);
    expect(firstSpec.at(-1)).toBe(10);
    expect(firstIssue.at(-2)).not.toBe(10);
    expect(firstSpec.at(-2)).not.toBe(10);
  });

  it("keeps committed OpenCode workflows generated from the canonical source", async () => {
    await expect(
      run(resolve("."), resolve("."), "opencode", true),
    ).resolves.toBeDefined();
  });
});
