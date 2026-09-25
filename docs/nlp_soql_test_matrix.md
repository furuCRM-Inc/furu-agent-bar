# NLP → SOQL / JEV Semantic Layer — Tuning Test Matrix

Every case below targets a **specific line of code** in `flash-agent-stack/apps/backend/src/engine/jev-intent.ts` or `soqlCompiler.ts`, not just "does search work." Each row states what the *current* implementation will actually do (traced from source, not guessed) and why that might be wrong. Use this as a tuning backlog — check each row against a live run and fix the ones that surprise you.

Legend: 🟢 likely correct today · 🟡 probably wrong / edge case · 🔴 confirmed gap (no code path handles it at all)

---

## ✅ Fixed (flash-agent-stack commit 380679b)

Confirmed bugs and clean, contained gaps were fixed and covered by 34 new unit tests (`jev-intent.test.ts`) plus live e2e regression (furu-agent-bar specs 02/18/19, 21/21 pass):

- **§1.1/1.4** — `isCreatedIntent`: "new" alone now triggers CreatedDate (was CloseDate); JA 追加 added
- **§2.4** — compound Japanese numerals ("1億5000万") now sum correctly instead of dropping the 万 remainder
- **§2.1/2.2** — English magnitude words ("$3 million", "50k") now parse
- **§2.6** — "exactly"/"ちょうど" now maps to an `eq` operator
- **§3.2/3.3** — new `extractLeadStatusFilter` (IsConverted), matching Case's IsClosed pattern
- **§3.5** — Case status negation bug fixed ("クローズしていない" no longer misreads as IsClosed=true)
- **§3.6/3.7** — removed escalated/pending from the Case fast-route regex (was actively wrong — silently mapped both to IsClosed=false — not just unimplemented)
- **§4.1** — English parent-account patterns added ("Acme Corp's opportunities" / "opportunities for Acme Corp")
- **§10.1** — LIKE wildcard escaping (%, _) in extracted account names
- **§12.1/12.2** — English RECORD_UPDATE patterns + English FIELD_SYNONYM_MAP entries
- **§13.1/13.2** — "all"/"every"/"すべて"/"全て" now resolve to a max-page limit; explicit counts above 50 clamp to 100 instead of silently resetting to the default of 20

**Deliberately deferred** (real new capabilities, not bugs — need product scoping before implementation): range/BETWEEN amounts (§2.3), multi-hop relationship paths (§7.1), general-purpose negation beyond Case/Lead status (§8), IN-clause extraction from free text (§9), the ranking-regex robustness gaps (§5.2–5.5), and the confidence-boundary probing in §6 (needs live model scoring, not a code fix).

---

## 1. Date-field selection heuristic (Opportunity CreatedDate vs CloseDate)

`isCreatedIntent = /作成|created|新規|added|new.*creat|creat.*new/.test(lower)` — note **"new" alone does not match**; it needs "new...creat" or "creat...new" as a combo. Anything phrased as "new X" without the word "creat*" falls through to `CloseDate`.

