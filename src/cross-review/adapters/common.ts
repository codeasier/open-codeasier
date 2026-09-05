import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PR_VIEW_JSON_FIELDS =
  "number,url,title,body,baseRefName,headRefName,baseRefOid,headRefOid";

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

// Matches the outer spawn limit in pr-gather.ts: `git diff` output can far
// exceed Node's 1MB default maxBuffer, and the overflow must reach the
// snapshot validator (not kill the child with an opaque spawn error).
const ADAPTER_MAX_BUFFER = 16 * 1024 * 1024;

export const defaultRunCommand: CommandRunner = (command, args, options) =>
  execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: ADAPTER_MAX_BUFFER,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });

export type AdapterFlags = {
  repo: string;
  target: string;
  worktree: string;
  snapshot: string;
  notes?: string;
};

export type ParsedAdapterFlags =
  | { ok: true; flags: AdapterFlags }
  | { ok: false; error: string };

const FLAG_KEYS = ["repo", "target", "worktree", "snapshot", "notes"] as const;

type FlagKey = (typeof FLAG_KEYS)[number];

function isFlagKey(key: string): key is FlagKey {
  return (FLAG_KEYS as readonly string[]).includes(key);
}

export function parseAdapterFlags(argv: string[]): ParsedAdapterFlags {
  const values: Partial<Record<FlagKey, string>> = {};
  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    const key = flag?.startsWith("--") ? flag.slice(2) : undefined;
    if (key === undefined || !isFlagKey(key))
      return { ok: false, error: `Unknown adapter flag: ${flag ?? "(empty)"}` };
    const value = argv[index + 1];
    if (value === undefined)
      return { ok: false, error: `Missing value for --${key}` };
    // Structural paths must not look like another flag; free-form note text
    // is accepted verbatim.
    if (key !== "notes" && value.startsWith("--"))
      return { ok: false, error: `Missing value for --${key}` };
    if (values[key] !== undefined)
      return { ok: false, error: `Duplicate flag --${key}` };
    values[key] = value;
    index += 2;
  }
  for (const required of ["repo", "target", "worktree", "snapshot"] as const)
    if (values[required] === undefined)
      return { ok: false, error: `Missing required flag --${required}` };
  return {
    ok: true,
    flags: {
      repo: values.repo as string,
      target: values.target as string,
      worktree: values.worktree as string,
      snapshot: values.snapshot as string,
      ...(values.notes === undefined ? {} : { notes: values.notes }),
    },
  };
}

export type PrViewFields = {
  number: number;
  url: string;
  title: string;
  body: string;
  baseRefName: string;
  headRefName: string;
  baseRefOid: string;
  headRefOid: string;
};

const SHA_40 = /^[0-9a-f]{40}$/i;

export function parsePrViewJson(raw: string, source: string): PrViewFields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${source} returned invalid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null)
    throw new Error(`${source} returned ${JSON.stringify(raw.slice(0, 200))}`);
  const view = parsed as Record<string, unknown>;
  if (
    typeof view.number !== "number" ||
    !Number.isInteger(view.number) ||
    view.number < 1
  )
    throw new Error(`${source} returned no pull request number`);
  for (const field of ["url", "title", "baseRefName", "headRefName"] as const) {
    if (typeof view[field] !== "string" || (view[field] as string).length === 0)
      throw new Error(`${source} returned no ${field}`);
  }
  for (const field of ["baseRefOid", "headRefOid"] as const) {
    const value = view[field];
    if (typeof value !== "string" || !SHA_40.test(value))
      throw new Error(
        `${source} returned an invalid ${field}: ${JSON.stringify(value)}`,
      );
  }
  return {
    number: view.number,
    url: view.url as string,
    title: view.title as string,
    body: typeof view.body === "string" ? view.body : "",
    baseRefName: view.baseRefName as string,
    headRefName: view.headRefName as string,
    baseRefOid: (view.baseRefOid as string).toLowerCase(),
    headRefOid: (view.headRefOid as string).toLowerCase(),
  };
}

/**
 * Normalize the target for `pr view`: URLs pass through untouched (the CLI
 * resolves the repository itself); bare `#123` / `123` targets reduce to the
 * plain number resolved against `--repo`.
 */
