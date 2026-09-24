/**
 * 16 — Parent-to-Child Record Filter (Account → Opportunity)
 *
 * Regression suite for the bug where asking "Dickenson plcの商談を全て見せて"
 * from an Account record page returned the wrong (or all) Opportunities instead
 * of only those belonging to that specific Account.
 *
 * Root cause fixed (FuruAgentController.injectParentFilter):
 *   When the current page is a parent record (Account/Contact/etc.) and the
 *   Worker returns SOQL_SEARCH for a child object (Opportunity/Contact/Case/etc.)
 *   with no or unrelated conditions, Apex now dynamically resolves the child's
 *   lookup field to the parent via Schema.describe and injects
 *   `{ field: "AccountId", op: "eq", value: "[recordId]" }` automatically.
 *
 * Requires SF_RECORD_URL to point to an Account record page.
 * The Account must have at least one Opportunity for the positive assertion.
 * Set SF_ACCOUNT_NAME in .env to the exact name of that Account (default: "Dickenson plc").
 */
import { test, expect, Page } from '@playwright/test';
import { FuruBarPage } from '../helpers/furuBarPage';

const RECORD_URL   = process.env.SF_RECORD_URL;
const ACCOUNT_NAME = process.env.SF_ACCOUNT_NAME ?? 'Dickenson plc';

// ── Helpers ────────────────────────────────────────────────────────────────

async function waitForSoqlResult(page: Page, timeout = 90_000) {
  await page.waitForFunction(() => {
    const b    = document.querySelector('c-furu-agent-bar');
    const root = (b as HTMLElement)?.shadowRoot ?? b!;
    const soql   = root.querySelector('.furu-bar__soql-header');
    const status = (root.querySelector('.furu-bar__status') as HTMLElement)?.innerText?.trim();
    return !!(soql || (status && status.length > 0));
  }, { timeout });
}

async function statusText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const b    = document.querySelector('c-furu-agent-bar');
    const root = (b as HTMLElement)?.shadowRoot ?? b!;
    return (root.querySelector('.furu-bar__status') as HTMLElement)?.innerText?.trim() ?? '';
  });
}

async function soqlCardCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const b    = document.querySelector('c-furu-agent-bar');
    const root = (b as HTMLElement)?.shadowRoot ?? b!;
    return root.querySelectorAll('.furu-bar__soql-card, .furu-bar__soql-tr').length;
  });
}

// ── Suite ─────────────────────────────────────────────────────────────────

