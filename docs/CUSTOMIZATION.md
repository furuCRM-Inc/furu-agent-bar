# Customization Guide

Practical "how do I..." notes for setting up and extending FlashBar AI. For install steps, see the main [README](../README.md#installation) — this doc picks up after that.

## Setting up Lead Qualify & Assign

No configuration required. It's gated purely on the currently-displayed SOQL result's sObject:

1. Run any Lead search from the command bar (e.g. "show all leads" / `リードを表示`)
2. Switch to table view (📊)
3. The **"🎯 クオリファイ&割当"** action appears in the table toolbar automatically

Backend: `FlashBar_LeadAssigner.cls` (Apex) → `POST /api/jev/qualify-batch` (Worker) for ICP scoring, `FlashBar_LeadAssigner.assignLeadsRoundRobin` for the DML. The UI is `furuAgentLeadAssigner` LWC, opened as an overlay from `furuAgentBar.js` (see `_showLeadAssigner` / `handleOpenLeadAssigner`).

One thing worth knowing if you extend this: `qualifyLeads` forwards its `requestJson` to the Worker **verbatim, with no server-side reshaping** — the LWC is responsible for sending the exact shape the Worker expects (`{ leads: [{leadId, company, title, annualRevenue, ...}] }`), not just bare IDs. Getting this wrong fails silently as `HTTP_400` with every row showing `—`, which is exactly the bug that shipped here originally — see `_loadScores()` in `furuAgentLeadAssigner.js` for the corrected shape.

## Setting up the Case Triage card

This one needs a one-time manual placement — it isn't wired into any page by default, and it can't currently be done via a metadata deploy (see "Why can't this be deployed?" below).

1. Open any Case record
2. Gear icon (⚙) → **Edit Page**
3. Drag **FlashBar Case Triage Card** (`flashBarCaseTriageCard`) from the component palette onto the page — anywhere in the main or side column
4. **Save** → **Activation** → set it as the org default for Case (or assign to specific apps/profiles as needed)

Backend: `FlashBar_CaseTriageController.cls` → `getCaseContext` (reads `Case.Subject/Description` + `Case.Account.SLA__c`) → `scoreTriage` → `POST /api/jev/triage` (Worker) → `assignCaseToQueue` (DML, `update as user`).

### Why can't this be deployed?

Lightning Record Pages that use a "full" template (tabs, sidebar, related lists — anything beyond a bare header) get those extra regions by **inheriting from a managed base page** via the FlexiPage's `parentFlexiPage` field (e.g. the standard Account page in this org references `sfa__Account_rec_L`). Without that reference, `mode: Replace` on any region beyond a plain header/main fails server-side validation with "no parent region enabling that mode" — and there's no guaranteed, org-portable managed page id for Case to reference the same way. Lightning App Builder resolves this interactively when you build the page by hand; there's no equivalent one-shot metadata deploy that works across orgs. If you find your org *does* have a suitable Case base page, retrieve an existing FlexiPage for reference:

```bash
sf project retrieve start --metadata "FlexiPage:<some-existing-page>" \
  --target-org my-org --target-metadata-dir /tmp/flexi-ref
```

and copy its `parentFlexiPage` value into a new Case page.

## Adding a new Score/Choice/Noul feature end to end

Case Triage and Lead Qualify are the reference implementations for "add a new JEV-backed feature." The shape is the same each time:

**1. Worker route** (separate repo — `flash-agent-stack`, `apps/backend/src/cf-worker.ts`, not this one)
- Add a `POST /api/jev/<your-feature>` route
- System prompt instructs the model to return **only** JSON matching a fixed shape (`status`, plus whatever `score`/`choice`/`noul` fields you need) — no markdown, no code fences
- Wrap the whole thing in try/catch returning `{status: 'ERROR', message}` on failure, never an unhandled 5xx

**2. Apex controller** (`force-app/main/default/classes/`)
- One `@AuraEnabled(cacheable=true)` read method to fetch context (`WITH USER_MODE` on all SOQL) — **wrap it in try/catch and throw `AuraHandledException`, not a bare exception.** Cacheable methods that throw unhandled exceptions get masked by the platform as a generic "Script-thrown exception" with no useful detail — this is exactly the bug fixed in `getCaseContext` on this branch. `AuraHandledException` also needs an explicit `.setMessage()` call; `getMessage()` returns `null` otherwise even when you passed a message to the constructor.
- One `@AuraEnabled` method that calls the Worker via `Http`/`HttpRequest`, parses the JSON response defensively (`JSON.deserializeUntyped`, null-checked `Map` gets), and **never lets `Http().send()` propagate uncaught** — catch `Exception` and return a typed error result instead
- If there's a DML step, use `update as user` / `insert as user` (not classic `Database.update`) and keep partial-failure semantics if it's a bulk operation
- Test coverage: the org gate is **75% per class**, checked at deploy time. `sf package version create` validates this against a clean org built only from `force-app` — if your Apex references a field or object that only exists because someone clicked it into being in Setup, package creation will fail even though ad-hoc org deploys succeed. Add real custom fields as tracked metadata under `objects/<Object>/fields/`.

**3. LWC**
- If it's a bulk action over SOQL results (like Lead Assigner): build it as a sibling overlay component to `furuAgentMassEditor`/`furuAgentLeadAssigner` — a `@track _show<Feature> = false` flag in `furuAgentBar.js`, a `handleOpen<Feature>()` gated on the result's sObject type, and a conditional `<c-your-component>` block near the bottom of `furuAgentBar.html`. Trigger button goes in the SOQL table toolbar (`furu-bar__soql-table-actions`, default-controls block).
- If it's a record-page card (like Case Triage): a standalone LWC with `@api recordId`, calling your Apex from `connectedCallback()`. Needs manual App Builder placement — see above.
- Double-check the exact request shape your Apex method expects before wiring up the callout — Apex methods that forward `requestJson` verbatim to the Worker (rather than deserializing into a typed request class first) won't validate the shape for you.

**4. Permission sets**
- Add `apexClass` access for any new controller to `FlashBar_User.permissionset-meta.xml` (and `FlashBar_Admin` if admin-only)

**5. E2E test**
- New spec under `tests/e2e/specs/`, next available number
- Use `page.evaluate()` shadow-DOM traversal (see `tests/e2e/helpers/shadowDom.ts` and any existing spec) — Playwright locators don't reliably pierce LWC shadow roots
- If the feature depends on the Worker responding with real data, don't just assert a CSS class is present (it may render unconditionally on both success and failure paths) — assert the actual rendered *value* matches an expected pattern, and treat a surfaced backend error as a documented skip rather than a silent pass. See spec 21's tier-badge test for the pattern.

## Local packaging & release (when CI is blocked)

If GitHub Actions can't run `sf package version create` (billing lock, quota, etc.), see the `/package-release` command (`.claude/commands/package-release.md`) for the full local fallback — DevHub auth, package version creation, common validation failures and how to triage them, cutting the GitHub Release with install links, and refreshing README/this doc afterward.

## Self-hosting the Worker backend

See [README → Installation → Option 3](../README.md#option-3--self-host-the-cloudflare-worker-backend). The actual backend repo is `flash-agent-stack` (`apps/backend`) — deploy with `npm run deploy:cf` (free-tier bindings) or `npm run deploy:cf:prod` (adds KV + rate limiting, requires a Workers paid plan), then point `FuruAgent_Backend`'s Named Credential endpoint at your deployment URL.
