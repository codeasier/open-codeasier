import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256, type PackagedAsset } from "./assets.js";

export const CROSS_REVIEW_SKILL_ASSET = "skills/cross-review/SKILL.md";
export const CROSS_REVIEW_SKILL_NAME = "cross-review";

export function agentsSkillPath(
  home: string,
  name = CROSS_REVIEW_SKILL_NAME,
): string {
  return join(home, ".agents", "skills", name);
}

export class ShadowSkillError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(
      `Shadow skill outside package-owned paths: ${path}. npx open-codeasier install does not update ~/.agents. Remove or replace it with the packaged ${CROSS_REVIEW_SKILL_ASSET}, then rerun.`,
    );
    this.name = "ShadowSkillError";
    this.path = path;
  }
}

export function packagedSkillHash(
  assets: PackagedAsset[],
  relativeTarget: PackagedAsset["relativeTarget"] = CROSS_REVIEW_SKILL_ASSET,
): string {
  const asset = assets.find((item) => item.relativeTarget === relativeTarget);
  if (asset === undefined)
    throw new Error(`Packaged asset missing: ${relativeTarget}`);
  return asset.sha256;
}

export async function findConflictingShadowSkill(input: {
  home: string;
  expectedSha256: string;
  name?: string;
}): Promise<string | undefined> {
  const path = agentsSkillPath(input.home, input.name);
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const contents = await readFile(join(path, "SKILL.md"));
    if (sha256(contents) === input.expectedSha256) return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
  return path;
}

export async function rejectConflictingShadowSkill(input: {
  home: string;
  expectedSha256: string;
  name?: string;
}): Promise<void> {
  const path = await findConflictingShadowSkill(input);
  if (path !== undefined) throw new ShadowSkillError(path);
}
