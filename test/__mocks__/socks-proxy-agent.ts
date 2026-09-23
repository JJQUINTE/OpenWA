/**
 * Unit-test stub for `socks-proxy-agent` (ESM-only since v9). ts-jest runs in CommonJS mode, so any
 * source file that imports it — directly (baileys-lifecycle) or transitively (anything that pulls in
 * the engine adapters) — fails to load without this stub once the package lands in the unit test
 * graph. The unit suites never open a real proxied socket (the e2e config exercises the real module
 * via transformIgnorePatterns), so a class that records the proxy URL and satisfies the `Agent`
 * return type of createProxyAgent is sufficient — and because the spec's `instanceof` checks import
 * the same mapped module, they run against this very class. `proxy` mirrors the library's parsed
 * object (parseSocksURL: `host` is URL.hostname, brackets included for an IPv6 literal).
 */
import { Agent } from 'node:https';

export class SocksProxyAgent extends Agent {
  readonly proxy: { host?: string; port: number; type: 4 | 5 };
  readonly proxyUrl: string;

  constructor(proxy: string | URL) {
    super();
    const url = typeof proxy === 'string' ? new URL(proxy) : proxy;
    this.proxy = { host: url.hostname, port: Number(url.port) || 1080, type: url.protocol === 'socks4:' ? 4 : 5 };
    this.proxyUrl = url.href;
  }
}
