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

  /**
   * Submits a command and waits for the bar to settle into ANY outcome (SOQL
   * results, a clarify card, or non-empty status) rather than requiring SOQL
   * results specifically. "show all cases" has no status qualifier (closed/open/
   * etc.), so it doesn't match the Worker's fast-route regex and falls through to
   * full LLM classification, which is slower and occasionally times out — that's
   * an unrelated Worker-latency concern, not the crash this spec targets. On
   * timeout, the crash check below still runs against whatever's on the page.
   */
  async function submitAndSettle(page: Page, command: string, timeout = 60_000): Promise<void> {
    await bar.typeCommand(command);
    await bar.submit();
    await page.waitForFunction(
      () => {
        const b    = document.querySelector('c-furu-agent-bar');
        const root = (b as HTMLElement)?.shadowRoot ?? b!;
        const soql    = root.querySelector('.furu-bar__soql-list, .furu-bar__soql-table');
        const clarify = root.querySelector('.furu-bar__clarify');
        const stat    = (root.querySelector('.furu-bar__status') as HTMLElement)?.innerText?.trim();
        return !!(soql || clarify || stat);
      },
      { timeout }
    ).catch(() => {});
  }

  test('"show all cases" does not surface a Script-thrown exception toast', async ({ page }) => {
    await submitAndSettle(page, 'show all cases');

    // Give the reactive context-panel calls (getObjectFieldInsights /
    // getApprovedRules) time to resolve after the sObject context changes.
    await page.waitForTimeout(3_000);

    const found = await hasErrorToastOrBanner(page);
    expect(found, `Unexpected error surfaced on page: "${found}"`).toBeNull();
  });

  test('switching sObject context across multiple searches never crashes', async ({ page }) => {
    for (const cmd of ['show all cases', '取引先を5件見せて', 'show all leads']) {
      await submitAndSettle(page, cmd);
      await page.waitForTimeout(2_000);

      const found = await hasErrorToastOrBanner(page);
      expect(found, `Unexpected error after "${cmd}": "${found}"`).toBeNull();
    }
  });
});
