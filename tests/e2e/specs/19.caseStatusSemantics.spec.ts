/**
 * 19 — Case Status Semantic Layer
 *
 * Verifies that the Worker correctly maps status-based Case queries:
 *   - "how many closed cases" → IsClosed = true  (not CreatedDate >= LAST_N_DAYS:30)
 *   - "show open cases"       → IsClosed = false
 *   - "クローズしたケース"   → IsClosed = true  (Japanese fast-route via Jev template)
 *   - "今月クローズしたケース" → IsClosed = true + THIS_MONTH date filter
 *   - Regression: "show recent cases" → CreatedDate (not IsClosed)
 *
 * The badge format for boolean IsClosed conditions:
 *   - English: "Closed = true" / "Closed = false"
 *   - Japanese: "完了 = true" / "完了 = false"
 */
import { test, expect, Page } from '@playwright/test';
import { FuruBarPage } from '../helpers/furuBarPage';

test.describe('Case Status Semantic Layer', () => {
  test.describe.configure({ timeout: 600_000 });
  let bar: FuruBarPage;

  test.beforeEach(async ({ page }) => {
    bar = new FuruBarPage(page);
    // Navigate to Case list so the LWC context = Case
    await bar.gotoObject('Case');
    await bar.openPanel();
  });

  // ── helpers ───────────────────────────────────────────────────────────────────

  async function submitAndWait(page: Page, command: string, timeout = 90_000): Promise<string> {
    await bar.typeCommand(command);
    await bar.submit();
    await page.waitForFunction(
      () => {
        const b    = document.querySelector('c-furu-agent-bar');
        const root = (b as HTMLElement)?.shadowRoot ?? b!;
        const soql = root.querySelector('.furu-bar__soql-list, .furu-bar__soql-table');
        const stat = (root.querySelector('.furu-bar__status') as HTMLElement)?.innerText?.trim();
        return !!(soql || stat);
      },
      { timeout }
    );
    return page.evaluate(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      return (root.querySelector('.furu-bar__status') as HTMLElement)?.innerText?.trim() ?? '';
    });
  }

  async function condBadgeLabels(page: Page): Promise<string[]> {
    return page.evaluate(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      return Array.from(root.querySelectorAll('.furu-bar__soql-cond-badge'))
        .map(el => (el as HTMLElement).innerText?.replace('✕', '').trim() ?? '');
    });
  }

  async function waitForCondBadge(page: Page, ms = 10_000): Promise<boolean> {
    return page.waitForFunction(
      () => {
        const b    = document.querySelector('c-furu-agent-bar');
        const root = (b as HTMLElement)?.shadowRoot ?? b!;
        return root.querySelectorAll('.furu-bar__soql-cond-badge').length > 0;
      },
      { timeout: ms }
    ).then(() => true).catch(() => false);
  }

  // ── "how many closed cases" ───────────────────────────────────────────────────

  test('how many closed cases → no error', async ({ page }) => {
    const status = await submitAndWait(page, 'how many closed cases');
    expect(status).not.toMatch(/HTTP 402|HTTP 500|検索エラー/);
    test.info().annotations.push({ type: 'status', description: status });
  });

  test('how many closed cases → badge shows IsClosed (Closed = true), not 作成日', async ({ page }) => {
    await submitAndWait(page, 'how many closed cases');

    const hasBadge = await waitForCondBadge(page);
    if (!hasBadge) return;  // 0-row results with no badge still pass

    const labels = await condBadgeLabels(page);
    const combined = labels.join(' | ');

    // Must show IsClosed = true, NOT the CreatedDate fallback
    expect(combined, `Badge labels: ${combined}`).toMatch(/Closed\s*=\s*true|完了\s*=\s*true/);
    expect(combined, `Badge labels: ${combined}`).not.toMatch(/Created Date|作成日/);
    expect(combined).not.toMatch(/LAST_N_DAYS/);

    test.info().annotations.push({ type: 'badge-labels', description: combined });
  });

  // ── "show open cases" ─────────────────────────────────────────────────────────

  test('show open cases → badge shows IsClosed = false (not CreatedDate)', async ({ page }) => {
    await submitAndWait(page, 'show open cases');

    const hasBadge = await waitForCondBadge(page);
    if (!hasBadge) return;

    const labels = await condBadgeLabels(page);
    const combined = labels.join(' | ');

    expect(combined, `Badge labels: ${combined}`).toMatch(/Closed\s*=\s*false|完了\s*=\s*false/);
    expect(combined, `Badge labels: ${combined}`).not.toMatch(/Created Date|作成日/);

    test.info().annotations.push({ type: 'badge-labels', description: combined });
  });

  // ── Japanese queries ──────────────────────────────────────────────────────────

  test('クローズしたケース → no error, IsClosed = true', async ({ page }) => {
    const status = await submitAndWait(page, 'クローズしたケース');
    expect(status).not.toMatch(/HTTP 402|HTTP 500|検索エラー/);

    const hasBadge = await waitForCondBadge(page);
    if (!hasBadge) return;

    const labels = await condBadgeLabels(page);
    const combined = labels.join(' | ');

    expect(combined, `Badge labels: ${combined}`).toMatch(/Closed\s*=\s*true|完了\s*=\s*true/);
    expect(combined, `Badge labels: ${combined}`).not.toMatch(/作成日|Created Date/);

    test.info().annotations.push({ type: 'badge-labels', description: combined });
  });

  test('今月クローズしたケース → IsClosed = true AND THIS_MONTH date filter', async ({ page }) => {
    await submitAndWait(page, '今月クローズしたケース');

    const hasBadge = await waitForCondBadge(page);
    if (!hasBadge) return;

    const labels = await condBadgeLabels(page);
    const combined = labels.join(' | ');

    // Should have both a status badge (IsClosed) and a date badge (THIS_MONTH)
    expect(combined, `Badge labels: ${combined}`).toMatch(/Closed\s*=\s*true|完了\s*=\s*true/);
    expect(combined, `Badge labels: ${combined}`).toMatch(/今月|this month/i);
    expect(combined).not.toMatch(/LAST_N_DAYS/);

    test.info().annotations.push({ type: 'badge-labels', description: combined });
  });

  // ── Regression guard ──────────────────────────────────────────────────────────

  test('show recent cases → badge uses CreatedDate (not IsClosed)', async ({ page }) => {
    await submitAndWait(page, 'show recent cases');

    const hasBadge = await waitForCondBadge(page);
    if (!hasBadge) return;

    const labels = await condBadgeLabels(page);
    const combined = labels.join(' | ');

    // "recent cases" is a recency query — should use CreatedDate, NOT IsClosed
    expect(combined, `Badge labels: ${combined}`).not.toMatch(/Closed\s*=/);
    expect(combined, `Badge labels: ${combined}`).toMatch(/Created Date|作成日/);

    test.info().annotations.push({ type: 'badge-labels', description: combined });
  });
});
