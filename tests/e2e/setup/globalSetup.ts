/**
 * globalSetup — Playwright session builder for FlashBar AI E2E tests.
 *
 * Auth strategy:
 *   Admin  → frontdoor.jsp (SF_ADMIN_ACCESS_TOKEN)
 *   EN/JA  → admin frontdoor.jsp → servlet.su "Login As" switch
 *            (org has enableAdminLoginAsAnyUser=true, so no device-verification prompt)
 */
import { chromium, FullConfig } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

const AUTH_EN    = path.join(__dirname, '../.auth/sfState.en.json');
const AUTH_JA    = path.join(__dirname, '../.auth/sfState.ja.json');
const AUTH_ADMIN = path.join(__dirname, '../.auth/sfAdminState.json');
const AUTH_TS    = path.join(__dirname, '../.auth/lastAuth.ts.txt');

const E2E_QUERY_NAME = '__e2e_test_accounts__';
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

// ── Helpers ─────────────────────────────────────────────────────────────────

async function getUserId(instanceUrl: string, accessToken: string): Promise<string> {
  const res = await fetch(`${instanceUrl}/services/oauth2/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`[globalSetup] userinfo fetch failed: ${res.status}`);
  const data = await res.json() as { user_id: string; organization_id: string };
  return data.user_id;
}

async function getOrgId(instanceUrl: string, accessToken: string): Promise<string> {
  const res = await fetch(`${instanceUrl}/services/oauth2/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`[globalSetup] userinfo fetch failed: ${res.status}`);
  const data = await res.json() as { user_id: string; organization_id: string };
  return data.organization_id;
}

function getLastAuthAge(): number {
  if (!fs.existsSync(AUTH_TS)) return Infinity;
  const ts = parseInt(fs.readFileSync(AUTH_TS, 'utf-8').trim(), 10);
  return isNaN(ts) ? Infinity : Date.now() - ts;
}

