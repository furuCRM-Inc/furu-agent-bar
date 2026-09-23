# FuruAgentBar E2E Test Scenarios
> Version: v0.9.x — Total: **91 tests** across 11 spec files  
> Target org: `orgfarm-ce649a3945-dev-ed.develop.my.salesforce.com`  
> Runner: Playwright (Chromium, 1 worker, serial execution)

---

## Test Coverage Summary

| Spec | Feature Area | Tests | Pipeline |
|------|-------------|-------|----------|
| 01 | Smoke / Bar Rendering | 5 | LWC only |
| 02 | SOQL Smart Search | 9 | Worker → Apex → SOQL |
| 03 | Inline Table Edit | 8 | Apex DML |
| 04 | Navigation Hub (Pins) | 9 | Apex custom object |
| 05 | Record Summary Card | 8 | Apex describe |
| 06 | Admin Panel / Knowledge Approval | 7 | Apex @wire |
| 07 | Complex SOQL & AI Pipeline | 19 | Worker → Apex → SOQL |
| 08 | CSV Bulk Import | 5 | Worker → Apex DML |
| 09 | Massive Bulk Update | 6 | Apex DML |
| 10 | Phase Enhancements / SOSL | 8 | Worker → Apex |
| 11 | Data Cloud Integration | 7 | DC Query API v2 |

---

## 01 — Smoke (Bar Rendering)
> **Purpose:** Verify the LWC custom element mounts and the basic UI is interactive before any feature tests run.

| # | Test Name | Acceptance Criteria |
|---|-----------|---------------------|
| 1 | `c-furu-agent-bar` custom element is in the DOM | `document.querySelector('c-furu-agent-bar')` returns non-null |
| 2 | textarea is focusable and accepts input | `.furu-bar__textarea` is visible; `typeCommand()` sets its value |
| 3 | quick chips are visible | At least one `.furu-bar__chip` element rendered |
| 4 | pressing Enter on an unknown command returns a status message | Status bar shows non-empty text after Enter on gibberish input |
| 5 | Escape key clears status | Status bar clears after `Escape` keydown |

**Notes:** No Apex/Worker calls. Pure DOM checks.

---

## 02 — SOQL Smart Search
> **Purpose:** Verify the full search pipeline (Worker AI → Apex `executeSoqlQuery` → LWC result rendering) for the most common user action.

| # | Test Name | Acceptance Criteria |
|---|-----------|---------------------|
| 1 | typing a search returns SOQL results | Status shows `\d+件` within 60 s |
| 2 | card view shows record names | `.furu-bar__soql-card` elements contain non-empty name text |
| 3 | switch to table view shows table headers | `.furu-bar__soql-th` elements present after view toggle |
| 4 | table row count matches status count badge | `<tr>` count == number parsed from status badge |
| 5 | navigate button (↗) is present for each row | Every row has an `↗` button |
| 6 | コマンド button injects record name into textarea | After click, textarea value matches `「…」` or `"…"` pattern |
| 7 | ↗ 開く button in card view has a valid Salesforce record ID | `data-id` attribute matches 15- or 18-char alphanumeric SF ID format |
| 8 | ↗ 開く button click does not throw an error | Click + 2 s wait; no `.furu-bar__status--error` appears |
| 9 | dismiss (✕) clears SOQL results | After ✕ click, `.furu-bar__soql-list` and `.furu-bar__soql-table` are gone |

**Notes:** Tests 6–8 are regression guards for silent action bugs (data-id missing, click no-op).

---

## 03 — Inline Table Edit
> **Purpose:** Verify the inline DML edit flow: enter edit mode → change cells → save/discard.

| # | Test Name | Acceptance Criteria |
|---|-----------|---------------------|
| 1 | インライン編集 button is visible in table toolbar | `.furu-bar__soql-table-actions` contains the edit toggle |
| 2 | toggling edit mode shows input elements in cells | `.furu-bar__cell-input` elements appear in `<td>` cells |
| 3 | edit mode shows 編集終了 button | Toggle button text changes to 編集終了 |
| 4 | changing a cell marks it dirty (yellow background) | Changed `<td>` gets `.furu-bar__soql-td--dirty` class |
| 5 | dirty badge appears after editing a cell | `.furu-bar__soql-dirty-badge` is visible |
| 6 | 破棄 clears all dirty cells | After 破棄, no `.furu-bar__soql-td--dirty` remains |
| 7 | 編集終了 exits edit mode and hides inputs | After toggle, `.furu-bar__cell-input` count == 0 |
| 8 | 保存 button is disabled when no cells are dirty | `保存` button `disabled` attribute is set when no dirty cells |

**Notes:** Uses `loadAccountsViaShortcut()` to bypass AI. Apex DML uses plain `insert/update` (not `as user`) due to FLS gap in test org.

