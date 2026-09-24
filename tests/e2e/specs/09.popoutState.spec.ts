/**
 * 09 — Pop-out State Transfer
 *
 * When the user presses Cmd+Shift+P, `_popOutWindow()` calls `_savePopOutTransfer()`
 * which serialises the current SOQL query (including records) to a localStorage
 * key (`LSKey[c]furubar_pot_<userId-suffix>`).  The new window, on
 * `connectedCallback`, calls `_consumePopOutTransfer()` which reads, clears, and
 * restores that payload — overriding the empty sessionStorage of the new tab.
 *
 * Two tests:
 *   1. Write side: Cmd+Shift+P after SOQL results loads → transfer key written
 *      with sObject + records.
 *   2. Read side:  Mock payload pre-seeded in localStorage → reload page →
 *      component restores SOQL state + deletes key (read-once guarantee).
 *
 * No full cross-window Salesforce load required — the write test intercepts &
 * immediately closes the popup; the read test seeds + reloads in the same tab.
 */
import { test, expect, Page } from '@playwright/test';
import { FuruBarPage } from '../helpers/furuBarPage';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Return the LWS-namespaced pot key using the component's actual user suffix (data-furu-suffix). */
async function getPotKey(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    // Prefer the suffix exposed by the component (handles "Login As" admin-session edge case)
    const host   = document.querySelector('c-furu-agent-bar') as HTMLElement | null;
    const suffix = host?.dataset?.furuSuffix
      ?? (() => {
        const qsKey = Object.keys(localStorage).find((k: string) => k.includes('furubar_qs_'));
        return qsKey ? qsKey.replace(/.*furubar_qs_/, '') : null;
      })();
    return suffix ? `LSKey[c]furubar_pot_${suffix}` : null;
  });
}

/** Write a mock pop-out transfer payload to localStorage. */
async function seedTransferPayload(page: Page, records: object[] = []) {
  await page.evaluate((recs: object[]) => {
    const host   = document.querySelector('c-furu-agent-bar') as HTMLElement | null;
    const suffix = host?.dataset?.furuSuffix
      ?? (() => {
        const qsKey = Object.keys(localStorage).find((k: string) => k.includes('furubar_qs_'));
        return qsKey ? qsKey.replace(/.*furubar_qs_/, '') : null;
      })();
    if (!suffix) return;
    const payload = {
      soqlQuery: {
        sObject:      'Account',
        conditions:   [],
        orderBy:      null,
        limit:        5,
        selectFields: [
          { apiName: 'Name',  label: '取引先名', labelEn: 'Account Name' },
          { apiName: 'Phone', label: '電話',     labelEn: 'Phone' },
        ],
        records:  recs,
        summary:  `${recs.length}件が見つかりました`,
        hasMore:  false,
      },
      viewMode:  'card',
      inputText: 'テスト検索',
      ts:        Date.now(),
    };
    localStorage.setItem(`LSKey[c]furubar_pot_${suffix}`, JSON.stringify(payload));
  }, records);
}

// ── Test: write side ──────────────────────────────────────────────────────────

test.describe('Pop-out State Transfer — write side', () => {
  test.describe.configure({ timeout: 300_000 });

  test('Cmd+Shift+P writes full SOQL state to pop-out transfer key', async ({ page }) => {
    const bar = new FuruBarPage(page);
    await bar.goto();
    await bar.openPanel();
    await bar.loadAccountsViaShortcut();

    // Intercept and close the popup immediately to keep the test fast
    const popupPromise = page.context()
      .waitForEvent('page', { timeout: 8_000 })
      .catch(() => null);

    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'p', metaKey: true, shiftKey: true,
        bubbles: true, composed: true, cancelable: true,
      }));
    });

    const popup = await popupPromise;
    if (popup) await popup.close();

    // Verify the transfer key was written
    const potKey = await getPotKey(page);
    expect(potKey).not.toBeNull();

    const transfer = await page.evaluate((key: string) => {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    }, potKey!);

    expect(transfer).not.toBeNull();
    expect(transfer.soqlQuery).not.toBeNull();
    expect(transfer.soqlQuery.sObject).toBe('Account');
    expect(Array.isArray(transfer.soqlQuery.records)).toBe(true);
    expect(Array.isArray(transfer.soqlQuery.selectFields)).toBe(true);
    expect(typeof transfer.ts).toBe('number');
    expect(Date.now() - transfer.ts).toBeLessThan(10_000); // written just now
  });
});

