/**
 * 13 — CSV Import: Parent External Key & Child Upsert
 *
 * Tests the two extended lookup modes in bulkImportCsv:
 *
 *   A. Parent by Name      — AccountId column holds Account.Name string
 *                            → Apex resolves via WHERE Name IN :vals
 *
 *   B. Child upsert        — External Key Field input typed in the UI
 *                            → Apex calls Database.upsert(toSave, extFld, false)
 *                            → second import with same key → UPDATE, not INSERT
 *
 *   C. Combined            — child upsert key + parent resolved by Name
 *
 * Prerequisites (deploy before running):
 *   sf project deploy start --metadata "CustomField:Contact.CSV_External_Key__c"
 */
import { test, expect, Page } from '@playwright/test';
import { FuruBarPage } from '../helpers/furuBarPage';

// ── Salesforce REST API helpers (runs in Node context, not browser) ───────────

const INSTANCE_URL  = process.env.SF_INSTANCE_URL ?? '';
const ACCESS_TOKEN  = process.env.SF_ADMIN_ACCESS_TOKEN ?? process.env.SF_ACCESS_TOKEN ?? '';
const API_BASE      = `${INSTANCE_URL}/services/data/v62.0`;

async function sfCreate(sObject: string, fields: Record<string, unknown>): Promise<string> {
  const res  = await fetch(`${API_BASE}/sobjects/${sObject}`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(fields),
  });
  const body = await res.json() as { id?: string; message?: string };
  if (!body.id) throw new Error(`sfCreate ${sObject} failed: ${JSON.stringify(body)}`);
  return body.id;
}

