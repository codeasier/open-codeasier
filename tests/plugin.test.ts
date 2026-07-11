import { describe, expect, it } from "vitest";
import plugin from "../src/plugin.js";

describe("plugin module", () => {
  it("exports the OpenCode server entry", () => {
    expect(plugin).toEqual(
      expect.objectContaining({ server: expect.any(Function) }),
    );
  });
});
