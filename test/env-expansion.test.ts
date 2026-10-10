/**
 * Tests for ${VAR} expansion in child-server env blocks.
 *
 * Root cause: loadConfig did a raw JSON.parse, so `${EME_ADMIN_KEY}` in a
 * server's env block was passed to the child as the literal string, silently
 * breaking auth. Expansion happens at load time using process.env.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { expandEnvVars } from "../src/index.js";

describe("expandEnvVars", () => {
  beforeEach(() => {
    process.env.TEST_KEY = "sk-test-value";
  });
  afterEach(() => {
    delete process.env.TEST_KEY;
  });

  test("expands a single ${VAR} in an env value", () => {
    const out = expandEnvVars({ A: "${TEST_KEY}" });
    expect(out.A).toBe("sk-test-value");
  });

  test("expands ${VAR} embedded in a larger string", () => {
    const out = expandEnvVars({ A: "prefix-${TEST_KEY}-suffix" });
    expect(out.A).toBe("prefix-sk-test-value-suffix");
  });

  test("leaves unknown ${VAR} untouched (no silent empty)", () => {
    const out = expandEnvVars({ A: "${DOES_NOT_EXIST_XYZ}" });
    expect(out.A).toBe("${DOES_NOT_EXIST_XYZ}");
  });

  test("passes through non-templated values unchanged", () => {
    const out = expandEnvVars({ A: "plain", B: "sk-literal" });
    expect(out).toEqual({ A: "plain", B: "sk-literal" });
  });
});
