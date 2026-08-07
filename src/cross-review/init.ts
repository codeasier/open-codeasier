import { lstat, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { InstallTarget } from "../installer/paths.js";

export const CROSS_REVIEW_CONFIG_TEMPLATE = `${JSON.stringify(
  {
    reviewers: [
      {
        model: "provider/reviewer-model-1",
        focus: "correctness, behavioral regressions, and missing tests",
      },
      {
        model: "provider/reviewer-model-2",
        focus: "security, permissions, and abuse cases",
      },
      {
        model: "provider/reviewer-model-3",
        focus: "performance, concurrency, and maintainability",
      },
    ],
    judgeModel: "provider/judge-model",
    maxConcurrency: 3,
  },
  null,
  2,
)}\n`;

export class CrossReviewConfigConflictError extends Error {
  constructor(path: string) {
    super(`Refusing to overwrite existing or unsafe path: ${path}`);
    this.name = "CrossReviewConfigConflictError";
  }
}

async function rejectExistingOrUnsafe(path: string): Promise<void> {
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isDirectory())
      throw new CrossReviewConfigConflictError(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function initializeCrossReviewConfig(input: {
  target: InstallTarget;
  dryRun: boolean;
}): Promise<{ path: string; scope: InstallTarget["scope"] }> {
  const path = join(input.target.root, "cross-review.json");
  await rejectExistingOrUnsafe(input.target.root);
  try {
    await lstat(path);
    throw new CrossReviewConfigConflictError(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (input.dryRun) return { path, scope: input.target.scope };

  await mkdir(input.target.root, { recursive: true });
  await rejectExistingOrUnsafe(input.target.root);
  let handle;
  try {
    handle = await open(path, "wx");
    await handle.writeFile(CROSS_REVIEW_CONFIG_TEMPLATE);
    await handle.close();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (handle !== undefined) await rm(path, { force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new CrossReviewConfigConflictError(path);
    throw error;
  }
  return { path, scope: input.target.scope };
}