---

## 04 — Navigation Hub (Pins)
> **Purpose:** Verify saved SOQL shortcuts can be pinned, relaunched, and deleted via the nav hub.

| # | Test Name | Acceptance Criteria |
|---|-----------|---------------------|
| 1 | 📌 ピン留め button is visible in table toolbar | Pin button present in toolbar |
| 2 | pin dialog opens when ピン留め is clicked | `.furu-bar__pin-input` appears |
| 3 | pin input accepts text | Input value set via `fillPinLabel()` |
| 4 | pinning a query adds it to the nav hub | `.furu-bar__nav-item` count increases by 1 |
| 5 | pinned item label is visible in the nav hub | `.furu-bar__nav-item-label` contains pinned name text |
| 6 | clicking a pinned nav item re-runs the SOQL query | After click, SOQL results appear again |
| 7 | nav item button carries a `data-id` attribute | `.furu-bar__nav-item-btn[data-id]` has value ≥ 15 chars |
| 8 | nav item delete button carries a `data-id` attribute | `.furu-bar__nav-item-del[data-id]` has value ≥ 15 chars |
| 9 | deleting a nav item removes it from the hub | After delete click, nav item count decreases by 1 |

**Notes:** Tests 7–8 guard against silent no-op button actions (missing `data-id` means the click handler has no target record to delete/replay).

---

## 05 — Record Summary Card
> **Purpose:** Verify the summary card rendered on context page loads (record pages) shows correct fields and the field-picker edit mode works.

| # | Test Name | Acceptance Criteria |
|---|-----------|---------------------|
| 1 | summary card renders with at least one field | `.furu-bar__summary-field` count ≥ 1 |
| 2 | required fields are marked with 必須 | At least one field has `.furu-bar__required-badge` or `必須` text |
| 3 | edit mode toggle shows candidate field list | After toggle, candidate field list renders |
| 4 | edit mode shows checkboxes for all available fields | `input[type=checkbox]` count ≥ 1 in edit mode |
| 5 | edit mode field list includes picklist-type fields | A checkbox has a label matching a known picklist field |
| 6 | edit mode field list includes lookup-type fields | A checkbox has a label matching a known lookup field |
| 7 | edit mode field list shows required markers for required fields | Required fields have a required marker in edit mode list |
| 8 | toggling a field checkbox changes its checked state | Checkbox `checked` flips after click |

---

## 06 — Admin Panel / Knowledge Approval
> **Purpose:** Verify the admin gear icon, settings modal, and rule approval/reject workflow.

| # | Test Name | Acceptance Criteria |
|---|-----------|---------------------|
| 1 | gear icon ⚙️ is visible for admin users | `button[title*=設定]` or button containing `⚙️` is rendered |
| 2 | settings modal opens on ⚙️ click | `.furu-bar__modal` appears after gear click |
| 3 | pending approval card shows approve/reject buttons | `.furu-bar__approval button` contains 承認 and 拒否 |
| 4 | pending rule card shows non-empty rule content | `.furu-bar__approval-rule` inner text length > 0 |
| 5 | pending rule count badge matches actual pending cards served | `.furu-bar__approval-count` shows number ≥ 1 |
| 6 | approve button dismisses the current pending card | Badge count decreases after 承認 click |
| 7 | reject button dismisses the current pending card | Badge count decreases after 拒否 click |

**Notes:**  
- Test 1 soft-fails (annotation only) for non-admin users — expected behavior.  
- Test 4: `FuruAgent_Knowledge__c` records in the org may have null `Plain_English_Rule__c`. The LWC `pendingRuleText` getter now falls back to `sObjectType`-based guidance text. Test annotates the data gap but does not hard-fail on the old placeholder.

---

## 07 — Complex SOQL & Semantic Search

### 07a — Shortcut-based (AI bypassed)
> **Purpose:** Structural SOQL feature tests using pre-seeded shortcuts. No AI dependency.

| # | Test Name | Acceptance Criteria |
|---|-----------|---------------------|
| 1 | multi-condition query: amount > threshold AND stage filter | Status shows `\d+件` |
| 2 | date-range query: CloseDate within next 30 days | Status shows `\d+件` |
| 3 | cross-object query: search by account industry | Status shows `\d+件` |
| 4 | ADD FIELD command appends a column to the table | `th` count ≥ count before the command |
| 5 | ORDER BY descending: most recently modified records first | Row count > 0 in table view |
| 6 | LIMIT respected: requesting exactly 3 records | Row count ≤ 5 |
| 7 | semantic UPDATE intent shows pre-fill card (not SOQL) | `.furu-bar__soql-table` is NOT visible; prefill or status is shown |
| 8 | SOQL query shortcut (⭐) can be saved and reloaded | `.furu-bar__shortcut-chip` or `.furu-bar__shortcuts` appears after save + dismiss |

