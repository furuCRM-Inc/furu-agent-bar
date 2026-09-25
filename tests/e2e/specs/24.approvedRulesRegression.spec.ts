/**
 * 24 — Approved Rules context panel: cacheable-method crash regression
 *
 * Reported live: "show all cases" → a "❌ Script-thrown exception" toast,
 * even though the SOQL results themselves rendered fine.
 *
 * Root cause: FuruAgentController.getApprovedRules() — @AuraEnabled(cacheable=true),
 * fired reactively whenever the bar's sObject context changes (independent of the
 * search itself, and independent of its own .catch(() => {}) in furuAgentBar.js) —
 * had no try/catch around `SELECT Plain_English_Rule__c FROM FuruAgent_Knowledge__c`.
 * That field (along with Status__c, Occurrences__c, and most of the object's other
 * tracked fields) isn't actually deployed on e2e-orgfarm — only Target_sObject__c is
 * live there — so every search that set an sObject context threw a QueryException.
 * Unhandled exceptions from cacheable methods get masked by the platform as the
 * generic "Script-thrown exception" toast, bypassing the caller's own .catch().
 *
 * This isn't Case-specific — any sObject search would have hit it. Fixed by wrapping
 * the query in try/catch and degrading to an empty rule list.
 */
import { test, expect, Page } from '@playwright/test';
import { FuruBarPage } from '../helpers/furuBarPage';

const RAW_ERROR_PATTERNS = /Script-thrown exception|No such column|HTTP 500|検索エラー/i;

test.describe('Approved Rules context panel — cacheable crash regression', () => {
  test.describe.configure({ timeout: 300_000 });
  let bar: FuruBarPage;

  test.beforeEach(async ({ page }) => {
    bar = new FuruBarPage(page);
    await bar.goto();
    await bar.openPanel();
  });

  async function hasErrorToastOrBanner(page: Page): Promise<string | null> {
    // Toasts render outside the LWC's own shadow root at the Lightning App level.
    const toastText = await page.evaluate(() => document.body.innerText ?? '');
    const match = toastText.match(RAW_ERROR_PATTERNS);
    return match ? match[0] : null;
  }

  test('"show all cases" does not surface a Script-thrown exception toast', async ({ page }) => {
    await bar.typeCommand('show all cases');
    await bar.submit();
    await bar.waitForSoqlResults(90_000);

    // Give the reactive context-panel calls (getObjectFieldInsights /
    // getApprovedRules) time to resolve after the sObject context changes.
    await page.waitForTimeout(3_000);

    const found = await hasErrorToastOrBanner(page);
    expect(found, `Unexpected error surfaced on page: "${found}"`).toBeNull();

    const status = await bar.statusText();
    expect(status, `Status: "${status}"`).not.toMatch(RAW_ERROR_PATTERNS);
  });

  test('switching sObject context across multiple searches never crashes', async ({ page }) => {
    for (const cmd of ['show all cases', '取引先を5件見せて', 'show all leads']) {
      await bar.typeCommand(cmd);
      await bar.submit();
      await bar.waitForSoqlResults(90_000);
      await page.waitForTimeout(2_000);

      const found = await hasErrorToastOrBanner(page);
      expect(found, `Unexpected error after "${cmd}": "${found}"`).toBeNull();
    }
  });
});
