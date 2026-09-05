import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findGitRoot } from "./config.js";

const execFileAsync = promisify(execFile);

export type PrForge = "github" | "gitcode";

export type PrTargetClassification =
  | { kind: "pr"; forge: PrForge }
  | { kind: "legacy" }
  | { kind: "error"; message: string };

const FORGE_HOSTS: Record<string, PrForge> = {
  "github.com": "github",
  "www.github.com": "github",
  "gitcode.com": "gitcode",
  "www.gitcode.com": "gitcode",
};

// scp-like: `git@host:path` or `host:path`
const SCP_LIKE_REMOTE = /^[^@/\s]+@([^:\s]+):/;
// absolute URLs: `scheme://[user@]host[:port]/...`
const ABSOLUTE_REMOTE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/\s]+@)?([^:/\s]+)/;
const BARE_PR_NUMBER = /^#?([1-9][0-9]*)$/;

export function hostFromRemoteUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (trimmed.length === 0) return undefined;
  const absolute = ABSOLUTE_REMOTE.exec(trimmed);
  if (absolute?.[1] !== undefined) return absolute[1].toLowerCase();
  // A Windows drive letter or relative path must not look like an SCP host.
  if (
    /^[A-Za-z]:/.test(trimmed) ||
    trimmed.startsWith("/") ||
    trimmed.startsWith(".")
  )
    return undefined;
  const scp = SCP_LIKE_REMOTE.exec(trimmed);
  if (scp?.[1] !== undefined) return scp[1].toLowerCase();
  const bareHost = /^([^:/\s]+):/.exec(trimmed);
  return bareHost?.[1]?.toLowerCase();
}

export function remoteUrlsFromVerboseOutput(output: string): string[] {
  const urls: string[] = [];
  for (const line of output.split("\n")) {
    const match = /^\S+\t(\S+)\s+\((?:fetch|push)\)$/.exec(line.trim());
    if (match?.[1] !== undefined) urls.push(match[1]);
  }
  return urls;
}

function forgeFromTargetUrl(target: string): PrForge | "other" | undefined {
  try {
    const url = new URL(target);
    const host = url.hostname.toLowerCase();
    const forge = FORGE_HOSTS[host];
    if (forge !== undefined) return forge;
    return "other";
  } catch {
    return undefined;
  }
}

function urlPathIsPullRequest(target: string): boolean {
  try {
    const path = new URL(target).pathname;
    return /\/pull(s)?(\/|$|\?)/i.test(path);
  } catch {
    return false;
  }
}

function forgeFromRemoteUrls(urls: string[]): PrForge | undefined {
  let forge: PrForge | undefined;
  for (const url of urls) {
    const host = hostFromRemoteUrl(url);
    const current = host === undefined ? undefined : FORGE_HOSTS[host];
    if (current === undefined) return undefined;
    if (forge === undefined) forge = current;
    else if (forge !== current) return undefined;
  }
  return forge;
}

export function classifyPrTarget(
  target: string,
  remoteUrls: string[],
): PrTargetClassification {
  const trimmed = target.trim();
  if (trimmed.length === 0)
    return {
      kind: "error",
      message: "Cannot classify cross-review target: empty target",
    };

  const urlForge = forgeFromTargetUrl(trimmed);
  if (urlForge !== undefined) {
    if (urlForge === "other") return { kind: "legacy" };
    if (!urlPathIsPullRequest(trimmed)) return { kind: "legacy" };
    return { kind: "pr", forge: urlForge };
  }

  // Git ranges never use the snapshot path, regardless of remotes.
  if (trimmed.includes("..")) return { kind: "legacy" };

  const bare = BARE_PR_NUMBER.exec(trimmed);
  if (bare !== null) {
    const forge = forgeFromRemoteUrls(remoteUrls);
    if (forge === undefined) {
      const hosts = Array.from(
        new Set(
          remoteUrls
            .map((url) => hostFromRemoteUrl(url))
            .filter((host): host is string => host !== undefined),
        ),
      );
      const detail =
        hosts.length === 0
          ? "no git remotes were found"
          : `git remotes are neither clearly GitHub nor GitCode (${hosts.join(", ")})`;
      return {
        kind: "error",
        message: `Cannot classify cross-review target "${trimmed}" as a pull request: ${detail}. Pass a GitHub or GitCode pull request URL, or an explicit issue URL / git range.`,
      };
    }
    return { kind: "pr", forge };
  }

  return { kind: "legacy" };
}

export async function remoteUrlsInRepository(
  directory: string,
): Promise<string[]> {
  const gitRoot = await findGitRoot(directory);
  if (gitRoot === undefined) return [];
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", gitRoot, "remote", "-v"],
      { encoding: "utf8", timeout: 10_000 },
    );
    return remoteUrlsFromVerboseOutput(stdout);
  } catch {
    return [];
  }
}

export async function classifyPrTargetInRepository(
  target: string,
  directory: string,
): Promise<PrTargetClassification> {
  const direct = classifyPrTarget(target, []);
  if (direct.kind !== "legacy") return direct;
  // Only a bare PR number depends on the repository remotes; every other
  // legacy target (git ranges, refs, non-forge URLs) needs no inspection.
  if (!/^#?[0-9]+$/.test(target.trim())) return { kind: "legacy" };
  return classifyPrTarget(target, await remoteUrlsInRepository(directory));
}
