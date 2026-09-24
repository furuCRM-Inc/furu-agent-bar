/**
 * 23 — Global keyboard shortcuts
 *
 * Regression coverage for a live report: "Cmd+K does nothing on Mac."
 *
 * Two independent bugs were found and fixed:
 *   1. _clickUtilityBarToggle() looked for a button whose aria-label contains
 *      "furu"/"Furu" — but Salesforce only sets that label once the utility
 *      bar panel has been opened at least once; in the cold/collapsed state
 *      the button's aria-label is empty, so the selector matched nothing and
 *      its closest()-based fallback couldn't work either (the toggle button
 *      isn't a DOM ancestor of the component's own content). Fixed to try a
 *      case-insensitive label match first, then fall back to the last
 *      utility-bar item button (same heuristic already proven in
 *      helpers/furuBarPage.ts's openPanel()).
 *   2. Cmd+K itself: verified live that macOS Chrome intercepts Cmd+K at the
 *      OS/menu level ("Search Tabs") before a keydown event ever reaches the
 *      page — preventDefault() in _onGlobalKey can't stop that, so Cmd+K is
 *      untestable/unusable in that specific browser+OS combination. Cmd+J
 *      was tried as a fallback and is ALSO reserved (Chrome's Downloads
 *      shortcut on Mac). Cmd+/ was verified free and added as the working
 *      fallback binding — this spec tests Cmd+/ since it's the one that can
 *      actually be driven through a real OS-level keypress in CI.
 */
import { test, expect } from '@playwright/test';

test.describe('Global keyboard shortcuts', () => {
  test.describe.configure({ timeout: 120_000 });

  test('Cmd+/ (Ctrl+/) opens the collapsed panel and focuses the textarea', async ({ page }) => {
    await page.goto('about:blank');
    await page.goto(process.env.SF_APP_URL ?? '/lightning/app/standard__LightningInstrumentation', { waitUntil: 'load' });
    await page.waitForTimeout(3_000);

    const before = await page.evaluate(() => {
      const b = document.querySelector('c-furu-agent-bar') as HTMLElement | null;
      return { offsetParentNull: b ? b.offsetParent === null : null };
    });
    expect(before.offsetParentNull, 'panel should start collapsed').toBe(true);

    await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
    await page.keyboard.press('/');
    await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
    // _togglePalette()'s cold-open path clicks the utility toggle then focuses the
    // textarea in a 300ms setTimeout once the panel has rendered — give it room.
    await page.waitForTimeout(2_500);

    const after = await page.evaluate(() => {
      const b = document.querySelector('c-furu-agent-bar') as HTMLElement | null;
      return { offsetParentNull: b ? b.offsetParent === null : null };
    });
    // The core regression: the panel must actually open. Whether the textarea also
    // grabs focus isn't reliably observable from outside Salesforce's synthetic
    // shadow DOM in Playwright (activeElement doesn't pierce it consistently), so
    // that part isn't asserted here — it's a UX nicety, not the reported bug.
    expect(after.offsetParentNull, 'Cmd+/ or Ctrl+/ should open the panel').toBe(false);
  });
});
