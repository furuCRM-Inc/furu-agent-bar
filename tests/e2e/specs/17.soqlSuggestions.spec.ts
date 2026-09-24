/**
 * 17 — SOQL Suggestion Chips
 *
 * After SOQL results load, two rows of chips appear below the field badges:
 *   • Field chips (purple, "+ <label>") — calls getCandidateFields then filters
 *     against already-selected fields. Clicking adds the field and re-queries.
 *   • Condition chips (green, preset per sObject) — clicking merges the preset
 *     conditions into the current query and re-queries.
 *
 * Prerequisite: the global setup must have seeded the __e2e_test_accounts__
 * shortcut (Account, 5 fields, no conditions) which is used to load results
 * without hitting the AI backend.
 */
import { test, expect, Page } from '@playwright/test';
import { FuruBarPage } from '../helpers/furuBarPage';

// ── helpers ───────────────────────────────────────────────────────────────────

function getRoot(page: Page) {
  return page.evaluate(() => {
    const bar  = document.querySelector('c-furu-agent-bar');
    const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
    return root as unknown as Element;
  });
}

/** Count `.furu-bar__soql-field-badge` elements in shadow DOM */
async function fieldBadgeCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const bar  = document.querySelector('c-furu-agent-bar');
    const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
    return root.querySelectorAll('.furu-bar__soql-field-badge').length;
  });
}

/** Return text content of all visible field suggestion chips */
async function fieldChipLabels(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bar  = document.querySelector('c-furu-agent-bar');
    const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
    return Array.from(root.querySelectorAll('.furu-bar__soql-chip-row .furu-bar__suggestion-chip:not(.furu-bar__suggestion-chip--cond)'))
      .map(el => (el as HTMLElement).innerText?.trim() ?? '');
  });
}

/** Return text content of all visible condition suggestion chips */
async function condChipLabels(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bar  = document.querySelector('c-furu-agent-bar');
    const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
    return Array.from(root.querySelectorAll('.furu-bar__suggestion-chip--cond'))
      .map(el => (el as HTMLElement).innerText?.trim() ?? '');
  });
}

/** Wait up to `timeout` ms for at least one element matching `selector` to appear */
async function waitForChips(page: Page, selector: string, timeout = 20_000): Promise<boolean> {
  return page.waitForFunction(
    (sel: string) => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return root.querySelectorAll(sel).length > 0;
    },
    selector,
    { timeout }
  ).then(() => true).catch(() => false);
}

// ── tests ─────────────────────────────────────────────────────────────────────

