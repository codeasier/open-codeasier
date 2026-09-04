import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isGitcodeCliPath } from "./gitcode-cli.js";

export const MODEL_ID = /^[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*$/;

export type CrossReviewReviewer = {
  model: string;
  focus?: string;
};

export type CrossReviewConfig = {
  reviewers?: CrossReviewReviewer[];
  reviewModels?: string[];
  agents?: number;
  maxConcurrency?: number;
  judgeModel?: string;
  focus?: string;
  reviewerTimeoutMs?: number;
  gitcodeCli?: string;
};

export type CrossReviewConfigSource = "loaded" | "absent";

export type CrossReviewConfigSources = {
  project: CrossReviewConfigSource;
  global: CrossReviewConfigSource;
};

export type LoadedCrossReviewConfig = {
  config: CrossReviewConfig;
  sources: CrossReviewConfigSources;
  projectPath: string;
  globalPath: string;
};

const CONFIG_KEYS = [
  "reviewers",
  "reviewModels",
  "agents",
  "maxConcurrency",
  "judgeModel",
  "focus",
  "reviewerTimeoutMs",
  "gitcodeCli",
] as const;

function invalid(source: string, message: string): never {
  throw new Error(`Invalid cross-review config ${source}: ${message}`);
}

function isModel(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID.test(value);
}

function isBound(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 8
  );
}

function isReviewerTimeoutMs(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 5_000 &&
    value <= 3_600_000
  );
}

function isReviewers(value: unknown): value is CrossReviewReviewer[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 8 &&
    value.every((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const record = entry as Record<string, unknown>;
      return (
        isModel(record.model) &&
        (record.focus === undefined || typeof record.focus === "string")
      );
    })
  );
}

function isModelList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 8 &&
    value.every(isModel)
  );
}

/**
 * Enforce the loader's bounds on per-invocation tool overrides so an
 * out-of-range value fails fast even when the host skips tool-schema
 * validation.
 */
export function validateCrossReviewOverrides(overrides: {
  reviewModels?: string[] | undefined;
  agents?: number | undefined;
  maxConcurrency?: number | undefined;
  reviewerTimeoutMs?: number | undefined;
}): void {
  if (
    overrides.reviewModels !== undefined &&
    !isModelList(overrides.reviewModels)
  )
    throw new Error("`reviewModels` must be 1-8 `provider/model` identifiers");
  if (overrides.agents !== undefined && !isBound(overrides.agents))
    throw new Error("`agents` must be an integer from 1 to 8");
  if (
    overrides.maxConcurrency !== undefined &&
    !isBound(overrides.maxConcurrency)
  )
    throw new Error("`maxConcurrency` must be an integer from 1 to 8");
  if (
    overrides.reviewerTimeoutMs !== undefined &&
    !isReviewerTimeoutMs(overrides.reviewerTimeoutMs)
  )
    throw new Error(
      "`reviewerTimeoutMs` must be an integer from 5000 to 3600000",
    );
}

export function parseCrossReviewConfig(
  source: string,
  raw: unknown,
): CrossReviewConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    invalid(source, "expected a JSON object");
  const config = raw as Record<string, unknown>;
  const unknown = Object.keys(config).filter(
    (key) => !(CONFIG_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0)
    invalid(source, `unknown keys: ${unknown.join(", ")}`);
  if (config.reviewers !== undefined && config.reviewModels !== undefined)
    invalid(source, "use only one of `reviewers` or `reviewModels`");
  if (config.reviewers !== undefined && !isReviewers(config.reviewers))
    invalid(source, '`reviewers` must be 1-8 `{ "model", "focus"? }` entries');
  if (config.reviewModels !== undefined && !isModelList(config.reviewModels))
    invalid(source, "`reviewModels` must be 1-8 `provider/model` identifiers");
  if (config.agents !== undefined && !isBound(config.agents))
    invalid(source, "`agents` must be an integer from 1 to 8");
  if (config.maxConcurrency !== undefined && !isBound(config.maxConcurrency))
    invalid(source, "`maxConcurrency` must be an integer from 1 to 8");
  if (config.judgeModel !== undefined && !isModel(config.judgeModel))
    invalid(source, "`judgeModel` must be a `provider/model` identifier");
  if (config.focus !== undefined && typeof config.focus !== "string")
    invalid(source, "`focus` must be a string");
  if (
    config.reviewerTimeoutMs !== undefined &&
    !isReviewerTimeoutMs(config.reviewerTimeoutMs)
  )
    invalid(
      source,
      "`reviewerTimeoutMs` must be an integer from 5000 to 3600000",
    );
  if (config.gitcodeCli !== undefined && !isGitcodeCliPath(config.gitcodeCli))
    invalid(source, "`gitcodeCli` must be an absolute path");

  const parsed: CrossReviewConfig = {};
  if (config.reviewers !== undefined) parsed.reviewers = config.reviewers;
  if (config.reviewModels !== undefined)
    parsed.reviewModels = config.reviewModels;
  if (config.agents !== undefined) parsed.agents = config.agents;
  if (config.maxConcurrency !== undefined)
    parsed.maxConcurrency = config.maxConcurrency;
  if (config.judgeModel !== undefined) parsed.judgeModel = config.judgeModel;
  if (config.focus !== undefined) parsed.focus = config.focus;
  if (config.reviewerTimeoutMs !== undefined)
    parsed.reviewerTimeoutMs = config.reviewerTimeoutMs;
  if (isGitcodeCliPath(config.gitcodeCli))
    parsed.gitcodeCli = config.gitcodeCli;
  return parsed;
}

