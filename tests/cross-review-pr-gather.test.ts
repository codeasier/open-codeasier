import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADAPTER_MAX_BUFFER,
  ADAPTER_NODE_ENV,
  ADAPTER_TIMEOUT_MS,
  createDefaultPrAdapterRunner,
  resolveAdapterRuntime,
  snapshotPaths,
  type ExecFileLike,
} from "../src/cross-review/pr-gather.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "pr-gather-runtime-"));
  roots.push(root);
  return root;
}

function request(
  root: string,
  overrides: { forge?: "github" | "gitcode"; notes?: string } = {},
) {
  return {
    forge: overrides.forge ?? "github",
    repo: join(root, "repo"),
    target: "#87",
    runID: "run-87",
    stateRoot: join(root, "state"),
    ...(overrides.notes === undefined ? {} : { notes: overrides.notes }),
  };
}

describe("resolveAdapterRuntime", () => {
  it("reuses a Node host executable", async () => {
    const result = await resolveAdapterRuntime({
      host: { execPath: "/usr/bin/node", versions: { node: "22.14.0" } },
      env: {},
      isFile: async (path) => path === "/usr/bin/node",
    });
    expect(result).toEqual({ ok: true, executable: "/usr/bin/node" });
  });

  it("does not reuse a standalone host even when versions.node is set", async () => {
    const result = await resolveAdapterRuntime({
      host: {
        execPath: "/opt/opencode",
        versions: { node: "22.14.0" },
      },
      env: { PATH: "/opt/node/bin" },
      isFile: async (path) => path === "/opt/node/bin/node",
      platform: "darwin",
      pathDelimiter: ":",
    });
    expect(result).toEqual({ ok: true, executable: "/opt/node/bin/node" });
  });

  it("does not reuse a Bun host executable", async () => {
    const result = await resolveAdapterRuntime({
      host: {
        execPath: "/opt/homebrew/bin/bun",
        versions: { node: "22.6.0", bun: "1.2.19" },
      },
      env: { PATH: "/usr/local/bin" },
      isFile: async (path) => path === "/usr/local/bin/node",
      platform: "darwin",
      pathDelimiter: ":",
    });
    expect(result).toEqual({ ok: true, executable: "/usr/local/bin/node" });
  });

  it("prefers OPEN_CODEASIER_NODE over the host and PATH", async () => {
    const result = await resolveAdapterRuntime({
      host: { execPath: "/usr/bin/node", versions: { node: "22.14.0" } },
      env: {
        [ADAPTER_NODE_ENV]: "/opt/node22/bin/node",
        PATH: "/usr/bin",
      },
      isFile: async (path) =>
        path === "/opt/node22/bin/node" || path === "/usr/bin/node",
    });
    expect(result).toEqual({ ok: true, executable: "/opt/node22/bin/node" });
  });

  it("rejects a relative OPEN_CODEASIER_NODE", async () => {
    const result = await resolveAdapterRuntime({
      host: { execPath: "/usr/bin/node", versions: { node: "22.14.0" } },
      env: { [ADAPTER_NODE_ENV]: "bin/node" },
      isFile: async () => true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(ADAPTER_NODE_ENV);
      expect(result.error).toContain("absolute path");
    }
  });

  it("rejects a missing OPEN_CODEASIER_NODE file", async () => {
    const result = await resolveAdapterRuntime({
      env: { [ADAPTER_NODE_ENV]: "/missing/node" },
      isFile: async () => false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(ADAPTER_NODE_ENV);
      expect(result.error).toContain("/missing/node");
    }
  });

  it("fails clearly when no Node runtime is available", async () => {
    const result = await resolveAdapterRuntime({
      host: {
        execPath: "/opt/opencode",
        versions: { node: "22.14.0", bun: "1.2.19" },
      },
      env: { PATH: "" },
      isFile: async () => false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Node.js 22+");
      expect(result.error).toContain("/opt/opencode");
      expect(result.error).toContain(ADAPTER_NODE_ENV);
      expect(result.error).not.toContain("opencode pr");
    }
  });

  it("skips a win32 node.cmd shim and continues to node.exe", async () => {
    const shimDir = "C:\\nvm-shim";
    const nodeDir = "C:\\nodejs";
    const result = await resolveAdapterRuntime({
      host: {
        execPath: "C:\\opencode.exe",
        versions: { bun: "1.2.19" },
      },
      env: { PATH: `${shimDir};${nodeDir}` },
      isFile: async (path) =>
        path === join(shimDir, "node.cmd") || path === join(nodeDir, "node.exe"),
      platform: "win32",
      pathDelimiter: ";",
    });
    expect(result).toEqual({ ok: true, executable: join(nodeDir, "node.exe") });
  });

  it("does not select a win32 node.cmd as the adapter runtime", async () => {
    const shimDir = "C:\\nvm-shim";
    const result = await resolveAdapterRuntime({
      host: {
        execPath: "C:\\opencode.exe",
        versions: { bun: "1.2.19" },
      },
      env: { PATH: shimDir },
      isFile: async (path) => path === join(shimDir, "node.cmd"),
      platform: "win32",
      pathDelimiter: ";",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Node.js 22+");
  });

  it.skipIf(process.platform === "win32")(
    "skips a non-executable PATH node and continues",
    async () => {
      const root = await tempRoot();
      const shadow = join(root, "shadow");
      const real = join(root, "real");
      await mkdir(shadow);
      await mkdir(real);
      const shadowNode = join(shadow, "node");
      const realNode = join(real, "node");
      await writeFile(shadowNode, "not executable");
      await writeFile(realNode, `#!${process.execPath}\n`);
      await chmod(realNode, 0o755);

      const result = await resolveAdapterRuntime({
        host: {
          execPath: "/opt/opencode",
          versions: { bun: "1.2.19" },
        },
        env: { PATH: `${shadow}:${real}` },
        platform: "darwin",
        pathDelimiter: ":",
      });
      expect(result).toEqual({ ok: true, executable: realNode });
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a non-executable OPEN_CODEASIER_NODE",
    async () => {
      const root = await tempRoot();
      const override = join(root, "node");
      await writeFile(override, "not executable");

      const result = await resolveAdapterRuntime({
        env: { [ADAPTER_NODE_ENV]: override },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(ADAPTER_NODE_ENV);
        expect(result.error).toContain(override);
      }
    },
  );
});

describe("createDefaultPrAdapterRunner", () => {
  it("spawns the resolved runtime with shell-free adapter args", async () => {
    const root = await tempRoot();
    const calls: Array<{
      file: string;
      args: string[];
      options: {
        timeout?: number;
        maxBuffer?: number;
        env?: NodeJS.ProcessEnv;
      };
    }> = [];
    const execFileLike: ExecFileLike = async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: "", stderr: "" };
    };
    const runner = createDefaultPrAdapterRunner(execFileLike, {
      host: {
        execPath: "/opt/opencode",
        versions: { node: "22.14.0", bun: "1.2.19" },
      },
      env: { PATH: "/usr/bin" },
      isFile: async (path) => path === "/usr/bin/node",
      platform: "darwin",
      pathDelimiter: ":",
    });
    const input = request(root, { notes: "caller notes" });
    const result = await runner(input);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("/usr/bin/node");
    expect(calls[0]?.file).not.toBe("/opt/opencode");
    const paths = snapshotPaths(input.stateRoot, input.runID);
    expect(calls[0]?.args).toEqual([
      expect.stringMatching(/github-pr-snapshot\.js$/),
      "--repo",
      input.repo,
      "--target",
      input.target,
      "--worktree",
      paths.worktree,
      "--snapshot",
      paths.snapshotDir,
      "--notes",
      "caller notes",
    ]);
    expect(calls[0]?.options.timeout).toBe(ADAPTER_TIMEOUT_MS);
    expect(calls[0]?.options.maxBuffer).toBe(ADAPTER_MAX_BUFFER);
    expect(calls[0]?.options.env).toBeUndefined();
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toContain("PR snapshot contract validation failed");
  });

  it("propagates GitCode CLI env and uses the gitcode adapter script", async () => {
    const root = await tempRoot();
    const calls: Array<{
      file: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];
    const runner = createDefaultPrAdapterRunner(
      async (file, args, options) => {
        calls.push({ file, args, env: options.env });
        return { stdout: "", stderr: "" };
      },
      {
        host: { execPath: "/usr/bin/node", versions: { node: "22.14.0" } },
        env: {},
        isFile: async (path) => path === "/usr/bin/node",
      },
    );
    await runner({
      ...request(root, { forge: "gitcode" }),
      gitcodeCli: "/usr/local/bin/gitcode",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]).toMatch(/gitcode-pr-snapshot\.js$/);
    expect(calls[0]?.env?.GITCODE_CLI_PATH).toBe("/usr/local/bin/gitcode");
  });

  it("returns a concise error when the runtime cannot be resolved", async () => {
    let spawned = false;
    const runner = createDefaultPrAdapterRunner(
      async () => {
        spawned = true;
        return { stdout: "", stderr: "" };
      },
      {
        host: {
          execPath: "/opt/opencode",
          versions: { bun: "1.2.19" },
        },
        env: { PATH: "" },
        isFile: async () => false,
      },
    );
    const result = await runner(request(await tempRoot()));
    expect(spawned).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(
        /^PR snapshot adapter \(github\) failed: Node\.js 22\+/,
      );
      expect(result.error).toContain(ADAPTER_NODE_ENV);
      expect(result.error).not.toContain("opencode pr");
      expect(result.error).not.toContain("Usage");
    }
  });

  it("returns a concise error when the runtime cannot be launched", async () => {
    const runner = createDefaultPrAdapterRunner(
      async () => {
        throw Object.assign(new Error("spawn /missing/node ENOENT"), {
          code: "ENOENT",
        });
      },
      {
        host: { execPath: "/usr/bin/node", versions: { node: "22.14.0" } },
        env: {},
        isFile: async (path) => path === "/usr/bin/node",
      },
    );
    const result = await runner(request(await tempRoot()));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("could not launch Node.js runtime");
      expect(result.error).toContain("/usr/bin/node");
      expect(result.error).toContain(ADAPTER_NODE_ENV);
      expect(result.error).not.toContain("opencode pr");
    }
  });

  it.skipIf(process.platform === "win32")(
    "does not spawn a standalone host executable",
    async () => {
      const root = await tempRoot();
      const hostMarker = join(root, "host-invoked");
      const nodeMarker = join(root, "node-invoked");
      const host = join(root, "opencode");
      const node = join(root, "node");
      await writeFile(
        host,
        `#!${process.execPath}
require("fs").writeFileSync(${JSON.stringify(hostMarker)}, "host");
console.log("Usage:\\n  opencode pr <number>");
process.exit(1);
`,
      );
      await writeFile(
        node,
        `#!${process.execPath}
require("fs").writeFileSync(
  ${JSON.stringify(nodeMarker)},
  process.argv.slice(2).join("\\n"),
);
`,
      );
      await chmod(host, 0o755);
      await chmod(node, 0o755);

      const runner = createDefaultPrAdapterRunner(execFileAsync, {
        host: {
          execPath: host,
          versions: { node: "22.14.0", bun: "1.2.19" },
        },
        env: { PATH: root },
        platform: "darwin",
        pathDelimiter: ":",
      });
      const result = await runner(request(root));
      await expect(stat(hostMarker)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(nodeMarker)).resolves.toBeTruthy();
      const spawnedArgs = await readFile(nodeMarker, "utf8");
      expect(spawnedArgs).toContain("github-pr-snapshot.js");
      expect(spawnedArgs).toContain("--target");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(
          "PR snapshot contract validation failed",
        );
        expect(result.error).not.toContain("opencode pr");
        expect(result.error).not.toContain("Usage");
      }
    },
  );
});