function hasE2eQuery(authFile: string, storageKey: string): boolean {
  if (!fs.existsSync(authFile)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(authFile, 'utf-8')) as {
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

async function injectE2eQuery(page: any, storageKey: string): Promise<void> {
  await page.evaluate(
    ({ key, query, queryName }: { key: string; query: object; queryName: string }) => {
      const existing = localStorage.getItem(key);
      let queries: object[] = [];
      if (existing) {
        try { queries = JSON.parse(existing); } catch { /* start fresh */ }
        if (!Array.isArray(queries)) queries = [];
      }
      if (!queries.some((q: any) => q.name === queryName)) queries.unshift(query);
      localStorage.setItem(key, JSON.stringify(queries));
    },
    { key: storageKey, query: E2E_ACCOUNT_QUERY, queryName: E2E_QUERY_NAME },
  );
}

async function dismissModals(page: any): Promise<void> {
  for (const sel of ['[title="Dismiss"]', 'button:has-text("後で")', 'button:has-text("Skip")']) {
    const btn = page.locator(sel);
    if (await btn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await btn.click().catch(() => {});
    }
  }
}

// ── Admin session via frontdoor.jsp ──────────────────────────────────────────

async function buildAdminSession(
  instanceUrl: string,
  accessToken: string,
  appUrl: string,
  outputFile: string,
): Promise<void> {
  const adminUserId = await getUserId(instanceUrl, accessToken);
  const storageKey  = `LSKey[c]furubar_qs_${adminUserId.slice(-8)}`;

  if (getLastAuthAge() < 25 * 60 * 1000 && hasE2eQuery(outputFile, storageKey)) {
    console.log('[globalSetup] Reusing cached admin session');
    return;
  }

  console.log('[globalSetup] Building admin session…');
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: instanceUrl });
  const page    = await context.newPage();

  await page.goto(`${instanceUrl}/secur/frontdoor.jsp?sid=${accessToken}`, {
    waitUntil: 'load', timeout: 60_000,
  });
  await page.waitForURL(/\/lightning\//, { timeout: 60_000 });
  await page.waitForTimeout(2_000);
  await dismissModals(page);

  await page.goto(`${instanceUrl}${appUrl}`, { waitUntil: 'load', timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(3_000);
  await injectE2eQuery(page, storageKey);

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  await context.storageState({ path: outputFile });
  await browser.close();
  console.log('[globalSetup][admin] Session saved to', outputFile);
}

// ── User session via admin "Login As" (servlet.su) ────────────────────────────
// Requires org setting: enableAdminLoginAsAnyUser = true

async function buildUserSessionViaLoginAs(
  instanceUrl: string,
  adminToken: string,
  targetUserId: string,
  orgId: string,
  adminUserId: string,
  appUrl: string,
  outputFile: string,
  label: string,
): Promise<void> {
  console.log(`[globalSetup] Building ${label} session via Login As…`);
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: instanceUrl });
  const page    = await context.newPage();

  // Step 1: Establish admin session via frontdoor.jsp
  await page.goto(`${instanceUrl}/secur/frontdoor.jsp?sid=${adminToken}`, {
    waitUntil: 'load', timeout: 60_000,
  });
  await page.waitForURL(/\/lightning\//, { timeout: 60_000 });
  await page.waitForTimeout(1_000);

  // Step 2: Switch to target user via servlet.su
  const loginAsUrl = `${instanceUrl}/servlet/servlet.su` +
    `?oid=${orgId}` +
    `&suorgadminid=${adminUserId}` +
    `&targetURL=${encodeURIComponent(instanceUrl + appUrl)}` +
    `&loginAsUserId=${targetUserId}`;

  await page.goto(loginAsUrl, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForURL(/\/lightning\//, { timeout: 60_000 });
  await page.waitForTimeout(3_000);
  await dismissModals(page);

  await page.goto(`${instanceUrl}${appUrl}`, { waitUntil: 'load', timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(3_000);

  // Derive the localStorage key from the known targetUserId — no in-browser fetch needed.
  const storageKey = `LSKey[c]furubar_qs_${targetUserId.slice(-8)}`;
  await injectE2eQuery(page, storageKey);
  console.log(`[globalSetup][${label}] Injected e2e query at key ${storageKey}`);

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  await context.storageState({ path: outputFile });
  await browser.close();
  console.log(`[globalSetup][${label}] Session saved to ${outputFile}`);
}

// ── Entry point ─────────────────────────────────────────────────────────────

export default async function globalSetup(_config: FullConfig) {
  const instanceUrl = process.env.SF_INSTANCE_URL!;
  const appUrl      = process.env.SF_APP_URL ?? '/lightning/page/home';
  const adminToken  = process.env.SF_ADMIN_ACCESS_TOKEN!;

  if (!instanceUrl) throw new Error('SF_INSTANCE_URL must be set in .env');
  if (!adminToken)  throw new Error('SF_ADMIN_ACCESS_TOKEN must be set in .env');

  const orgId      = await getOrgId(instanceUrl, adminToken);
  const adminUserId = await getUserId(instanceUrl, adminToken);

  // Admin session
  await buildAdminSession(instanceUrl, adminToken, appUrl, AUTH_ADMIN);

  // EN user — Login As (no device verification)
  await buildUserSessionViaLoginAs(
    instanceUrl, adminToken,
    '005aj00000eophpAAA', // flashbar.test.en
    orgId, adminUserId, appUrl, AUTH_EN, 'en-user',
  );

  // JA user — Login As (no device verification)
  await buildUserSessionViaLoginAs(
    instanceUrl, adminToken,
    '005aj00000eophqAAA', // flashbar.test.ja
    orgId, adminUserId, appUrl, AUTH_JA, 'ja-user',
  );

  fs.mkdirSync(path.dirname(AUTH_TS), { recursive: true });
  fs.writeFileSync(AUTH_TS, String(Date.now()));
}
