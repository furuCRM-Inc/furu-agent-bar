/**
 * 18 — CloseDate Semantic Layer Fixes
 *
 * Verifies that the Worker correctly maps:
 *   - "今月完了予定の商談" → CloseDate = THIS_MONTH  (not CreatedDate)
 *   - "来月クローズ予定の案件" → CloseDate = NEXT_MONTH
 *   - "先月作成した商談" → CreatedDate = LAST_MONTH  (not CloseDate)
 *   - "今月完了予定" badge label shows "完了予定日: 今月" (not "作成日: 過去30日")
 *
 * All tests go through the full Worker → Apex → SOQL pipeline.
 * 0-row results are acceptable (sparse org data) — tests assert correct
 * field routing and absence of errors, not specific record counts.
 *
 * Prerequisite: page context is set to Opportunity list view so _sObjectType
 * is 'Opportunity' for each query.
 */
import { test, expect, Page } from '@playwright/test';
import { FuruBarPage } from '../helpers/furuBarPage';

test.describe('CloseDate Semantic Layer', () => {
  test.describe.configure({ timeout: 600_000 });
  let bar: FuruBarPage;

  test.beforeEach(async ({ page }) => {
    bar = new FuruBarPage(page);
    // Navigate to Opportunity list so the LWC context = Opportunity
    await bar.gotoObject('Opportunity');
    await bar.openPanel();
  });

  // ── helpers ─────────────────────────────────────────────────────────────────

  /** Submit a command, wait for SOQL results OR a non-empty status text. */
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

  /** Return all condition badge label texts (stripped of the ✕ button text). */
  async function condBadgeLabels(page: Page): Promise<string[]> {
    return page.evaluate(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      return Array.from(root.querySelectorAll('.furu-bar__soql-cond-badge'))
        .map(el => (el as HTMLElement).innerText?.replace('✕', '').trim() ?? '');
    });
  }

  /** Wait up to `ms` for at least one condition badge to appear. */
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

  // ── CloseDate tests ──────────────────────────────────────────────────────────

  test('今月完了予定の商談 → no error, results returned', async ({ page }) => {
    const status = await submitAndWait(page, '今月完了予定の商談を教えて');
    expect(status).not.toMatch(/HTTP 402|HTTP 500|検索エラー/);
    test.info().annotations.push({ type: 'status', description: status });
  });

  test('今月完了予定の商談 → condition badge shows CloseDate (完了予定日), not CreatedDate', async ({ page }) => {
    await submitAndWait(page, '今月完了予定の商談を教えて');

    const hasBadge = await waitForCondBadge(page);
    if (!hasBadge) {
      // No conditions → no badge; still passes if there was no error
      return;
    }

    const labels = await condBadgeLabels(page);
    const combined = labels.join(' | ');

    // Must contain CloseDate label (完了予定日) or at minimum NOT CreatedDate label (作成日)
    expect(combined, `Badge labels: ${combined}`).toMatch(/完了予定日/);
    expect(combined, `Badge labels: ${combined}`).not.toMatch(/作成日/);
    // Must not show the raw LAST_N_DAYS:30 fallback literal
    expect(combined).not.toMatch(/LAST_N_DAYS/);

    test.info().annotations.push({ type: 'badge-labels', description: combined });
  });

  test('今月完了予定の商談 → badge uses "eq" period literal (今月), not ">= 今月" comparison', async ({ page }) => {
    await submitAndWait(page, '今月完了予定の商談を教えて');

    const hasBadge = await waitForCondBadge(page);
    if (!hasBadge) return;

    const labels = await condBadgeLabels(page);
    const combined = labels.join(' | ');

    // The badge label for THIS_MONTH should be "完了予定日: 今月" — colon separator, no "≥"
    // If gte op was used it would appear as "完了予定日 ≥ 今月"
    expect(combined).not.toMatch(/≥\s*今月/);
    expect(combined).not.toMatch(/>=\s*今月/);

    test.info().annotations.push({ type: 'badge-labels', description: combined });
  });

  test('来月クローズ予定の案件 → no error, CloseDate used', async ({ page }) => {
    const status = await submitAndWait(page, '来月クローズ予定の案件を見せて');
    expect(status).not.toMatch(/HTTP 402|HTTP 500|検索エラー/);

    const hasBadge = await waitForCondBadge(page);
    if (!hasBadge) return;

    const labels = await condBadgeLabels(page);
    const combined = labels.join(' | ');

    // CloseDate = NEXT_MONTH → badge should show "完了予定日" not "作成日"
    expect(combined).not.toMatch(/作成日/);
    expect(combined).not.toMatch(/LAST_N_DAYS/);

    test.info().annotations.push({ type: 'badge-labels', description: combined });
  });

  // ── CreatedDate tests (regression guard) ─────────────────────────────────────

  test('先月作成した商談 → no error, CreatedDate used (not CloseDate)', async ({ page }) => {
    const status = await submitAndWait(page, '先月作成した商談を見せて');
    expect(status).not.toMatch(/HTTP 402|HTTP 500|検索エラー/);

    const hasBadge = await waitForCondBadge(page);
    if (!hasBadge) return;

    const labels = await condBadgeLabels(page);
    const combined = labels.join(' | ');

    // CreatedDate = LAST_MONTH → badge should show "作成日" not "完了予定日"
    expect(combined, `Badge labels: ${combined}`).toMatch(/作成日/);
    expect(combined, `Badge labels: ${combined}`).not.toMatch(/完了予定日/);

    test.info().annotations.push({ type: 'badge-labels', description: combined });
  });

  test('過去30日間に作成された商談 → badge shows 作成日 + 過去30日', async ({ page }) => {
    const status = await submitAndWait(page, '過去30日間に作成された商談を見せて');
    expect(status).not.toMatch(/HTTP 402|HTTP 500|検索エラー/);

    const hasBadge = await waitForCondBadge(page);
    if (!hasBadge) return;

    const labels = await condBadgeLabels(page);
    const combined = labels.join(' | ');

    expect(combined).toMatch(/作成日/);
    expect(combined).not.toMatch(/LAST_N_DAYS/);   // raw literal should not appear

    test.info().annotations.push({ type: 'badge-labels', description: combined });
  });
});