export function prViewTarget(target: string): string {
  const trimmed = target.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  const bare = /^#?(\d+)$/.exec(trimmed);
  return bare?.[1] ?? trimmed;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

export type MaterializeResult =
  | { ok: true; headSha: string; mergeBaseSha: string }
  | { ok: false; error: string };

export type MaterializeInput = {
  forge: "github" | "gitcode";
  repo: string;
  worktree: string;
  snapshot: string;
  target: string;
  notes?: string;
  view: PrViewFields;
  /** Extra refs to try fetching when the head SHA is not locally present. */
  headFetchRefs?: string[];
  runCommand: CommandRunner;
  fetchedAt?: string;
};

async function git(
  runCommand: CommandRunner,
  repo: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return runCommand("git", ["-C", repo, ...args], {});
}

async function commitPresent(
  runCommand: CommandRunner,
  repo: string,
  sha: string,
): Promise<boolean> {
  try {
    await git(runCommand, repo, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function ensureCommit(
  runCommand: CommandRunner,
  repo: string,
  sha: string,
  extraRefs: string[],
  label: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Ref names come from the PR view payload and are attacker-influenced;
  // a ref starting with `-` would be parsed as a git option (for example
  // `--upload-pack=<prog>`) instead of a refspec.
  const refs = [sha, ...extraRefs];
  for (const ref of refs) {
    if (ref.startsWith("-"))
      return {
        ok: false,
        error: `${label} ref ${JSON.stringify(ref)} looks like a git option and was rejected`,
      };
  }
  if (await commitPresent(runCommand, repo, sha)) return { ok: true };
  for (const ref of refs) {
    try {
      // `--` ends option parsing so a refspec can never be interpreted
      // as a flag, even if a future check misses one.
      await git(runCommand, repo, ["fetch", "origin", "--", ref]);
    } catch {
      continue;
    }
    if (await commitPresent(runCommand, repo, sha)) return { ok: true };
  }
  return {
    ok: false,
    error: `${label} commit ${sha} is not available from origin (fetch failed or the commit is missing)`,
  };
}

async function worktreeExcludeLine(
  runCommand: CommandRunner,
  worktree: string,
): Promise<void> {
  const result = await git(runCommand, worktree, [
    "rev-parse",
    "--git-path",
    "info/exclude",
  ]);
  const excludePath = resolve(worktree, result.stdout.trim());
  await mkdir(dirname(excludePath), { recursive: true });
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const alreadyExcluded = existing
    .split("\n")
    .some((line) => line.trim() === ".cross-review/");
  if (alreadyExcluded) return;
  const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  await writeFile(excludePath, `${existing}${prefix}.cross-review/\n`, "utf8");
}

export async function materializePrSnapshot(
  input: MaterializeInput,
): Promise<MaterializeResult> {
  const { repo, worktree, snapshot, view, runCommand } = input;
  try {
    const head = await ensureCommit(
      runCommand,
      repo,
      view.headRefOid,
      input.headFetchRefs ?? [],
      "PR head",
    );
    if (!head.ok) return { ok: false, error: head.error };
    const base = await ensureCommit(
      runCommand,
      repo,
      view.baseRefOid,
      [],
      "PR base",
    );
    if (!base.ok) return { ok: false, error: base.error };

    let mergeBaseSha: string;
    try {
      const mergeBase = await git(runCommand, repo, [
        "merge-base",
        view.baseRefOid,
        view.headRefOid,
      ]);
      mergeBaseSha = mergeBase.stdout.trim().toLowerCase();
    } catch (error) {
      return {
        ok: false,
        error: `git merge-base failed: ${errorMessage(error)}`,
      };
    }
    if (!SHA_40.test(mergeBaseSha))
      return {
        ok: false,
        error: `git merge-base returned an invalid SHA: ${JSON.stringify(mergeBaseSha)}`,
      };

    try {
      await git(runCommand, repo, [
        "worktree",
        "add",
        "--detach",
        worktree,
        view.headRefOid,
      ]);
    } catch (error) {
      return {
        ok: false,
        error: `git worktree add failed: ${errorMessage(error)}`,
      };
    }

    let diff: string;
    try {
      const diffResult = await git(runCommand, repo, [
        "diff",
        mergeBaseSha,
        view.headRefOid,
      ]);
      diff = diffResult.stdout;
    } catch (error) {
      return {
        ok: false,
        error: `git diff failed: ${errorMessage(error)}`,
      };
    }

    const fetchedAt = input.fetchedAt ?? new Date().toISOString();
    await mkdir(snapshot, { recursive: true });
    await writeFile(
      resolve(snapshot, "meta.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          forge: input.forge,
          target: input.target,
          url: view.url,
          baseSha: view.baseRefOid,
          headSha: view.headRefOid,
          mergeBaseSha,
          fetchedAt,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(resolve(snapshot, "diff.patch"), diff, "utf8");
    await writeFile(
      resolve(snapshot, "pr.md"),
      [
        `# Pull Request #${view.number}: ${view.title}`,
        "",
        `- URL: ${view.url}`,
        `- Base: ${view.baseRefName} (${view.baseRefOid})`,
        `- Head: ${view.headRefName} (${view.headRefOid})`,
        `- Merge base: ${mergeBaseSha}`,
        `- Fetched: ${fetchedAt}`,
        "",
        "## Description",
        "",
        view.body.length === 0 ? "(no description)" : view.body,
        "",
      ].join("\n"),
      "utf8",
    );
    if (input.notes !== undefined)
      await writeFile(resolve(snapshot, "notes.md"), input.notes, "utf8");

    try {
      await worktreeExcludeLine(runCommand, worktree);
    } catch (error) {
      return {
        ok: false,
        error: `Failed to exclude .cross-review/ from the snapshot worktree git status: ${errorMessage(error)}`,
      };
    }

    return { ok: true, headSha: view.headRefOid, mergeBaseSha };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
