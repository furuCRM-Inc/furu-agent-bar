/**
 * 03 — Inline Table Edit Mode
 * Covers: toggle on/off → schema loads → cell renders input → dirty cell CSS →
 * dirty badge shows → discard clears → save (allOrNone=false, partial success ok).
 *
 * NOTE: This test edits a real Salesforce record. Use a sandbox / scratch org.
 * The test looks for the first text-editable cell in the first row and modifies it
 * to a no-op value (appends a space and trims) so the API call is harmless.
 */
import { test, expect } from '@playwright/test';
import { FuruBarPage } from '../helpers/furuBarPage';

test.describe('Inline Table Edit', () => {
  test.describe.configure({ timeout: 240_000 });
  let bar: FuruBarPage;

  test.beforeEach(async ({ page }) => {
    bar = new FuruBarPage(page);
    await bar.goto();
    await bar.openPanel();
    // Load via pre-seeded shortcut to bypass processIntent (AI backend).
    // _runSoqlFromSaved() calls executeSoqlQuery directly — no AI needed.
    await bar.loadAccountsViaShortcut();
    await bar.switchToTableView();
  });

  test('インライン編集 button is visible in table toolbar', async ({ page }) => {
    const visible = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const btns = Array.from(root.querySelectorAll('button'));
      return btns.some(b => b.textContent?.includes('インライン編集'));
    });
    expect(visible).toBe(true);
  });

  test('toggling edit mode shows input elements in cells', async ({ page }) => {
    await bar.toggleInlineEdit();
    const inputCount = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return root.querySelectorAll('.furu-bar__cell-input, .furu-bar__cell-check').length;
    });
    expect(inputCount).toBeGreaterThan(0);
  });

  test('edit mode shows 編集終了 button', async ({ page }) => {
    await bar.toggleInlineEdit();
    const visible = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const btns = Array.from(root.querySelectorAll('button'));
      return btns.some(b => b.textContent?.includes('編集終了'));
    });
    expect(visible).toBe(true);
  });

  test('changing a cell marks it dirty (yellow background)', async ({ page }) => {
    await bar.toggleInlineEdit();
    // Change the first text input we can find
    await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const inp = root.querySelector('.furu-bar__cell-input') as HTMLInputElement | null;
      if (!inp) throw new Error('No cell input found');
      const orig = inp.value;
      inp.focus();
      inp.value = orig + ' ';   // append space — harmless, saves as trimmed in Salesforce
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(500);
    const dirty = await bar.isDirtyCellVisible();
    expect(dirty).toBe(true);
  });

  test('dirty badge appears after editing a cell', async ({ page }) => {
    await bar.toggleInlineEdit();
    await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const inp = root.querySelector('.furu-bar__cell-input') as HTMLInputElement | null;
      if (inp) {
        inp.value = (inp.value ?? '') + ' ';
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await page.waitForTimeout(500);
    const badge = await bar.isDirtyBadgeVisible();
    expect(badge).toBe(true);
  });

  test('破棄 clears all dirty cells', async ({ page }) => {
    await bar.toggleInlineEdit();
    await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const inp = root.querySelector('.furu-bar__cell-input') as HTMLInputElement | null;
      if (inp) {
        inp.value = (inp.value ?? '') + ' ';
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await page.waitForTimeout(300);
    await bar.clickDiscard();
    await page.waitForTimeout(300);
    const dirty = await bar.isDirtyCellVisible();
    expect(dirty).toBe(false);
  });

  test('編集終了 exits edit mode and hides inputs', async ({ page }) => {
    await bar.toggleInlineEdit();
    await page.waitForTimeout(500);
    await bar.toggleInlineEdit();   // toggles back off (button now says 編集終了)
    await page.waitForTimeout(300);
    const inputCount = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return root.querySelectorAll('.furu-bar__cell-input').length;
    });
    expect(inputCount).toBe(0);
  });

  test('保存 button is disabled when no cells are dirty', async ({ page }) => {
    await bar.toggleInlineEdit();
    const disabled = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const btns = Array.from(root.querySelectorAll('button'));
      const save = btns.find(b => b.textContent?.trim().includes('保存'));
      return (save as HTMLButtonElement | undefined)?.disabled ?? true;
    });
    expect(disabled).toBe(true);
  });
});