| # | EN | JA | Code path | Current result | Note |
|---|---|---|---|---|---|
| 1.1 | "show new deals this month" | "今月の新規商談を見せて" | `isCreatedIntent` regex | 🟡 EN: **CloseDate** (wrong — "new" alone doesn't match); JA: **CreatedDate** (新規 matches) | English/Japanese give *different* field for the same intent |
| 1.2 | "opportunities created this month" | "今月作成された商談" | same | 🟢 CreatedDate (both) | control case |
| 1.3 | "opportunities closing this month" | "今月クローズ予定の商談" | same | 🟢 CloseDate (both) | control case, matches spec 18 |
| 1.4 | "deals added this month" | "今月追加された商談" | same | EN: 🟢 CreatedDate ("added" matches); JA: 🟡 **CloseDate** — 追加 isn't in the JA branch of the regex at all | JA has no equivalent to "added" |
| 1.5 | "opportunities from this month" | "今月の商談" | same | 🟡 **CloseDate** (default when neither branch matches) | ambiguous by design, but silently picks a field — worth an explicit CLARIFY here instead |
| 1.6 | "freshly created opportunities this month" | "今月新しく作成した商談" | same | 🟢 CreatedDate | "creat" substring present |

## 2. Amount extraction (`extractAmountValue` / `extractAmountOp`)

| # | EN | JA | Code path | Current result | Note |
|---|---|---|---|---|---|
| 2.1 | "opportunities over $500,000" | "500万円以上の商談" | `extractAmountValue` + `extractAmountOp` | 🟡 EN: **not extracted** — `$` and comma-grouped USD amounts aren't in any pattern, falls through to plain-number match (`500,000` ≥1000 → 500000, but the `$` and intent are ignored, operator defaults to `gte` anyway so it accidentally works); JA: 🟢 5,000,000 gte | EN path only works by accident, not because `$` is recognized |
| 2.2 | "opportunities under 3 million yen" | "300万円以下の商談" | same | 🟡 EN: **not extracted** (no "million" unit handling at all — only 万/億/千万) → falls to recency default; JA: 🟢 3,000,000 lte | 🔴 English has **zero** magnitude-word support (no "million", "thousand", "k") |
| 2.3 | "deals worth between 100万 and 500万" | "100万円から500万円の間の商談" | same | 🔴 **Only the first amount is ever extracted** (`extractAmountValue` returns on first match) — the range is silently collapsed to one boundary | no range/BETWEEN support exists in this layer at all |
| 2.4 | "150 million yen deal" | "1億5000万円の商談" | same | 🔴 compound units not handled — regex matches only ONE of 千万/億/万 per call; JA input matches the `okuMatch` branch for "1億" and **drops the "5000万" remainder entirely** → extracts 100,000,000 instead of 150,000,000 | compound Japanese numerals (億+万) are a real, common phrasing this will silently mis-parse |
| 2.5 | "show 1500 leads" | "1500件のリードを見せて" | `extractAmountValue` vs `extractLimit` collision | 🟡 `extractLimit` requires the number be followed by 件/records/rows **and be 1–50** — 1500 fails that range check, so it does NOT set the limit; separately, `extractAmountValue`'s plain-number fallback requires ≥1000 and **has no unit check**, so "1500" could get misread as a currency amount on an Account/Opportunity search if `hasAmount` noul also fires | numeric record-count vs currency collision — worth an explicit regression test |
| 2.6 | "exactly $50,000 deals" | "ちょうど500万円の商談" | `extractAmountOp` | 🟡 no "exact/equal" branch exists — falls to the `gte` default regardless of "exactly"/"ちょうど" | can't currently express `=` on amount at all, only >=/<=/>/< |
| 2.7 | "opportunities ≥ 10000000" (raw digits, no unit word) | "10000000円以上の商談" | `extractAmountValue` plain-number path | 🟢 both: 10,000,000 gte | control — confirms the ≥1000 plain-number fallback works |

## 3. Case / Opportunity boolean-status semantic layer — and its total absence elsewhere

`extractCaseStatusFilter` exists only for Case. `extractStageFilter` (closed/won/lost) exists only for Opportunity. **No equivalent exists for Lead.IsConverted, Task.IsClosed, Event, or any custom boolean/checkbox field.**

| # | EN | JA | Code path | Current result | Note |
|---|---|---|---|---|---|
| 3.1 | "how many closed cases" | "クローズしたケース数は" | `extractCaseStatusFilter` | 🟢 `IsClosed = true` | control, matches spec 19 |
| 3.2 | "converted leads" | "変換済みのリード" | *(none — no Lead status layer exists)* | 🔴 falls through to generic recency default (`CreatedDate >= LAST_N_DAYS:30`), `IsConverted` is never referenced | Lead has the exact same boolean-semantics need as Case and gets nothing |
| 3.3 | "unconverted leads" | "未変換のリード" | *(none)* | 🔴 same gap | — |
| 3.4 | "completed tasks" | "完了したタスク" | *(none)* | 🔴 same gap — Task.IsClosed/Status untouched | Task/Activity has zero semantic layer at all in this file |
| 3.5 | "cases that are NOT closed" | "クローズしていないケース" | `extractCaseStatusFilter` negation | 🟡 the "open" branch (`\bopen\b|未解決|未クローズ|オープンなケース?`) does **not** match "クローズしていない" (a negated phrasing of "closed", not the "open" vocabulary) — likely falls through unmatched | negation-of-closed ≠ the hardcoded "open" synonym list |
| 3.6 | "escalated cases" | "エスカレーションされたケース" | *(none in jev-intent.ts)* | 🔴 no field mapping exists (`extractCaseStatusFilter` only knows closed/open) — this is exactly the phrase the Case status fast-route regex in `cf-worker.ts` also lists (`closed\|open\|escalated\|pending`) but `extractCaseStatusFilter` itself never implements the escalated/pending branches | **inconsistency between the two Case-status code paths** — the cf-worker.ts regex advertises 4 statuses, jev-intent.ts only implements 2 |
| 3.7 | "pending cases" | "保留中のケース" | same inconsistency as 3.6 | 🔴 same gap | — |

## 4. Parent-account context extraction (`extractParentAccountContext`)

Two rigid, Japanese-only regexes: `"X取引先の(全ての)?商談/案件/売上/受注/オポチュニティ"` and `"Xという取引先の商談/案件"`. **No English equivalent exists at all.**

| # | EN | JA | Code path | Current result | Note |
|---|---|---|---|---|---|
| 4.1 | "show me Acme Corp's opportunities" | "Acme Corp取引先の商談" | `extractParentAccountContext` | 🔴 EN: **not extracted** — zero English pattern exists for this; JA: 🟢 `Account.Name LIKE '%Acme Corp%'` | Confirms this whole feature is JA-only despite the product being bilingual |
| 4.2 | "opportunities related to Acme Corp" | "Acme Corpに関連する商談" | same | 🔴 both fail — JA regex requires the literal noun 取引先 immediately before の; "に関連する" isn't a supported connector | common paraphrase, not covered |
| 4.3 | "Acme Corpの全案件一覧" (no trailing の before the noun) | — | same | 🟡 should match `m1` (案件 is in the noun list) — 🟢 expected to work | control |
| 4.4 | "Dickenson plcで受注した商談" (different particle: で instead of の) | — | same | 🔴 regex requires literally "取引先の" — "Xで受注した" doesn't contain 取引先 at all, unmatched | very natural alternate phrasing, unmatched |

## 5. Ranking / Top-N queries (fast-route regex in `cf-worker.ts`, `^`-anchored)

| # | EN | JA | Code path | Current result | Note |
|---|---|---|---|---|---|
| 5.1 | "top 10 highest opportunities" | "金額が高い商談トップ10" | NAVIGATE→SOQL_SEARCH rank interceptor | 🟢 `ORDER BY Amount DESC LIMIT 10` | control, matches the fix in commit f940609 |
| 5.2 | "please show me the top 10 highest opportunities" | "商談を金額が高い順にトップ10で見せて欲しい" | same | 🟡 depends on where in `cf-worker.ts` this pattern is anchored — if `^`-anchored to the start of input, a polite prefix ("please", "〜欲しい" wrapping) breaks the match | politeness padding is extremely common in real usage |
| 5.3 | "bottom 5 opportunities" / "worst performing deals" | "最も金額が低い商談5件" | same | 🟡 the regex only special-cases `lowest\|least\|最低\|最小` for the ORDER direction — "bottom"/"worst"/"最も...低い" (a different surface form of "lowest") likely don't match the direction keywords even if "N highest/top" pattern itself isn't triggered | direction-keyword list is narrow |
| 5.4 | "top 3 accounts by revenue" | "売上上位3社の取引先" | same | 🟡 rank regex hardcodes Amount as the sort field for Opportunity; for Account there's a separate `rankObj == 'Opportunity'` branch — need to verify Account.AnnualRevenue ranking actually resolves rather than defaulting to no ORDER BY | field-to-rank-by inference for non-Opportunity objects |
| 5.5 | "top 100 leads" (limit > the "top N" extraction's practical range) | "リード上位100件" | rank regex `top\s*(\d+)` + downstream `extractLimit` (capped 1–50) | 🟡 rank regex itself has no upper bound and would set `rankLimit=100`, but if this ever routes back through `extractLimit` (1–50 only) the two limit-extraction paths could disagree | two independent limit-parsing implementations in the codebase (jev-intent.ts vs cf-worker.ts rank interceptor) |

## 6. Confidence-tier boundaries (FuruAgentController.cls, not the Worker)

Tiers: `<0.50` → SOSL fallback, `0.50–0.84` → DISAMBIGUATE candidates, `≥0.85` → direct execution. `buildSoqlFilterFromJev` separately requires `intentAnswer.confidence >= 0.60` just to attempt the deterministic template at all, and `sObjectAnswer.confidence >= 0.55` to trust the sObject guess over page context.

| # | EN | JA | Code path | Current result | Note |
|---|---|---|---|---|---|
| 6.1 | Deliberately vague: "stuff from last week" | "先週のやつ" | intent confidence gate | 🟡 likely lands in the 0.50–0.84 DISAMBIGUATE band or below — good candidate to confirm the CLARIFY/candidate UI actually fires rather than silently defaulting to Account | boundary-probing input, outcome depends on live model score |
| 6.2 | Single ambiguous noun only: "leads" | "リード" | sObject confidence gate (0.55) | 🟢 should classify Lead with high confidence — control for the boundary case below | — |
| 6.3 | Object name embedded in a longer unrelated clause: "I was looking at leads yesterday when my laptop crashed, anyway show them" | "昨日リードを見てたらPCが落ちたんだけど、また見せて" | same | 🟡 noise before/after the actual object mention could drag sObject confidence under 0.55, silently falling back to page context or Account instead of Lead | tests robustness to conversational padding, not just clean commands |
| 6.4 | Two objects mentioned, one intended: "compare leads to my open opportunities" | "リードと商談を比較して" | sObject Choice (single-answer) | 🔴 the sObject question is a single Choice — there's no representation for "two objects at once" or a comparison intent; one will silently win | multi-object requests have no modeled outcome at all |

## 7. Cross-object field validation bypass (`soqlCompiler.ts` `buildWhereClause`)

`isCrossObjectField = cond.field.includes('.')` **skips schema validation entirely** for any dotted field path — by design (Salesforce validates at runtime), but that means arbitrarily deep or hallucinated paths pass the compiler silently and only fail (or worse, silently return wrong data) at Salesforce's own query time.

| # | EN | JA | Code path | Current result | Note |
|---|---|---|---|---|---|
| 7.1 | "opportunities where the account owner's manager is Tanaka" | "取引先責任者の上司が田中である商談" | 2-level relationship (`Account.Owner.ManagerId`) | 🔴 nothing in `jev-intent.ts` builds multi-hop parent paths at all — this would need LLM-authored `parentFields`, which then sails through `buildWhereClause` completely unvalidated if the LLM ever does hallucinate one | worth a deliberate adversarial test: ask for a 2+ level relationship and confirm what actually gets sent to Salesforce |
| 7.2 | "opportunities where Account.NOT_A_REAL_FIELD__c = 'x'" (adversarial, direct field-name injection attempt) | 同上を日本語で | same bypass | 🟡 should be caught by Salesforce's own runtime validation (INVALID_FIELD) rather than this compiler — confirm the resulting error surfaces cleanly to the user instead of a raw stack trace | security/robustness boundary test, not just a UX one |

## 8. Negation & exclusion (no general-purpose NOT handling exists)

| # | EN | JA | Code path | Current result | Note |
|---|---|---|---|---|---|
| 8.1 | "opportunities NOT in California" | "カリフォルニア州以外の商談" | *(none)* | 🔴 no negation extraction exists anywhere in `jev-intent.ts` beyond the two hardcoded closed/open booleans | general free-text negation is unimplemented |
| 8.2 | "leads excluding Web source" | "Web以外のリードソースのリード" | same | 🔴 same gap | — |
| 8.3 | "cases without an owner" (null check) | "担当者が未設定のケース" | *(none)* | 🔴 `is_null`/`not_null` operators exist in the compiler's type system but nothing in `jev-intent.ts` ever populates them from free text | IS NULL / IS NOT NULL is structurally supported but never reachable from NL |

## 9. Multi-value IN-clauses (structurally supported, never populated from NL)

| # | EN | JA | Code path | Current result | Note |
|---|---|---|---|---|---|
| 9.1 | "leads from Tokyo, Osaka, or Nagoya" | "東京、大阪、名古屋のリード" | `in` operator (compiler supports it) | 🔴 `jev-intent.ts` has no list/enumeration extractor — the `'in'`/`'not_in'` operators in `SoqlCondition` are dead code from the NL layer's perspective | same class of gap as #8.3 — the compiler is more capable than the NL front-end feeding it |
| 9.2 | "opportunities in stage Prospecting or Negotiation" | "フェーズがProspectingまたはNegotiationの商談" | same | 🔴 same gap — `extractStageFilter` only recognizes the hardcoded won/lost/open trio, not arbitrary picklist value lists | — |

## 10. LIKE-value escaping / adversarial input on the account-name extractor

| # | EN | JA | Code path | Current result | Note |
|---|---|---|---|---| ---|
| 10.1 | Company legitimately named with a SOQL wildcard char: "100%_Growth Inc's opportunities" | "100%_Growth Inc取引先の商談" | `extractParentAccountContext` → `LIKE '%...%'` | 🟡 the extracted name is interpolated into the LIKE pattern with **no escaping of `%`/`_`** (Salesforce SOQL wildcard chars) — a literal `%` or `_` in the company name will be interpreted as a wildcard, over- or under-matching | rare but realistic — worth one regression test with a literal `%` in test data |
| 10.2 | Single-quote in name: "O'Brien Consulting's deals" | "O'Brien Consultingの商談" | same → `formatValue` escaping | 🟢 `formatValue` does escape `'` → `\\'`, so this specific case should be safe | control, confirms the escaping that *does* exist |

## 11. Mixed-language / code-switched input

| # | Input (deliberately bilingual in one sentence) | Code path | Current result | Note |
|---|---|---|---|---|
| 11.1 | "今月created商談を見せて" (JA sentence, English verb) | `isCreatedIntent` / date literal regexes | 🟡 each regex alternation is independent (JA and EN patterns coexist in the same `RegExp`), so this *should* still match both 今月→THIS_MONTH and created→CreatedDate — good candidate to confirm in practice | tests whether the "separate alternations" design documented in the code comment actually holds under real code-switching |
| 11.2 | "show me 取引先 from 先月" | `STANDARD_SYNONYM_MAP` + date literal | 🟡 sObject resolution goes through the LLM Choice question (which sees the raw text, likely fine), but confirm the KV synonym map isn't only consulted for pure-JA strings | — |
| 11.3 | "商談 that closed 今月" | date field + literal | 🟡 combines an English relative clause with two JA keywords — stresses whether `isCreatedIntent`'s English-only "closed" isn't in its regex at all (it only checks for *created*-intent, not close-intent, so this should default to CloseDate correctly) — 🟢 expected correct by accident, confirm live | — |

## 12. RECORD_UPDATE extractor — English is completely unimplemented

`extractSimpleUpdate` only recognizes Japanese particle patterns (の/を/に + 変更/設定/更新/修正/として保存/にして/に直して/にする). **There is no English pattern at all in this function.**

| # | EN | JA | Code path | Current result | Note |
|---|---|---|---|---|---|
| 12.1 | "change the amount to 5 million" | "金額を500万に変更" | `extractSimpleUpdate` | 🔴 EN: **returns null unconditionally** (no English regex branch exists); JA: 🟢 `{Amount: 50000000}` | confirms RECORD_UPDATE via simple pattern is JA-only; English presumably falls through to a full LLM path elsewhere — confirm that fallback actually exists and works |
| 12.2 | "set the stage to Closed Won" | "フェーズをClosed Wonに設定" | same | 🔴 / 🟢 same split | — |
| 12.3 | "A社の金額を1000万に変更" (record name + field + value, JA) | — | `jaMatch` (with record-name capture group) | 🟡 the record-name-vs-field-name disambiguation (`if (!FIELD_SYNONYM_MAP[candidate] && !validFields.has(candidate))`) could misfire if a company is literally named the same as a field synonym (e.g. a company named "フェーズ株式会社") — extreme edge case but worth knowing the failure mode | — |

## 13. Limit/quantity extraction ceiling

`extractLimit` only recognizes 1–50; anything outside that silently falls back to the default of 20, even though `soqlCompiler.ts`'s grammar allows up to 2000.

| # | EN | JA | Code path | Current result | Note |
|---|---|---|---|---|---|
| 13.1 | "show all 200 open cases" | "未解決ケースを200件すべて見せて" | `extractLimit` | 🟡 both silently clamp to the **default 20**, not 200 — "all" is not interpreted as "no limit" or "max limit" anywhere, and 200 is outside the 1–50 window this function accepts | user explicitly asked for 200 and got 20 with no warning surfaced in the UI |
| 13.2 | "show every case" (no explicit number, but "every"/"all") | "すべてのケースを見せて" | same | 🟡 no number present at all → defaults to 20 — "every"/"all" as a synonym for max_limit is unimplemented | — |

---

## Suggested next steps

1. Run each 🔴/🟡 row live (both languages) and record actual behavior — this file predicts from source, live LLM classification can still surprise you upstream of these deterministic branches.
2. The biggest structural theme: **the deterministic keyword-extraction layer (`jev-intent.ts`) is meaningfully more English-light than the rest of the product** — `extractParentAccountContext` and `extractSimpleUpdate` have *zero* English patterns, and amount-unit parsing has *zero* English magnitude words ("million", "k", "$"). If English-speaking users are a real segment, this file is the priority list.
3. Second theme: several **operators the compiler already supports structurally** (`in`, `not_in`, `is_null`, `not_null`) are never populated by anything in the NL extraction layer — the ceiling is higher than what's currently reachable from a chat command.
4. Cross-check `extractCaseStatusFilter`'s 2 implemented statuses (closed/open) against the 4 statuses the Case fast-route regex in `cf-worker.ts` already advertises (closed/open/escalated/pending) — that inconsistency (§3.6–3.7) is a quick, contained fix.