export const projectConfigPath = (directory: string) =>
  join(directory, ".opencode", "cross-review.json");

export const globalConfigPath = (home: string) =>
  join(home, ".config", "opencode", "cross-review.json");

/**
 * Locate the nearest enclosing repository or linked-worktree root.
 * Returns `undefined` outside a repository.
 */
export async function findGitRoot(
  directory: string,
): Promise<string | undefined> {
  let current = directory;
  while (true) {
    try {
      const status = await stat(join(current, ".git"));
      if (status.isDirectory() || status.isFile()) return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function findSharedGitRoot(repositoryRoot: string): Promise<string> {
  const gitEntry = join(repositoryRoot, ".git");
  if (!(await stat(gitEntry)).isFile()) return repositoryRoot;
  const match = /^gitdir:\s*(.+)\s*$/m.exec(await readFile(gitEntry, "utf8"));
  if (match?.[1] === undefined) return repositoryRoot;
  const gitDirectory = resolve(repositoryRoot, match[1]);
  try {
    const commonDirectory = resolve(
      gitDirectory,
      (await readFile(join(gitDirectory, "commondir"), "utf8")).trim(),
    );
    return basename(commonDirectory) === ".git"
      ? dirname(commonDirectory)
      : repositoryRoot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return repositoryRoot;
    throw error;
  }
}

async function readConfigContent(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError)
      throw new Error(`Invalid JSON in ${path}: ${error.message}`);
    throw error;
  }
}

async function configExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Resolve the project config path the way `loadCrossReviewConfig` reads
 * it: the enclosing repository root, falling back to the shared
 * repository root when a linked worktree has no own config.
 */
export async function resolveProjectConfigPath(
  directory: string,
): Promise<string> {
  const enclosingGitRoot = await findGitRoot(directory);
  const gitRoot = enclosingGitRoot ?? directory;
  const ownPath = projectConfigPath(gitRoot);
  if (enclosingGitRoot === undefined) return ownPath;
  if (await configExists(ownPath)) return ownPath;
  const sharedGitRoot = await findSharedGitRoot(gitRoot);
  return sharedGitRoot === gitRoot ? ownPath : projectConfigPath(sharedGitRoot);
}

export async function loadCrossReviewConfig(
  directory: string,
  home = homedir(),
): Promise<LoadedCrossReviewConfig> {
  const projectPath = await resolveProjectConfigPath(directory);
  const globalPath = globalConfigPath(home);

  const projectRaw = await readConfigContent(projectPath);
  const globalRaw = await readConfigContent(globalPath);

  const project: CrossReviewConfig | undefined =
    projectRaw === undefined
      ? undefined
      : parseCrossReviewConfig(projectPath, projectRaw);
  const global: CrossReviewConfig | undefined =
    globalRaw === undefined
      ? undefined
      : parseCrossReviewConfig(globalPath, globalRaw);

  let config: CrossReviewConfig;
  if (project !== undefined && global !== undefined) {
    const merged: CrossReviewConfig = { ...global };
    if (project.reviewers !== undefined) {
      merged.reviewers = project.reviewers;
      delete merged.reviewModels;
    }
    if (project.reviewModels !== undefined) {
      merged.reviewModels = project.reviewModels;
      delete merged.reviewers;
    }
    if (project.agents !== undefined) merged.agents = project.agents;
    if (project.maxConcurrency !== undefined)
      merged.maxConcurrency = project.maxConcurrency;
    if (project.judgeModel !== undefined)
      merged.judgeModel = project.judgeModel;
    if (project.focus !== undefined) merged.focus = project.focus;
    if (project.reviewerTimeoutMs !== undefined)
      merged.reviewerTimeoutMs = project.reviewerTimeoutMs;
    if (project.gitcodeCli !== undefined)
      merged.gitcodeCli = project.gitcodeCli;
    config = merged;
  } else if (project !== undefined) {
    config = project;
  } else if (global !== undefined) {
    config = global;
  } else {
    config = {};
  }

  return {
    config,
    sources: {
      project: projectRaw === undefined ? "absent" : "loaded",
      global: globalRaw === undefined ? "absent" : "loaded",
    },
    projectPath,
    globalPath,
  };
}
