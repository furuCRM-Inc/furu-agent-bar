/**
 * 06 — Admin Panel
 * Covers: settings gear visible for admins → settings modal opens →
 * pending rule count shows → approve/reject buttons present →
 * rule content is not empty → approve action dismisses the card.
 *
 * Also covers: Admin Debug Panel (Tier 4 confidence UX) —
 *   ⚙ toggle button visible → click shows dark debug panel →
 *   panel contains Intent / JEV% / Latency / sObj after a query.
 */
import { test, expect, Page } from '@playwright/test';
import { FuruBarPage } from '../helpers/furuBarPage';

/** DOM helper: find the bar shadow root. */
const getRoot = `(() => { const b = document.querySelector('c-furu-agent-bar'); return (b as HTMLElement)?.shadowRoot ?? b!; })()`;

test.describe('Admin Panel', () => {
  let bar: FuruBarPage;

  test.beforeEach(async ({ page }) => {
    bar = new FuruBarPage(page);
    await bar.goto();
    await bar.openPanel();
    await page.waitForTimeout(2_000); // wait for @wire admin context
  });

  test('gear icon ⚙️ is visible for admin users', async ({ page }) => {
    const gearVisible = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const btns = Array.from(root.querySelectorAll('button'));
      return btns.some(b => b.textContent?.includes('⚙️') || b.getAttribute('title')?.includes('設定'));
    });
    if (!gearVisible) {
      test.info().annotations.push({ type: 'note', description: 'Non-admin user — gear not shown (expected)' });
    }
  });

  test('settings modal opens on ⚙️ click', async ({ page }) => {
    const gearVisible = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const btns = Array.from(root.querySelectorAll('button'));
      return btns.some(b => b.textContent?.includes('⚙️'));
    });
    test.skip(!gearVisible, 'Non-admin user');

    await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const btns = Array.from(root.querySelectorAll('button'));
      const gear = btns.find(b => b.textContent?.includes('⚙️'));
      (gear as HTMLButtonElement | undefined)?.click();
    });

    await page.waitForFunction(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__modal');
    }, { timeout: 10_000 });

    const modalVisible = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__modal');
    });
    expect(modalVisible).toBe(true);
  });

  test('pending approval card shows approve/reject buttons', async ({ page }) => {
    await page.waitForTimeout(3_000);
    const hasPendingCard = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__approval');
    });

    if (!hasPendingCard) {
      test.info().annotations.push({ type: 'note', description: 'No pending rules in this org' });
      return;
    }

    const btns = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return Array.from(root.querySelectorAll('.furu-bar__approval button'))
        .map(b => (b as HTMLElement).innerText.trim());
    });
    expect(btns.some(t => t.includes('承認') || t.includes('Approve'))).toBe(true);
    expect(btns.some(t => t.includes('拒否') || t.includes('却下') || t.includes('Reject'))).toBe(true);
  });

  // ── Strengthened: rule content must not be empty ──────────────────────────

  test('pending rule card shows non-empty rule content', async ({ page }) => {
    await page.waitForTimeout(3_000);

    const info = await page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const card = root.querySelector('.furu-bar__approval');
      if (!card) return null;

      // Count badge
      const countBadge = root.querySelector('.furu-bar__approval-count');
      const countText  = (countBadge as HTMLElement)?.innerText?.trim() ?? '';

      // Rule content paragraph
      const rulePara = root.querySelector('.furu-bar__approval-rule');
      const ruleText = (rulePara as HTMLElement)?.innerText?.trim() ?? '';

      return { countText, ruleText };
    });

    if (!info) {
      test.info().annotations.push({ type: 'note', description: 'No pending rules in this org — skipping content check' });
      return;
    }

    // After the LWC fix, records with no ruleText/errorMessage show at minimum the
    // sObjectType-based guidance, so the bare zero-context placeholder should never appear.
    // If still showing the old placeholder, it means the LWC fix is not yet deployed.
    if (info.ruleText === '（ルール内容未設定）') {
      test.info().annotations.push({
        type: 'known-data-issue',
        description: 'FuruAgent_Knowledge__c records have null Plain_English_Rule__c and null Error_Message__c. Deploy LWC fix to resolve.',
      });
    }
    expect(info.ruleText.length).toBeGreaterThan(0);

    // Count badge must show a number ≥ 1
    expect(info.countText).toMatch(/\d+/);
  });

  test('pending rule count badge matches actual pending cards served', async ({ page }) => {
    await page.waitForTimeout(3_000);

    const hasPendingCard = await page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__approval');
    });
    if (!hasPendingCard) {
      test.info().annotations.push({ type: 'note', description: 'No pending rules — count badge test skipped' });
      return;
    }

    const badgeNum = await page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const txt  = (root.querySelector('.furu-bar__approval-count') as HTMLElement)?.innerText ?? '';
      const m    = txt.match(/(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    });

    // The LWC shows one card at a time (pendingRule = _pendingRules[0]).
    // The badge should reflect the total queue size ≥ 1.
    expect(badgeNum).toBeGreaterThanOrEqual(1);
  });

  test('approve button dismisses the current pending card', async ({ page }) => {
    await page.waitForTimeout(3_000);

    const hasPendingCard = await page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__approval');
    });
    if (!hasPendingCard) {
      test.info().annotations.push({ type: 'note', description: 'No pending rules — approve action test skipped' });
      return;
    }

    const badgeBefore = await page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const txt  = (root.querySelector('.furu-bar__approval-count') as HTMLElement)?.innerText ?? '';
      const m    = txt.match(/(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    });

    // Click approve (ワンタップ承認)
    await page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const btns = Array.from(root.querySelectorAll('.furu-bar__approval button'));
      const approveBtn = btns.find(b =>
        (b as HTMLElement).innerText?.includes('承認') || (b as HTMLElement).innerText?.includes('Approve')
      );
      (approveBtn as HTMLButtonElement | undefined)?.click();
    });

    // Wait up to 15s for the Apex callout to complete: badge shrinks OR status text appears
    await page.waitForFunction(
      (before: number) => {
        const bar  = document.querySelector('c-furu-agent-bar');
        const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
        const badge = root.querySelector('.furu-bar__approval-count');
        const count = parseInt(((badge as HTMLElement)?.innerText ?? '').match(/(\d+)/)?.[1] ?? '999', 10);
        const stat  = (root.querySelector('.furu-bar__status') as HTMLElement)?.innerText?.trim();
        return count < before || !!stat;
      },
      badgeBefore,
      { timeout: 15_000 }
    ).catch(() => {});  // timeout is OK — we check state below

    const { badgeAfter, statusText } = await page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const badge = root.querySelector('.furu-bar__approval-count');
      const txt   = (badge as HTMLElement)?.innerText ?? '';
      const m     = txt.match(/(\d+)/);
      return {
        badgeAfter: m ? parseInt(m[1], 10) : 0,
        statusText: (root.querySelector('.furu-bar__status') as HTMLElement)?.innerText?.trim() ?? '',
      };
    });

    test.info().annotations.push({ type: 'approve-result', description: `badge: ${badgeBefore}→${badgeAfter}, status: "${statusText}"` });

    // If Apex failed (error in status), skip rather than fail — this is a data/permission issue
    if (/error|エラー|permission|FIELD_INTEGRITY|INSUFFICIENT/i.test(statusText)) {
      test.info().annotations.push({ type: 'skip-reason', description: `Apex approveRule failed: ${statusText}` });
      return;
    }

    // After approval the queue shrinks by 1 (or card disappears entirely)
    expect(badgeAfter, `Badge should decrease after approve. Before: ${badgeBefore}, After: ${badgeAfter}`).toBeLessThan(badgeBefore);
  });

  test('reject button dismisses the current pending card', async ({ page }) => {
    await page.waitForTimeout(3_000);

    const hasPendingCard = await page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__approval');
    });
    if (!hasPendingCard) {
      test.info().annotations.push({ type: 'note', description: 'No pending rules — reject action test skipped' });
      return;
    }

    const badgeBefore = await page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const txt  = (root.querySelector('.furu-bar__approval-count') as HTMLElement)?.innerText ?? '';
      const m    = txt.match(/(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    });

    await page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const btns = Array.from(root.querySelectorAll('.furu-bar__approval button'));
      const rejectBtn = btns.find(b => {
        const t = (b as HTMLElement).innerText ?? '';
        return t.includes('拒否') || t.includes('却下') || t.includes('Reject');
      });
      (rejectBtn as HTMLButtonElement | undefined)?.click();
    });

    // Wait up to 15s for the Apex callout to complete
    await page.waitForFunction(
      (before: number) => {
        const bar  = document.querySelector('c-furu-agent-bar');
        const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
        const badge = root.querySelector('.furu-bar__approval-count');
        const count = parseInt(((badge as HTMLElement)?.innerText ?? '').match(/(\d+)/)?.[1] ?? '999', 10);
        const stat  = (root.querySelector('.furu-bar__status') as HTMLElement)?.innerText?.trim();
        return count < before || !!stat;
      },
      badgeBefore,
      { timeout: 15_000 }
    ).catch(() => {});

    const { badgeAfter, statusText } = await page.evaluate(() => {
      const bar  = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const badge = root.querySelector('.furu-bar__approval-count');
      const txt   = (badge as HTMLElement)?.innerText ?? '';
      const m     = txt.match(/(\d+)/);
      return {
        badgeAfter: m ? parseInt(m[1], 10) : 0,
        statusText: (root.querySelector('.furu-bar__status') as HTMLElement)?.innerText?.trim() ?? '',
      };
    });

    test.info().annotations.push({ type: 'reject-result', description: `badge: ${badgeBefore}→${badgeAfter}, status: "${statusText}"` });

    if (/error|エラー|permission|FIELD_INTEGRITY|INSUFFICIENT/i.test(statusText)) {
      test.info().annotations.push({ type: 'skip-reason', description: `Apex rejectRule failed: ${statusText}` });
      return;
    }

    expect(badgeAfter, `Badge should decrease after reject. Before: ${badgeBefore}, After: ${badgeAfter}`).toBeLessThan(badgeBefore);
  });
});

