import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type EvidencePack = { files: Map<string, Buffer>; evidenceDir: string };

/** Capture validated bytes before dispatch; later source edits cannot change the review. */
export async function readEvidencePack(
  project: string,
  evidenceDir: string,
): Promise<EvidencePack> {
  if (
    typeof evidenceDir !== "string" ||
    !evidenceDir.trim() ||
    isAbsolute(evidenceDir)
  )
    throw new Error(
      "evidenceDir must be a nonblank project-relative directory",
    );
  const root = await realpath(project);
  const path = resolve(root, evidenceDir);
  const inside = (base: string, candidate: string) => {
    const rel = relative(base, candidate);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (!inside(root, path) || !inside(root, await realpath(path)))
    throw new Error("evidenceDir escapes the project directory");
  const files = new Map<string, Buffer>();
  const walk = async (current: string, name: string): Promise<void> => {
    const info = await lstat(current);
    if (info.isSymbolicLink())
      throw new Error(`Evidence pack symlinks are not allowed: ${name}`);
    if (!inside(root, await realpath(current)))
      throw new Error("Evidence pack escapes the project directory");
    if (info.isDirectory()) {
      for (const entry of await readdir(current))
        await walk(join(current, entry), join(name, entry));
    } else if (info.isFile()) {
      files.set(name, await readFile(current));
    } else throw new Error(`Invalid evidence pack entry: ${name}`);
  };
  if (!(await lstat(path)).isDirectory())
    throw new Error("evidenceDir must be a directory (not a symlink)");
  await walk(path, "");
  const summary = files.get("summary.md")?.toString("utf8");
  if (!summary?.trim())
    throw new Error("Evidence pack requires a nonblank summary.md");
  let meta: unknown;
  try {
    meta = JSON.parse(files.get("meta.json")?.toString("utf8") ?? "");
  } catch {
    throw new Error("Evidence pack requires valid meta.json");
  }
  if (
    typeof meta !== "object" ||
    meta === null ||
    Array.isArray(meta) ||
    Object.keys(meta).length === 0
  )
    throw new Error("Evidence pack meta.json must be a nonempty object");
  return { files, evidenceDir };
}

export async function writeEvidencePack(
  destination: string,
  pack: EvidencePack,
) {
  // Exclusive creation also prevents following pre-existing contract symlinks.
  await mkdir(destination, { recursive: false });
  for (const [name, bytes] of pack.files) {
    const path = join(destination, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: "wx" });
  }
}
