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
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("workflow generator", () => {
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

  it("rejects unknown and malformed placeholders", async () => {
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

    const malformed = await fixture();
    const specPath = join(
      malformed.source,
      "workflow-source/skills/spec-write.md",
    );
    await writeFile(
      specPath,
      `${await readFile(specPath, "utf8")}{{RESOLVE_AMBIGUITY}\n`,
    );
    await expect(
      run(malformed.source, malformed.target, "opencode"),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("malformed or unresolved placeholder"),
    });

    for (const placeholder of [
      "{{{ASK_REQUIRED_FIELDS}}}",
      "{{ASK_REQUIRED_FIELDS}}}",
      "{{ASK_REQUIRED_FIELDS}}x}",
    ]) {
      const extraBrace = await fixture();
      const extraBracePath = join(
        extraBrace.source,
        "workflow-source/skills/issue-submit.md",
      );
      await writeFile(
        extraBracePath,
        `${await readFile(extraBracePath, "utf8")} ${placeholder}\n`,
      );
      await expect(
        run(extraBrace.source, extraBrace.target, "opencode"),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("malformed or unresolved placeholder"),
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
