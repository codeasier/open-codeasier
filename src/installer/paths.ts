import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type InstallTarget = { root: string; scope: "global" | "project" };

export function resolveTarget(input: {
  home?: string;
  project?: string;
}): InstallTarget {
  if (input.project !== undefined) {
    return {
      root: join(resolve(input.project), ".opencode"),
      scope: "project",
    };
  }
  return {
    root: join(input.home ?? homedir(), ".config", "opencode"),
    scope: "global",
  };
}
