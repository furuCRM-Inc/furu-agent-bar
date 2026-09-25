# FlashBar AI — Salesforce Command Palette & AI Acceleration Layer

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Salesforce API](https://img.shields.io/badge/Salesforce_API-66.0-blue)](https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/)
[![CI](https://github.com/furuCRM-Inc/furu-agent-bar/actions/workflows/flashbar-pipeline.yml/badge.svg)](https://github.com/furuCRM-Inc/furu-agent-bar/actions/workflows/flashbar-pipeline.yml)

**FlashBar AI** is an open-source sub-second `Cmd+K` command palette and intelligent UI layer for Salesforce Lightning Experience. It replaces slow multi-tab legacy Salesforce navigation with intent-driven natural language search, inline relational filtering, dynamic column management, and AI-assisted mass editing — all without writing a single line of SOQL.

Built on a stateless **JEV (JSON Event Vector) architecture** running on **Cloudflare Workers**, FlashBar AI bypasses Salesforce governor limits and API overhead to deliver responses under 400 ms.

---

## Key Features

- **Sub-second `Cmd+K` palette** — Instant modal available from anywhere in Lightning Experience
- **Label-first UI** — All fields and filters display localized Japanese/English labels (`商談金額`) rather than raw API names (`Amount`)
- **Any-object search** — Query and filter any standard or custom object with dynamic column management; no hardcoded object list
- **Relational lookup engine** — Filter on 1-level parent relationships (`Account.Type`, `Owner.Name`, `MyParent__r.Field__c`) directly from filter chips
- **Incremental list editor** — Real-time field search, inline draft editing (`isDirty`), and bulk save with change count
- **Load more / pagination** — Infinite scroll via `OFFSET`-based pagination
- **Parent → child filter injection** — Automatically scopes child-object queries to the current parent record (e.g., asking "show opportunities" on an Account page returns only that Account's Opportunities, for any object pair)
- **CSV bulk import** — Upload CSV with Name-based or external-key-based parent lookup resolution
- **State resilience** — `sessionStorage` persists active filters, draft edits, and search keywords across pop-out windows and modal close events; draft recovery toast on re-open
- **Worker KV schema seeding** — Org's full schema (including custom objects + lookup relationships) is cached in Cloudflare KV for sub-millisecond field validation
- **Security-first** — All SOQL uses `WITH USER_MODE`; FLS and sharing rules always enforced

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Salesforce User (LWC)                       │
│            Cmd+K Palette / List Editor / CSV Import             │
└──────────────────────┬──────────────────────────────────────────┘
                       │ (1) User intent / keywords
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│               Salesforce Apex (Stateless Gateway)               │
│         WITH USER_MODE FLS · Schema describe · DML              │
└──────────────────────┬──────────────────────────────────────────┘
                       │ (2) Stateless REST — JEV event payload
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│              Cloudflare Worker (FlashBar AI hosted backend)       │
│       Intent parsing · SOQL template generation · KV cache      │
└──────────────────────┬──────────────────────────────────────────┘
                       │ (3) LLM request (optional)
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Claude 3.5 Sonnet / Claude 4                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## JEV Architecture & Principles

FlashBar AI separates **AI judgment** from **Salesforce execution**. Instead of letting LLMs directly mutate database records, FlashBar AI uses a stateless JEV (JSON Event Vector) pattern: **the AI evaluates intent and returns typed structured decisions, while Salesforce Apex deterministically executes the actions**.

```
┌──────────────────┐     Structured JSON State      ┌───────────────────────────┐
│ 1. SF Context    │ ─────────────────────────────> │ 2. Edge Judgment Engine   │
│ - Record/Fields  │                                │  (Cloudflare / JEV Model) │
│ - User Perms     │ <─────────────────────────────  │ - Choice / Score / Noul   │
└──────────────────┘     Typed Judgment Result      └───────────────────────────┘
         │
         ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│ 3. Deterministic Action (Apex)                                                │
│  Apply Business Rules & Validation · Human-in-the-Loop Confidence Thresholds  │
└───────────────────────────────────────────────────────────────────────────────┘
```

**4-Step Execution Pipeline:**

1. **Salesforce Context Preparation** — Apex extracts minimal JSON state (Record Id, Fields, User Permissions, Active Filters).
2. **Edge Judgment** — The Cloudflare Worker evaluates against fast decision models, returning typed responses (`ChoiceResult`, `ScoreResult`, `NoulResult`).
3. **Typed Result Delivery** — Results return via Named Credentials with confidence probability scores.
4. **Deterministic Action** — Apex enforces FLS/CRUD, runs validation rules, updates records, or presents disambiguation to the user.

**Key Principles:**

| Principle | Detail |
|---|---|
| **Deterministic Execution** | Salesforce maintains 100% control over execution, business rules, and validation. AI only provides structured evaluation. |
| **Focused Decision Models** | Replaces open-ended text generation with fast, decision-oriented evaluation (Choice, Score, Yes/No Noul). |
| **Sub-Second & Low Cost** | Minimal token payloads mean zero governor limit breaches, dramatically lower API costs, and sub-400 ms UI responsiveness. |
| **Human-in-the-Loop** | High-confidence outputs execute immediately; medium/low-confidence outputs trigger user confirmation or fallback. |

---

## Enterprise Use Cases

| Category | Use Case | JEV Type | Action | Status |
|---|---|---|---|---|
| Command & Navigation | Intent-driven filter | `Choice` | Natural prompt → SOQL filter chips + dynamic columns | ✅ Shipped |
| Support & Operations | Case triage & routing | `Choice` + `Score` + `Noul` | Scores urgency/churn risk, recommends a queue, reassigns on confirm (`FlashBar_CaseTriageController` + `flashBarCaseTriageCard`, placed on the Case record page) | ✅ Shipped |
| Sales Operations | Lead qualification & assignment | `Score` | ICP-scores selected Leads (HOT/WARM/COLD) and round-robins them across reps, with a minimum-score threshold (`FlashBar_LeadAssigner` + `furuAgentLeadAssigner`, opened from the "🎯 クオリファイ&割当" action on Lead SOQL results) | ✅ Shipped |
| Data Hygiene | Mass record updates | `Choice` + `Confidence` | Inline table edit and a standalone bulk editor overlay, both backed by `FlashBarMassEditService` (partial-success DML, FLS-checked) | ✅ Shipped |
| Risk & Compliance | Escalation detection | `Noul` | `isImmediateEscalationRequired` flag returned alongside Case triage scoring | ✅ Shipped (part of Case triage) |

---

## Installation

### Option 1 — Unlocked Package (Recommended)

Install directly from the latest GitHub Release:

| Org Type | Link |
|---|---|
| Production / Developer Org | See [Releases](https://github.com/furuCRM-Inc/furu-agent-bar/releases/latest) |
| Sandbox | See [Releases](https://github.com/furuCRM-Inc/furu-agent-bar/releases/latest) |

### Option 2 — Deploy Source via SF CLI

```bash
# 1. Clone
git clone https://github.com/furuCRM-Inc/furu-agent-bar.git
cd furu-agent-bar

# 2. Authenticate
sf org login web --alias my-org

# 3. Deploy
sf project deploy start --target-org my-org --ignore-warnings
```

### Option 3 — Self-host the Cloudflare Worker Backend

For teams that want full data sovereignty:

```bash
# Clone the worker repo (separate repository)
git clone https://github.com/furuCRM-Inc/flashbar-worker.git
cd flashbar-worker
npm install
npx wrangler deploy --env production
```

Then update `force-app/main/default/namedCredentials/FuruAgent_Backend.namedCredential-meta.xml`
to point to your own worker URL before deploying.

---

## Post-Installation Configuration

1. **Assign permission sets**
   ```bash
   sf org assign permset --name FlashBar_User --target-org my-org
   # For admins who manage the knowledge dictionary:
   sf org assign permset --name FlashBar_Admin --target-org my-org
   ```

2. **Add to Utility Bar** — In Lightning App Builder, open your app's Utility Bar and add `c-furu-agent-bar`. The palette opens on `Cmd+K`/`Ctrl+K`; on macOS Chrome that shortcut is reserved by the browser's own "Search Tabs" command before the page ever sees the keypress, so `Cmd+/`/`Ctrl+/` is wired up as a working fallback — no extra config needed, both just work.

3. **Named Credential** — The default Named Credential (`FuruAgent_Backend`) points to the hosted FlashBar AI backend. No changes needed for the standard install.

4. **Lead Qualify & Assign** — No setup required. Run any Lead search (e.g. "show all leads"), switch to table view, and the "🎯 クオリファイ&割当" action appears automatically — it's gated purely on the SOQL result's sObject being `Lead`.

5. **Case Triage card** — Requires one manual placement step; it isn't wired into any existing page by default:
   1. Open any Case record → gear icon (⚙) → **Edit Page**
   2. Drag **FlashBar Case Triage Card** (`flashBarCaseTriageCard`) from the component list onto the page
   3. Save → **Activation** → set as the org default for Case
   
   This can't currently be done via a metadata deploy — Lightning Record Pages inherit their available regions from a managed base page (`parentFlexiPage`, e.g. `sfa__Account_rec_L` for the standard Account page) that Case doesn't have a public equivalent for in every org edition, so App Builder's own region validation has to run interactively.

---

## Repository Structure

```
force-app/main/default/
├── classes/                   # Apex: controller, services, runtime
│   ├── FuruAgentController.cls          # Main intent orchestrator + SOQL engine
│   ├── FlashBarAgentforceRuntime.cls    # Jev hybrid pipeline execution
│   ├── FlashBarSummaryService.cls       # Record summary + field candidate
│   ├── FlashBarMassEditService.cls      # Partial-success bulk DML
│   ├── FlashBarSchemaCacheService.cls   # L1→L2→L3 schema cache
│   ├── FlashBarNavigationController.cls # Personal nav items (pins)
│   ├── FlashBarOCRController.cls        # Agentforce Vision / OCR
│   ├── FlashBar_CaseTriageController.cls # Case triage: urgency/churn score → queue routing
│   ├── FlashBar_LeadAssigner.cls        # Lead ICP qualify → round-robin assignment
│   └── ...
├── lwc/
│   ├── furuAgentBar/            # Main command-palette bundle (host to everything below)
│   ├── furuAgentCompanion/      # Companion/side-panel view
│   ├── furuAgentMassEditor/     # Bulk field-edit overlay over SOQL results
│   ├── furuAgentLeadAssigner/   # Lead qualify + round-robin assign overlay (Lead SOQL results only)
│   └── flashBarCaseTriageCard/  # Case record-page triage card
├── objects/                   # Custom objects + fields added to standard objects
│   ├── FuruAgent_Knowledge__c/  # Self-learning validation-rule dictionary
│   ├── FlashBar_Nav_Item__c/    # Personal nav pins
│   ├── Contact/fields/          # CSV_External_Key__c
│   └── Account/fields/          # SLA__c (used by Case triage scoring)
├── permissionSets/            # FlashBar_User, FlashBar_Admin
├── namedCredentials/          # FuruAgent_Backend (points to hosted backend)
└── remoteSiteSettings/        # Allowlist for the backend callout

e2e-config/                    # Playwright test-harness-only metadata (NOT packaged —
                                # excluded from force-app on purpose; see docs/CUSTOMIZATION.md)
tests/e2e/specs/               # Playwright end-to-end tests (22 suites)
docs/
├── test_scenarios.md          # Test coverage reference
└── CUSTOMIZATION.md           # How to set up, extend, and package this repo
config/
└── project-scratch-def.json   # Scratch org definition for CI
.github/workflows/
└── flashbar-pipeline.yml      # CI/CD: lint → apex tests → package build → release
.claude/commands/
└── package-release.md         # /package-release — local packaging + release + docs refresh
```

---

## Development

### Prerequisites

- Salesforce CLI (`sf`) v2+
- Node.js 20+
- A Salesforce Developer Org or Scratch Org

### First-time CI Setup (repo admins only)

Before the CI pipeline can build package versions, create the Unlocked Package once:

```bash
# Authenticate as Dev Hub
sf org login web --alias devhub --set-default-dev-hub

# Create the package (run once, then commit the updated sfdx-project.json)
sf package create \
  --name "FlashBar AI" \
  --package-type Unlocked \
  --path force-app \
  --target-dev-hub devhub \
  --no-namespace
```

Then add the following secrets to your GitHub repository:
- `SFDX_AUTH_URL` — output of `sf org display --target-org devhub --verbose --json | jq -r '.result.sfdxAuthUrl'`
- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with Workers deploy permission

### Running E2E Tests Locally

```bash
cp .env.example .env
# Fill in SF_INSTANCE_URL, SF_APP_URL, SF_ADMIN_ACCESS_TOKEN,
# SF_EN_USERNAME/SF_EN_PASSWORD, SF_JA_USERNAME/SF_JA_PASSWORD
npm run test:e2e:install
npm run test:e2e
```

The admin token builds EN/JA test-user sessions via "Login As" (no separate device verification needed for those two), which is why both a token and two username/password pairs are required — see `tests/e2e/setup/globalSetup.ts`.

---

## Security

All data operations run inside the authenticated Salesforce session with strict security guarantees:

- All SOQL queries use `WITH USER_MODE` — FLS and sharing rules are always enforced
- Zero customer data is sent to the Cloudflare Worker; only structured intent payloads (object type, field names) cross the boundary
- DML uses partial-success mode (`allOrNone: false`) with per-row error reporting
- Schema exports for Worker KV filter accessible fields using `isAccessible()`

To report a security vulnerability, email [contact@furucrm.com](mailto:contact@furucrm.com).

---

## Enterprise Support

FlashBar AI is 100% free and open source under the [Apache 2.0 License](LICENSE).

For enterprise clients needing dedicated support, custom integrations, or managed infrastructure:

- **Custom Engineering** — JEV model tuning, custom object integrations, ERP backends
- **Enterprise Support Retainer** — Dedicated Slack channel, SLA-backed bug fixes
- **Managed Infrastructure** — Hosted Cloudflare Worker cluster with full observability

Contact: [contact@furucrm.com](mailto:contact@furucrm.com)
