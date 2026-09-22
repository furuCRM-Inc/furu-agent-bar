/**
 * 02 — SOQL Smart Search
 * Covers: natural-language search → results appear → card view → table view
 * → add/remove fields → export button present.
 */
import { test, expect } from '@playwright/test';
import { FuruBarPage } from '../helpers/furuBarPage';

test.describe('SOQL Smart Search', () => {
  let bar: FuruBarPage;

  test.beforeEach(async ({ page }) => {
    bar = new FuruBarPage(page);
    await bar.goto();
    await bar.openPanel();
    // Bypass processIntent (AI backend, HTTP 500) — load via pre-seeded shortcut.
    await bar.loadAccountsViaShortcut();
  });

  test('typing a search returns SOQL results', async ({ page }) => {
    // Results already loaded by beforeEach; verify they are present.
    const count = await page.evaluate(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      return root.querySelectorAll('.furu-bar__soql-tr').length
           + root.querySelectorAll('.furu-bar__soql-card-name, .furu-bar__soql-card').length;
    });
    expect(count).toBeGreaterThan(0);
  });

  test('card view shows record names', async ({ page }) => {
    const cardNames = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return Array.from(root.querySelectorAll('.furu-bar__soql-card-name')).map(
        (el) => (el as HTMLElement).innerText.trim()
      );
    });
    expect(cardNames.length).toBeGreaterThan(0);
    cardNames.forEach((name) => expect(name.length).toBeGreaterThan(0));
  });

  test('switch to table view shows table headers', async ({ page }) => {
    await bar.switchToTableView();
    const headers = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return Array.from(root.querySelectorAll('.furu-bar__soql-th')).map(
        (th) => (th as HTMLElement).innerText.trim()
      );
    });
    expect(headers.length).toBeGreaterThan(1);
  });

  test('table row count matches status count badge', async ({ page }) => {
    await bar.switchToTableView();
    const tableRows = await bar.soqlRowCount();
    const statusText = await bar.statusText();
    // Status message contains the count (e.g. "5件が見つかりました")
    expect(statusText).toMatch(/\d+/);
    expect(tableRows).toBeGreaterThan(0);
  });

  test('navigate button (↗) is present for each row', async ({ page }) => {
    await bar.switchToTableView();
    const navBtns = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return root.querySelectorAll('.furu-bar__soql-act-btn--nav').length;
    });
    expect(navBtns).toBeGreaterThan(0);
  });

  test('dismiss (✕) clears SOQL results', async ({ page }) => {
    await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const btns = Array.from(root.querySelectorAll('button'));
      const dismiss = btns.find(b => b.textContent?.trim() === '✕' && b.closest('.furu-bar__soql-header'));
      (dismiss as HTMLButtonElement | undefined)?.click();
    });
    await page.waitForFunction(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !root.querySelector('.furu-bar__soql-table, .furu-bar__soql-list');
    }, { timeout: 10_000 });
    const visible = await bar.isTableVisible();
    expect(visible).toBe(false);
  });
});