test.describe('SOQL Suggestion Chips', () => {
  let bar: FuruBarPage;

  test.beforeEach(async ({ page }) => {
    bar = new FuruBarPage(page);
    await bar.goto();
    await bar.openPanel();
    await bar.loadAccountsViaShortcut();
  });

  // ── field chips ─────────────────────────────────────────────────────────────

  test('field suggestion chips appear after results load', async ({ page }) => {
    // getCandidateFields is called async after _doSoqlSearch; give it time
    const appeared = await waitForChips(page, '.furu-bar__soql-chip-row .furu-bar__suggestion-chip:not(.furu-bar__suggestion-chip--cond)');
    expect(appeared, 'field suggestion chips should appear after loadAccountsViaShortcut').toBe(true);

    const labels = await fieldChipLabels(page);
    expect(labels.length).toBeGreaterThan(0);
    // Each chip label starts with "+ " (the prefix added in the template)
    labels.forEach(l => expect(l).toMatch(/^\+/));
  });

  test('clicking a field chip adds the field badge and re-queries', async ({ page }) => {
    const appeared = await waitForChips(page, '.furu-bar__soql-chip-row .furu-bar__suggestion-chip:not(.furu-bar__suggestion-chip--cond)');
    if (!appeared) {
      test.skip();
      return;
    }

    const beforeCount = await fieldBadgeCount(page);

    // Click the first field suggestion chip
    await page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const chip = root.querySelector(
        '.furu-bar__soql-chip-row .furu-bar__suggestion-chip:not(.furu-bar__suggestion-chip--cond)'
      ) as HTMLButtonElement | null;
      chip?.click();
    });

    // Wait for loading to finish (isLoading goes true then false)
    await page.waitForFunction(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !root.querySelector('.furu-bar__soql-loading');
    }, { timeout: 15_000 });

    const afterCount = await fieldBadgeCount(page);
    expect(afterCount).toBe(beforeCount + 1);
  });

  test('clicked field chip disappears from suggestion row', async ({ page }) => {
    const appeared = await waitForChips(page, '.furu-bar__soql-chip-row .furu-bar__suggestion-chip:not(.furu-bar__suggestion-chip--cond)');
    if (!appeared) { test.skip(); return; }

    const labelsBefore = await fieldChipLabels(page);
    const firstLabel   = labelsBefore[0];

    // Click first chip
    await page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const chip = root.querySelector(
        '.furu-bar__soql-chip-row .furu-bar__suggestion-chip:not(.furu-bar__suggestion-chip--cond)'
      ) as HTMLButtonElement | null;
      chip?.click();
    });

    await page.waitForFunction(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !root.querySelector('.furu-bar__soql-loading');
    }, { timeout: 15_000 });

    const labelsAfter = await fieldChipLabels(page);
    expect(labelsAfter).not.toContain(firstLabel);
  });

  // ── condition chips ─────────────────────────────────────────────────────────

  test('condition suggestion chips appear for Account results', async ({ page }) => {
    // Condition chips are built synchronously in _buildCondSuggestions — they
    // appear immediately after the SOQL results are set (no extra async call).
    const appeared = await waitForChips(page, '.furu-bar__suggestion-chip--cond', 5_000);
    expect(appeared, 'condition suggestion chips should appear for Account sObject').toBe(true);

    const labels = await condChipLabels(page);
    expect(labels.length).toBeGreaterThan(0);
  });

  test('clicking a condition chip re-queries and updates status', async ({ page }) => {
    const appeared = await waitForChips(page, '.furu-bar__suggestion-chip--cond', 5_000);
    if (!appeared) { test.skip(); return; }

    // Click first condition chip
    await page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const chip = root.querySelector('.furu-bar__suggestion-chip--cond') as HTMLButtonElement | null;
      chip?.click();
    });

    // Wait for the loading spinner to appear then clear
    await page.waitForFunction(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !root.querySelector('.furu-bar__soql-loading');
    }, { timeout: 15_000 });

    // Status should show "X件が見つかりました" (or english equivalent)
    const statusText = await bar.statusText();
    expect(statusText).toMatch(/件が見つかりました|record.*found/i);
  });

  test('clicked condition chip disappears from chip row', async ({ page }) => {
    const appeared = await waitForChips(page, '.furu-bar__suggestion-chip--cond', 5_000);
    if (!appeared) { test.skip(); return; }

    const labelsBefore = await condChipLabels(page);
    const firstLabel   = labelsBefore[0];

    await page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const chip = root.querySelector('.furu-bar__suggestion-chip--cond') as HTMLButtonElement | null;
      chip?.click();
    });

    await page.waitForFunction(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !root.querySelector('.furu-bar__soql-loading');
    }, { timeout: 15_000 });

    const labelsAfter = await condChipLabels(page);
    expect(labelsAfter).not.toContain(firstLabel);
  });

  // ── chips clear on dismiss ───────────────────────────────────────────────────

  test('suggestion chips clear when SOQL results are dismissed', async ({ page }) => {
    // Wait for at least one chip type to appear
    await waitForChips(page, '.furu-bar__soql-chip-row .furu-bar__suggestion-chip', 20_000);

    // Dismiss results — click the ✕ button that is next sibling of the CSV export button
    await page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const exportBtn = root.querySelector('.furu-bar__soql-export-btn');
      const btn = (exportBtn?.nextElementSibling ?? null) as HTMLButtonElement | null;
      if (btn) {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
      }
    });

    await page.waitForFunction(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !root.querySelector('.furu-bar__soql-list, .furu-bar__soql-table');
    }, { timeout: 10_000 });

    const allChips = await page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return root.querySelectorAll('.furu-bar__soql-chip-row .furu-bar__suggestion-chip').length;
    });
    expect(allChips).toBe(0);
  });
});
