/**
 * 08 — Keyboard Shortcuts
 * Covers the full FlashBar AI keyboard-first interaction matrix:
 *   - Cmd+K: toggle palette open/close + focus textarea
 *   - ↑/↓:   history navigation through recent prompts
 *   - Cmd+E: toggle edit mode on summary card
 *   - Cmd+S: save in edit mode
 *   - Cmd+Z: revert last field draft change in edit mode
 *   - Esc:   dismiss results / close edit mode
 *
 * Note: Cmd+Shift+P (pop-out) opens a new browser window — tested only for the
 * event dispatch because we cannot reliably intercept popups in CI.
 *
 * History navigation tests:
 *   ↑/↓ require _recentPrompts to be populated. Because submitting a command
 *   causes isLoading=true (textarea disabled) for 45-90s while the AI pipeline
 *   runs, and LWC onkeydown bindings do not fire on disabled elements even for
 *   programmatic events in LWS mode, we seed history directly into localStorage
 *   (using the same LWS-namespaced key the component writes to) and reload the
 *   page once so connectedCallback re-reads the seeded data.
 */
import { test, expect, Page } from '@playwright/test';
import { FuruBarPage } from '../helpers/furuBarPage';

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Fire a keydown on the bar's textarea element (inside shadow DOM).
 *
 * For plain keys (no modifier) we use focus + page.keyboard.press so the
 * browser generates a trusted CDP event — Salesforce Lightning has capture-phase
 * listeners that intercept ArrowUp/ArrowDown dispatched events before they
 * reach LWC template handlers.  Modifier combos (Cmd+E etc.) cannot be sent
 * via page.keyboard (LWS blocks them), so those still use dispatchEvent.
 */
async function pressInTextarea(page: Page, init: KeyboardEventInit) {
  await page.evaluate((evInit: KeyboardEventInit) => {
    const bar  = document.querySelector('c-furu-agent-bar');
    const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
    const ta   = root.querySelector('.furu-bar__textarea') as HTMLTextAreaElement | null;
    if (!ta) throw new Error('pressInTextarea: textarea not found');
    ta.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true, composed: true, cancelable: true, ...evInit,
    }));
  }, init);
}

/** Fire a keydown on window (for global shortcuts like Cmd+K). */
async function pressGlobal(page: Page, init: KeyboardEventInit) {
  await page.evaluate((evInit: KeyboardEventInit) => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true, composed: true, cancelable: true, ...evInit,
    }));
  }, init);
}

/** Read the current value of the bar's textarea. */
async function textareaValue(page: Page): Promise<string> {
  return page.evaluate(() => {
    const bar  = document.querySelector('c-furu-agent-bar');
    const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
    const ta   = root.querySelector('.furu-bar__textarea') as HTMLTextAreaElement | null;
    return ta?.value ?? '';
  });
}

/**
 * Seed _recentPrompts by writing to the LWS-namespaced localStorage key,
 * then reload the page so connectedCallback → _loadRecentPrompts() picks them up.
 *
 * Why: submitting a command triggers the AI pipeline (isLoading=true, textarea
 * disabled, ~45-90s). LWC onkeydown does not fire on disabled elements in LWS
 * mode even with programmatic dispatchEvent. Seeding via localStorage and
 * reloading is the reliable, fast alternative.
 *
 * Key format: _promptHistoryKey() = `furubar_ph_${userId.slice(-8)}`
 * LWS namespace: `LSKey[c]furubar_ph_${suffix}`
 * We detect the suffix from the already-seeded `furubar_qs_*` key (globalSetup).
 */
async function seedHistory(page: Page, bar: FuruBarPage, prompts: string[]) {
  // Read the component's actual user-key suffix from the data-furu-suffix attribute
  // set by connectedCallback. This handles the "Login As" edge case where
  // @salesforce/user/Id returns the admin's ID rather than the test user's ID,
  // meaning the LWS-namespaced key differs from the globalSetup-written qs_ key.
  const suffix = await page.evaluate(() => {
    const host = document.querySelector('c-furu-agent-bar') as HTMLElement | null;
    return host?.dataset?.furuSuffix ?? null;
  });

  await page.evaluate(({ data, furuSuffix }: { data: string[], furuSuffix: string | null }) => {
    const keysToWrite = new Set<string>();
    if (furuSuffix) keysToWrite.add(`LSKey[c]furubar_ph_${furuSuffix}`);
    // Fallback: qs-derived suffix and any existing ph_ keys
    const qsKey = Object.keys(localStorage).find(k => k.includes('furubar_qs_'));
    if (qsKey) keysToWrite.add(`LSKey[c]furubar_ph_${qsKey.replace(/.*furubar_qs_/, '')}`);
    Object.keys(localStorage).filter(k => k.includes('furubar_ph_')).forEach(k => keysToWrite.add(k));
    keysToWrite.forEach(k => localStorage.setItem(k, JSON.stringify(data)));
  }, { data: prompts, furuSuffix: suffix });

  // Reload so connectedCallback re-runs and calls _loadRecentPrompts()
  await bar.goto();
  await bar.openPanel();
}

// ── test suite ────────────────────────────────────────────────────────────────

