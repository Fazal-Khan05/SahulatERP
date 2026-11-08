import type { FullConfig } from '@playwright/test';

/**
 * Warms the dev server before the suite. In development Next compiles each route on its first
 * request; a POST that arrives during that compile can lose its body, which shows up as a
 * misleading 500. Hitting the routes once up front keeps the tests deterministic.
 */
export default async function globalSetup(config: FullConfig) {
  const base = config.projects[0]?.use.baseURL ?? 'http://127.0.0.1:3000';
  for (const path of ['/', '/api/workspace', '/account/reset', '/auth/password', '/auth/signin', '/auth/forgot', '/print/sales_invoice/warm-up', '/api/branding/logo']) {
    await fetch(`${base}${path}`).catch(() => undefined);
  }
}
