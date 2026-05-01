/**
 * Minimal type declarations for Node.js built-in undici module.
 * undici is bundled with Node.js 18+; these declarations allow dynamic imports.
 */
declare module "undici" {
  export class ProxyAgent {
    constructor(proxyUrl: string | { uri: string });
  }
  export class EnvHttpProxyAgent {
    constructor(opts?: { httpProxy?: string; httpsProxy?: string; noProxy?: string });
  }
}
