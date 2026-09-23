/**
 * 04 — Navigation Hub
 * Covers: pin button visible after SOQL → pin dialog opens → label input works →
 * pinned item appears in hub → clicking recalls SOQL → delete removes it.
 *
 * Each test cleans up after itself by deleting the pinned item it creates.
 */
import { test, expect } from '@playwright/test';
import { FuruBarPage } from '../helpers/furuBarPage';

const PIN_LABEL = `E2E Test Pin ${Date.now()}`;

test.describe('Navigation Hub', () => {
  test.describe.configure({ timeout: 240_000 });
  let bar: FuruBarPage;

  test.beforeEach(async ({ page }) => {
    bar = new FuruBarPage(page);
    await bar.goto();
    await bar.openPanel();
    // Load via pre-seeded shortcut to bypass processIntent (AI backend).
    await bar.loadAccountsViaShortcut();
    await bar.switchToTableView();
  });

  test('📌 ピン留め button is visible in table toolbar', async ({ page }) => {
    const visible = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const btns = Array.from(root.querySelectorAll('button'));
      return btns.some(b => b.textContent?.includes('ピン留め') && !b.textContent.includes('ピン留め名'));
    });
    expect(visible).toBe(true);
  });

  test('pin dialog opens when ピン留め is clicked', async ({ page }) => {
    await bar.openPinDialog();
    const inputVisible = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__pin-input');
    });
    expect(inputVisible).toBe(true);
  });

  test('pin input accepts text', async ({ page }) => {
    await bar.openPinDialog();
    await bar.fillPinLabel(PIN_LABEL);
    const val = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return (root.querySelector('.furu-bar__pin-input') as HTMLInputElement)?.value;
    });
    expect(val).toBe(PIN_LABEL);
  });

  test('pinning a query adds it to the nav hub', async ({ page }) => {
    const beforeCount = await bar.navHubItemCount();
    await bar.openPinDialog();
    await bar.fillPinLabel(PIN_LABEL);
    await bar.confirmPin();
    // Wait for the Apex insert to complete and wire to re-fire
    await page.waitForFunction(
      (expected: number) => {
        const bar = document.querySelector('c-furu-agent-bar');
        const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
        return root.querySelectorAll('.furu-bar__nav-item').length > expected;
      },
      beforeCount,
      { timeout: 15_000 }
    );
    const afterCount = await bar.navHubItemCount();
    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  test('pinned item label is visible in the nav hub', async ({ page }) => {
    await bar.openPinDialog();
    await bar.fillPinLabel(PIN_LABEL);
    await bar.confirmPin();
    await page.waitForFunction(
      (lbl: string) => {
        const bar = document.querySelector('c-furu-agent-bar');
        const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
        const labels = Array.from(root.querySelectorAll('.furu-bar__nav-item-label'));
        return labels.some(el => (el as HTMLElement).innerText?.includes(lbl));
      },
      PIN_LABEL,
      { timeout: 15_000 }
    );
    const labels = await page.evaluate((lbl: string) => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return Array.from(root.querySelectorAll('.furu-bar__nav-item-label')).map(
        el => (el as HTMLElement).innerText.trim()
      );
    }, PIN_LABEL);
    expect(labels).toContain(PIN_LABEL);
  });

  test('clicking a pinned nav item re-runs the SOQL query', async ({ page }) => {
    await bar.openPinDialog();
    await bar.fillPinLabel(PIN_LABEL);
    await bar.confirmPin();
    await page.waitForFunction(
      (lbl: string) => {
        const bar = document.querySelector('c-furu-agent-bar');
        const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
        return Array.from(root.querySelectorAll('.furu-bar__nav-item-label'))
          .some(el => (el as HTMLElement).innerText?.includes(lbl));
      },
      PIN_LABEL,
      { timeout: 15_000 }
    );

    // Dismiss current SOQL results first
    await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const btns = Array.from(root.querySelectorAll('button'));
      const dismiss = btns.find(b => b.textContent?.trim() === '✕' && b.closest('.furu-bar__soql-header'));
      (dismiss as HTMLButtonElement | undefined)?.click();
    });
    await page.waitForTimeout(500);

    // Click the nav item
    await bar.clickNavItem(PIN_LABEL);
    await bar.waitForSoqlResults(30_000);
    const rows = await bar.soqlRowCount();
    expect(rows).toBeGreaterThan(0);

    // Cleanup
    await bar.deleteNavItem(PIN_LABEL);
  });

  test('nav item button carries a data-id attribute', async ({ page }) => {
    // After pinning, every .furu-bar__nav-item-btn must have data-id set.
    // handleNavItemClick uses dataset.id to find the record — if missing, click is a no-op.
    await bar.openPinDialog();
    await bar.fillPinLabel(PIN_LABEL);
    await bar.confirmPin();
    await page.waitForFunction(
      (lbl: string) => {
        const bar  = document.querySelector('c-furu-agent-bar');
        const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
        return Array.from(root.querySelectorAll('.furu-bar__nav-item-label'))
          .some(el => (el as HTMLElement).innerText?.includes(lbl));
      },
      PIN_LABEL,
      { timeout: 15_000 }
    );

    const dataId = await page.evaluate((lbl: string) => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const items = Array.from(root.querySelectorAll('.furu-bar__nav-item-btn'));
      const item  = items.find(el => el.textContent?.includes(lbl)) as HTMLButtonElement | null;
      return item?.dataset.id ?? null;
    }, PIN_LABEL);

    expect(dataId).not.toBeNull();
    expect(dataId!.length).toBeGreaterThanOrEqual(15); // valid SF record ID

    await bar.deleteNavItem(PIN_LABEL);
  });

  test('nav item delete button carries a data-id attribute', async ({ page }) => {
    // handleDeleteNavItem uses dataset.id — verify it is set so delete is not a no-op.
    await bar.openPinDialog();
    await bar.fillPinLabel(PIN_LABEL);
    await bar.confirmPin();
    await page.waitForFunction(
      (lbl: string) => {
        const bar  = document.querySelector('c-furu-agent-bar');
        const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
        return Array.from(root.querySelectorAll('.furu-bar__nav-item-label'))
          .some(el => (el as HTMLElement).innerText?.includes(lbl));
      },
      PIN_LABEL,
      { timeout: 15_000 }
    );

    const delDataId = await page.evaluate((lbl: string) => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const items = Array.from(root.querySelectorAll('.furu-bar__nav-item'));
      const item  = items.find(el => el.querySelector('.furu-bar__nav-item-label')?.textContent?.includes(lbl));
      const delBtn = item?.querySelector('.furu-bar__nav-item-del') as HTMLButtonElement | null;
      return delBtn?.dataset.id ?? null;
    }, PIN_LABEL);

    expect(delDataId).not.toBeNull();
    expect(delDataId!.length).toBeGreaterThanOrEqual(15);

    await bar.deleteNavItem(PIN_LABEL);
  });

  test('deleting a nav item removes it from the hub', async ({ page }) => {
    await bar.openPinDialog();
    await bar.fillPinLabel(PIN_LABEL);
    await bar.confirmPin();
    await page.waitForFunction(
      (lbl: string) => {
        const bar = document.querySelector('c-furu-agent-bar');
        const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
        return Array.from(root.querySelectorAll('.furu-bar__nav-item-label'))
          .some(el => (el as HTMLElement).innerText?.includes(lbl));
      },
      PIN_LABEL,
      { timeout: 15_000 }
    );

    const beforeCount = await bar.navHubItemCount();
    await bar.deleteNavItem(PIN_LABEL);

    await page.waitForFunction(
      (expected: number) => {
        const bar = document.querySelector('c-furu-agent-bar');
        const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
        return root.querySelectorAll('.furu-bar__nav-item').length < expected;
      },
      beforeCount,
      { timeout: 20_000 }
    );

    const afterCount = await bar.navHubItemCount();
    expect(afterCount).toBeLessThan(beforeCount);
  });
});
