# @alsania-io/mcp-code-mode

Code-mode MCP server. Connects to child MCP servers, exposes their tools as
TypeScript definitions, and executes LLM-authored code against them in a
sandboxed `node:vm` context.

Collapses N tool-call round-trips into a single code execution. Inspired by
CodeAct (Apple, ICML 2024), Cloudflare Code Mode, and mcpcodeserver.

## Meta-tools exposed

| Tool | Purpose |
|---|---|
| `list_servers` | Enumerate configured child servers and their tool counts. |
| `get_tool_definitions` | Return TypeScript interfaces for child tools (optionally filtered by `server_names`). Call this before writing code. |
| `generate_and_execute_code` | Run LLM-authored TypeScript in a sandbox with all discovered tool functions available. |

## Install

```bash
npm install @alsania-io/mcp-code-mode
```

Or run directly via npx:

```bash
npx @alsania-io/mcp-code-mode --config ./config.json
```

## Config

Point `--config` at a JSON file describing child servers. See `example-config.json`.

```json
{
  "version": 1,
  "servers": [
    { "name": "registry", "command": "node", "args": [".../mcp-server.mjs"] },
    { "name": "context7", "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }
  ],
  "sandbox": { "timeoutMs": 30000, "maxOutputBytes": 200000 },
  "security": { "allowAllHosts": false, "allowedHosts": [] }
}
```

Env values support `${VAR}` expansion from `process.env` at load time. **Never
commit real keys** — use `${VAR}` placeholders.

### Lazy child spawning

Children are **not** spawned at startup. They are constructed at boot and
connected on first use (`list_servers`, `get_tool_definitions`, or
`generate_and_execute_code`). An idle code-mode process holds **zero** child
processes. Connections are memoized and race-safe; a failed connect is recorded
and does not block other children.

## Development

```bash
make install     # install deps
make typecheck   # tsc --noEmit
make test        # vitest
make build       # emit dist/
```

## License

MIT © Alsania

*Imagined by Sigma. Powered by Echo.*
