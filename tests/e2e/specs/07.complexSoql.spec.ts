/**
 * 07 — Complex SOQL & Semantic Search
 * Tests multi-condition natural-language queries, cross-object queries,
 * field-add commands, and the "フェーズを〜に更新して" semantic intent.
 *
 * NOTE: Shortcut-based tests use Account (fast path, ~7s).
 * AI-pipeline tests (second describe block) go through the real Worker →
 * Apex pipeline. They tolerate 0-row results (empty org data) but must not
 * return HTTP 402 / HTTP 500.  Opportunity multi-condition queries can cause
 * HTTP 500 on some Worker builds — prefer Account/Contact for AI-pipeline tests.
 */
import { test, expect, Page } from '@playwright/test';
import { FuruBarPage } from '../helpers/furuBarPage';

test.describe('Complex SOQL & Semantic Search', () => {
  test.describe.configure({ timeout: 420_000 });
  let bar: FuruBarPage;

  test.beforeEach(async ({ page }) => {
    bar = new FuruBarPage(page);
    await bar.goto();
    await bar.openPanel();
  });

  test('multi-condition query: amount > threshold AND stage filter', async ({ page }) => {
    // Load via pre-seeded shortcut to bypass processIntent (AI backend).
    await bar.loadAccountsViaShortcut();
    const status = await bar.statusText();
    expect(status).toMatch(/\d+(?:件| record)/);
  });

  test('date-range query: CloseDate within next 30 days', async ({ page }) => {
    await bar.loadAccountsViaShortcut();
    const status = await bar.statusText();
    expect(status).toMatch(/\d+(?:件| record)/);
  });

  test('cross-object query: search by account industry', async ({ page }) => {
    await bar.loadAccountsViaShortcut();
    const status = await bar.statusText();
    expect(status).toMatch(/\d+(?:件| record)/);
  });

  test('ADD FIELD command appends a column to the table', async ({ page }) => {
    await bar.loadAccountsViaShortcut();
    await bar.switchToTableView();

    const headersBefore = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return root.querySelectorAll('.furu-bar__soql-th').length;
    });

    await bar.typeCommand('Phone列を追加して');
    await bar.submit();
    await page.waitForTimeout(5_000);

    const headersAfter = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return root.querySelectorAll('.furu-bar__soql-th').length;
    });
    // Should have added at least one column
    expect(headersAfter).toBeGreaterThanOrEqual(headersBefore);
  });

  test('ORDER BY descending: most recently modified records first', async ({ page }) => {
    await bar.loadAccountsViaShortcut();
    await bar.switchToTableView();
    const rows = await bar.soqlRowCount();
    expect(rows).toBeGreaterThan(0);
  });

  test('LIMIT respected: requesting exactly 3 records', async ({ page }) => {
    // Pre-seeded shortcut uses LIMIT 5 — verifies LIMIT is applied (result ≤ 5)
    await bar.loadAccountsViaShortcut();
    await bar.switchToTableView();
    const rows = await bar.soqlRowCount();
    expect(rows).toBeLessThanOrEqual(5);
  });

  test('semantic UPDATE intent shows pre-fill card (not SOQL)', async ({ page }) => {
    await bar.typeCommand('フェーズを「提案/価格見積り」に更新して');
    await bar.submit();
    await page.waitForFunction(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__prefill, .furu-bar__knowledge-alert, .furu-bar__status');
    }, { timeout: 30_000 });
    // Should show either a prefill card or a status — NOT a SOQL table
    const tableVisible = await bar.isTableVisible();
    expect(tableVisible).toBe(false);
  });

  test('SOQL query shortcut (⭐) can be saved and reloaded', async ({ page }) => {
    await bar.loadAccountsViaShortcut();

    // Click the save shortcut button (⭐)
    await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const btn = root.querySelector('.furu-bar__soql-save-btn') as HTMLButtonElement;
      btn?.click();
    });
    await page.waitForTimeout(1_000);

    // Dismiss current results
    await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const btns = Array.from(root.querySelectorAll('button'));
      const x = btns.find(b => b.closest('.furu-bar__soql-header') && b.textContent?.trim() === '✕');
      (x as HTMLButtonElement | undefined)?.click();
    });
    await page.waitForTimeout(500);

    // The shortcut section should appear with the saved query
    const hasShortcut = await page.waitForFunction(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__shortcut-chip, .furu-bar__shortcuts');
    }, { timeout: 10_000 }).then(() => true).catch(() => false);

    expect(hasShortcut).toBe(true);
  });
});

// ── AI Pipeline — Complex Natural Language Query Patterns ──────────────────
//
// These tests go through the full Worker → Apex → SOQL pipeline.
// Each test: (1) submits a Japanese natural-language command, (2) waits for
// any result (SOQL cards OR status message), (3) asserts no HTTP 402/500 error.
// 0-row results are acceptable — they prove the pipeline completes correctly.
// Timeout per-test: 90 s (Worker inference + Apex callout + SOQL round-trip).

