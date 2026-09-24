/**
 * 22 — NAVIGATE-by-name regressions
 *
 * Locks in two bugs reported live against the deployed bar:
 *
 *   1. "open this case <subject text>" → FuruAgentController.findRecordId()
 *      hardcoded `WHERE Name LIKE ...` for every sObject. Case has no Name
 *      field, so this threw "No such column 'Name' on entity 'Case'" straight
 *      into the status bar. Fixed by resolveNameLikeField() (Case/Task/Event
 *      → Subject, dynamic schema check otherwise, graceful null instead of
 *      throwing for unresolvable objects).
 *
 *   2. "Triage this case <text>" → typed from the command bar with no Case
 *      context, this silently ran an unrelated Opportunity search instead of
 *      failing loudly or guiding the user. There is no NL-triggered entry
 *      point to Case Triage (flashBarCaseTriageCard only activates via the
 *      Case record page's recordId, not the chat command bar), so the
 *      deterministic thing this suite can assert is that the bar fails
 *      gracefully — no raw error, no HTTP 500 — rather than the previously
 *      observed crash class. It intentionally does NOT assert which object
 *      the Worker resolves this to, since that's Cloudflare Worker-side
 *      classification this repo doesn't control.
 */
import { test, expect, Page } from '@playwright/test';
import { FuruBarPage } from '../helpers/furuBarPage';

const RAW_ERROR_PATTERNS = /No such column|Script-thrown exception|HTTP 500|検索エラー/i;

test.describe('NAVIGATE-by-name regressions', () => {
  test.describe.configure({ timeout: 300_000 });
  let bar: FuruBarPage;

  test.beforeEach(async ({ page }) => {
    bar = new FuruBarPage(page);
    await bar.goto();
    await bar.openPanel();
  });

  async function submitAndWaitForStatus(page: Page, command: string, timeout = 90_000): Promise<string> {
    await bar.typeCommand(command);
    await bar.submit();
    // Wait for ANY of: SOQL results, a clarify card, or non-empty status text —
    // whichever the Worker's classification lands on, the bar must settle into
    // one of these instead of hanging or crashing.
    await page.waitForFunction(
      () => {
        const b    = document.querySelector('c-furu-agent-bar');
        const root = (b as HTMLElement)?.shadowRoot ?? b!;
        const soql    = root.querySelector('.furu-bar__soql-list, .furu-bar__soql-table');
        const clarify = root.querySelector('.furu-bar__clarify');
        const stat    = (root.querySelector('.furu-bar__status') as HTMLElement)?.innerText?.trim();
        return !!(soql || clarify || stat);
      },
      { timeout }
    );
    return bar.statusText();
  }

  test('"open this case <subject>" does not surface a raw SOQL column error', async ({ page }) => {
    const status = await submitAndWaitForStatus(
      page,
      'open this case Structural breakdown of rotor assembly plz'
    );
    expect(status, `Status: "${status}"`).not.toMatch(RAW_ERROR_PATTERNS);
  });

  test('"Triage this case <text>" fails gracefully instead of crashing', async ({ page }) => {
    const status = await submitAndWaitForStatus(
      page,
      'Triage this case Structural breakdown of rotor assembly plz'
    );
    expect(status, `Status: "${status}"`).not.toMatch(RAW_ERROR_PATTERNS);
  });

  test('"open this task <text>" (another Name-less object) does not throw', async ({ page }) => {
    const status = await submitAndWaitForStatus(page, 'open this task Follow up on rotor inspection plz');
    expect(status, `Status: "${status}"`).not.toMatch(RAW_ERROR_PATTERNS);
  });
});
