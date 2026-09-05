import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { lock } from "proper-lockfile";

export const RUN_SCHEMA_VERSION = 3;
export const RUN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ReviewerRunStatus =
  | "queued"
  | "starting"
  | "running"
  | "retrying"
  | "timeout_pending"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled";

export type ReviewerRun = {
  reviewer: number;
  model: string;
  focus?: string;
  sessionID: string;
  messageID: string;
  status: ReviewerRunStatus;
  startedAt?: number;
  deadlineAt?: number;
  latestActivityAt?: number;
  timeoutDetectedAt?: number;
  timeoutExtensions?: number;
  completedAt?: number;
  retry?: { attempt: number; message: string; next: number };
  output?: string;
  error?: string;
};

export type JudgeRun = {
  model: string;
  sessionID: string;
  messageID: string;
  status:
    | "queued"
    | "starting"
    | "running"
    | "retrying"
    | "timeout_pending"
    | "succeeded"
    | "failed"
    | "timed_out"
    | "cancelled";
  startedAt?: number;
  deadlineAt?: number;
  latestActivityAt?: number;
  timeoutDetectedAt?: number;
  timeoutExtensions?: number;
  completedAt?: number;
  retry?: { attempt: number; message: string; next: number };
  output?: string;
  error?: string;
};

export type GathererRun = {
  model: string;
  sessionID: string;
  messageID: string;
  status:
    | "queued"
    | "starting"
    | "running"
    | "retrying"
    | "timeout_pending"
    | "succeeded"
    | "failed"
    | "timed_out"
    | "cancelled";
  startedAt?: number;
  deadlineAt?: number;
  latestActivityAt?: number;
  timeoutDetectedAt?: number;
  timeoutExtensions?: number;
  completedAt?: number;
  retry?: { attempt: number; message: string; next: number };
  output?: string;
  error?: string;
};

export type CrossReviewRunPhase =
  | "gathering"
  | "reviewing"
  | "judging"
  | "completed"
  | "quorum-not-met"
  | "failed"
  | "cancelled";

export type CrossReviewRun = {
  schemaVersion: typeof RUN_SCHEMA_VERSION;
  runID: string;
  directory: string;
  ownerSessionID: string;
  createdAt: number;
  updatedAt: number;
  phase: CrossReviewRunPhase;
  target: string;
  brief: string;
  context?: string;
  warning?: string;
  quorum: number;
  maxConcurrency: number;
  reviewerTimeoutMs: number;
  judgeModel?: string;
  configSources: { project: "loaded" | "absent"; global: "loaded" | "absent" };
  projectConfigPath: string;
  globalConfigPath: string;
  reviewers: ReviewerRun[];
  gatherer?: GathererRun;
  judge?: JudgeRun;
  finalResult?: Record<string, unknown>;
};

export type SaveRun = () => Promise<void>;

export type RunStoreError = {
  code: "MANIFEST_CORRUPT" | "MANIFEST_NOT_FOUND";
  detail: string;
  runID?: string;
};

export type ListByOwnerResult = {
  runs: CrossReviewRun[];
  errors: RunStoreError[];
};

export type ReadRunResult = { run: CrossReviewRun } | { error: RunStoreError };

export interface CrossReviewRunStore {
  create(run: CrossReviewRun): Promise<void>;
  withRun<T>(
    runID: string,
    action: (run: CrossReviewRun, save: SaveRun) => Promise<T>,
  ): Promise<T>;
  listByOwner(ownerSessionID: string): Promise<ListByOwnerResult>;
  read(runID: string): Promise<ReadRunResult>;
}

const TERMINAL_PHASES = new Set<CrossReviewRunPhase>([
  "completed",
  "quorum-not-met",
  "failed",
  "cancelled",
]);
const STALE_LOCK_MS = 60_000;
const LOCK_UPDATE_MS = 10_000;
// The lock holder can perform several SDK requests (status plus per-active
// reviewer messages and aborts, each up to 15s). Wait long enough that a
// concurrent poll after reload does not give up before the holder finishes.
const LOCK_RETRIES = 4_800;
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const LOCAL_LOCKS = new Map<string, Promise<void>>();

export function defaultCrossReviewStateDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  home = homedir(),
) {
  if (environment.XDG_STATE_HOME)
    return join(environment.XDG_STATE_HOME, "open-codeasier", "cross-review");
  if (platform === "darwin")
    return join(
      home,
      "Library",
      "Application Support",
      "open-codeasier",
      "cross-review",
    );
  if (platform === "win32")
    return join(
      environment.LOCALAPPDATA ?? join(home, "AppData", "Local"),
      "open-codeasier",
      "cross-review",
    );
  return join(home, ".local", "state", "open-codeasier", "cross-review");
}

function assertRunID(runID: string) {
  if (!RUN_ID.test(runID))
    throw new Error(`Invalid cross-review run ID: ${runID}`);
}

function corruptManifestError(runID: string): RunStoreError {
  return {
    code: "MANIFEST_CORRUPT",
    runID,
    detail: "Corrupt or unsupported cross-review run manifest",
  };
}

