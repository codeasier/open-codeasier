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
// `#123`, `123`, `PR#123`, `pr #123`, `PR 123`. Not `PR123` or `pr-123`.
const BARE_PR_NUMBER = /^(?:pr(?:\s*#|\s+)|#)?([1-9][0-9]*)$/i;

export function barePrNumber(target: string): string | undefined {
  return BARE_PR_NUMBER.exec(target.trim())?.[1];
}

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

export type GitRemote = { name: string; url: string };

type ParsedRemoteLine = GitRemote & { kind: "fetch" | "push" };

const FETCH_SUFFIX = " (fetch)";
const PUSH_SUFFIX = " (push)";
// Git prints a partial-clone filter after the fetch marker, e.g. ` (fetch) [blob:none]`.
const PARTIAL_CLONE_ANNOTATION = /^ \[[^\]]*\]$/;

function verboseSuffixIndex(rest: string, suffix: string): number | undefined {
  const at = rest.lastIndexOf(suffix);
  if (at < 0) return undefined;
  const after = rest.slice(at + suffix.length);
  if (after.length === 0 || PARTIAL_CLONE_ANNOTATION.test(after)) return at;
  return undefined;
}

/**
 * Parse one `git remote -v` line. The URL is the text between the name's
 * trailing tab and the ` (fetch)` / ` (push)` marker, so local paths that
 * contain spaces are preserved. A partial-clone annotation after `(fetch)`
 * stays outside the URL.
 */
function parseRemoteVerboseLine(line: string): ParsedRemoteLine | undefined {
  const trimmed = line.trim();
  const tab = trimmed.indexOf("\t");
  if (tab <= 0) return undefined;
  const name = trimmed.slice(0, tab);
  const rest = trimmed.slice(tab + 1);
  const fetchAt = verboseSuffixIndex(rest, FETCH_SUFFIX);
  const pushAt = verboseSuffixIndex(rest, PUSH_SUFFIX);
  let kind: ParsedRemoteLine["kind"] | undefined;
  let at: number | undefined;
  if (fetchAt !== undefined && (pushAt === undefined || fetchAt > pushAt)) {
    kind = "fetch";
    at = fetchAt;
  } else if (pushAt !== undefined) {
    kind = "push";
    at = pushAt;
  }
  if (kind === undefined || at === undefined) return undefined;
  const url = rest.slice(0, at);
  if (name.length === 0 || url.length === 0) return undefined;
  return { name, url, kind };
}

export function remoteUrlsFromVerboseOutput(output: string): string[] {
  const urls: string[] = [];
  for (const line of output.split("\n")) {
    const parsed = parseRemoteVerboseLine(line);
    if (parsed !== undefined) urls.push(parsed.url);
  }
  return urls;
}

export function remotesFromVerboseOutput(output: string): GitRemote[] {
  const byName = new Map<string, string>();
  for (const line of output.split("\n")) {
    const parsed = parseRemoteVerboseLine(line);
    if (parsed === undefined) continue;
    // Fetch URL is the one `git fetch` uses. Keep a push URL only when no
    // fetch line for that name has been seen yet, so a later push cannot
    // overwrite the pull identity.
    if (parsed.kind === "fetch" || !byName.has(parsed.name))
      byName.set(parsed.name, parsed.url);
  }
  return Array.from(byName, ([name, url]) => ({ name, url }));
}

function normalizeRepoSlug(owner: string, repo: string): string {
  const stripGit = (segment: string) => segment.replace(/\.git$/i, "");
  return `${stripGit(owner).toLowerCase()}/${stripGit(repo).toLowerCase()}`;
}

/** Owner/repo slug from a GitHub or GitCode pull request URL. */
export function repoSlugFromPrUrl(url: string): string | undefined {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const owner = parts[0];
    const repoName = parts[1];
    if (owner === undefined || repoName === undefined) return undefined;
    return normalizeRepoSlug(owner, repoName);
  } catch {
    return undefined;
  }
}

/** Owner/repo slug from a git remote URL (HTTPS or SCP-style). */
export function repoSlugFromRemoteUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (trimmed.length === 0) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parts = new URL(trimmed).pathname.split("/").filter(Boolean);
      const owner = parts[0];
      const repoName = parts[1];
      if (owner === undefined || repoName === undefined) return undefined;
      return normalizeRepoSlug(owner, repoName);
    } catch {
      return undefined;
    }
  }
  if (
    /^[A-Za-z]:/.test(trimmed) ||
    trimmed.startsWith("/") ||
    trimmed.startsWith(".")
  )
    return undefined;
  const colon = trimmed.indexOf(":");
  if (colon === -1) return undefined;
  const path = trimmed.slice(colon + 1);
  const segments = path.split("/").filter(Boolean);
  const owner = segments[0];
  const repoName = segments[1];
  if (owner === undefined || repoName === undefined) return undefined;
  return normalizeRepoSlug(owner, repoName);
}

function stripWww(host: string): string {
  return host.replace(/^www\./i, "");
}

function repoIdentityFromPrUrl(
  url: string,
): { host: string; slug: string } | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const slug = repoSlugFromPrUrl(url);
    if (host.length === 0 || slug === undefined) return undefined;
    return { host: stripWww(host), slug };
  } catch {
    return undefined;
  }
}

function repoIdentityFromRemoteUrl(
  url: string,
): { host: string; slug: string } | undefined {
  const host = hostFromRemoteUrl(url);
  const slug = repoSlugFromRemoteUrl(url);
  if (host === undefined || slug === undefined) return undefined;
  return { host: stripWww(host), slug };
}

function sameRepoIdentity(
  left: { host: string; slug: string } | undefined,
  right: { host: string; slug: string } | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.host === right.host &&
    left.slug === right.slug
  );
}

/**
 * Order git remote names for PR commit fetches: the remote whose host and
 * owner/repo match the PR repository first, then `upstream`, then `origin`,
 * then others.
 */
export function orderFetchRemotesForPr(
  remotes: GitRemote[],
  prUrl: string,
): string[] {
  if (remotes.length === 0) return ["origin"];
  const prIdentity = repoIdentityFromPrUrl(prUrl);
  const rank = (name: string, remoteUrl: string): number => {
    if (sameRepoIdentity(prIdentity, repoIdentityFromRemoteUrl(remoteUrl)))
      return 0;
    if (name === "upstream") return 1;
    if (name === "origin") return 2;
    return 3;
  };
  return [...remotes]
    .sort((left, right) => {
      const byRank = rank(left.name, left.url) - rank(right.name, right.url);
      return byRank !== 0 ? byRank : left.name.localeCompare(right.name);
    })
    .map((remote) => remote.name);
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

  const bare = barePrNumber(trimmed);
  if (bare !== undefined) {
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
  // Only a bare PR number depends on the repository remotes; every other
  // target (URLs, git ranges, refs) classifies without inspecting them.
  if (barePrNumber(target) !== undefined)
    return classifyPrTarget(target, await remoteUrlsInRepository(directory));
  return classifyPrTarget(target, []);
}
