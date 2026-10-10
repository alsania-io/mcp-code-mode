/**
 * Core types for @alsania-io/mcp-code-mode.
 *
 * A code-mode MCP server that connects to child MCP servers, generates
 * TypeScript interfaces from their tool schemas, and executes LLM-authored
 * TypeScript code that calls those tools.
 *
 * Inspired by:
 *   - CodeAct (Apple, ICML 2024)
 *   - Cloudflare Code Mode
 *   - mcpcodeserver (Zac Bowling, MIT)
 *   - alsania-mcp-toolkit (Alsania, MIT)
 *
 * @license MIT
 */

export interface ChildServerConfig {
  /** Server name (namespaces tool names). */
  name: string;
  /** stdio transport: command to spawn. */
  command?: string;
  /** stdio transport: arguments. */
  args?: string[];
  /** stdio transport: env vars. */
  env?: Record<string, string>;
  /** HTTP/SSE transport: URL. */
  url?: string;
  /** HTTP/SSE transport type. */
  transport?: 'stdio' | 'sse' | 'streamable-http';
  /** Startup timeout in ms. */
  timeoutMs?: number;
}

export interface RootConfig {
  /** Version of the config schema. */
  version: 1;
  /** Child MCP servers to connect to. */
  servers: ChildServerConfig[];
  /** Sandbox settings. */
  sandbox?: SandboxConfig;
  /** Security settings. */
  security?: SecurityConfig;
}

export interface SandboxConfig {
  /** Execution timeout in ms. Default: 30000. Max: 300000. */
  timeoutMs?: number;
  /** Max captured output length per execution. */
  maxOutputBytes?: number;
  /** Record console.log calls into the result. */
  captureConsole?: boolean;
}

export interface SecurityConfig {
  /** Allow http:// URLs when connecting to child servers. Default: false. */
  allowHttp?: boolean;
  /** Allow private/loopback hosts. Default: false. */
  allowPrivateHosts?: boolean;
  /** Host allowlist. Empty = deny all unless allowAllHosts is set. */
  allowedHosts?: string[];
  /** Host patterns (e.g. "*.example.com"). */
  allowedHostPatterns?: string[];
  /** Explicitly allow any host (dangerous). Default: false. */
  allowAllHosts?: boolean;
}

/** A tool discovered from a child server. */
export interface DiscoveredTool {
  /** Tool name (raw from child server). */
  name: string;
  /** Fully-qualified name (server_name + '_' + tool_name). */
  fqName: string;
  /** Owning server name. */
  server: string;
  /** Tool description. */
  description: string;
  /** JSON Schema for the tool inputs. */
  inputSchema: Record<string, unknown>;
}

/** Result of calling a child tool from inside the sandbox. */
export interface ToolCallResult {
  /** Content blocks returned by the child server. */
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  /** True when the child marked the call as an error. */
  isError?: boolean;
}

/** A single TS type declaration block for a group of tools. */
export interface GeneratedTypes {
  /** The TypeScript source to hand to the LLM. */
  source: string;
  /** Per-server tool counts. */
  perServer: Record<string, number>;
  /** Number of type conflicts that were auto-prefixed. */
  conflicts: number;
}

/** Structured sandbox execution result. */
export interface SandboxResult {
  /** Return value of the user's code (if any). */
  result?: unknown;
  /** Console output captured during execution. */
  consoleOutput: string[];
  /** Error message if the code threw. */
  error?: string;
  /** Execution time in ms. */
  durationMs: number;
}
