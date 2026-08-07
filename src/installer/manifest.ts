import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const NAME = "[a-z0-9]+(?:-[a-z0-9]+)*";
const ASSET_PATH = new RegExp(
  `^(?:skills/${NAME}/SKILL\\.md|commands/${NAME}\\.md|agents/${NAME}\\.md)$`,
);

export function validateAssetPath(path: string): void {
  if (!ASSET_PATH.test(path))
    throw new Error(`Invalid open-codeasier asset path: ${path}`);
}

export type InstallManifest = {
  schemaVersion: 1;
  packageVersion: string;
  files: Array<{ path: string; sha256: string }>;
};

export const manifestPath = (root: string) =>
  join(root, ".open-codeasier", "installed-assets.json");

export async function readManifest(
  root: string,
): Promise<InstallManifest | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(manifestPath(root), "utf8"),
    );
    if (
      typeof value !== "object" ||
      value === null ||
      !("schemaVersion" in value) ||
      value.schemaVersion !== 1 ||
      !("packageVersion" in value) ||
      typeof value.packageVersion !== "string" ||
      !("files" in value) ||
      !Array.isArray(value.files) ||
      !value.files.every(
        (file) =>
          typeof file === "object" &&
          file !== null &&
          "path" in file &&
          typeof file.path === "string" &&
          "sha256" in file &&
          typeof file.sha256 === "string",
      )
    ) {
      throw new Error("Invalid open-codeasier install manifest");
    }
    const manifest = value as InstallManifest;
    for (const file of manifest.files) validateAssetPath(file.path);
    return manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeManifest(
  root: string,
  manifest: InstallManifest,
): Promise<void> {
  await atomicWrite(
    manifestPath(root),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

export async function atomicWrite(
  path: string,
  contents: string | Buffer,
): Promise<void> {
  const { mkdir, rename, rm } = await import("node:fs/promises");
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