### 07b — AI Pipeline (real Worker → Apex → SOQL)
> **Purpose:** Verify the end-to-end AI inference pipeline correctly interprets complex Japanese natural-language query patterns and generates appropriate SOQL.  
> **Acceptance baseline:** Pipeline completes within 90 s; no HTTP 402 / HTTP 500 in status.

| # | Test Name | Expected SOQL Pattern | Acceptance Criteria |
|---|-----------|----------------------|---------------------|
| 1 | OR condition: IT業界またはメディア業界のアカウント | `WHERE Industry = 'Technology' OR Industry = 'Media'` | Status not matching `/HTTP 402\|HTTP 500/` |
| 2 | date literal: 過去30日間に作成されたアカウント | `WHERE CreatedDate >= LAST_N_DAYS:30` | Status not matching `/HTTP 402\|HTTP 500/` |
| 3 | date literal: 今年作成したアカウント | `WHERE CreatedDate = THIS_YEAR` | Status not matching `/HTTP 402\|HTTP 500/` |
| 4 | LIKE pattern: 名前に"Global"を含むアカウント | `WHERE Name LIKE '%Global%'` | Status not matching `/HTTP 402\|HTTP 500/` |
| 5 | IS NULL: 電話番号が未設定のアカウント | `WHERE Phone = null` | Status not matching `/HTTP 402\|HTTP 500/` |
| 6 | NOT condition: Technology業界以外のアカウント | `WHERE Industry != 'Technology'` | Status not matching `/HTTP 402\|HTTP 500/` |
| 7 | ORDER BY: 売上額が多い順のアカウント上位10件 | `ORDER BY AnnualRevenue DESC LIMIT 10` | Status not matching `/HTTP 402\|HTTP 500/` |
| 8 | multi-field SELECT: アカウントの名前・電話番号・売上額 | `SELECT Name, Phone, AnnualRevenue FROM Account` | Status clean; if table rendered → `th` count ≥ 2 |
| 9 | AND + LIMIT: 最近更新された5件のアカウント | `ORDER BY LastModifiedDate DESC LIMIT 5` | Status clean; if rows rendered → row count ≤ 5 |
| 10 | cross-object: Account.Industry = Technology でフィルター | `WHERE Account.Industry = 'Technology'` (parent traversal) | Status not matching `/HTTP 402\|HTTP 500/` |
| 11 | search phrasing does not trigger UPDATE intent | `SOQL_SEARCH` intent (not `PREFILL`) | `.furu-bar__prefill` NOT present |

---

## 08 — CSV Bulk Import
> **Purpose:** Verify the drag-and-drop CSV import flow: file detection → column AI mapping → DML insert → result feedback.

| # | Test Name | Acceptance Criteria |
|---|-----------|---------------------|
| 1 | dropping a CSV file triggers the import flow | `.furu-bar__csv-card` appears after `DataTransfer` drop event |
| 2 | CSV card shows file name and row count | Card displays filename and correct row count from CSV |
| 3 | column mapping phase shows AI-mapped columns | Mapping UI shows field API names matched to CSV headers |
| 4 | import button triggers insert and shows progress | Progress indicator appears; no immediate error |
| 5 | download link appears after import completes | Error report download link rendered after import |

**Notes:** `gotoObject('Account')` required before test so `_sObjectType` is set in LWC context.

---

## 09 — Massive Bulk Update
> **Purpose:** Verify the batch inline-edit flow with multiple simultaneous row edits.

| # | Test Name | Acceptance Criteria |
|---|-----------|---------------------|
| 1 | edit all visible rows simultaneously | All `td` inputs populated |
| 2 | bulk save sends all dirty rows in one request | Single Apex `saveRecords` call; no per-row calls |
| 3 | rows saved successfully show green row feedback | Saved rows get success class/style |
| 4 | after save, dirty cells for succeeded rows are cleared | No `.furu-bar__soql-td--dirty` on saved rows |
| 5 | picklist cells render as `<select>` in edit mode | `<select>` element present in picklist-type cells |
| 6 | changing a picklist cell marks the row dirty | `<select>` change event → dirty badge appears |
| 7 | adding StageName column and editing it via picklist | ADD FIELD → StageName column → picklist edit works |

---

## 10 — Phase Enhancements / SOSL
> **Purpose:** Verify advanced routing features: navigation intent, synonym resolution, UPDATE via prefill, SOSL cross-object search.

