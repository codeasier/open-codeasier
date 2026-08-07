import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type PackagedAsset = {
  source: string;
  relativeTarget:
    | `skills/${string}/SKILL.md`
    | `commands/${string}.md`
    | `agents/${string}.md`;
  sha256: string;
};

export const sha256 = (contents: string | Buffer) =>
  createHash("sha256").update(contents).digest("hex");

export async function discoverAssets(
  packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
) {
  const assets: PackagedAsset[] = [];
  for (const directory of ["skills", "commands", "agents"] as const) {
    const root = join(packageRoot, directory);
    const entries = await readdir(root, {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const source = join(entry.parentPath, entry.name);
      const target = relative(packageRoot, source).replaceAll("\\", "/");
      if (
        !/^skills\/[^/]+\/SKILL\.md$|^commands\/[^/]+\.md$|^agents\/[^/]+\.md$/.test(
          target,
        )
      )
        continue;
      assets.push({
        source,
        relativeTarget: target as PackagedAsset["relativeTarget"],
        sha256: sha256(await readFile(source)),
      });
    }
  }
  return assets.sort((a, b) =>
    a.relativeTarget.localeCompare(b.relativeTarget),
  );
}
