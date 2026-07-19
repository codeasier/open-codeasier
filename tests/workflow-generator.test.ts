import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

  it("renders OpenCode and Codex wording into platform-native targets", async () => {
    const open = await fixture();
    await run(open.source, open.target, "opencode");
    const openIssue = await readFile(
      join(open.target, "skills/issue-submit/SKILL.md"),
      "utf8",
    );
    expect(openIssue).toContain(
      "Use the question tool to collect each required field",
    );
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
    expect(codexIssue).toContain(
      "Ask the user for each required field one at a time",
    );
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

  it("rejects missing and unused profile values", async () => {
    const missing = await fixture();
    await writeFile(
      join(missing.source, "workflow-source/platforms/opencode.json"),
      JSON.stringify({ RESOLVE_AMBIGUITY: "Resolve ambiguity" }),
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
          "issue-submit: malformed or unresolved placeholder",
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
});
