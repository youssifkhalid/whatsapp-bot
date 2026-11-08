import type { WwebClient } from './wwebjs-adapter.ts';

export interface WwebFactoryOptions {
  /** Directory for the persistent session (LocalAuth). Must be on a persistent volume. */
  sessionDir: string;
  /** Path to a system Chromium/Chrome. Required in Docker images that do not bundle one. */
  chromiumPath?: string;
}

/**
 * Builds a real whatsapp-web.js client. UNVERIFIED: this file needs the `whatsapp-web.js` package
 * (not installable in the build sandbox) and has not been run against a real account.
 * The package name is held in a variable so TypeScript does not require its types here.
 */
export async function createWwebjsClientFactory(opts: WwebFactoryOptions): Promise<() => WwebClient> {
  const pkg = 'whatsapp-web.js';
  const mod = (await import(pkg)) as { default?: Record<string, unknown> } & Record<string, unknown>;
  const lib = (mod.default ?? mod) as {
    Client: new (o: unknown) => WwebClient;
    LocalAuth: new (o: unknown) => unknown;
  };
  return () =>
    new lib.Client({
      authStrategy: new lib.LocalAuth({ dataPath: opts.sessionDir }),
      puppeteer: {
        headless: true,
        ...(opts.chromiumPath ? { executablePath: opts.chromiumPath } : {}),
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      },
    });
}
