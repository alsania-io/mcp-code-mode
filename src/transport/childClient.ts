/**
 * Child MCP client.
 *
 * Spawns a child MCP server over stdio (or connects over HTTP/SSE), lists its
 * tools, and exposes a call() method used by the sandbox.
 *
 * @license MIT
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ChildServerConfig, DiscoveredTool, ToolCallResult } from '../types.js';
import { ChildAllowlist } from '../security/allowlist.js';

export class ChildConnectError extends Error {
  constructor(server: string, reason: string) {
    super(`Failed to connect to child server '${server}': ${reason}`);
    this.name = 'ChildConnectError';
  }
}

export class ChildClient {
  public readonly config: ChildServerConfig;
  public readonly tools: DiscoveredTool[] = [];
  private client?: Client;
  private closed = false;
  /**
   * Memoized connect promise for lazy, race-safe connection.
   *
   * Children are NOT spawned at boot; they are spawned on first use via
   * ensureConnected(). Concurrent callers share this single in-flight promise
   * so a server is never connected twice.
   */
  private connecting?: Promise<void>;

  constructor(
    config: ChildServerConfig,
    private readonly allowlist: ChildAllowlist,
  ) {
    this.config = config;
  }

  /**
   * Connect once, on first use. Idempotent and race-safe: concurrent callers
   * await the same in-flight connect promise. A closed client is not reopened
   * (treated as an error surface for the caller).
   */
  public async ensureConnected(): Promise<void> {
    if (this.closed) {
      throw new ChildConnectError(this.config.name, 'client is closed');
    }
    if (!this.connecting) {
      this.connecting = this.connect().catch((err) => {
        // Do not cache failures: a transient error should be retryable on the
        // next call rather than poisoning this client for the process lifetime.
        this.connecting = undefined;
        throw err;
      });
    }
    return this.connecting;
  }

  public async connect(): Promise<void> {
    if (this.client) return;
    const c = this.config;
    const transport =
      c.transport === 'sse' || c.transport === 'streamable-http' || (c.url && !c.command)
        ? this.buildHttpTransport(c)
        : this.buildStdioTransport(c);

    const client = new Client(
      { name: `mcp-code-mode:${c.name}`, version: '0.1.0' },
      { capabilities: {} },
    );

    const timeout = c.timeoutMs ?? 20000;
    try {
      await withTimeout(client.connect(transport), timeout, c.name);
    } catch (err) {
      throw new ChildConnectError(c.name, err instanceof Error ? err.message : String(err));
    }

    this.client = client;

    const listed = await client.listTools();
    for (const t of listed.tools) {
      this.tools.push({
        name: t.name,
        fqName: `${c.name}_${t.name}`,
        server: c.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
      });
    }
  }

  public async call(toolName: string, args: unknown): Promise<ToolCallResult> {
    await this.ensureConnected();
    if (!this.client) throw new Error(`Child '${this.config.name}' not connected`);
    const res = (await this.client.callTool({
      name: toolName,
      arguments: (args ?? {}) as Record<string, unknown>,
    })) as { content: Array<{ type: string; text?: string; [k: string]: unknown }>; isError?: boolean };
    return { content: res.content ?? [], isError: res.isError };
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client?.close();
    } catch {
      /* ignore close errors */
    }
  }

  private buildStdioTransport(c: ChildServerConfig) {
    if (!c.command) {
      throw new ChildConnectError(c.name, 'stdio transport requires a `command`');
    }
    return new StdioClientTransport({
      command: c.command,
      args: c.args ?? [],
      env: { ...process.env, ...(c.env ?? {}) } as Record<string, string>,
      stderr: 'pipe',
    });
  }

  private buildHttpTransport(c: ChildServerConfig) {
    if (!c.url) throw new ChildConnectError(c.name, 'HTTP transport requires `url`');
    this.allowlist.assertAllowed(c.url);
    const url = new URL(c.url);
    if (c.transport === 'sse') return new SSEClientTransport(url);
    return new StreamableHTTPClientTransport(url);
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, server: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
