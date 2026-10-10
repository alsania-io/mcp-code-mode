/**
 * URL allowlist for child server connections.
 *
 * Prevents a misconfigured (or malicious) config from connecting to unexpected
 * hosts. Default-deny.
 *
 * @license MIT
 */

export class ChildBlockedError extends Error {
  public readonly url: string;
  public readonly reason: string;
  constructor(url: string, reason: string) {
    super(`Child server blocked: ${reason} (${url})`);
    this.name = 'ChildBlockedError';
    this.url = url;
    this.reason = reason;
  }
}

export interface AllowlistOptions {
  allowedHosts?: string[];
  allowedHostPatterns?: string[];
  allowHttp?: boolean;
  allowPrivateHosts?: boolean;
  allowAllHosts?: boolean;
}

export class ChildAllowlist {
  private readonly hosts: Set<string>;
  private readonly patterns: RegExp[];
  private readonly allowHttp: boolean;
  private readonly allowPrivateHosts: boolean;
  private readonly allowAllHosts: boolean;

  constructor(opts: AllowlistOptions = {}) {
    this.hosts = new Set((opts.allowedHosts ?? []).map((h) => h.toLowerCase()));
    this.patterns = (opts.allowedHostPatterns ?? []).map(globToRegExp);
    this.allowHttp = opts.allowHttp ?? false;
    this.allowPrivateHosts = opts.allowPrivateHosts ?? false;
    this.allowAllHosts = opts.allowAllHosts ?? false;
  }

  public assertAllowed(rawUrl: string): void {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new ChildBlockedError(rawUrl, 'malformed URL');
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new ChildBlockedError(
        rawUrl,
        `scheme '${parsed.protocol}' not permitted`,
      );
    }

    if (parsed.protocol === 'http:' && !this.allowHttp) {
      throw new ChildBlockedError(rawUrl, 'http:// not permitted');
    }

    const host = parsed.hostname.toLowerCase();

    if (!this.allowPrivateHosts && isPrivateHost(host)) {
      throw new ChildBlockedError(
        rawUrl,
        `private/loopback host '${host}' not permitted`,
      );
    }

    if (this.allowAllHosts) return;

    if (this.hosts.size === 0 && this.patterns.length === 0) {
      throw new ChildBlockedError(
        rawUrl,
        'no hosts configured and allowAllHosts=false',
      );
    }

    if (this.hosts.has(host)) return;
    for (const p of this.patterns) if (p.test(host)) return;

    throw new ChildBlockedError(rawUrl, `host '${host}' not in allowlist`);
  }
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^.]*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function isPrivateHost(host: string): boolean {
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0 || a === 127) return true;
  }
  if (
    host === '::1' ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe80:')
  ) {
    return true;
  }
  return false;
}