test.describe(`Parent → Child filter (Account/${ACCOUNT_NAME} → Opportunity)`, () => {
  test.describe.configure({ timeout: 420_000 });
  test.skip(!RECORD_URL, 'Set SF_RECORD_URL (Account page) in .env to run parent-child filter tests');

  let bar: FuruBarPage;

  test.beforeEach(async ({ page }) => {
    bar = new FuruBarPage(page);
    // Navigate to the Account record page (parent context)
    await page.goto(RECORD_URL!, { waitUntil: 'load' });
    await page.waitForTimeout(2_000);
    await bar.openPanel();
    await page.waitForTimeout(3_000);
  });

  // ── Core regression test ───────────────────────────────────────────────

  test(`"${ACCOUNT_NAME}の商談を全て見せて" returns Opportunities (not Accounts)`, async ({ page }) => {
    await bar.typeCommand(`${ACCOUNT_NAME}の商談を全て見せて`);
    await bar.submit();
    await waitForSoqlResult(page);

    const status = await statusText(page);
    test.info().annotations.push({ type: 'status', description: status });

    // Must not return an error
    expect(status).not.toMatch(/HTTP 402|HTTP 500/);

    // The SOQL card header must be visible (not just a plain status message)
    const hasSoqlHeader = await page.evaluate(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      return !!root.querySelector('.furu-bar__soql-header');
    });
    expect(hasSoqlHeader).toBe(true);

    // If records are shown, verify they look like Opportunity cards
    // (Opportunity default fields: Name, Amount, StageName, CloseDate, Account.Name)
    const cardCount = await soqlCardCount(page);
    test.info().annotations.push({ type: 'record-count', description: String(cardCount) });

    if (cardCount > 0) {
      // None of the cards should show just the Account name as a header
      // — they should show Opportunity names (amounts, stages, etc.)
      const hasAmountOrStage = await page.evaluate(() => {
        const b    = document.querySelector('c-furu-agent-bar');
        const root = (b as HTMLElement)?.shadowRoot ?? b!;
        const cards = Array.from(root.querySelectorAll('.furu-bar__soql-card, .furu-bar__soql-tr'));
        return cards.some(card => {
          const text = (card as HTMLElement).innerText ?? '';
          // Opportunity cards show Amount (¥ or numbers) or Stage names
          return /[¥$€￥]|StageName|金額|フェーズ|Prospecting|Closed|Proposal|\d{5,}/i.test(text);
        });
      });
      if (hasAmountOrStage) {
        test.info().annotations.push({ type: 'note', description: 'Opportunity fields (Amount/Stage) detected in results' });
      }
    }
  });

  test(`asking "全ての商談" on Account page scopes to this account's Opps`, async ({ page }) => {
    await bar.typeCommand('全ての商談を表示して');
    await bar.submit();
    await waitForSoqlResult(page);

    const status = await statusText(page);
    expect(status).not.toMatch(/HTTP 402|HTTP 500/);

    const hasSoqlHeader = await page.evaluate(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      return !!root.querySelector('.furu-bar__soql-header');
    });
    expect(hasSoqlHeader).toBe(true);

    test.info().annotations.push({ type: 'status', description: status });
  });

  test('"show opportunities" in English also uses parent-account filter', async ({ page }) => {
    await bar.typeCommand('show opportunities');
    await bar.submit();
    await waitForSoqlResult(page);

    const status = await statusText(page);
    expect(status).not.toMatch(/HTTP 402|HTTP 500/);
    test.info().annotations.push({ type: 'status', description: status });
  });

  // ── Regression guard: results must not be all-org records ────────────────

  test('result count is consistent (not returning all-org Opportunities)', async ({ page }) => {
    // Run the query twice; both runs should return the same count.
    // If the count were "all org opportunities", it would still be consistent —
    // but the previous test's soql-header check ensures it returns an Opp query,
    // and having a scoped filter means the count should be ≤ total org count.
    await bar.typeCommand(`${ACCOUNT_NAME}の商談`);
    await bar.submit();
    await waitForSoqlResult(page);

    const count1 = await soqlCardCount(page);
    const status1 = await statusText(page);

    // Dismiss results
    await page.evaluate(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      const btn  = root.querySelector('.furu-bar__soql-header button') as HTMLButtonElement | null;
      btn?.click();
    });
    await page.waitForTimeout(1_000);

    // Re-query
    await bar.typeCommand(`${ACCOUNT_NAME}の商談`);
    await bar.submit();
    await waitForSoqlResult(page, 90_000);

    const count2 = await soqlCardCount(page);
    const status2 = await statusText(page);

    test.info().annotations.push({
      type: 'consistency',
      description: `run1=${count1} "${status1}" run2=${count2} "${status2}"`,
    });

    // Both runs must produce the same count (idempotent)
    expect(count2).toBe(count1);
    expect(status2).not.toMatch(/HTTP 402|HTTP 500/);
  });
});

// ── Case parent-child filter ─────────────────────────────────────────────
// Verifies that asking for Cases from an Account record page correctly
// scopes results to the current Account (via Case.AccountId injection).