async function sfDeleteRecord(sObject: string, id: string): Promise<void> {
  await fetch(`${API_BASE}/sobjects/${sObject}/${id}`, {
    method:  'DELETE',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
}

async function sfQuery(soql: string): Promise<Record<string, unknown>[]> {
  const url = `${API_BASE}/query?q=${encodeURIComponent(soql)}`;
  const res  = await fetch(url, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  const body = await res.json() as { records?: Record<string, unknown>[] };
  return body.records ?? [];
}

// ── Shared constants ──────────────────────────────────────────────────────────

const PARENT_ACCT_NAME = 'E2E_CsvExtKey_ParentAccount_E2E';
const EXT_KEY_VALUE    = 'EXT-KEY-E2E-001';
const EXT_KEY_VALUE2   = 'EXT-KEY-E2E-002';

// ── Per-test data helpers ─────────────────────────────────────────────────────

/** Drop a CSV blob onto the FlashBar import card and wait for the mapping preview. */
async function dropCsvAndWaitForMapping(page: Page, csvContent: string, fileName: string): Promise<void> {
  await page.evaluate(({ csv, name }: { csv: string; name: string }) => {
    const bar  = document.querySelector('c-furu-agent-bar');
    const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
    const dt   = new DataTransfer();
    dt.items.add(new File([new Blob([csv], { type: 'text/csv' })], name, { type: 'text/csv' }));
    (root.querySelector('.furu-bar__input-card') as HTMLElement)
      ?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { csv: csvContent, name: fileName });

  await page.waitForFunction(() => {
    const bar  = document.querySelector('c-furu-agent-bar');
    const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
    return !!root.querySelector('.furu-bar__csv-map-row');
  }, { timeout: 60_000 });
}

/** Type the external key field name into the UI input, then click Import. */
async function setExtKeyAndImport(page: Page, extKeyField: string): Promise<void> {
  // Set the input value and fire both 'input' and 'change' events with composed:true
  // so LWC's handleCsvExtKeyChange receives evt.target.value correctly across shadow DOM.
  await page.evaluate((field: string) => {
    const bar   = document.querySelector('c-furu-agent-bar');
    const root  = (bar as HTMLElement)?.shadowRoot ?? bar!;
    const input = root.querySelector('.furu-bar__csv-ext-key-input') as HTMLInputElement | null;
    if (input) {
      input.value = field;
      input.dispatchEvent(new InputEvent('input',  { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change',      { bubbles: true, composed: true }));
    }
  }, extKeyField);

  // Small pause so LWC's reactive property update settles before we click import
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    const bar  = document.querySelector('c-furu-agent-bar');
    const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
    const btns = Array.from(root.querySelectorAll('button'));
    (btns.find(b => b.textContent?.includes('インポート') || b.textContent?.includes('Import')) as HTMLButtonElement | undefined)?.click();
  });
}

/** Click Import without setting an external key field. */
async function clickImport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const bar  = document.querySelector('c-furu-agent-bar');
    const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
    const btns = Array.from(root.querySelectorAll('button'));
    (btns.find(b => b.textContent?.includes('インポート') || b.textContent?.includes('Import')) as HTMLButtonElement | undefined)?.click();
  });
}

/** Wait for the result download link and decode the result CSV. */
async function waitAndDecodeResultCsv(page: Page): Promise<string[][]> {
  await page.waitForFunction(() => {
    const bar = document.querySelector('c-furu-agent-bar');
    const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
    const a = root.querySelector('a[download]') as HTMLAnchorElement | null;
    return !!(a?.href?.startsWith('data:'));
  }, { timeout: 120_000 });

  const csvText = await page.evaluate(() => {
    const bar  = document.querySelector('c-furu-agent-bar');
    const root = (bar as HTMLElement)?.shadowRoot ?? bar!;
    const href = (root.querySelector('a[download]') as HTMLAnchorElement)?.href ?? '';
    const b64  = href.split(',')[1];
    // Reverse of btoa(unescape(encodeURIComponent(csv))) — handles UTF-8 Japanese column names
    return b64 ? decodeURIComponent(escape(atob(b64))) : '';
  });

  const content = csvText.replace(/^﻿/, '');
  return content
    .split(/\r?\n/)
    .filter(l => l.trim())
    .map(l => l.split(',').map(c => c.replace(/^"|"$/g, '').trim()));
}

// ── Test suite ────────────────────────────────────────────────────────────────

test.describe('CSV Import — Parent External Key & Child Upsert', () => {
  let bar: FuruBarPage;
  let parentAccountId: string;
  const createdContactIds: string[] = [];

  test.beforeAll(async () => {
    // Create one parent Account used across tests
    parentAccountId = await sfCreate('Account', { Name: PARENT_ACCT_NAME });
  });

  test.afterAll(async () => {
    for (const id of createdContactIds) {
      await sfDeleteRecord('Contact', id).catch(() => {});
    }
    if (parentAccountId) await sfDeleteRecord('Account', parentAccountId).catch(() => {});
  });

  test.beforeEach(async ({ page }) => {
    bar = new FuruBarPage(page);
    await bar.gotoObject('Contact');
    await bar.openPanel();
  });

  // ── A: Parent lookup by Account Name ─────────────────────────────────────

  test('AccountId resolved by Account Name — Contact linked to correct parent', async ({ page }) => {
    const csv = [
      'LastName,AccountId',
      `E2E_ChildByName,${PARENT_ACCT_NAME}`,
    ].join('\n');

    await dropCsvAndWaitForMapping(page, csv, 'contact_by_name.csv');
    await clickImport(page);

    const rows = await waitAndDecodeResultCsv(page);
    const headers   = rows[0];
    const statusIdx = headers.findIndex(h => /import_status|インポート結果/i.test(h));
    expect(statusIdx, 'status column must exist').toBeGreaterThanOrEqual(0);

    const dataRows = rows.slice(1);
    expect(dataRows.length).toBe(1);
    expect(dataRows[0][statusIdx]).toBe('OK');

    // Verify the Contact is actually linked to the parent Account
    const contacts = await sfQuery(
      `SELECT Id, AccountId FROM Contact WHERE LastName = 'E2E_ChildByName' ORDER BY CreatedDate DESC LIMIT 1`
    );
    expect(contacts.length, 'Contact must have been created').toBe(1);
    expect(contacts[0].AccountId).toBe(parentAccountId);
    createdContactIds.push(contacts[0].Id as string);
  });

  // ── B: Child upsert — create then update via external key ────────────────

  test('child upsert creates Contact on first import', async ({ page }) => {
    const csv = [
      'LastName,Company,CSV_External_Key__c',
      `E2E_Upsert_V1,E2E Corp Upsert,${EXT_KEY_VALUE}`,
    ].join('\n');

    await dropCsvAndWaitForMapping(page, csv, 'contact_upsert_create.csv');
    await setExtKeyAndImport(page, 'CSV_External_Key__c');

    const rows = await waitAndDecodeResultCsv(page);
    const headers   = rows[0];
    const statusIdx = headers.findIndex(h => /import_status|インポート結果/i.test(h));
    expect(statusIdx, 'status column must exist').toBeGreaterThanOrEqual(0);
    expect(rows[1]?.[statusIdx]).toBe('OK');

    const contacts = await sfQuery(
      `SELECT Id, LastName FROM Contact WHERE CSV_External_Key__c = '${EXT_KEY_VALUE}' LIMIT 1`
    );
    expect(contacts.length, 'Contact must be created').toBe(1);
    expect(contacts[0].LastName).toBe('E2E_Upsert_V1');
    createdContactIds.push(contacts[0].Id as string);
  });

  test('child upsert updates existing Contact on second import with same key', async ({ page }) => {
    // Pre-condition: EXT_KEY_VALUE contact already created by the previous test.
    // If run in isolation, create it first.
    const existing = await sfQuery(
      `SELECT Id FROM Contact WHERE CSV_External_Key__c = '${EXT_KEY_VALUE}' LIMIT 1`
    );
    if (existing.length === 0) {
      const id = await sfCreate('Contact', { LastName: 'E2E_Upsert_V1', CSV_External_Key__c: EXT_KEY_VALUE });
      createdContactIds.push(id);
    }

    const csv = [
      'LastName,Company,CSV_External_Key__c',
      `E2E_Upsert_V2,E2E Corp Upsert Updated,${EXT_KEY_VALUE}`,
    ].join('\n');

    await dropCsvAndWaitForMapping(page, csv, 'contact_upsert_update.csv');
    await setExtKeyAndImport(page, 'CSV_External_Key__c');

    const rows = await waitAndDecodeResultCsv(page);
    const headers   = rows[0];
    const statusIdx = headers.findIndex(h => /import_status|インポート結果/i.test(h));
    expect(rows[1]?.[statusIdx]).toBe('OK');

    // Status bar should mention update count (totalUpserted > 0)
    const statusText = await bar.statusText();
    // When update: the bar shows "1件登録完了" — we just verify OK result, no new record created
    const contacts = await sfQuery(
      `SELECT Id, LastName FROM Contact WHERE CSV_External_Key__c = '${EXT_KEY_VALUE}' LIMIT 2`
    );
    expect(contacts.length, 'must still be exactly 1 Contact — no duplicate created').toBe(1);
    expect(contacts[0].LastName).toBe('E2E_Upsert_V2');
  });

  // ── C: Combined — child upsert + parent resolved by Name ─────────────────

  test('combined: child upsert by external key + parent AccountId resolved by Name', async ({ page }) => {
    const csv = [
      'LastName,AccountId,CSV_External_Key__c',
      `E2E_Combined,${PARENT_ACCT_NAME},${EXT_KEY_VALUE2}`,
    ].join('\n');

    await dropCsvAndWaitForMapping(page, csv, 'contact_combined.csv');
    await setExtKeyAndImport(page, 'CSV_External_Key__c');

    const rows = await waitAndDecodeResultCsv(page);
    const headers   = rows[0];
    const statusIdx = headers.findIndex(h => /import_status|インポート結果/i.test(h));
    expect(statusIdx, 'status column must exist').toBeGreaterThanOrEqual(0);
    expect(rows[1]?.[statusIdx]).toBe('OK');

    // Verify: Contact created with correct AccountId + external key
    const contacts = await sfQuery(
      `SELECT Id, LastName, AccountId, CSV_External_Key__c FROM Contact WHERE CSV_External_Key__c = '${EXT_KEY_VALUE2}' LIMIT 1`
    );
    expect(contacts.length, 'Contact must exist').toBe(1);
    expect(contacts[0].AccountId).toBe(parentAccountId);
    expect(contacts[0].LastName).toBe('E2E_Combined');
    createdContactIds.push(contacts[0].Id as string);
  });
});
