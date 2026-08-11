#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findGitRoot } from "./cross-review/config.js";
import {
  CrossReviewConfigConflictError,
  initializeCrossReviewConfig,
} from "./cross-review/init.js";
import { discoverAssets } from "./installer/assets.js";
import {
  AssetConflictError,
  installAssets,
  uninstallAssets,
} from "./installer/install.js";
import { resolveTarget } from "./installer/paths.js";

export function runtimePluginInstallCommand(
  packageVersion: string,
  scope: "global" | "project",
): string {
  return `opencode plugin open-codeasier@${packageVersion}${scope === "global" ? " --global" : ""} --force`;
}

export async function run(argv: string[]): Promise<number> {
  const command = argv.shift();
  if (command === "init") {
    let requestedScope: "local" | "global" | undefined;
    let project: string | undefined;
    let dryRun = false;
    while (argv.length) {
      const option = argv.shift();
      if (option === "--dry-run") dryRun = true;
      else if (option === "--global" && requestedScope === undefined)
        requestedScope = "global";
      else if (option === "--local" && requestedScope === undefined)
        requestedScope = "local";
      else if (
        option !== undefined &&
        !option.startsWith("--") &&
        project === undefined
      )
        project = option;
      else return 2;
    }
    const scope = requestedScope ?? "local";
    if (scope === "global" && project !== undefined) return 2;
    const requestedProject = resolve(project ?? ".");
    const target =
      scope === "global"
        ? resolveTarget({})
        : resolveTarget({
            project: (await findGitRoot(requestedProject)) ?? requestedProject,
          });
    try {
      const result = await initializeCrossReviewConfig({ target, dryRun });
      console.log(
        `${dryRun ? "would-initialize" : "initialized"}: ${result.path}`,
      );
      return 0;
    } catch (error) {
      if (error instanceof CrossReviewConfigConflictError) {
        console.error(error.message);
        return 1;
      }
      throw error;
    }
  }
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
    if (command === "install") {
      const packageVersion = JSON.parse(
        await readFile(
          resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"),
          "utf8",
        ),
      ).version as string;
      const result = await installAssets({
        target,
        assets: await discoverAssets(),
        packageVersion,
        dryRun,
      });
      for (const [operation, paths] of Object.entries(result))
        for (const path of paths)
          console.log(`${dryRun ? "would-" : ""}${operation}: ${path}`);
      if (target.scope === "project")
        console.log(`runtime-plugin-cwd: ${dirname(target.root)}`);
      console.log(
        `runtime-plugin: ${runtimePluginInstallCommand(packageVersion, target.scope)}`,
      );
    } else {
      const result = await uninstallAssets({ target, dryRun });
      for (const [operation, paths] of Object.entries(result))
        for (const path of paths)
          console.log(`${dryRun ? "would-" : ""}${operation}: ${path}`);
    }
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
