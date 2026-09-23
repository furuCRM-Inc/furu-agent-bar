/**
 * 01 — Smoke tests
 * Verifies the bar mounts, the textarea is interactive, and basic
 * status flow works without any Apex calls timing out.
 */
import { test, expect } from '@playwright/test';
import { FuruBarPage } from '../helpers/furuBarPage';

test.describe('Smoke — bar renders and input works', () => {
  let bar: FuruBarPage;

  test.beforeEach(async ({ page }) => {
    bar = new FuruBarPage(page);
    await bar.goto();
    await bar.openPanel();
  });

  test('c-furu-agent-bar custom element is in the DOM', async ({ page }) => {
    await expect(page.locator('c-furu-agent-bar')).toBeAttached();
  });

  test('textarea is focusable and accepts input', async ({ page }) => {
    await bar.typeCommand('テスト入力');
    // Read via shadow-DOM evaluate (Playwright locator can't pierce native shadow root for assertions)
    const val = await page.evaluate(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      return (root.querySelector('.furu-bar__textarea, textarea') as HTMLTextAreaElement)?.value ?? '';
    });
    expect(val).toContain('テスト入力');
  });

  test('quick chips are visible', async ({ page }) => {
    const chips = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return root.querySelectorAll('.furu-bar__chip').length;
    });
    expect(chips).toBeGreaterThan(0);
  });

  test('pressing Enter on an unknown command returns a status message', async ({ page }) => {
    await bar.typeCommand('xyzzy unknown command 123456');
    await bar.submit();
    await page.waitForFunction(
      () => {
        const bar = document.querySelector('c-furu-agent-bar');
        const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
        const status = root.querySelector('.furu-bar__status') as HTMLElement;
        return status && status.innerText.trim().length > 0;
      },
      { timeout: 30_000 }
    );
    const text = await bar.statusText();
    expect(text.length).toBeGreaterThan(0);
  });

  test('Escape key clears status', async ({ page }) => {
    await bar.typeCommand('anything');
    await bar.submit();
    await page.waitForTimeout(3_000);
    // Dispatch Escape directly on the textarea — page.keyboard.press() requires CDP focus
    // which LWC shadow root doesn't expose to Playwright.
    await page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const ta   = root.querySelector('.furu-bar__textarea') as HTMLTextAreaElement | null;
      if (!ta) throw new Error('Escape: .furu-bar__textarea not found');
      ta.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27,
        bubbles: true, composed: true, cancelable: true,
      }));
    });
    const text = await bar.statusText();
    expect(text).toBe('');
  });
});