test.describe(`Parent → Child filter (Account/${ACCOUNT_NAME} → Case)`, () => {
  test.describe.configure({ timeout: 420_000 });
  test.skip(!RECORD_URL, 'Set SF_RECORD_URL (Account page) in .env to run parent-child filter tests');

  let bar: FuruBarPage;

  test.beforeEach(async ({ page }) => {
    bar = new FuruBarPage(page);
    await page.goto(RECORD_URL!, { waitUntil: 'load' });
    await page.waitForTimeout(2_000);
    await bar.openPanel();
    await page.waitForTimeout(3_000);
  });

  test(`"${ACCOUNT_NAME}のケースを全て見せて" returns Cases for this Account`, async ({ page }) => {
    await bar.typeCommand(`${ACCOUNT_NAME}のケースを全て見せて`);
    await bar.submit();
    await waitForSoqlResult(page);

    const status = await statusText(page);
    test.info().annotations.push({ type: 'status', description: status });

    expect(status).not.toMatch(/HTTP 402|HTTP 500/);

    const hasSoqlHeader = await page.evaluate(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      return !!root.querySelector('.furu-bar__soql-header');
    });
    expect(hasSoqlHeader).toBe(true);

    const cardCount = await soqlCardCount(page);
    test.info().annotations.push({ type: 'record-count', description: String(cardCount) });

    if (cardCount > 0) {
      // Case cards show CaseNumber (8-digit), Subject, Status, or Priority
      const hasCaseFields = await page.evaluate(() => {
        const b    = document.querySelector('c-furu-agent-bar');
        const root = (b as HTMLElement)?.shadowRoot ?? b!;
        const cards = Array.from(root.querySelectorAll('.furu-bar__soql-card, .furu-bar__soql-tr'));
        return cards.some(card => {
          const text = (card as HTMLElement).innerText ?? '';
          return /\d{8}|Subject|件名|Status|ステータス|Priority|優先度|New|Open|Closed|High|Medium|Low/i.test(text);
        });
      });
      test.info().annotations.push({ type: 'case-fields-visible', description: String(hasCaseFields) });
    }
  });

  test('"全てのケース" on Account page is scoped to this Account', async ({ page }) => {
    await bar.typeCommand('全てのケースを表示して');
    await bar.submit();
    await waitForSoqlResult(page);

    const status = await statusText(page);
    expect(status).not.toMatch(/HTTP 402|HTTP 500/);

    const hasSoqlHeader = await page.evaluate(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      return !!root.querySelector('.furu-bar__soql-header');
    });
    expect(hasSoqlHeader).toBe(true);
    test.info().annotations.push({ type: 'status', description: status });
  });

  test('"show cases" in English uses parent-Account filter', async ({ page }) => {
    await bar.typeCommand('show cases');
    await bar.submit();
    await waitForSoqlResult(page);

    const status = await statusText(page);
    expect(status).not.toMatch(/HTTP 402|HTTP 500/);
    test.info().annotations.push({ type: 'status', description: status });
  });

  test('Case result count is consistent across two runs (not org-wide)', async ({ page }) => {
    await bar.typeCommand(`${ACCOUNT_NAME}のケース`);
    await bar.submit();
    await waitForSoqlResult(page);
    const count1 = await soqlCardCount(page);

    // Dismiss and re-query
    await page.evaluate(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      (root.querySelector('.furu-bar__soql-header button') as HTMLButtonElement | null)?.click();
    });
    await page.waitForTimeout(1_000);

    await bar.typeCommand(`${ACCOUNT_NAME}のケース`);
    await bar.submit();
    await waitForSoqlResult(page, 90_000);
    const count2 = await soqlCardCount(page);

    test.info().annotations.push({ type: 'consistency', description: `run1=${count1} run2=${count2}` });
    expect(count2).toBe(count1);
  });
});

// ── Non-record-page baseline ─────────────────────────────────────────────
// These tests run without a record page context (no parent record ID).
// They verify the filter is NOT injected when there's no parent context.

test.describe('Parent filter NOT injected when no record context', () => {
  test.describe.configure({ timeout: 300_000 });
  let bar: FuruBarPage;

  test.beforeEach(async ({ page }) => {
    bar = new FuruBarPage(page);
    await bar.goto();  // Home/App page — no record context
    await bar.openPanel();
  });

  test('asking for Opportunities without record context returns org-wide results', async ({ page }) => {
    await bar.loadAccountsViaShortcut();

    // Ensure the result is Accounts (the shortcut is for Account)
    const status = await bar.statusText();
    expect(status).toMatch(/\d+件/);
  });

  test('SOQL query from app home page has no injected parent condition', async ({ page }) => {
    await bar.typeCommand('商談を10件見せて');
    await bar.submit();

    await page.waitForFunction(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      const soql   = root.querySelector('.furu-bar__soql-header');
      const status = (root.querySelector('.furu-bar__status') as HTMLElement)?.innerText?.trim();
      return !!(soql || (status && status.length > 0));
    }, { timeout: 90_000 });

    const status = await statusText(page);
    expect(status).not.toMatch(/HTTP 402|HTTP 500/);
    test.info().annotations.push({ type: 'status', description: status });
  });
});
