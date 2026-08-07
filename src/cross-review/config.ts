import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const MODEL_ID = /^[^/\s]+\/[^/\s]+$/;

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
};

const CONFIG_KEYS = [
  "reviewers",
  "reviewModels",
  "agents",
  "maxConcurrency",
  "judgeModel",
  "focus",
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

  const parsed: CrossReviewConfig = {};
  if (config.reviewers !== undefined) parsed.reviewers = config.reviewers;
  if (config.reviewModels !== undefined)
    parsed.reviewModels = config.reviewModels;
  if (config.agents !== undefined) parsed.agents = config.agents;
  if (config.maxConcurrency !== undefined)
    parsed.maxConcurrency = config.maxConcurrency;
  if (config.judgeModel !== undefined) parsed.judgeModel = config.judgeModel;
  if (config.focus !== undefined) parsed.focus = config.focus;
  return parsed;
}

export const projectConfigPath = (directory: string) =>
  join(directory, ".opencode", "cross-review.json");

export const globalConfigPath = (home: string) =>
  join(home, ".config", "opencode", "cross-review.json");

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

export async function loadCrossReviewConfig(
  directory: string,
  home = homedir(),
): Promise<CrossReviewConfig> {
  const projectPath = projectConfigPath(directory);
  const globalPath = globalConfigPath(home);
  const projectRaw = await readConfigContent(projectPath);
  const project =
    projectRaw === undefined
      ? undefined
      : parseCrossReviewConfig(projectPath, projectRaw);
  const globalRaw = await readConfigContent(globalPath);
  const global =
    globalRaw === undefined
      ? undefined
      : parseCrossReviewConfig(globalPath, globalRaw);
  if (project === undefined) return global ?? {};
  if (global === undefined) return project;

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
  if (project.judgeModel !== undefined) merged.judgeModel = project.judgeModel;
  if (project.focus !== undefined) merged.focus = project.focus;
  return merged;
}
