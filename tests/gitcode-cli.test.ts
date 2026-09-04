import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverGitcodeCli,
  GITCODE_INSTALL_URL,
  isGitcodeCliPath,
  type GitcodeCliDiscovery,
} from "../src/cross-review/gitcode-cli.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "open-codeasier-gitcode-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

function fakeDiscovery(
  files: Record<string, string>,
  extra: Partial<GitcodeCliDiscovery> = {},
): GitcodeCliDiscovery {
  const home = extra.home ?? "/home";
  return {
    platform: "darwin",
    pathEnv: "",
    pathDelimiter: ":",
    home,
    async isFile(path) {
      return path in files;
    },
    async listDir(path) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name !== undefined && name.length > 0) names.add(name);
      }
      return [...names];
    },
    async versionOutput(path) {
      return files[path] ?? "";
    },
    async resolvePath(path) {
      return path;
    },
    ...extra,
  };
}

describe("gitcodeCli path validation", () => {
  it("accepts absolute paths and rejects relative or empty values", () => {
    expect(isGitcodeCliPath("/usr/bin/gitcode")).toBe(true);
    expect(isGitcodeCliPath("/Users/me/miniconda3/bin/gc")).toBe(true);
    expect(isGitcodeCliPath("gitcode")).toBe(false);
    expect(isGitcodeCliPath("./gc")).toBe(false);
    expect(isGitcodeCliPath("~/miniconda3/bin/gitcode")).toBe(false);
    expect(isGitcodeCliPath("")).toBe(false);
    expect(isGitcodeCliPath(1)).toBe(false);
  });
});

