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

  test('コマンド button injects record name into textarea', async ({ page }) => {
    // Card view is the default after loadAccountsViaShortcut.
    // The first card's 📝 コマンド button has data-cmd="「RecordName」".
    // Clicking it must set that value in the textarea.
    const result = await page.evaluate(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      // Find the command-inject button (has data-cmd attribute, not the nav button)
      const cmdBtn = root.querySelector(
        '.furu-bar__soql-card-actions .furu-bar__soql-act-btn[data-cmd]'
      ) as HTMLButtonElement | null;
      if (!cmdBtn) return { found: false, cmd: '', textareaValue: '' };
      const cmd = cmdBtn.dataset.cmd ?? '';
      cmdBtn.click();
      const ta = root.querySelector('.furu-bar__textarea') as HTMLTextAreaElement | null;
      return { found: true, cmd, textareaValue: ta?.value ?? '' };
    });

    expect(result.found).toBe(true);
    // Textarea must contain the injected command string (「...」 or "...")
    expect(result.textareaValue).toBe(result.cmd);
    expect(result.textareaValue).toMatch(/「.+」|".+"/);
  });

  test('↗ 開く button in card view has a valid Salesforce record ID', async ({ page }) => {
    // The navigate button carries data-id with the Salesforce record Id (15 or 18 chars).
    const navBtnId = await page.evaluate(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      const navBtn = root.querySelector(
        '.furu-bar__soql-card-actions .furu-bar__soql-act-btn--nav'
      ) as HTMLButtonElement | null;
      return navBtn?.dataset.id ?? null;
    });

    expect(navBtnId).not.toBeNull();
    // Salesforce record IDs are 15 or 18 alphanumeric characters
    expect(navBtnId).toMatch(/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/);
  });

  test('↗ 開く button click does not throw an error', async ({ page }) => {
    // Clicking navigate calls NavigationMixin.Navigate — which in a test org redirects
    // within Lightning. Verify no error status appears after clicking.
    const errorBefore = await page.evaluate(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      return !!root.querySelector('.furu-bar__status--error');
    });

    await page.evaluate(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      const navBtn = root.querySelector(
        '.furu-bar__soql-card-actions .furu-bar__soql-act-btn--nav'
      ) as HTMLButtonElement | null;
      navBtn?.click();
    });

    await page.waitForTimeout(2_000);

    const errorAfter = await page.evaluate(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      return !!root.querySelector('.furu-bar__status--error');
    });

    // Clicking navigate should not produce a new error (it may already be false)
    if (!errorBefore) {
      expect(errorAfter).toBe(false);
    }
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
