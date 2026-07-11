import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PackagedAsset } from "./assets.js";
import { sha256 } from "./assets.js";
import {
  atomicWrite,
  manifestPath,
  readManifest,
  writeManifest,
} from "./manifest.js";
import type { InstallTarget } from "./paths.js";

export class AssetConflictError extends Error {
  constructor(path: string) {
    super(`Refusing to modify unowned or changed asset: ${path}`);
    this.name = "AssetConflictError";
  }
}

async function currentHash(path: string): Promise<string | undefined> {
  try {
    return sha256(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function removeEmptyParents(path: string, root: string) {
  let parent = dirname(path);
  while (parent !== root && parent.startsWith(`${root}/`)) {
    try {
      await rm(parent, { recursive: false });
    } catch {
      break;
    }
    parent = dirname(parent);
  }
}

export async function installAssets(input: {
  target: InstallTarget;
  assets: PackagedAsset[];
  packageVersion: string;
  dryRun: boolean;
}): Promise<{ written: string[]; removed: string[]; unchanged: string[] }> {
  const prior = await readManifest(input.target.root);
  const owned = new Map(prior?.files.map((file) => [file.path, file.sha256]));
  const next = new Set<string>(
    input.assets.map((asset) => asset.relativeTarget),
  );
  const result = {
    written: [] as string[],
    removed: [] as string[],
    unchanged: [] as string[],
  };

  for (const asset of input.assets) {
    const target = join(input.target.root, asset.relativeTarget);
    const current = await currentHash(target);
    const expected = owned.get(asset.relativeTarget);
    if (current === asset.sha256) result.unchanged.push(asset.relativeTarget);
    else {
      if (
        current !== undefined &&
        (expected === undefined || current !== expected)
      )
        throw new AssetConflictError(target);
      result.written.push(asset.relativeTarget);
    }
  }
  for (const [path, expected] of owned) {
    if (next.has(path)) continue;
    const target = join(input.target.root, path);
    const current = await currentHash(target);
    if (current !== undefined && current !== expected)
      throw new AssetConflictError(target);
    if (current !== undefined) result.removed.push(path);
  }
  if (input.dryRun) return result;
  for (const path of result.removed) {
    const target = join(input.target.root, path);
    await rm(target);
    await removeEmptyParents(target, input.target.root);
  }
  for (const path of result.written) {
    const asset = input.assets.find(
      (candidate) => candidate.relativeTarget === path,
    );
    if (asset === undefined) throw new Error(`Missing planned asset: ${path}`);
    await atomicWrite(
      join(input.target.root, path),
      await readFile(asset.source),
    );
  }
  await writeManifest(input.target.root, {
    schemaVersion: 1,
    packageVersion: input.packageVersion,
    files: input.assets.map(({ relativeTarget: path, sha256 }) => ({
      path,
      sha256,
    })),
  });
  return result;
}

export async function uninstallAssets(input: {
  target: InstallTarget;
  dryRun: boolean;
}) {
  const manifest = await readManifest(input.target.root);
  const removed: string[] = [];
  for (const file of manifest?.files ?? []) {
    const target = join(input.target.root, file.path);
    const current = await currentHash(target);
    if (current === undefined) continue;
    if (current !== file.sha256) throw new AssetConflictError(target);
    removed.push(file.path);
  }
  if (!input.dryRun) {
    for (const path of removed) {
      const target = join(input.target.root, path);
      await rm(target);
      await removeEmptyParents(target, input.target.root);
    }
    await rm(manifestPath(input.target.root), { force: true });
    await removeEmptyParents(
      manifestPath(input.target.root),
      input.target.root,
    );
  }
  return { removed };
}