function parseRun(path: string, content: string): CrossReviewRun {
  const parsed: unknown = JSON.parse(content);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { schemaVersion?: unknown }).schemaVersion !== "number"
  )
    throw new Error(`Unsupported cross-review run manifest: ${path}`);
  const version = (parsed as { schemaVersion: number }).schemaVersion;
  if (version < 1 || version > RUN_SCHEMA_VERSION)
    throw new Error(`Unsupported cross-review run manifest: ${path}`);
  if (version < RUN_SCHEMA_VERSION)
    (parsed as Record<string, unknown>).schemaVersion = RUN_SCHEMA_VERSION;
  return parsed as CrossReviewRun;
}

async function acquireLocalLock(key: string) {
  const previous = LOCAL_LOCKS.get(key) ?? Promise.resolve();
  let releaseGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const tail = previous.then(() => gate);
  LOCAL_LOCKS.set(key, tail);
  await previous;
  return () => {
    releaseGate();
    void tail.finally(() => {
      if (LOCAL_LOCKS.get(key) === tail) LOCAL_LOCKS.delete(key);
    });
  };
}

export class FileCrossReviewRunStore implements CrossReviewRunStore {
  constructor(
    private readonly root = defaultCrossReviewStateDirectory(),
    private readonly now: () => number = Date.now,
  ) {}

  private runPath(runID: string) {
    assertRunID(runID);
    return join(this.root, `${runID}.json`);
  }

  private lockPath(runID: string) {
    assertRunID(runID);
    return join(this.root, `${runID}.lock`);
  }

  private async ensureRoot() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  private async writeAtomic(path: string, run: CrossReviewRun) {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(run)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }

  private async acquire(runID: string, retries = LOCK_RETRIES) {
    await this.ensureRoot();
    const target = join(this.root, runID);
    const releaseLocal = await acquireLocalLock(target);
    try {
      const releaseFile = await lock(target, {
        realpath: false,
        lockfilePath: this.lockPath(runID),
        stale: STALE_LOCK_MS,
        update: LOCK_UPDATE_MS,
        retries: {
          retries,
          factor: 1,
          minTimeout: 25,
          maxTimeout: 25,
          randomize: false,
        },
      });
      return async () => {
        try {
          await releaseFile();
        } finally {
          releaseLocal();
        }
      };
    } catch (error) {
      releaseLocal();
      throw error;
    }
  }

  async create(run: CrossReviewRun) {
    assertRunID(run.runID);
    await this.ensureRoot();
    const release = await this.acquire(run.runID);
    try {
      const path = this.runPath(run.runID);
      try {
        await stat(path);
        throw new Error(`Cross-review run already exists: ${run.runID}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await this.writeAtomic(path, run);
    } finally {
      await release();
    }
    await this.cleanupTerminalRuns().catch(() => undefined);
  }

  async withRun<T>(
    runID: string,
    action: (run: CrossReviewRun, save: SaveRun) => Promise<T>,
  ) {
    const release = await this.acquire(runID);
    try {
      const path = this.runPath(runID);
      let run: CrossReviewRun;
      try {
        run = parseRun(path, await readFile(path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new Error(`Cross-review run not found: ${runID}`);
        throw error;
      }
      const save = async () => {
        run.updatedAt = this.now();
        await this.writeAtomic(path, run);
      };
      const result = await action(run, save);
      await save();
      return result;
    } finally {
      await release();
    }
  }

  async listByOwner(ownerSessionID: string): Promise<ListByOwnerResult> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { runs: [], errors: [] };
      throw error;
    }
    const runs: CrossReviewRun[] = [];
    const errors: RunStoreError[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const runID = entry.slice(0, -".json".length);
      if (!RUN_ID.test(runID)) continue;
      try {
        const run = parseRun(
          join(this.root, entry),
          await readFile(join(this.root, entry), "utf8"),
        );
        if (run.ownerSessionID === ownerSessionID) runs.push(run);
      } catch {
        errors.push(corruptManifestError(runID));
      }
    }
    runs.sort(
      (left, right) =>
        left.createdAt - right.createdAt ||
        left.runID.localeCompare(right.runID),
    );
    return { runs, errors };
  }

  async read(runID: string): Promise<ReadRunResult> {
    const path = this.runPath(runID);
    try {
      return { run: parseRun(path, await readFile(path, "utf8")) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          error: {
            code: "MANIFEST_NOT_FOUND",
            runID,
            detail: `Cross-review run not found: ${runID}`,
          },
        };
      return { error: corruptManifestError(runID) };
    }
  }

  private async cleanupTerminalRuns() {
    const cutoff = this.now() - TERMINAL_RETENTION_MS;
    for (const entry of await readdir(this.root)) {
      if (!entry.endsWith(".json")) continue;
      const runID = entry.slice(0, -".json".length);
      if (!RUN_ID.test(runID)) continue;
      const path = join(this.root, entry);
      let release: (() => Promise<void>) | undefined;
      try {
        const candidate = parseRun(path, await readFile(path, "utf8"));
        if (
          !TERMINAL_PHASES.has(candidate.phase) ||
          candidate.updatedAt >= cutoff
        )
          continue;
        release = await this.acquire(runID, 0);
        const run = parseRun(path, await readFile(path, "utf8"));
        if (TERMINAL_PHASES.has(run.phase) && run.updatedAt < cutoff)
          await unlink(path);
      } catch {
        // A corrupt or concurrently replaced manifest is left for diagnosis.
      } finally {
        await release?.().catch(() => undefined);
      }
    }
  }
}
