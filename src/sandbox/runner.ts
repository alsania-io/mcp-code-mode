/**
 * Sandbox runner for LLM-authored TypeScript.
 *
 * Compiles TS to JS, then evaluates it in a vm.Context with:
 *   - All discovered tool functions injected as async fns
 *   - Captured console.log/warn/error
 *   - Timeout enforcement
 *   - NO fs/network/child_process access
 *
 * Security note: this is NOT a bulletproof sandbox. Only run code from trusted
 * sources. For untrusted code, wrap this in an OS-level isolation layer
 * (Podman, bubblewrap, seccomp).
 *
 * @license MIT
 */
import vm from 'node:vm';
import type { SandboxResult, SandboxConfig, ToolCallResult } from '../types.js';
import type { ChildClient } from '../transport/childClient.js';
import { toTsIdentifier } from '../types/generator.js';

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

export interface SandboxDeps {
  clients: Map<string, ChildClient>;
  config: SandboxConfig;
}

export async function runInSandbox(
  userCode: string,
  deps: SandboxDeps,
): Promise<SandboxResult> {
  const start = Date.now();
  const timeoutMs = Math.min(deps.config.timeoutMs ?? 30000, 300000);
  const maxOutputBytes = deps.config.maxOutputBytes ?? 200_000;

  const consoleOutput: string[] = [];
  const pushOutput = (prefix: string, args: unknown[]) => {
    const text = args
      .map((a) => {
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a, null, 2);
        } catch {
          return String(a);
        }
      })
      .join(' ');
    if (consoleOutput.join('\n').length + text.length > maxOutputBytes) return;
    consoleOutput.push(`[${prefix}] ${text}`);
  };

  // Build tool functions for the sandbox.
  const toolFns: Record<string, (params: unknown) => Promise<ToolCallResult>> = {};
  for (const client of deps.clients.values()) {
    for (const tool of client.tools) {
      const safeName = toTsIdentifier(tool.fqName);
      toolFns[safeName] = (params: unknown) => client.call(tool.name, params);
    }
  }

  // Compile TS → JS by stripping simple type annotations.
  // (A full TS compiler adds ~5MB; for sandbox use we accept a lighter path
  //  that relies on the LLM emitting mostly-JS with light type hints.)
  const js = stripTypes(userCode);

  const wrapped = `
"use strict";
(async () => {
  try {
    ${js}
  } catch (e) { throw e; }
})()
`;

  const context = vm.createContext({
    console: {
      log: (...a: unknown[]) => pushOutput('log', a),
      info: (...a: unknown[]) => pushOutput('info', a),
      warn: (...a: unknown[]) => pushOutput('warn', a),
      error: (...a: unknown[]) => pushOutput('error', a),
    },
    Math, JSON, Date, Array, Object, String, Number, Boolean, Promise,
    setTimeout: (...a: unknown[]) => (globalThis as any).setTimeout(...(a as any)),
    clearTimeout: (...a: unknown[]) => (globalThis as any).clearTimeout(...(a as any)),
    ...toolFns,
  });

  let result: unknown;
  let error: string | undefined;

  try {
    const runner = new vm.Script(wrapped, { filename: 'mcp-code-mode-sandbox.js' });
    const execPromise = runner.runInContext(context, { timeout: timeoutMs }) as Promise<unknown>;
    result = await Promise.race([
      execPromise,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new SandboxError(`execution exceeded ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return {
    result,
    consoleOutput,
    error,
    durationMs: Date.now() - start,
  };
}

/**
 * Very small TS-type stripper. Handles the common cases LLMs emit:
 *   - `const x: Type =` → `const x =`
 *   - `function f(a: T, b: U): R {}` → `function f(a, b) {}`
 *   - `let x: T` / `var x: T`
 *   - `as Type` casts (removed)
 *
 * This is intentionally conservative. If the input uses advanced TS features
 * (generics, decorators, etc.) it may not strip cleanly — the sandbox will
 * report a syntax error and the LLM can retry.
 */
function stripTypes(src: string): string {
  return src
    // Remove interfaces/type aliases that leaked in.
    .replace(/^\s*interface\s+\w+\s*\{[^}]*\}\s*;?/gm, '')
    .replace(/^\s*type\s+\w+\s*=\s*[^;]+;?/gm, '')
    // Remove `declare function` lines.
    .replace(/^\s*declare\s+function\s+[^;]+;/gm, '')
    // Strip `: Type` in const/let/var declarations.
    .replace(/(\b(?:const|let|var)\s+\w+)\s*:\s*[^=;\n]+(?=[=;\n])/g, '$1')
    // Strip function param types and return types.
    .replace(/(\([^)]*)\)\s*:\s*[^{\n]+(?=\{)/g, '$1)')
    // Strip `as Type` casts.
    .replace(/\s+as\s+[A-Za-z_$][\w$<>, \[\]]*/g, '');
}
