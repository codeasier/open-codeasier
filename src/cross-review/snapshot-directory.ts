import { lstat, rm } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Reserve the evidence destination in a freshly checked-out worktree.
 * The checkout can contain a tracked directory, file, or symlink at this
 * name. Remove that entry without following symlinks before any writer
 * creates its own directory. Never use this on the user's source checkout.
 */
export async function clearSnapshotDirectory(
  worktree: string,
  snapshot = resolve(worktree, ".cross-review"),
): Promise<void> {
  const root = resolve(worktree);
  const destination = resolve(snapshot);
  if (destination !== resolve(root, ".cross-review"))
    throw new Error("Snapshot destination must be worktree/.cross-review");
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Snapshot worktree must be a directory, not a symlink");
  await rm(destination, { recursive: true, force: true });
}