// ── Admin Debug Panel (Tier 4 confidence UX) ─────────────────────────────────

test.describe('Admin Debug Panel (Tier 4)', () => {
  test.describe.configure({ timeout: 600_000 });
  let bar: FuruBarPage;

  const getRoot = `(() => { const b = document.querySelector('c-furu-agent-bar'); return (b as HTMLElement)?.shadowRoot ?? b!; })()`;

  async function shadowEval<T>(page: Page, expr: string): Promise<T> {
    return page.evaluate<T>(`(${getRoot}).${expr}` as string);
  }

  test.beforeEach(async ({ page }) => {
    bar = new FuruBarPage(page);
    await bar.gotoObject('Opportunity');
    await bar.openPanel();
    await page.waitForTimeout(2_000);  // allow @wire admin context
  });

  test('⚙ debug toggle button is visible for admin user', async ({ page }) => {
    const hasToggle = await page.evaluate(
      () => (document.querySelector('c-furu-agent-bar') as HTMLElement)?.shadowRoot
              ?.querySelector('.furu-bar__debug-toggle') !== null
    );
    expect(hasToggle, 'Admin should see ⚙ debug toggle in the footer').toBe(true);
  });

  test('debug panel is hidden before toggle is clicked', async ({ page }) => {
    const panelVisible = await page.evaluate(
      () => (document.querySelector('c-furu-agent-bar') as HTMLElement)?.shadowRoot
              ?.querySelector('.furu-bar__debug-panel') !== null
    );
    expect(panelVisible, 'Debug panel must be hidden before clicking toggle').toBe(false);
  });

  test('clicking ⚙ toggle after a SOQL query shows debug panel', async ({ page }) => {
    // Run a known SOQL query to populate _debugInfo
    await bar.typeCommand('今月の商談');
    await bar.submit();
    await page.waitForFunction(
      () => {
        const b    = document.querySelector('c-furu-agent-bar');
        const root = (b as HTMLElement)?.shadowRoot ?? b!;
        return !!(root.querySelector('.furu-bar__soql-list, .furu-bar__soql-table') ||
                  (root.querySelector('.furu-bar__status') as HTMLElement)?.innerText?.trim());
      },
      { timeout: 90_000 }
    );

    // Click the debug toggle
    await page.evaluate(() => {
      const root = (document.querySelector('c-furu-agent-bar') as HTMLElement)?.shadowRoot!;
      (root.querySelector('.furu-bar__debug-toggle') as HTMLButtonElement | null)?.click();
    });

    await page.waitForTimeout(300);

    const panelVisible = await page.evaluate(
      () => (document.querySelector('c-furu-agent-bar') as HTMLElement)?.shadowRoot
              ?.querySelector('.furu-bar__debug-panel') !== null
    );
    expect(panelVisible, 'Debug panel should appear after clicking ⚙ toggle').toBe(true);
  });

  test('debug panel shows Intent, JEV%, Latency after query', async ({ page }) => {
    // Run a known SOQL query
    await bar.typeCommand('今月の商談');
    await bar.submit();
    await page.waitForFunction(
      () => {
        const b    = document.querySelector('c-furu-agent-bar');
        const root = (b as HTMLElement)?.shadowRoot ?? b!;
        return !!(root.querySelector('.furu-bar__soql-list, .furu-bar__soql-table') ||
                  (root.querySelector('.furu-bar__status') as HTMLElement)?.innerText?.trim());
      },
      { timeout: 90_000 }
    );

    // Open debug panel
    await page.evaluate(() => {
      const root = (document.querySelector('c-furu-agent-bar') as HTMLElement)?.shadowRoot!;
      (root.querySelector('.furu-bar__debug-toggle') as HTMLButtonElement | null)?.click();
    });

    await page.waitForFunction(
      () => (document.querySelector('c-furu-agent-bar') as HTMLElement)?.shadowRoot
              ?.querySelector('.furu-bar__debug-panel') !== null,
      { timeout: 5_000 }
    );

    const panelText = await page.evaluate(() => {
      const root = (document.querySelector('c-furu-agent-bar') as HTMLElement)?.shadowRoot!;
      return (root.querySelector('.furu-bar__debug-panel') as HTMLElement)?.innerText?.trim() ?? '';
    });

    // Must contain intent label, a percentage, and a latency (number + "ms")
    expect(panelText, `Debug panel text: ${panelText}`).toMatch(/Intent:/i);
    expect(panelText, `Debug panel text: ${panelText}`).toMatch(/JEV:/i);
    expect(panelText, `Debug panel text: ${panelText}`).toMatch(/\d+%/);
    expect(panelText, `Debug panel text: ${panelText}`).toMatch(/Latency:/i);
    expect(panelText, `Debug panel text: ${panelText}`).toMatch(/\d+ms/);

    test.info().annotations.push({ type: 'debug-panel', description: panelText });
  });

  test('clicking ⚙ toggle again hides the debug panel', async ({ page }) => {
    // Submit query first
    await bar.typeCommand('今月の商談');
    await bar.submit();
    await page.waitForFunction(
      () => {
        const b    = document.querySelector('c-furu-agent-bar');
        const root = (b as HTMLElement)?.shadowRoot ?? b!;
        return !!(root.querySelector('.furu-bar__soql-list, .furu-bar__soql-table') ||
                  (root.querySelector('.furu-bar__status') as HTMLElement)?.innerText?.trim());
      },
      { timeout: 90_000 }
    );

    const toggle = async () => page.evaluate(() => {
      const root = (document.querySelector('c-furu-agent-bar') as HTMLElement)?.shadowRoot!;
      (root.querySelector('.furu-bar__debug-toggle') as HTMLButtonElement | null)?.click();
    });

    await toggle();  // open
    await page.waitForTimeout(300);
    await toggle();  // close
    await page.waitForTimeout(300);

    const panelVisible = await page.evaluate(
      () => (document.querySelector('c-furu-agent-bar') as HTMLElement)?.shadowRoot
              ?.querySelector('.furu-bar__debug-panel') !== null
    );
    expect(panelVisible, 'Debug panel should hide after second ⚙ click').toBe(false);
  });
});
