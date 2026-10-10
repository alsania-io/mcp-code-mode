/*
 * Tests for lazy child-server connection (ChildClient.ensureConnected).
 *
 * Root cause this guards against: children used to be spawned eagerly in
 * index.ts's startup loop, so an idle code-mode process held one child process
 * per configured server even when code-mode was never invoked. The fix makes
 * connection lazy (on first get_tool_definitions / list_servers /
 * generate_and_execute_code) and race-safe via a memoized promise.
 */
import { describe, test, expect } from "vitest";
import { ChildClient } from "../src/transport/childClient.js";
import { ChildAllowlist } from "../src/security/allowlist.js";
import type { ChildServerConfig } from "../src/types.js";

// A child that cannot connect: point at a command that exits immediately.
const DEAD_CHILD: ChildServerConfig = {
  name: "dead",
  command: "node",
  args: ["-e", "process.exit(0)"],
  timeoutMs: 4000,
};

function makeAllowlist() {
  return new ChildAllowlist({ allowAllHosts: false, allowHttp: false });
}

describe("ChildClient lazy connection", () => {
  test("constructs without connecting (no tools, no client)", () => {
    const client = new ChildClient(DEAD_CHILD, makeAllowlist());
    // Construction must not spawn anything: tools stay empty until connect.
    expect(client.tools).toEqual([]);
    expect((client as unknown as { client?: unknown }).client).toBeUndefined();
  });

  test("ensureConnected is idempotent: a failed connect does not poison the client", async () => {
    const client = new ChildClient(DEAD_CHILD, makeAllowlist());
    let firstError: unknown;
    let secondError: unknown;
    try {
      await client.ensureConnected();
    } catch (e) {
      firstError = e;
    }
    // Second attempt must also run (not resolve from a cached rejected promise).
    try {
      await client.ensureConnected();
    } catch (e) {
      secondError = e;
    }
    expect(firstError).toBeDefined();
    expect(secondError).toBeDefined();
    // The connecting promise must have been reset, not left cached.
    expect((client as unknown as { connecting?: unknown }).connecting).toBeUndefined();
  });

  test("call() attempts connection on first use", async () => {
    const client = new ChildClient(DEAD_CHILD, makeAllowlist());
    await expect(client.call("anything", {})).rejects.toBeDefined();
  });

  test("ensureConnected after close() rejects with a closed error", async () => {
    const client = new ChildClient(DEAD_CHILD, makeAllowlist());
    await client.close();
    await expect(client.ensureConnected()).rejects.toThrow(/closed/i);
  });
});
