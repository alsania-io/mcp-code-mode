/**
 * TypeScript type generator for MCP tools.
 *
 * Turns a list of DiscoveredTool entries into a single .ts source string the
 * LLM can consume. Handles:
 *   - Interface naming per tool
 *   - Auto-prefixing on type-name conflicts
 *   - Promise<ToolCallResult> function signatures
 *
 * @license MIT
 */
import type { DiscoveredTool, GeneratedTypes } from '../types.js';

interface GenOptions {
  /** Include example usage in the emitted docstrings. */
  includeExamples?: boolean;
}

export function generateTypes(
  tools: DiscoveredTool[],
  options: GenOptions = {},
): GeneratedTypes {
  const lines: string[] = [];
  const perServer: Record<string, number> = {};
  let conflicts = 0;

  lines.push('/**');
  lines.push(' * Auto-generated TypeScript definitions for MCP tools.');
  lines.push(' * These are the callable functions available in the sandbox.');
  lines.push(' */');
  lines.push('');
  lines.push('interface ToolContentBlock {');
  lines.push('  type: string;');
  lines.push('  text?: string;');
  lines.push('  [key: string]: unknown;');
  lines.push('}');
  lines.push('');
  lines.push('interface ToolCallResult {');
  lines.push('  content: ToolContentBlock[];');
  lines.push('  isError?: boolean;');
  lines.push('}');
  lines.push('');

  // First pass: detect which param-interface names would collide.
  const nameCounts = new Map<string, number>();
  for (const t of tools) {
    const iface = toPascalCase(t.name) + 'Params';
    nameCounts.set(iface, (nameCounts.get(iface) ?? 0) + 1);
  }

  for (const t of tools) {
    perServer[t.server] = (perServer[t.server] ?? 0) + 1;
    const baseName = toPascalCase(t.name) + 'Params';
    const needsPrefix = (nameCounts.get(baseName) ?? 0) > 1;
    if (needsPrefix) conflicts += 1;
    const ifaceName = needsPrefix
      ? `${toPascalCase(t.server)}${baseName}`
      : baseName;
    const fnName = toTsIdentifier(t.fqName);

    lines.push('/**');
    lines.push(` * ${t.description.replace(/\*\//g, '* /') || t.fqName}`);
    lines.push(` * Server: ${t.server}`);
    lines.push(` * Tool: ${t.name}`);
    if (fnName !== t.fqName) {
      lines.push(` * Call as: ${fnName}`);
    }
    lines.push(' */');
    lines.push(`interface ${ifaceName} ${schemaToInterfaceBody(t.inputSchema)}`);
    lines.push('');
    lines.push(
      `declare function ${fnName}(params: ${ifaceName}): Promise<ToolCallResult>;`,
    );
    lines.push('');

    if (options.includeExamples) {
      const example = buildExampleCall(t);
      if (example) {
        lines.push('/*');
        lines.push(` * Example: ${example}`);
        lines.push(' */');
        lines.push('');
      }
    }
  }

  return { source: lines.join('\n'), perServer, conflicts };
}

function schemaToInterfaceBody(schema: Record<string, unknown>): string {
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  const required = new Set<string>(
    Array.isArray(schema.required) ? (schema.required as string[]) : [],
  );

  const entries = Object.entries(props);
  if (entries.length === 0) return '{}';

  const body: string[] = ['{'];
  for (const [key, val] of entries) {
    const isRequired = required.has(key);
    body.push(
      `  ${JSON.stringify(key)}${isRequired ? '' : '?'}: ${jsonSchemaToTs(val)};`,
    );
  }
  body.push('}');
  return body.join('\n');
}

function jsonSchemaToTs(node: unknown): string {
  if (!node || typeof node !== 'object') return 'unknown';
  const s = node as Record<string, unknown>;

  if (Array.isArray(s.enum) && s.enum.every((v) => typeof v === 'string')) {
    return (s.enum as string[]).map((v) => JSON.stringify(v)).join(' | ');
  }

  if (Array.isArray(s.oneOf)) {
    return (s.oneOf as unknown[]).map(jsonSchemaToTs).join(' | ');
  }
  if (Array.isArray(s.anyOf)) {
    return (s.anyOf as unknown[]).map(jsonSchemaToTs).join(' | ');
  }

  switch (s.type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array':
      return `Array<${jsonSchemaToTs(s.items)}>`;
    case 'object': {
      if (s.properties) return schemaToInterfaceBody(s);
      return 'Record<string, unknown>';
    }
    default:
      return 'unknown';
  }
}

/**
 * Convert a string into a valid TS identifier. Replaces non-identifier chars
 * with underscores. Never starts with a digit.
 *
 * Exported so the sandbox can register tools under the same names.
 */
export function toTsIdentifier(s: string): string {
  let out = s.replace(/[^a-zA-Z0-9_$]/g, '_');
  if (!/^[a-zA-Z_$]/.test(out)) out = '_' + out;
  return out;
}

function toPascalCase(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

function buildExampleCall(t: DiscoveredTool): string | undefined {
  const fnName = toTsIdentifier(t.fqName);
  const props = (t.inputSchema.properties ?? {}) as Record<string, unknown>;
  const required = new Set<string>(
    Array.isArray(t.inputSchema.required) ? (t.inputSchema.required as string[]) : [],
  );
  const argNames = Object.keys(props).filter((k) => required.has(k));
  if (argNames.length === 0) return `await ${fnName}({});`;
  const args = argNames.map((k) => `${k}: /* ${jsonSchemaToTs(props[k])} */`).join(', ');
  return `await ${fnName}({ ${args} });`;
}
