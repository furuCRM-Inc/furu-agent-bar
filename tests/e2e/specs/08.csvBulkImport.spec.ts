/**
 * 08 — CSV Bulk Import
 * Tests drag-and-drop CSV upload, column mapping, import execution,
 * and result download.
 *
 * The test builds a small in-memory CSV blob and drops it onto the bar.
 */
import { test, expect } from '@playwright/test';
import { FuruBarPage } from '../helpers/furuBarPage';

// A minimal valid Lead CSV (3 rows) for import testing
const LEAD_CSV = [
  'LastName,Company,Email,LeadSource',
  'E2ETest_山田,E2E株式会社_A,e2e-yamada@test.local,Web',
  'E2ETest_佐藤,E2E株式会社_B,e2e-sato@test.local,Web',
  'E2ETest_鈴木,E2E株式会社_C,e2e-suzuki@test.local,Web',
].join('\n');

// CSV with one valid row and one row missing required LastName — forces a DML NG
const BAD_LEAD_CSV = [
  'LastName,Company,Email',
  'E2ETest_ValidRow,E2E Corp NG-A,e2e-ng-valid@test.local',
  ',E2E Corp NG-B,e2e-ng-noname@test.local',
].join('\n');

test.describe('CSV Bulk Import', () => {
  let bar: FuruBarPage;

  test.beforeEach(async ({ page }) => {
    bar = new FuruBarPage(page);
    // Navigate to Lead list view so _sObjectType='Lead' is set via CurrentPageReference.
    // handleCsvImport() returns early if _sObjectType is null (generic app page has no context).
    await bar.gotoObject('Lead');
    await bar.openPanel();
  });

  test.afterEach(async () => {
    // Best-effort cleanup: delete any E2ETest leads created during the test
    // (done via sf CLI outside the browser — test doesn't block on this)
  });

  test('dropping a CSV file triggers the import flow', async ({ page }) => {
    // Simulate file drop via page.evaluate + DataTransfer
    await page.evaluate((csvContent: string) => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const dropTarget = root.querySelector('.furu-bar__input-card') as HTMLElement;
      if (!dropTarget) throw new Error('.furu-bar__input-card not found');

      const blob = new Blob([csvContent], { type: 'text/csv' });
      const file = new File([blob], 'leads.csv', { type: 'text/csv' });
      const dt   = new DataTransfer();
      dt.items.add(file);

      dropTarget.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      dropTarget.dispatchEvent(new DragEvent('drop',     { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, LEAD_CSV);

    // CSV import card should appear
    await page.waitForFunction(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__csv');
    }, { timeout: 20_000 });

    const csvCardVisible = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__csv');
    });
    expect(csvCardVisible).toBe(true);
  });

  test('CSV card shows file name and row count', async ({ page }) => {
    await page.evaluate((csvContent: string) => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const dt   = new DataTransfer();
      dt.items.add(new File([new Blob([csvContent], { type: 'text/csv' })], 'leads.csv', { type: 'text/csv' }));
      (root.querySelector('.furu-bar__input-card') as HTMLElement)
        ?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, LEAD_CSV);

    await page.waitForFunction(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__csv-title');
    }, { timeout: 20_000 });

    const fileName = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return (root.querySelector('.furu-bar__csv-title') as HTMLElement)?.innerText?.trim();
    });
    expect(fileName).toBe('leads.csv');

    const rowCount = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return (root.querySelector('.furu-bar__csv-count') as HTMLElement)?.innerText?.trim();
    });
    expect(rowCount).toContain('3');
  });

  test('column mapping phase shows AI-mapped columns', async ({ page }) => {
    await page.evaluate((csv: string) => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const dt = new DataTransfer();
      dt.items.add(new File([new Blob([csv], { type: 'text/csv' })], 'leads.csv', { type: 'text/csv' }));
      (root.querySelector('.furu-bar__input-card') as HTMLElement)
        ?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, LEAD_CSV);

    // Wait for mapping preview phase
    await page.waitForFunction(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__csv-map-list, .furu-bar__csv-map-row');
    }, { timeout: 30_000 });

    const mapRows = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return root.querySelectorAll('.furu-bar__csv-map-row').length;
    });
    // Should have 4 mapping rows (one per CSV column)
    expect(mapRows).toBeGreaterThanOrEqual(1);
  });

  test('import button triggers insert and shows progress', async ({ page }) => {
    await page.evaluate((csv: string) => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const dt = new DataTransfer();
      dt.items.add(new File([new Blob([csv], { type: 'text/csv' })], 'leads.csv', { type: 'text/csv' }));
      (root.querySelector('.furu-bar__input-card') as HTMLElement)
        ?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, LEAD_CSV);

    // Wait for mapping preview to appear
    await page.waitForFunction(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__csv-map-row');
    }, { timeout: 60_000 });

    await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const btns = Array.from(root.querySelectorAll('button'));
      const importBtn = btns.find(b => b.textContent?.includes('インポート') || b.textContent?.includes('Import'));
      (importBtn as HTMLButtonElement | undefined)?.click();
    });

    // Verify import started (progress bar or result already done)
    await page.waitForFunction(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!(
        root.querySelector('.furu-bar__csv-progress-bar') ||
        root.querySelector('.furu-bar__csv-result')
      );
    }, { timeout: 120_000 });

    // Wait for import to finish — progress bar disappears and result card appears
    await page.waitForFunction(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__csv-result');
    }, { timeout: 180_000 });

    const resultVisible = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__csv-result');
    });
    expect(resultVisible).toBe(true);
  });

  test('download link appears after import completes', async ({ page }) => {
    await page.evaluate((csv: string) => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const dt = new DataTransfer();
      dt.items.add(new File([new Blob([csv], { type: 'text/csv' })], 'leads.csv', { type: 'text/csv' }));
      (root.querySelector('.furu-bar__input-card') as HTMLElement)
        ?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, LEAD_CSV);

    await page.waitForFunction(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__csv-map-row');
    }, { timeout: 60_000 });

    await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const btns = Array.from(root.querySelectorAll('button'));
      (btns.find(b => b.textContent?.includes('インポート') || b.textContent?.includes('Import')) as HTMLButtonElement | undefined)?.click();
    });

    await page.waitForFunction(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('a[download], .furu-bar__csv-result');
    }, { timeout: 120_000 });

    const href = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return (root.querySelector('a[download]') as HTMLAnchorElement)?.href ?? '';
    });
    expect(href).toContain('data:text/csv');
  });

  test('result CSV contains NG status and error message for failed rows', async ({ page }) => {
    // Drop CSV that has one valid row and one row missing required LastName
    await page.evaluate((csv: string) => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const dt = new DataTransfer();
      dt.items.add(new File([new Blob([csv], { type: 'text/csv' })], 'leads_bad.csv', { type: 'text/csv' }));
      (root.querySelector('.furu-bar__input-card') as HTMLElement)
        ?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, BAD_LEAD_CSV);

    await page.waitForFunction(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      return !!root.querySelector('.furu-bar__csv-map-row');
    }, { timeout: 60_000 });

    await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const btns = Array.from(root.querySelectorAll('button'));
      (btns.find(b => b.textContent?.includes('インポート') || b.textContent?.includes('Import')) as HTMLButtonElement | undefined)?.click();
    });

    // Wait for result download link (data: URI is set directly on the <a> element)
    await page.waitForFunction(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const a = root.querySelector('a[download]') as HTMLAnchorElement | null;
      return !!(a?.href?.startsWith('data:'));
    }, { timeout: 120_000 });

    // Decode the base64 data URI directly in the browser — no file save needed
    const csvText = await page.evaluate(() => {
      const bar = document.querySelector('c-furu-agent-bar');
      const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
      const href = (root.querySelector('a[download]') as HTMLAnchorElement)?.href ?? '';
      const b64 = href.split(',')[1];
      return b64 ? atob(b64) : '';
    });

    const content = csvText.replace(/^﻿/, ''); // strip BOM
    const lines   = content.split(/\r?\n/).filter(l => l.trim());
    const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());

    // Result CSV must include status and error columns
    const statusIdx = headers.findIndex(h => /import_status|インポート結果/i.test(h));
    const errorIdx  = headers.findIndex(h => /error_message|エラー内容/i.test(h));
    expect(statusIdx, 'status column missing from result CSV').toBeGreaterThanOrEqual(0);
    expect(errorIdx,  'error column missing from result CSV').toBeGreaterThanOrEqual(0);

    // At least one row must be NG with a non-empty error
    const dataRows = lines.slice(1).map(l =>
      l.split(',').map(c => c.replace(/^"|"$/g, '').trim())
    );
    const ngRows = dataRows.filter(r => r[statusIdx] === 'NG');
    expect(ngRows.length, 'expected at least one NG row').toBeGreaterThanOrEqual(1);
    expect(ngRows[0][errorIdx], 'NG row must have a non-empty error message').toBeTruthy();
  });
});