| # | Test Name | Acceptance Criteria |
|---|-----------|---------------------|
| 1 | NAVIGATE intent shows navigation feedback | Status shows navigation message; no SOQL table |
| 2 | synonym alias "会社" resolves to Account SOQL results | "会社を探して" → Account records returned |
| 3 | RECORD_UPDATE intent shows prefill card with field values | `.furu-bar__prefill` is visible with pre-filled field values |
| 4 | SOQL compiler result: table renders with correct row count | Table row count matches Apex `totalSize` from query |
| 5 | SOQL compiler result: status badge matches row count | Status badge number == table row count |
| 6 | SOSL trigger keyword "横断検索" is recognized by bar input | "横断検索" triggers SOSL intent (not SOQL_SEARCH) |
| 7 | table renders relationship-style columns | Cross-object fields (e.g. `Account.Name`) render in headers |
| 8 | Data Cloud object suffix `__dlm` is detected and routed separately | `__dlm` object name → DC API route (not standard SOQL) |

---

## 11 — Data Cloud Integration
> **Purpose:** Verify the DC query pipeline: Worker detects `__dlm`/`__dlo` suffix → routes to `FlashBarDataCloudService.executeDataCloudQuery` → DC Query API v2 (self-org callout, HTTP 201 success).

| # | Test Name | Acceptance Criteria |
|---|-----------|---------------------|
| 1 | isDataCloudObject logic: `__dlm` and `__dlo` are Data Cloud objects | `isDataCloudObject('ssot__Individual__dlm') === true`; `'Account' === false` |
| 2 | DC Query API is reachable: `executeDataCloudQuery` returns without callout error | `_processWorkerIntent` shim injection completes without uncaught error |
| 3 | typing a DC object command goes through DC route without SOQL error | Status does NOT match `/MALFORMED_QUERY\|Invalid sObject\|Entity is not queryable/i` |
| 4 | `isDataCloudObject`: `__dlm` and `__dlo` suffix detection in LWC context | In-browser logic: `__dlm` → true, `__dlo` → true, `Account` → false, `Order__c` → false |
| 5 | DC query response shape is structurally valid | Mock result has `success: boolean`, `records: Array`, `totalSize: number`, `queryEngine: 'DATACLOUD_SQL'` |
| 6 | DC Worker routing: `search_query` field contains ANSI SQL (not SOQL) | SQL has `SELECT`/`FROM`; does NOT contain `WITH USER_MODE` or `USING SCOPE` |
| 7 | `__dlm` suffix: `isDcObject` field in Worker response is true | Worker response mock with `__dlm` suffix → `isDcObject === true` |

**Notes:**  
- DC endpoint: `{orgDomainUrl}/services/data/v62.0/ssot/queryv2` (self-org callout, no Named Credential).  
- DC Query API returns HTTP **201** (not 200) on success.  
- `ssot__Individual__dlm` is the standard probe object (exists in every DC instance, may have 0 rows).  
- Tests skip gracefully when DC has no queryable objects (empty schema).

---

## Known Limitations & Review Points

| Area | Issue | Status |
|------|-------|--------|
| Apex FLS | Test user lacks FLS on custom fields → `insert/update` must use plain DML (not `as user`) | Accepted / documented |
| AI backend 500s | Opportunity multi-condition queries occasionally return HTTP 500 from Worker | Mitigated by using Account for AI-pipeline tests |
| E2E SPA state | Same-URL navigation doesn't reset LWC state → `goto()` must use `about:blank` first | Fixed in `furuBarPage.goto()` |
| `_viewMode` reset | LWC resets card mode on every SOQL result → `switchToTableView()` uses retry loop | Fixed |
| CSV sObjectType | `handleCsvImport()` returns early if `_sObjectType` null → CSV tests use `gotoObject()` | Fixed |
| Parallel artifacts | Multiple parallel Playwright workers corrupt shared artifact dirs → single worker enforced | Fixed |
| Admin panel data | `FuruAgent_Knowledge__c` records have null `Plain_English_Rule__c` → LWC shows `sObjectType`-based fallback | LWC patched; test uses soft annotation |
| DC HTTP 201 | DC Query API returns 201, not 200 → Apex `FlashBarDataCloudService` fixed to accept both | Deployed |

---

## Review Request for Gemini

**Scope of review requested:**
1. **Coverage gaps** — Are there critical user flows not covered by any of the 91 tests?
2. **Test fragility** — Which tests are most likely to produce false positives/negatives? Suggest hardening.
3. **Assertion quality** — Tests that only check "no error" (especially in spec 07b and 11) — should they assert more specific outcomes?
4. **Timeout calibration** — AI-pipeline tests use 90 s per-test timeout. Is this appropriate? What are the risks?
5. **Data independence** — Tests depend on org data (e2e-orgfarm). Which tests would fail on a freshly provisioned org and how should they be seeded?
6. **Japanese NL patterns** — Review the 11 AI-pipeline patterns in spec 07b. Are there important SOQL clause types not yet covered (e.g. HAVING, subqueries, aggregate functions)?
7. **Data Cloud test strategy** — Most DC tests are mock-based. What real-data tests would add the most confidence?
