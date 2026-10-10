#!/usr/bin/env node
/**
 * @alsania-io/mcp-code-mode — MCP stdio server.
 *
 * Exposes three meta-tools to any MCP client:
 *   - list_servers           → which child servers are connected
 *   - get_tool_definitions   → TypeScript interfaces (optionally filtered)
 *   - generate_and_execute_code → run LLM-authored TS against child tools
 *   - list_supported_servers  → alias for list_servers (site-consistency)
 *
 * Config:
 *   --config <path>    Path to a JSON config with { servers: [...] }
 *   --help             Show usage
 *
 * @license MIT
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { ChildClient } from './transport/childClient.js';
import { ChildAllowlist } from './security/allowlist.js';
import { generateTypes } from './types/generator.js';
import { runInSandbox } from './sandbox/runner.js';
import type {
  RootConfig,
  SandboxConfig,
  DiscoveredTool,
} from './types.js';

const SERVER_NAME = 'mcp-code-mode';
const SERVER_VERSION = '0.1.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'list_servers',
    description: 'List child MCP servers and their tool counts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_tool_definitions',
    description:
      'Return TypeScript type declarations for the child servers\' tools. Optionally filter by server. Use this before writing code to know the exact function signatures.',
    inputSchema: {
      type: 'object',
      properties: {
        server_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only include tools from these servers. Omit for all.',
        },
        include_examples: {
          type: 'boolean',
          description: 'Include a one-line example call per tool.',
        },
      },
    },
  },
  {
    name: 'generate_and_execute_code',
    description:
      'Execute TypeScript code in a sandbox with all discovered tool functions available. Code is TypeScript with light type hints (types get stripped). Return values should be JSON-serializable.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'TypeScript/JavaScript to execute.' },
        timeout: {
          type: 'number',
          description: 'Max execution time in ms (default 30000, max 300000).',
        },
      },
      required: ['code'],
    },
  },
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const configIdx = args.indexOf('--config');
  if (configIdx === -1 || !args[configIdx + 1]) {
    console.error('[mcp-code-mode] --config <path> is required');
    printHelp();
    process.exit(1);
  }
  const configPath = args[configIdx + 1];

  const config = await loadConfig(configPath);
  const allowlist = new ChildAllowlist({
    allowedHosts: config.security?.allowedHosts,
    allowedHostPatterns: config.security?.allowedHostPatterns,
    allowHttp: config.security?.allowHttp,
    allowPrivateHosts: config.security?.allowPrivateHosts,
    allowAllHosts: config.security?.allowAllHosts,
  });

  // LAZY SPAWN: construct clients for every configured child, but do NOT
  // connect. Children are spawned on first use (get_tool_definitions,
  // list_servers, or generate_and_execute_code) so an idle code-mode process
  // costs zero child processes. See ensureConnected() in transport/childClient.
  const clients = new Map<string, ChildClient>();
  const failures: Array<{ name: string; reason: string }> = [];

  for (const serverConfig of config.servers) {
    clients.set(serverConfig.name, new ChildClient(serverConfig, allowlist));
  }

  /**
   * Connect all configured children on first use. Tolerant: a child that fails
   * to connect is recorded in `failures[]` and simply contributes no tools,
   * matching the previous eager-connect semantics. Idempotent and race-safe
   * per child (memoized in ChildClient.ensureConnected).
   */
  const connectClients = async (): Promise<void> => {
    for (const client of clients.values()) {
      if (client.tools.length > 0) continue;
      try {
        await client.ensureConnected();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (!failures.some((f) => f.name === client.config.name)) {
          failures.push({ name: client.config.name, reason });
        }
      }
    }
  };

  const collectTools = (): DiscoveredTool[] => {
    const all: DiscoveredTool[] = [];
    for (const c of clients.values()) all.push(...c.tools);
    return all;
  };

  const sandboxConfig: SandboxConfig = config.sandbox ?? {};

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    try {
      switch (name) {
        case 'list_servers': {
          await connectClients();
          const servers = [...clients.values()].map((c) => ({
            name: c.config.name,
            tools: c.tools.length,
          }));
          return json({ servers, failures });
        }

        case 'get_tool_definitions': {
          await connectClients();
          const filter = args.server_names as string[] | undefined;
          const allTools = collectTools();
          const tools = filter
            ? allTools.filter((t) => filter.includes(t.server))
            : allTools;
          const generated = generateTypes(tools, {
            includeExamples: Boolean(args.include_examples),
          });
          return text(generated.source);
        }

        case 'generate_and_execute_code': {
          const code = String(args.code ?? '');
          if (!code.trim()) return errorText('No code provided');
          await connectClients();
          const timeoutMs = args.timeout
            ? Math.min(Number(args.timeout), 300000)
            : sandboxConfig.timeoutMs;
          const result = await runInSandbox(code, {
            clients,
            config: { ...sandboxConfig, timeoutMs },
          });
          const chunks: string[] = [];
          if (result.consoleOutput.length > 0) {
            chunks.push('=== Console Output ===');
            chunks.push(result.consoleOutput.join('\n'));
            chunks.push('');
          }
          if (result.error) {
            chunks.push('=== Error ===');
            chunks.push(result.error);
          } else {
            chunks.push('=== Result ===');
            chunks.push(safeJson(result.result));
          }
          chunks.push(`(duration ${result.durationMs}ms)`);
          return text(chunks.join('\n'));
        }

        default:
          return errorText(`Unknown tool: ${name}`);
      }
    } catch (err) {
      return errorText(err instanceof Error ? err.message : String(err));
    }
  });

  // Clean shutdown.
  const shutdown = async () => {
    for (const c of clients.values()) await c.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Expand ${VAR} references in a map of env values using process.env.
 * Unknown vars are left untouched (so a missing key fails loudly in the child
 * rather than being silently passed as an empty string).
 *
 * Exported for tests.
 */
export function expandEnvVars(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = typeof v === 'string'
      ? v.replace(/\$\{([A-Z0-9_]+)\}/gi, (match, name) =>
          process.env[name] !== undefined ? process.env[name]! : match,
        )
      : v;
  }
  return out;
}

async function loadConfig(path: string): Promise<RootConfig> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as RootConfig;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.servers)) {
    throw new Error(`Invalid config at ${path}: expected { version: 1, servers: [...] }`);
  }
  // Expand ${VAR} in each child server's env block from process.env.
  const servers = parsed.servers.map((s) =>
    s.env ? { ...s, env: expandEnvVars(s.env) } : s,
  );
  return { ...parsed, servers, version: 1 };
}

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

function json(v: unknown) {
  return { content: [{ type: 'text' as const, text: safeJson(v) }] };
}

function errorText(s: string) {
  return { isError: true, content: [{ type: 'text' as const, text: s }] };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function printHelp(): void {
  console.log(`
@alsania-io/mcp-code-mode v${SERVER_VERSION}

Usage:
  mcp-code-mode --config <path>

Config shape:
  {
    "version": 1,
    "servers": [
      { "name": "registry", "command": "node", "args": ["..."] },
      { "name": "browser-capture", "command": "node", "args": ["..."] }
    ],
    "sandbox": { "timeoutMs": 30000 },
    "security": { "allowAllHosts": false, "allowedHosts": [] }
  }
`);
}

// Only start the server when executed as the CLI entry, not when imported
// (e.g. by tests). Compares the resolved entry path to this module's URL.
const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((err) => {
    console.error('[mcp-code-mode] fatal:', err);
    process.exit(1);
  });
}