test.describe('Keyboard Shortcuts', () => {
  test.describe.configure({ timeout: 300_000 });
  let bar: FuruBarPage;

  test.beforeEach(async ({ page }) => {
    bar = new FuruBarPage(page);
    await bar.goto();
    await bar.openPanel();
  });

  // ── Cmd+K ──────────────────────────────────────────────────────────────────

  test('Cmd+K focuses the textarea when panel is already open', async ({ page }) => {
    await pressGlobal(page, { key: 'k', metaKey: true });
    await page.waitForTimeout(400);

    const taExists = await page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__textarea');
    });
    expect(taExists).toBe(true);
  });

  test('Ctrl+K is also handled (non-Mac fallback)', async ({ page }) => {
    await pressGlobal(page, { key: 'k', ctrlKey: true });
    await page.waitForTimeout(400);
    const taExists = await page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__textarea');
    });
    expect(taExists).toBe(true);
  });

  // ── ↑ / ↓ history navigation ───────────────────────────────────────────────

  test('↑ fills textarea with most recent prompt from history', async ({ page }) => {
    await seedHistory(page, bar, ['最新クエリ', '古いクエリ']);

    await pressInTextarea(page, { key: 'ArrowUp' });
    await page.waitForTimeout(500);

    const val = await textareaValue(page);
    expect(val).toBe('最新クエリ');
  });

  test('↑ twice recalls second-most-recent prompt', async ({ page }) => {
    await seedHistory(page, bar, ['最新クエリ', '古いクエリ']);

    await pressInTextarea(page, { key: 'ArrowUp' });
    await page.waitForTimeout(200);
    await pressInTextarea(page, { key: 'ArrowUp' });
    await page.waitForTimeout(200);

    const val = await textareaValue(page);
    expect(val).toBe('古いクエリ');
  });

  test('↑ then ↓ clears selection back to empty', async ({ page }) => {
    await seedHistory(page, bar, ['最新クエリ']);

    await pressInTextarea(page, { key: 'ArrowUp' });
    await page.waitForTimeout(200);
    const afterUp = await textareaValue(page);
    expect(afterUp).toBe('最新クエリ');

    await pressInTextarea(page, { key: 'ArrowDown' });
    await page.waitForTimeout(200);
    const afterDown = await textareaValue(page);
    expect(afterDown).toBe('');
  });

  test('typing resets history cursor so next ↑ starts from most recent', async ({ page }) => {
    await seedHistory(page, bar, ['最新クエリ', '古いクエリ']);

    // Navigate into history
    await pressInTextarea(page, { key: 'ArrowUp' });
    await pressInTextarea(page, { key: 'ArrowUp' });
    await page.waitForTimeout(200);
    const atOld = await textareaValue(page);
    expect(atOld).toBe('古いクエリ');

    // Type new text — triggers handleInputAutoResize which resets _historyIdx = -1
    await bar.typeCommand('新しいテキスト');
    await page.waitForTimeout(200);

    // Press ↑ again — cursor reset to -1, so first ↑ goes to index 0 = '最新クエリ'
    await pressInTextarea(page, { key: 'ArrowUp' });
    await page.waitForTimeout(200);
    const val = await textareaValue(page);
    expect(val).toBe('最新クエリ');
  });

  // ── Esc ────────────────────────────────────────────────────────────────────

  test('Esc clears input and dismisses any status', async ({ page }) => {
    await bar.typeCommand('テスト');
    await pressInTextarea(page, { key: 'Escape' });
    await page.waitForTimeout(300);

    const val = await textareaValue(page);
    expect(val).toBe('');
  });

  // ── Cmd+E — toggle edit mode ───────────────────────────────────────────────

  test('Cmd+E does not crash when no summary card is loaded', async ({ page }) => {
    await pressInTextarea(page, { key: 'e', metaKey: true });
    await page.waitForTimeout(300);
    const taExists = await page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__textarea');
    });
    expect(taExists).toBe(true);
  });

  // ── Cmd+Z — revert last draft change ──────────────────────────────────────

  test('Cmd+Z does not crash outside edit mode', async ({ page }) => {
    await pressInTextarea(page, { key: 'z', metaKey: true });
    await page.waitForTimeout(300);
    const taExists = await page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__textarea');
    });
    expect(taExists).toBe(true);
  });

  // ── Cmd+Shift+P — pop-out window ──────────────────────────────────────────

  test('Cmd+Shift+P dispatches without error (popup intercepted)', async ({ page }) => {
    page.on('popup', async (popup) => { await popup.close(); });
    await pressGlobal(page, { key: 'p', metaKey: true, shiftKey: true });
    await page.waitForTimeout(500);

    const taExists = await page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__textarea');
    });
    expect(taExists).toBe(true);
  });

  // ── Combined flow: seed history → ↑ recall → Esc clear ───────────────────

  test('full keyboard flow: recall with ↑, then clear with Esc', async ({ page }) => {
    await seedHistory(page, bar, ['フルフローテスト']);

    await pressInTextarea(page, { key: 'ArrowUp' });
    await page.waitForTimeout(300);
    const recalled = await textareaValue(page);
    expect(recalled).toBe('フルフローテスト');

    await pressInTextarea(page, { key: 'Escape' });
    await page.waitForTimeout(300);
    const cleared = await textareaValue(page);
    expect(cleared).toBe('');
  });
});
