import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createChildDestinationVerifier } from "../src/opencode-v2/destination.js";
import type { V2Host } from "../src/opencode-v2/host.js";

type NativeInput = Parameters<V2Host["session"]["command"]>[0];

async function fixture(agent = "cross-reviewer") {
  const directory = await realpath(tmpdir());
  const get = vi.fn(async () => ({ data: { id: agent } }));
  const receiver = createChildDestinationVerifier({
    location: { directory },
    agent: { get },
  } as unknown as V2Host);
  const dispatch = (input: NativeInput) =>
    receiver.command.execute({
      sessionID: input.sessionID,
      prompt: { text: input.text },
      delivery: "queue",
    });
  const command = vi.fn(dispatch);
  const issuer = createChildDestinationVerifier({
    session: { command },
  } as unknown as V2Host);
  return { directory, get, command, dispatch, receiver, issuer };
}

describe("OpenCode V2 review destination verification", () => {
  it("accepts only its registered command's acknowledgement for a fresh session ticket", async () => {
    const f = await fixture();
    await f.issuer.verifyDestination("child", f.directory);
    expect(f.get).toHaveBeenCalledOnce();
    const actual = f.command.mock.calls[0]?.[0];
    expect(actual?.name).toBe(f.receiver.command.name);
    if (actual === undefined) throw new Error("No verification was sent");
    await f.dispatch(actual);
    await f.dispatch({ ...actual, text: "ordinary command argument" });
    expect(f.get).toHaveBeenCalledOnce();
  });

  it("rejects a command that returns success without the plugin acknowledgement", async () => {
    const f = await fixture();
    f.command.mockResolvedValueOnce(undefined);
    await expect(
      f.issuer.verifyDestination("child", f.directory),
    ).rejects.toThrow(/No reviewer prompt was sent/);
    const actual = f.command.mock.calls[0]?.[0];
    if (actual === undefined) throw new Error("No verification was sent");
    await f.dispatch(actual);
    expect(f.get).not.toHaveBeenCalled();
  });

  it("rejects an acknowledgement in a different session or location", async () => {
    const f = await fixture();
    f.command.mockImplementationOnce((input) =>
      f.dispatch({ ...input, sessionID: "wrong" }),
    );
    await expect(
      f.issuer.verifyDestination("child", f.directory),
    ).rejects.toThrow(/could not verify/);
    await expect(
      f.issuer.verifyDestination("child", process.cwd()),
    ).rejects.toThrow(/could not verify/);
    expect(f.get).not.toHaveBeenCalled();
  });

  it("rejects a destination missing the exact reviewer agent", async () => {
    const f = await fixture("build");
    await expect(
      f.issuer.verifyDestination("child", f.directory),
    ).rejects.toThrow(/cross-reviewer agent/);
    expect(f.get).toHaveBeenCalledWith({ agentID: "cross-reviewer" });
  });

  it("cleans its ticket when cancellation wins over destination activation", async () => {
    const f = await fixture();
    let started!: () => void;
    const commandStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    const stalled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.command.mockImplementationOnce(() => {
      started();
      return stalled;
    });
    const controller = new AbortController();
    const probe = f.issuer.verifyDestination(
      "child",
      f.directory,
      controller.signal,
    );
    await commandStarted;
    const outcome = expect(probe).rejects.toThrow("cancelled check");
    controller.abort(new Error("cancelled check"));
    await outcome;
    const actual = f.command.mock.calls[0]?.[0];
    if (actual === undefined) throw new Error("No verification was sent");
    await f.dispatch(actual);
    finish();
    expect(f.get).not.toHaveBeenCalled();
  });
});
