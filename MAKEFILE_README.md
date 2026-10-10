# Makefile Usage — @alsania-io/mcp-code-mode

| Target | Description |
|---|---|
| `make install` | Install dependencies |
| `make build` | Compile TypeScript to `dist/` |
| `make typecheck` | `tsc --noEmit` |
| `make test` | Run vitest |
| `make lint` | typecheck + test |
| `make clean` | Remove dist, cache, coverage |
| `make all` | install → lint → build |

```bash
make install
make all
```

Node.js >= 20 required.

## Config

Point `--config` at a JSON file describing child MCP servers. See `example-config.json`.

## Running

```bash
node dist/index.js --config example-config.json
```

Register as an MCP server in Claude Desktop, Nyx, or any MCP client.

## What it does

Code-mode MCP server. Exposes three meta-tools:
- `list_servers` — enumerate connected child MCP servers
- `get_tool_definitions` — TypeScript interfaces for child tools
- `generate_and_execute_code` — run LLM-authored TS in a sandbox with all tools available

Reduces token usage by collapsing N tool-call round-trips into one code execution.
Inspired by CodeAct (Apple, ICML 2024) and Cloudflare Code Mode.
