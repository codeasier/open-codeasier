import { pathToFileURL } from "node:url";
import {
  defaultRunCommand,
  materializePrSnapshot,
  parseAdapterFlags,
  parsePrViewJson,
  PR_VIEW_JSON_FIELDS,
  prViewTarget,
  type CommandRunner,
} from "./common.js";

export async function runGithubPrSnapshot(
  argv: string[],
  runCommand: CommandRunner = defaultRunCommand,
): Promise<{ exitCode: number; stderr?: string }> {
  const parsed = parseAdapterFlags(argv);
  if (!parsed.ok) return { exitCode: 2, stderr: parsed.error };
  const { repo, target, worktree, snapshot, notes } = parsed.flags;

  let rawView: string;
  try {
    const view = await runCommand(
      "gh",
      ["pr", "view", prViewTarget(target), "--json", PR_VIEW_JSON_FIELDS],
      { cwd: repo },
    );
    rawView = view.stdout;
  } catch (error) {
    return {
      exitCode: 1,
      stderr: `gh pr view failed for ${target}: ${commandError(error)}`,
    };
  }

  let view;
  try {
    view = parsePrViewJson(rawView, "gh pr view");
  } catch (error) {
    return { exitCode: 1, stderr: (error as Error).message };
  }

  const result = await materializePrSnapshot({
    forge: "github",
    repo,
    worktree,
    snapshot,
    target,
    ...(notes === undefined ? {} : { notes }),
    view,
    headFetchRefs: [
      `refs/pull/${view.number}/head`,
      view.headRefName,
      view.baseRefName,
    ],
    runCommand,
  });
  if (!result.ok) return { exitCode: 1, stderr: result.error };
  return { exitCode: 0 };
}

function commandError(error: unknown) {
  if (error instanceof Error) {
    const stderr = (error as { stderr?: string }).stderr;
    return stderr === undefined || stderr.length === 0
      ? error.message
      : stderr.trim();
  }
  return String(error);
}

// pathToFileURL handles Windows drive letters (`C:\...`) where a manual
// `file://` + path join would parse the drive as a URL host.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = await runGithubPrSnapshot(process.argv.slice(2));
  if (result.exitCode !== 0) {
    process.stderr.write(`${result.stderr ?? "GitHub PR snapshot failed"}\n`);
    process.exit(result.exitCode);
  }
}
