#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAssets } from "./installer/assets.js";
import {
  AssetConflictError,
  installAssets,
  uninstallAssets,
} from "./installer/install.js";
import { resolveTarget } from "./installer/paths.js";

export async function run(argv: string[]): Promise<number> {
  const command = argv.shift();
  if (command !== "install" && command !== "uninstall") return 2;
  let project: string | undefined;
  let dryRun = false;
  while (argv.length) {
    const option = argv.shift();
    if (option === "--dry-run") dryRun = true;
    else if (option === "--project" && argv[0] !== undefined)
      project = argv.shift();
    else return 2;
  }
  const target = resolveTarget(project === undefined ? {} : { project });
  try {
    const result =
      command === "install"
        ? await installAssets({
            target,
            assets: await discoverAssets(),
            packageVersion: JSON.parse(
              await readFile(
                resolve(
                  dirname(fileURLToPath(import.meta.url)),
                  "../package.json",
                ),
                "utf8",
              ),
            ).version as string,
            dryRun,
          })
        : await uninstallAssets({ target, dryRun });
    for (const [operation, paths] of Object.entries(result))
      for (const path of paths)
        console.log(`${dryRun ? "would-" : ""}${operation}: ${path}`);
    return 0;
  } catch (error) {
    if (error instanceof AssetConflictError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await run(process.argv.slice(2));