// ── Test: read side ───────────────────────────────────────────────────────────

test.describe('Pop-out State Transfer — read side', () => {
  test.describe.configure({ timeout: 300_000 });

  test('pop-out transfer payload is restored on connectedCallback', async ({ page }) => {
    const bar = new FuruBarPage(page);
    await bar.goto();

    // Seed a transfer payload with one mock record
    await seedTransferPayload(page, [
      { Id: '001000000000001AAA', Name: 'テスト取引先株式会社', Phone: '03-1234-5678' },
    ]);

    // Reload the page — connectedCallback will call _consumePopOutTransfer()
    await bar.goto();
    await bar.openPanel();

    // SOQL results should be restored: wait for soql-header to appear
    // (_consumePopOutTransfer runs in connectedCallback; LWC reactive rendering
    // may need a moment after openPanel() before the header is in the DOM)
    await page.waitForFunction(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      return !!root.querySelector('.furu-bar__soql-header');
    }, { timeout: 15_000 });

    // SOQL summary span should contain the restored record count
    const summary = await page.evaluate(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      return (root.querySelector('.furu-bar__soql-summary') as HTMLElement)?.innerText?.trim() ?? '';
    });
    expect(summary).toMatch(/\d+/);
  });

  test('transfer key is deleted after restore (read-once)', async ({ page }) => {
    const bar = new FuruBarPage(page);
    await bar.goto();

    await seedTransferPayload(page, [
      { Id: '001000000000002AAA', Name: 'リードワンス確認', Phone: '06-9999-0000' },
    ]);

    const potKey = await getPotKey(page);
    expect(potKey).not.toBeNull();

    // Verify the key exists before reload
    const beforeReload = await page.evaluate((key: string) => !!localStorage.getItem(key), potKey!);
    expect(beforeReload).toBe(true);

    // Reload triggers _consumePopOutTransfer which deletes the key
    await bar.goto();
    await bar.openPanel();

    // Key must be gone after consumption
    const afterReload = await page.evaluate((key: string) => localStorage.getItem(key), potKey!);
    expect(afterReload).toBeNull();
  });

  test('stale transfer payload (> 90s old) is discarded', async ({ page }) => {
    const bar = new FuruBarPage(page);
    await bar.goto();

    // Seed an expired payload (ts = 2 minutes ago)
    await page.evaluate(() => {
      const qsKey = Object.keys(localStorage).find((k: string) => k.includes('furubar_qs_'));
      if (!qsKey) return;
      const suffix = qsKey.replace(/.*furubar_qs_/, '');
      const payload = {
        soqlQuery: {
          sObject: 'Account',
          conditions: [], orderBy: null, limit: 5,
          selectFields: [{ apiName: 'Name', label: '取引先名', labelEn: 'Account Name' }],
          records: [{ Id: '001000000000003AAA', Name: '古いデータ' }],
          summary: '1件', hasMore: false,
        },
        viewMode: 'card', inputText: '',
        ts: Date.now() - 120_000, // 2 minutes ago — expired
      };
      localStorage.setItem(`LSKey[c]furubar_pot_${suffix}`, JSON.stringify(payload));
    });

    await bar.goto();
    await bar.openPanel();

    // Stale payload should NOT restore SOQL results
    const soqlVisible = await page.evaluate(() => {
      const b    = document.querySelector('c-furu-agent-bar');
      const root = (b as HTMLElement)?.shadowRoot ?? b!;
      return !!root.querySelector('.furu-bar__soql-header');
    });
    expect(soqlVisible).toBe(false);
  });
});