describe("discoverGitcodeCli", () => {
  it("prefers PATH gitcode whose --version output contains gitcode", async () => {
    const path = "/opt/bin/gitcode";
    await expect(
      discoverGitcodeCli(
        fakeDiscovery(
          {
            [path]: "gitcode, version 0.1.0",
            "/opt/bin/gc": "Usage: gc [-necCaDUrsv?] <files>",
          },
          { pathEnv: "/opt/bin" },
        ),
      ),
    ).resolves.toBe(path);
  });

  it("skips Graphviz gc and finds conda gitcode", async () => {
    const conda = "/home/miniconda3/bin/gitcode";
    await expect(
      discoverGitcodeCli(
        fakeDiscovery(
          {
            "/opt/homebrew/bin/gc": "Usage: gc [-necCaDUrsv?] <files>",
            [conda]: "gitcode, version 0.0.0.dev0",
          },
          { pathEnv: "/opt/homebrew/bin", home: "/home" },
        ),
      ),
    ).resolves.toBe(conda);
  });

  it("finds gitcode in a conda env bin directory", async () => {
    const envBin = "/home/miniconda3/envs/dev/bin/gitcode";
    await expect(
      discoverGitcodeCli(
        fakeDiscovery({ [envBin]: "GitCode CLI 1.2.3" }, { home: "/home" }),
      ),
    ).resolves.toBe(envBin);
  });

  it("searches Windows PATH and conda Scripts for gitcode.exe", async () => {
    const home = "/home";
    const cli = join(home, "miniconda3", "Scripts", "gitcode.exe");
    await expect(
      discoverGitcodeCli(
        fakeDiscovery(
          {
            [join("/win", "gc.exe")]: "Get-Content",
            [cli]: "gitcode, version 1.0.0",
          },
          {
            platform: "win32",
            pathEnv: "/win",
            pathDelimiter: ";",
            home,
          },
        ),
      ),
    ).resolves.toBe(cli);
  });

  it("returns undefined when every candidate fails the version check", async () => {
    await expect(
      discoverGitcodeCli(
        fakeDiscovery(
          { "/opt/homebrew/bin/gc": "Usage: gc [-necCaDUrsv?] <files>" },
          { pathEnv: "/opt/homebrew/bin" },
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("resolves the first valid candidate to an absolute path", async () => {
    const root = await fixture();
    const bin = join(root, "bin");
    await mkdir(bin);
    const cli = join(bin, "gitcode");
    await writeFile(cli, "#!/bin/sh\necho gitcode, version test\n", {
      mode: 0o755,
    });
    await expect(
      discoverGitcodeCli({
        platform: "darwin",
        pathEnv: bin,
        pathDelimiter: ":",
        home: root,
        async versionOutput() {
          return "gitcode, version test";
        },
      }),
    ).resolves.toBe(await realpath(cli));
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "skips candidates inside unreadable PATH directories",
    async () => {
      const root = await fixture();
      const bin = join(root, "bin");
      await mkdir(bin);
      await writeFile(
        join(bin, "gitcode"),
        "#!/bin/sh\necho gitcode, version test\n",
        {
          mode: 0o755,
        },
      );
      await chmod(bin, 0o000);
      try {
        await expect(
          discoverGitcodeCli({
            platform: "darwin",
            pathEnv: bin,
            pathDelimiter: ":",
            home: root,
          }),
        ).resolves.toBeUndefined();
      } finally {
        await chmod(bin, 0o755);
      }
    },
  );

  it("skips PATH entries that are files rather than directories", async () => {
    const root = await fixture();
    const notADir = join(root, "not-a-dir");
    const bin = join(root, "bin");
    await writeFile(notADir, "not a directory\n");
    await mkdir(bin);
    const cli = join(bin, "gitcode");
    await writeFile(cli, "#!/bin/sh\necho gitcode, version test\n", {
      mode: 0o755,
    });
    await expect(
      discoverGitcodeCli({
        platform: "darwin",
        pathEnv: `${notADir}:${bin}`,
        pathDelimiter: ":",
        home: root,
        async versionOutput() {
          return "gitcode, version test";
        },
      }),
    ).resolves.toBe(await realpath(cli));
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "skips unreadable conda env directories and still searches PATH",
    async () => {
      const root = await fixture();
      const bin = join(root, "bin");
      const envs = join(root, "miniconda3", "envs");
      await mkdir(bin);
      await mkdir(envs, { recursive: true });
      const cli = join(bin, "gitcode");
      await writeFile(cli, "#!/bin/sh\necho gitcode, version test\n", {
        mode: 0o755,
      });
      await chmod(envs, 0o000);
      try {
        await expect(
          discoverGitcodeCli({
            platform: "darwin",
            pathEnv: bin,
            pathDelimiter: ":",
            home: root,
            async versionOutput() {
              return "gitcode, version test";
            },
          }),
        ).resolves.toBe(await realpath(cli));
      } finally {
        await chmod(envs, 0o755);
      }
    },
  );
});

describe("detect-gitcode CLI", () => {
  it("rejects extra arguments", async () => {
    const { run } = await import("../src/cli.js");
    expect(GITCODE_INSTALL_URL).toBe(
      "https://github.com/codeasier/gitcode-cli",
    );
    expect(await run(["detect-gitcode", "--bogus"])).toBe(2);
  });

  it.skipIf(process.platform === "win32")(
    "prints the found path and exits 0 when a candidate matches",
    async () => {
      const { run } = await import("../src/cli.js");
      const root = await fixture();
      const bin = join(root, "bin");
      const home = join(root, "home");
      await mkdir(bin);
      await mkdir(home);
      const cli = join(bin, "gitcode");
      await writeFile(cli, "#!/bin/sh\necho gitcode, version test\n", {
        mode: 0o755,
      });
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const previousPath = process.env.PATH;
      const previousHome = process.env.HOME;
      process.env.PATH = bin;
      process.env.HOME = home;
      try {
        expect(await run(["detect-gitcode"])).toBe(0);
      } finally {
        process.env.PATH = previousPath;
        process.env.HOME = previousHome;
      }
      expect(log).toHaveBeenCalledWith(`found: ${await realpath(cli)}`);
    },
  );

  it("reports the install URL and exits 1 when nothing matches", async () => {
    const { run } = await import("../src/cli.js");
    const root = await fixture();
    const bin = join(root, "bin");
    const home = join(root, "home");
    await mkdir(bin);
    await mkdir(home);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const previousPath = process.env.PATH;
    const previousHome = process.env.HOME;
    process.env.PATH = bin;
    process.env.HOME = home;
    try {
      expect(await run(["detect-gitcode"])).toBe(1);
    } finally {
      process.env.PATH = previousPath;
      process.env.HOME = previousHome;
    }
    expect(error).toHaveBeenCalledWith(
      `gitcode-cli not found. Install from ${GITCODE_INSTALL_URL}`,
    );
  });
});