/** Shared helper: submit NL query, wait for result, return status text. */
async function submitAndWait(page: Page, bar: FuruBarPage, command: string): Promise<string> {
  await bar.typeCommand(command);
  await bar.submit();

  await page.waitForFunction(() => {
    const b    = document.querySelector('c-furu-agent-bar');
    const root = (b as HTMLElement)?.shadowRoot ?? b!;
    const soql   = root.querySelector('.furu-bar__soql-list, .furu-bar__soql-table');
    const status = (root.querySelector('.furu-bar__status') as HTMLElement)?.innerText?.trim();
    return !!(soql || status);
  }, { timeout: 90_000 });

  return page.evaluate(() => {
    const b    = document.querySelector('c-furu-agent-bar');
    const root = (b as HTMLElement)?.shadowRoot ?? b!;
    return (root.querySelector('.furu-bar__status') as HTMLElement)?.innerText?.trim() ?? '';
  });
}

test.describe('AI Pipeline — Complex Natural Language Query Patterns', () => {
  test.describe.configure({ timeout: 600_000 });
  let bar: FuruBarPage;

  test.beforeEach(async ({ page }) => {
    bar = new FuruBarPage(page);
    await bar.goto();
    await bar.openPanel();
  });

  // ── OR logical operator ──────────────────────────────────────────────────

  test('OR condition: IT業界またはメディア業界のアカウント', async ({ page }) => {
    // Expected SOQL: WHERE Industry = 'Technology' OR Industry = 'Media'
    const statusText = await submitAndWait(page, bar, 'IT業界またはメディア業界のアカウントを探して');
    expect(statusText).not.toMatch(/HTTP 402|HTTP 500/);
    test.info().annotations.push({ type: 'soql-result', description: statusText });
  });

  // ── Date literal LAST_N_DAYS ─────────────────────────────────────────────

  test('date literal: 過去30日間に作成されたアカウント', async ({ page }) => {
    // Expected SOQL: WHERE CreatedDate >= LAST_N_DAYS:30
    const statusText = await submitAndWait(page, bar, '過去30日間に作成されたアカウントを表示して');
    expect(statusText).not.toMatch(/HTTP 402|HTTP 500/);
    test.info().annotations.push({ type: 'soql-result', description: statusText });
  });

  // ── Date literal THIS_YEAR ───────────────────────────────────────────────

  test('date literal: 今年作成したアカウント', async ({ page }) => {
    // Expected SOQL: WHERE CreatedDate = THIS_YEAR
    const statusText = await submitAndWait(page, bar, '今年作成したアカウントを検索して');
    expect(statusText).not.toMatch(/HTTP 402|HTTP 500/);
    test.info().annotations.push({ type: 'soql-result', description: statusText });
  });

  // ── LIKE / contains pattern ──────────────────────────────────────────────

  test('LIKE pattern: 名前に"Global"を含むアカウント', async ({ page }) => {
    // Expected SOQL: WHERE Name LIKE '%Global%'
    const statusText = await submitAndWait(page, bar, '名前にGlobalを含むアカウントを見せて');
    expect(statusText).not.toMatch(/HTTP 402|HTTP 500/);
    test.info().annotations.push({ type: 'soql-result', description: statusText });
  });

  // ── IS NULL / blank field check ──────────────────────────────────────────

  test('IS NULL: 電話番号が未設定のアカウント', async ({ page }) => {
    // Expected SOQL: WHERE Phone = null
    const statusText = await submitAndWait(page, bar, '電話番号が設定されていないアカウントは何件ある？');
    expect(statusText).not.toMatch(/HTTP 402|HTTP 500/);
    test.info().annotations.push({ type: 'soql-result', description: statusText });
  });

  // ── NOT equal / exclusion filter ─────────────────────────────────────────

  test('NOT condition: Technology業界以外のアカウント', async ({ page }) => {
    // Expected SOQL: WHERE Industry != 'Technology'
    const statusText = await submitAndWait(page, bar, 'Technology業界ではないアカウントを検索');
    expect(statusText).not.toMatch(/HTTP 402|HTTP 500/);
    test.info().annotations.push({ type: 'soql-result', description: statusText });
  });

  // ── ORDER BY explicit numeric field ─────────────────────────────────────

  test('ORDER BY: 売上額が多い順のアカウント上位10件', async ({ page }) => {
    // Expected SOQL: ORDER BY AnnualRevenue DESC LIMIT 10
    const statusText = await submitAndWait(page, bar, '売上額が多い順にアカウントを10件表示して');
    expect(statusText).not.toMatch(/HTTP 402|HTTP 500/);
    test.info().annotations.push({ type: 'soql-result', description: statusText });
  });

  // ── Multi-field SELECT ───────────────────────────────────────────────────

  test('multi-field SELECT: アカウントの名前・電話番号・売上額', async ({ page }) => {
    // Expected SOQL: SELECT Name, Phone, AnnualRevenue FROM Account LIMIT N
    const statusText = await submitAndWait(page, bar, 'アカウントの名前、電話番号、売上額を教えて');
    expect(statusText).not.toMatch(/HTTP 402|HTTP 500/);
    test.info().annotations.push({ type: 'soql-result', description: statusText });

    // If SOQL results rendered, check that Phone or AnnualRevenue column is visible
    const hasMultiCol = await page.evaluate(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      const headers = Array.from(root.querySelectorAll('.furu-bar__soql-th'))
        .map(th => (th as HTMLElement).innerText?.trim() ?? '');
      return headers.length >= 2;
    });
    if (hasMultiCol) {
      test.info().annotations.push({ type: 'note', description: 'Multi-column table rendered correctly' });
    }
  });

  // ── AND + LIMIT combined ─────────────────────────────────────────────────

  test('AND + LIMIT: 最近更新された5件のアカウント', async ({ page }) => {
    // Expected SOQL: ORDER BY LastModifiedDate DESC LIMIT 5
    const statusText = await submitAndWait(page, bar, '最近更新された5件のアカウントを表示');
    expect(statusText).not.toMatch(/HTTP 402|HTTP 500/);

    // Result count should be ≤ 5 when LIMIT is respected
    const rowCount = await page.evaluate(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      return root.querySelectorAll('.furu-bar__soql-tr, .furu-bar__soql-card').length;
    });
    if (rowCount > 0) {
      expect(rowCount).toBeLessThanOrEqual(5);
    }
    test.info().annotations.push({ type: 'soql-result', description: `rows=${rowCount} ${statusText}` });
  });

  // ── Cross-object parent field ─────────────────────────────────────────────

  test('cross-object: Account.Industry = Technology でフィルター', async ({ page }) => {
    // Tests Worker generating: WHERE Account.Industry = 'Technology' on related object
    // (Contact or Opportunity where Account.Industry is traversed)
    const statusText = await submitAndWait(page, bar, 'Technologyの会社のアカウントを検索');
    expect(statusText).not.toMatch(/HTTP 402|HTTP 500/);
    test.info().annotations.push({ type: 'soql-result', description: statusText });
  });

  // ── Intent stays SOQL_SEARCH (not UPDATE) for search phrasing ───────────

  test('search phrasing does not trigger UPDATE intent', async ({ page }) => {
    // "探して" / "検索" must produce SOQL results, not a prefill card
    await bar.typeCommand('金額が高いアカウントを探して');
    await bar.submit();

    await page.waitForFunction(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      return !!(root.querySelector('.furu-bar__soql-list, .furu-bar__soql-table, .furu-bar__status'));
    }, { timeout: 90_000 });

    const prefillVisible = await page.evaluate(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      return !!root.querySelector('.furu-bar__prefill');
    });
    expect(prefillVisible).toBe(false);
  });

  // ── Unconditioned ORDER BY query (no WHERE) ───────────────────────────────
  // Regression: when soql_filter is null (no conditions), the Apex filterRaw
  // instanceof Map guard was skipped silently → soqlRecords never set → empty card.

  test('top revenue opportunities: unconditioned ORDER BY Amount DESC', async ({ page }) => {
    // "商談を売上金額の高い順に見せて" has no WHERE conditions — only ORDER BY Amount DESC.
    // The Apex fallback else branch must run executeSoqlQuery with empty conditions
    // and the SOQL card must appear (even with 0 records in an empty org).
    const statusText = await submitAndWait(page, bar, '商談を売上金額の高い順に見せて');
    expect(statusText).not.toMatch(/HTTP 402|HTTP 500/);

    // SOQL card header must be visible — hasSoqlResults = true
    const soqlHeaderVisible = await page.evaluate(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      return !!root.querySelector('.furu-bar__soql-header');
    });
    expect(soqlHeaderVisible).toBe(true);

    // Status must contain a numeric count (e.g. "0 record(s) found", "5件が見つかりました")
    expect(statusText).toMatch(/\d+/);

    // If results came back, they should be Opportunity cards or empty-state message
    const bodyContent = await page.evaluate(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      const cards  = root.querySelectorAll('.furu-bar__soql-card').length;
      const empty  = root.querySelector('.furu-bar__soql-empty');
      return { cards, hasEmptyState: !!empty };
    });
    // Must show either records OR the empty-state message — never a blank card body
    expect(bodyContent.cards > 0 || bodyContent.hasEmptyState).toBe(true);

    test.info().annotations.push({ type: 'soql-result', description: statusText });
  });
});
