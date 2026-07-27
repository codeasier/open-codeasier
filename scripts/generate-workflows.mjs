import { randomUUID } from "node:crypto";
import console from "node:console";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const expectedSkills = [
  "docs-governance",
  "handoff",
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

const placeholderPattern = /(?<!\{)\{\{([^{}]*)\}\}(?!\})/g;
const placeholderName = /^[A-Z][A-Z0-9_]*$/;
const targetPrefix = {
  opencode: "skills",
  codex: "plugins/codex-codeasier/skills",
};

function validatePlaceholderStructure(skill, template) {
  for (let index = 0; index < template.length; index += 1) {
    if (template.startsWith("{{", index)) {
      const close = template.indexOf("}}", index + 2);
      const trailing = close === -1 ? "" : template.slice(close + 2);
      if (
        close === -1 ||
        /[{}]/.test(template.slice(index + 2, close)) ||
        trailing.startsWith("}") ||
        /^[^\s{}]*}/.test(trailing)
      ) {
        throw new Error(`${skill}: malformed or unresolved placeholder`);
      }
      index = close + 1;
      continue;
    }
    if (template.startsWith("}}", index)) {
      throw new Error(`${skill}: malformed or unresolved placeholder`);
    }
  }
}

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
  const fields = {};
  for (const line of match[1].split("\n")) {
    const field = line.match(/^([a-z_]+):\s*(\S(?:.*\S)?)\s*$/);
    if (!field) {
      throw new Error(`${skill}: unsupported frontmatter line: ${line}`);
    }
    const [, key, value] = field;
    if (key in fields) {
      throw new Error(`${skill}: duplicate frontmatter key: ${key}`);
    }
    if (
      !/^(?!(?:null|true|false)$)[A-Za-z][A-Za-z0-9 .,()/'_-]*$/i.test(value)
    ) {
      throw new Error(`${skill}: unsupported frontmatter value for ${key}`);
    }
    fields[key] = value;
  }
  if (fields.name !== skill) {
    throw new Error(`${skill}: frontmatter name must equal ${skill}`);
  }
  if (!fields.description) {
    throw new Error(`${skill}: frontmatter description is required`);
  }
}

function render(skill, template, profile, usedKeys) {
  validatePlaceholderStructure(skill, template);
  const unknown = new Set();
  const rendered = template.replace(placeholderPattern, (_, key) => {
    if (!placeholderName.test(key)) {
      throw new Error(`${skill}: invalid placeholder name: ${key}`);
    }
    if (!(key in profile) || typeof profile[key] !== "string") {
      unknown.add(key);
      return `{{${key}}}`;
    }
    usedKeys.add(key);
    return profile[key];
  });
  if (unknown.size) {
    throw new Error(
      `${skill}: missing profile values: ${[...unknown].sort().join(", ")}`,
    );
  }
  if (rendered.includes("{{") || rendered.includes("}}")) {
    throw new Error(`${skill}: malformed or unresolved placeholder`);
  }
  const normalized = `${rendered.replace(/\r\n?/g, "\n").trimEnd()}\n`;
  validateFrontmatter(skill, normalized);
  return normalized;
}

async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function rejectTargetSymlinks(root, segments) {
  let current = root;
  for (const segment of [undefined, ...segments]) {
    if (segment !== undefined) current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`symlinked workflow target: ${current}`);
      }
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }
}

async function isDirectExecution(candidate) {
  if (!candidate) return false;
  let candidatePath;
  try {
    candidatePath = await realpath(candidate);
  } catch {
    return false;
  }
  return candidatePath === (await realpath(fileURLToPath(import.meta.url)));
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
  let profile;
  try {
    profile = JSON.parse(await readFile(profilePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `${options.platform} profile workflow-source/platforms/${options.platform}.json: invalid JSON: ${error.message}`,
      );
    }
    throw error;
  }
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
    throw new Error(
      `${options.platform}: unused profile keys: ${unused.join(", ")}`,
    );
  }

  for (const skill of actualSkills) {
    await rejectTargetSymlinks(targetRoot, [
      ...targetPrefix[options.platform].split("/"),
      skill,
      "SKILL.md",
    ]);
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

if (await isDirectExecution(process.argv[1])) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
}
