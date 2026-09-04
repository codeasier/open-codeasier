import { execFile } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GITCODE_INSTALL_URL = "https://github.com/codeasier/gitcode-cli";

export type GitcodeCliDiscovery = {
  platform: NodeJS.Platform;
  pathEnv: string | undefined;
  pathDelimiter: string;
  home: string;
  isFile(path: string): Promise<boolean>;
  listDir(path: string): Promise<string[]>;
  versionOutput(path: string): Promise<string>;
  resolvePath(path: string): Promise<string>;
};

export function isGitcodeCliPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isAbsolute(value);
}

function commandNames(platform: NodeJS.Platform): {
  gitcode: string[];
  gc: string[];
} {
  if (platform === "win32")
    return { gitcode: ["gitcode.exe", "gitcode"], gc: ["gc.exe", "gc"] };
  return { gitcode: ["gitcode"], gc: ["gc"] };
}

function condaBinDir(platform: NodeJS.Platform): string {
  return platform === "win32" ? "Scripts" : "bin";
}

async function defaultIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM")
      return false;
    throw error;
  }
}

async function defaultListDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "ENOTDIR") return [];
    throw error;
  }
}

async function defaultVersionOutput(path: string): Promise<string> {
  try {
    const result = await execFileAsync(path, ["--version"], {
      timeout: 5_000,
      encoding: "utf8",
    });
    return `${result.stdout}\n${result.stderr}`;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`;
  }
}

function looksLikeGitcode(output: string): boolean {
  return output.toLowerCase().includes("gitcode");
}

async function condaDirectories(
  discovery: GitcodeCliDiscovery,
): Promise<string[]> {
  const bin = condaBinDir(discovery.platform);
  const roots = ["miniconda3", "anaconda3"].map((name) =>
    join(discovery.home, name),
  );
  const directories = roots.map((root) => join(root, bin));
  for (const root of roots) {
    const envRoot = join(root, "envs");
    for (const env of await discovery.listDir(envRoot))
      directories.push(join(envRoot, env, bin));
  }
  return directories;
}

async function collectCandidates(
  discovery: GitcodeCliDiscovery,
): Promise<string[]> {
  const names = commandNames(discovery.platform);
  const pathDirs = (discovery.pathEnv ?? "")
    .split(discovery.pathDelimiter)
    .filter((directory) => directory.length > 0);
  const condaDirs = await condaDirectories(discovery);
  const candidates: string[] = [];
  for (const name of names.gitcode)
    for (const directory of pathDirs) candidates.push(join(directory, name));
  for (const name of names.gc)
    for (const directory of pathDirs) candidates.push(join(directory, name));
  for (const name of names.gitcode)
    for (const directory of condaDirs) candidates.push(join(directory, name));
  for (const name of names.gc)
    for (const directory of condaDirs) candidates.push(join(directory, name));
  return candidates;
}

export async function discoverGitcodeCli(
  overrides: Partial<GitcodeCliDiscovery> = {},
): Promise<string | undefined> {
  const discovery: GitcodeCliDiscovery = {
    platform: process.platform,
    pathEnv: process.env.PATH,
    pathDelimiter: delimiter,
    home: osHomedir(),
    isFile: defaultIsFile,
    listDir: defaultListDir,
    versionOutput: defaultVersionOutput,
    resolvePath: (path) => realpath(path),
    ...overrides,
  };
  const seen = new Set<string>();
  for (const candidate of await collectCandidates(discovery)) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (!(await discovery.isFile(candidate))) continue;
    if (!looksLikeGitcode(await discovery.versionOutput(candidate))) continue;
    try {
      return await discovery.resolvePath(candidate);
    } catch {
      continue;
    }
  }
  return undefined;
}
