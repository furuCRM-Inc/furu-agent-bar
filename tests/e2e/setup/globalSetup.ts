import { chromium, FullConfig } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

const AUTH_FILE    = path.join(__dirname, '../.auth/sfState.json');
// Separate timestamp file — not sfState.json mtime, which is also written during injection.
const AUTH_TS_FILE = path.join(__dirname, '../.auth/lastAuth.ts.txt');
const E2E_QUERY_NAME = '__e2e_test_accounts__';

// Pre-seeded Account query that bypasses processIntent (AI backend).
// Injected directly into the browser's localStorage so the LWC reads it at connectedCallback.
const E2E_ACCOUNT_QUERY = {
  name:         E2E_QUERY_NAME,
  sObject:      'Account',
  conditions:   [],
  orderBy:      'LastModifiedDate DESC',
  limit:        5,
  selectFields: [
    { apiName: 'Name',             label: '取引先名',   labelEn: 'Name' },
    { apiName: 'Industry',         label: '業種',       labelEn: 'Industry' },
    { apiName: 'AnnualRevenue',    label: '年間売上',   labelEn: 'Revenue' },
    { apiName: 'BillingCity',      label: '市区町村',   labelEn: 'City' },
    { apiName: 'LastActivityDate', label: '最終活動日', labelEn: 'Last Activity' },
  ],
  useCount: 0,
};

async function getSalesforceUserId(instanceUrl: string, accessToken: string): Promise<string> {
  const res = await fetch(`${instanceUrl}/services/oauth2/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`[globalSetup] userinfo fetch failed: ${res.status}`);
  const data = await res.json() as { user_id: string };
  return data.user_id;
}

function getLastAuthAge(): number {
  if (!fs.existsSync(AUTH_TS_FILE)) return Infinity;
  const ts = parseInt(fs.readFileSync(AUTH_TS_FILE, 'utf-8').trim(), 10);
  return isNaN(ts) ? Infinity : Date.now() - ts;
}

function hasE2eQueryInFile(storageKey: string): boolean {
  if (!fs.existsSync(AUTH_FILE)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8')) as {
      origins?: Array<{ localStorage?: Array<{ name: string; value: string }> }>
    };
    for (const origin of (state.origins ?? [])) {
      const entry = (origin.localStorage ?? []).find(e => e.name === storageKey);
      if (entry) {
        const queries = JSON.parse(entry.value) as Array<{ name: string }>;
        return Array.isArray(queries) && queries.some(q => q.name === E2E_QUERY_NAME);
      }
    }
  } catch { /* ignore */ }
  return false;
}

export default async function globalSetup(_config: FullConfig) {
  const instanceUrl = process.env.SF_INSTANCE_URL;
  const accessToken = process.env.SF_ACCESS_TOKEN;
  const appUrl      = process.env.SF_APP_URL ?? '/lightning/page/home';

  if (!instanceUrl || !accessToken) {
    throw new Error('SF_INSTANCE_URL and SF_ACCESS_TOKEN must be set in .env');
  }

  const userId     = await getSalesforceUserId(instanceUrl, accessToken);
  // LWS (Lightning Web Security) sandboxes localStorage — the LWC reads via
  // a proxy that prefixes keys with "LSKey[c]" for the custom (c) namespace.
  // We inject at the raw Storage level, so we must use the same prefixed key.
  const storageKey = `LSKey[c]furubar_qs_${userId.slice(-8)}`;

  // Fast path: recent auth (<25 min) with the e2e query already injected in the file
  if (getLastAuthAge() < 25 * 60 * 1000 && hasE2eQueryInFile(storageKey)) {
    console.log('[globalSetup] Reusing cached session (e2e query present)');
    return;
  }

  // Full login flow
  console.log('[globalSetup] Logging in to Salesforce via access token…');
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: instanceUrl });
  const page    = await context.newPage();

  // Frontdoor URL exchanges a session token for a Lightning session cookie.
  const frontdoor = `${instanceUrl}/secur/frontdoor.jsp?sid=${accessToken}`;
  await page.goto(frontdoor, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForURL(/lightning\.force\.com|\.salesforce\.com\/lightning/, { timeout: 60_000 });
  await page.waitForTimeout(2_000);

  // Dismiss any first-run modals
  for (const sel of ['[title="Dismiss"]', 'button:has-text("後で")', 'button:has-text("Skip")']) {
    const btn = page.locator(sel);
    if (await btn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await btn.click().catch(() => {});
    }
  }

  // Navigate to the app page — this ensures we're on the lightning.force.com origin
  // so that localStorage.setItem() targets the same origin the LWC will read from.
  await page.goto(appUrl, { waitUntil: 'load', timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(3_000);

  // Inject the e2e test query directly into browser localStorage so the LWC
  // reads it at connectedCallback time.  Using page.evaluate guarantees the value
  // lands in the same origin (lightning.force.com) and same storage partition that
  // the LWC component accesses via localStorage.getItem().
  await page.evaluate(
    ({ key, query, queryName }: { key: string; query: object; queryName: string }) => {
      const existing = localStorage.getItem(key);
      let queries: object[] = [];
      if (existing) {
        try { queries = JSON.parse(existing); } catch { /* start fresh */ }
        if (!Array.isArray(queries)) queries = [];
      }
      if (!queries.some((q: any) => q.name === queryName)) {
        queries.unshift(query);
      }
      localStorage.setItem(key, JSON.stringify(queries));
    },
    { key: storageKey, query: E2E_ACCOUNT_QUERY, queryName: E2E_QUERY_NAME }
  );

  // Verify the injection landed
  const injected = await page.evaluate((key: string) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try { return (JSON.parse(raw) as any[])[0]?.name ?? null; } catch { return null; }
  }, storageKey);
  console.log(`[globalSetup] Injected key ${storageKey} → first query name: ${injected}`);

  await context.storageState({ path: AUTH_FILE });
  fs.writeFileSync(AUTH_TS_FILE, String(Date.now()));
  await browser.close();

  console.log('[globalSetup] Session saved to', AUTH_FILE);
}
