import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

const forbidden =
  /CLAUDE_(PLUGIN_ROOT|SKILL_DIR|SESSION_ID)|\.claude\/settings\.local\.json|disable-model-invocation:|allowed-tools:|argument-hint:/;
const legacyPublicPrefix = /cce[-_]/;

describe("distributed workflow assets", () => {
  it("contains valid unique skills and matching commands", async () => {
    const skillDirectories = (
      await readdir("skills", { withFileTypes: true })
    ).filter((entry) => entry.isDirectory());
    expect(skillDirectories).toHaveLength(11);
    const names: string[] = [];
    for (const directory of skillDirectories) {
      expect(directory.name).not.toMatch(legacyPublicPrefix);
      const content = await readFile(
        join("skills", directory.name, "SKILL.md"),
        "utf8",
      );
      const name = content.match(/^name:\s*(.+)$/m)?.[1];
      const description = content.match(/^description:\s*(.+)$/m)?.[1] ?? "";
      expect(name).toBe(basename(directory.name));
      expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(description.length).toBeGreaterThan(0);
      expect(content).not.toMatch(forbidden);
      expect(content).not.toMatch(legacyPublicPrefix);
      names.push(name ?? "");
    }
    expect(new Set(names).size).toBe(names.length);
    const commands = await readdir("commands");
    expect(commands).toHaveLength(11);
    expect(commands.join("\n")).not.toMatch(legacyPublicPrefix);
    for (const name of names) {
      const content = await readFile(join("commands", `${name}.md`), "utf8");
      expect(content).not.toMatch(forbidden);
      expect(content).not.toMatch(legacyPublicPrefix);
      expect(
        content.match(new RegExp("Load the `" + name + "` skill", "g")),
      ).toHaveLength(1);
    }
  });

  it("keeps public documentation and runtime registrations prefix-free", async () => {
    const publicFiles = ["README.md", "src/plugin.ts"];
    for (const path of publicFiles) {
      expect(await readFile(path, "utf8")).not.toMatch(legacyPublicPrefix);
    }
  });
});
