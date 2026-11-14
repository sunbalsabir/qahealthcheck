# Qualovix QA Auditor — Project Overview

A plain-language guide to what this project is, why it exists, and how its parts fit
together. Read this first if you are new to the codebase. For setup commands, the full
configuration table and the API reference, see the [README](../README.md).

---

## 1. What is it, in one paragraph?

Qualovix is a small QA agency (three people) that wins clients by offering a **Free QA
Health Check** on LinkedIn. They can't manually test every website a prospect sends, so this
app does the first pass for them. A visitor enters a website URL. The app opens the site in
a real browser, crawls up to 10 pages and runs 9 automated QA checks. It then scores the
site and saves the results. Before anything reaches the client, a **Qualovix QA engineer
reviews every finding** (keep, ignore, edit, re-rate). After that review the app produces a
branded PDF report. The app is a lead-generation tool for the agency. It is not a
replacement for a real QA engagement.

> **Positioning:** "Automated QA Health Check reviewed by Qualovix QA Engineers."
> The human review step is the product. Without it, this would be just another scanner.

---

## 2. Who uses it?

| Person | Where | What they do |
|---|---|---|
| **Prospect** (anonymous visitor) | `/` → `/audit/<id>` | Submits a URL (and optionally company, name, email, industry, focus areas). Watches a progress screen, sees results, downloads the PDF. |
| **QA engineer / admin** | `/admin` | Signs in and opens an audit. Reviews each finding, adds notes and approves. Regenerates the report and tracks leads (New → Contacted → Qualified → Converted / Not interested). |

---

## 3. The life of one audit

```
 Prospect submits URL
        │
        ▼
 POST /api/audits ─────────────────────────────────────────────────────────────┐
   1. Validate form (Zod) + honeypot field                                     │
   2. SSRF guard  — refuse private/internal targets BEFORE writing anything    │
   3. Rate limits — per IP, per domain, per email, global                      │
   4. Create Lead (if contact details given) + Audit (status PENDING)          │
   5. Enqueue job, return audit id immediately                                 │
        │                                                                      │
        ▼                                                                      │
 Job queue  (inline = in the web process │ bullmq = Redis + worker app)        │
        │                                                                      │
        ▼                                                                      │
 Audit engine  runAudit()  — packages/audit-engine/src/engine/pipeline.ts      │
   validate → crawl → 9 scanners → normalize → severity → score → AI (opt.)    │
        │  (progress written to DB after each stage)                           │
        ▼                                                                      │
 Audit saved: status READY_FOR_REVIEW  (or FAILED with a friendly message)     │
        │                                                                      │
        ├──► Prospect's browser polls GET /api/audits/:id and shows results ◄──┘
        │
        ▼
 QA engineer reviews in /admin/audits/:id  → POST /api/audits/:id/review
   Keep / Ignore / Edit / Change severity + notes → score recalculated → REVIEWED
        │
        ▼
 PDF report  (only kept/edited findings)  → GET/POST /api/audits/:id/report
```

### Audit status state machine

```
PENDING → SCANNING → ANALYZING → READY_FOR_REVIEW → REVIEWED → REPORT_GENERATED
    └──────────┴──────────┴──→ FAILED
```

The public progress screen shows ten friendly stages ("Discovering pages", "Checking
links", … "Generating QA report"), defined in `AUDIT_STAGES` in
`packages/shared/src/types/audit.ts`.

---

## 4. The audit engine, stage by stage

All of this lives in `packages/audit-engine` and `packages/scanners`.

### Stage 0 — URL guard (SSRF protection)
`security/url-guard.ts`, `security/ip.ts`

Anonymous users supply the URLs the server fetches, so a malicious visitor could try to aim
the scanner at `localhost`, a cloud metadata endpoint or an internal network. The guard
blocks this in layers:

- protocol, port and credentials checks
- hostname checks
- DNS resolution checks
- re-checking the IP address at connect time, which defeats DNS rebinding
- re-validating every redirect hop
- intercepting every browser subrequest

It runs twice: once in the API route and once inside the engine.

### Stage 1 — Crawl once
`crawler/crawler.ts`, `crawler/page-extract.ts`, `crawler/url-utils.ts`

Playwright (headless Chromium) visits up to `MAX_PAGES` same-domain pages, at most
`MAX_DEPTH` links deep. For each page it records a full **snapshot**:

- DOM inventory: links, images, forms, buttons, headings and meta tags
- console errors and network requests
- performance timings: LCP, CLS, TBT and TTFB
- axe-core accessibility results
- layout measurements at mobile, tablet and desktop widths (375 / 768 / 1440 px)

It also probes links, HTTPS/HTTP behaviour, security headers and cookies.

**Why crawl once?** Nine scanners loading the site nine times would hammer the prospect's
server. With a single snapshot, each scanner becomes a plain function over data. That makes
scanners easy to unit test, and a new scanner adds zero network traffic.

The crawler also skips links that could change state, such as logout, delete-account,
unsubscribe and reset-password. It never submits forms.

**Mock mode** (`AUDIT_MOCK_MODE=true`) swaps in `crawler/mock-crawler.ts`. The mock generates
realistic snapshot data without touching the network. Everything after the crawler runs its
real code.

### Stage 2 — Nine scanners
`packages/scanners/src/<name>/index.ts`, registered in `registry.ts`

| Scanner | Category | Looks at |
|---|---|---|
| `broken-links` | Functional | 4xx/5xx, DNS, TLS and timeout failures |
| `console` | Functional | JS errors and uncaught exceptions |
| `forms` | Functional | Labels, input types, submit buttons (structure only, never submits) |
| `accessibility` | Accessibility | axe-core WCAG 2.0/2.1 A/AA rules |
| `performance` | Performance | Core Web Vitals, page weight, render-blocking resources, big images |
| `responsive` | Responsive | Horizontal overflow, overlaps, tiny tap targets and text |
| `technical` | Technical | Titles, meta, duplicate ids, `lang`, canonical, redirects |
| `security` | Security | HTTPS, headers, cookie flags, mixed content (passive only) |
| `ux` | UX | Accessible names, link text, heading structure |

Each scanner implements one interface (`Scanner` in `packages/scanners/src/types.ts`) and
returns **findings** plus **passed checks**. `FindingCollector` (`lib/emit.ts`) drops any
finding that has no evidence, and it redacts secrets from everything the user will see.

If one scanner crashes or times out (60 s), the audit still continues. The failure is
recorded as a warning and the other scanners' results are kept.

### Stage 3 — Normalizer
`engine/normalizer.ts`

Different scanners often report the same problem. For example, missing alt text is flagged
by both the accessibility scanner and the UX scanner. The normalizer merges these duplicates
using explicit groups of equivalent rules. The surviving finding keeps the evidence from
every scanner that reported it.

### Stage 4 — Severity engine
`engine/severity-engine.ts`

A scanner only sees one page at a time, so it can't judge how widespread a problem is. The
severity engine applies deterministic, site-wide rules. Each change is recorded in the
finding's evidence so a reviewer can see why the severity moved. The rules are:

1. The issue appears on every page → escalate (it's a template problem).
2. A medium, high-confidence issue on the homepage → escalate.
3. Low detection confidence → cap at MEDIUM.
4. A script that fails to load on every page → CRITICAL.
5. No HTTPS → always CRITICAL.
6. "Manual testing recommended" observations → always INFO.
7. A single, not-fully-confident issue on one page of a larger site → de-escalate.
8. Mock mode → nothing may be CRITICAL.

### Stage 5 — Score engine
`engine/score-engine.ts`, constants in `packages/shared/src/constants.ts`

- Each category starts at 100.
- Each finding costs points based on severity (Critical 30, High 15, Medium 6, Low 2,
  Info 0). That cost is scaled by confidence (High 1.0, Medium 0.75, Low 0.4), and repeat
  occurrences add to it on a logarithmic curve.
- The category's total penalty is damped (`100 × (1 − e^(−penalty/100))`). This way a bad
  category lands low without hitting zero.
- The overall **QA Health Score** is the weighted mean of the categories: Functional 25%,
  Performance 15%, Accessibility 15%, Responsive 15%, Technical 10%, Security 10%, UX 10%.
- Score bands: 0–49 Needs Significant Attention · 50–69 Needs Improvement · 70–84 Good ·
  85–94 Very Good · 95–100 Excellent.

The score is fully deterministic: no randomness and no AI input. It is labelled as a
heuristic indicator, not a certification.

### Stage 6 — AI analysis (optional)
`ai/analyzer.ts`, `ai/prompt.ts`

When `AI_ENABLED=true` and an Anthropic API key is set, Claude receives the findings. It
writes an executive summary, picks the top issues, adds recommendations and rewrites
findings in plainer language. Its output is **validated in code**:

- Any finding id the model returns that doesn't exist is dropped.
- Severities always come from the engine, never from the model.
- The model can't remove findings.

If the AI call is disabled, slow or failing, the pipeline builds the summary and
recommendations with deterministic fallbacks. The report is always complete either way.

---

## 5. Human review and the report

**Review** (`apps/web/src/components/review-workspace.tsx`,
`apps/web/src/app/api/audits/[id]/review/route.ts`)

For each finding, the engineer chooses **Keep**, **Ignore** (a false positive) or **Edit**
(rewrite the title/description). They can also override the severity and add a QA note.
There is also one note for the whole audit, shown under the executive summary. When the
engineer approves, the score is recalculated from the kept and edited findings only. The
original automated score is still stored, so the dashboard can show what the review
changed.

**Report** (`packages/reporting/src/report-document.tsx`, rendered with `@react-pdf/renderer`)

The PDF is branded "FREE QA HEALTH CHECK". It contains:

- the score and score band
- category scores
- the executive summary and the engineer's notes
- the findings (only approved ones, once the audit has been reviewed)
- passed checks
- recommendations
- a list of Qualovix services
- a disclaimer

Each regeneration creates a new version in the `Report` table.

---

## 6. Repository map

This is an npm-workspaces monorepo written in TypeScript throughout.

```
apps/
  web/                         Next.js 16 (App Router) + React 19 + Tailwind
    src/app/page.tsx             Landing page with the audit form
    src/app/audit/[id]/          Public progress + results page
    src/app/admin/               Dashboard, audit review, leads, login
    src/app/api/                 REST endpoints (audits, findings, review, report, leads, auth)
    src/lib/audit-runner.ts      Bridges queue ⇄ engine ⇄ database (inline driver)
    src/lib/auth.ts              scrypt password hashes + signed JWT session cookie (jose)
    src/lib/rate-limit.ts        Four-way rate limiting with hashed keys
    src/middleware.ts            Protects /admin routes
  worker/
    src/index.ts                 BullMQ consumer: runs audits outside the web process

packages/
  shared/        Types (Finding, Audit), Zod schemas, constants, env parsing, redaction
  audit-engine/  URL guard, crawler, normalizer, severity, score, AI layer, pipeline
  scanners/      The 9 scanners + Scanner interface + registry
  data/          Repository (Prisma or in-memory) + queue (BullMQ or inline) abstractions
  reporting/     PDF report document and generator

prisma/          schema.prisma (PostgreSQL data model) + seed.ts (creates admin user)
tests/
  unit/          URL validation/SSRF, severity & score, normalization & redaction, transport probe
  integration/   Full audit pipeline; review → report flow
  e2e/           Playwright: submit URL → results in a real browser
docs/            qa-auditor-spec.txt (original product brief) + this overview
```

**Dependency direction:** `shared` ← `scanners` ← `audit-engine` ← `web` / `worker`, and
`shared` ← `data` / `reporting` ← `web` / `worker`. Packages never import from the apps.

---

## 7. Data model (PostgreSQL via Prisma)

| Model | Holds |
|---|---|
| `Audit` | URL, status, progress stage, scores, executive summary, top issues, recommendations, warnings, AI usage, link to lead |
| `AuditPage` | One row per crawled page: status code, timing, element counts |
| `Finding` | Rule id, category, severity, confidence, evidence (JSON), recommendation, **review fields** (status, original severity, QA note, edited text) and **AI fields** |
| `AuditCategoryScore` | Score, weight and summary per category |
| `AuditReview` | Reviewer, notes, reviewed score, optional manual override, keep/ignore/edit counts, approval |
| `Report` | Versioned PDF metadata (size, checksum, reviewed?, includes AI?) |
| `Lead` | Company, contact, email, industry, focus areas, follow-up status, internal notes |
| `User` | Admin / QA engineer accounts (scrypt password hash) |
| `RateLimitCounter` | Durable rate-limit windows |

---

## 8. Swappable infrastructure (why it runs with zero setup)

Three environment switches let the same code run as a laptop demo or as a production stack:

| Switch | Demo value | Production value |
|---|---|---|
| `PERSISTENCE_DRIVER` | `memory` — in-process store, lost on restart | `prisma` — PostgreSQL |
| `QUEUE_DRIVER` | `inline` — audit runs in the web process | `bullmq` — Redis queue + `apps/worker` |
| `AUDIT_MOCK_MODE` | `false` — generated crawl data, no network | `false` — real Playwright crawl |

Both repository drivers implement the same interface (`packages/data/src/repository/types.ts`),
and both queue drivers do too. The API routes never know which one is active. `docker-compose.yml`
starts Postgres 16 and Redis 7 for the full stack.

---

## 9. Design principles (enforced in code, not just documented)

- **Evidence or nothing.** A finding without evidence is dropped. The app never reports
  what it couldn't determine; an inconclusive probe becomes a warning instead.
- **Passive and non-destructive.** It never submits forms, never follows destructive links
  and never pentests, fuzzes or brute-forces anything.
- **Deterministic core.** Severity and score depend only on the findings. AI is an optional
  extra layer and never decides anything.
- **Honest labelling.** Results are "automated accessibility findings", not WCAG
  compliance. The security checks are a "baseline", not a pentest. The score is an
  "indicator", not a certification.
- **Degrade, don't fail.** A crashing scanner or an AI outage still produces a report. Only
  an SSRF refusal or a completely failed crawl marks an audit as FAILED.
- **Privacy-aware.** IPs and emails are hashed for rate limiting. Secrets are redacted from
  evidence. Lead details and review records are hidden from unauthenticated callers.
- **No automatic outreach.** The app never emails leads automatically; follow-up is a manual
  decision tracked in the dashboard.

---

## 10. Tech stack at a glance

| Concern | Choice |
|---|---|
| Language | TypeScript (Node ≥ 20.11) |
| Web | Next.js 16, React 19, Tailwind CSS, lucide-react icons |
| Browser automation | Playwright (Chromium) + axe-core |
| Validation | Zod |
| Database | PostgreSQL 16 + Prisma 6 |
| Queue | BullMQ on Redis 7 |
| Auth | scrypt + JWT session cookie (`jose`) |
| AI (optional) | Anthropic Claude via `@anthropic-ai/sdk` |
| PDF | `@react-pdf/renderer` |
| Tests | Vitest (unit, integration), Playwright (e2e) |
| Lint / types | ESLint 9 + typescript-eslint, `tsc --noEmit` |

---

## 11. Common tasks

| I want to… | Go to |
|---|---|
| Run it locally | `npm install && npx playwright install chromium && cp .env.example .env && npm run dev` |
| Add a new QA check | Create `packages/scanners/src/<name>/index.ts` implementing `Scanner`, add it to `SCANNERS` in `registry.ts` |
| Merge two overlapping rules | Add a group to `EQUIVALENT_RULE_GROUPS` in `engine/normalizer.ts` |
| Tune severities | `engine/severity-engine.ts` |
| Change score weights/penalties | `packages/shared/src/constants.ts` (this changes historical scores, so bump `ENGINE_VERSION`) |
| Change the PDF | `packages/reporting/src/report-document.tsx` and `theme.ts` |
| Change the database schema | `prisma/schema.prisma`, then `npm run prisma:migrate` |
| Run all checks | `npm test && npm run typecheck && npm run lint && npm run test:e2e` |

---

## 12. Known limitations and future work

**Limitations** (details in the README):

- The PDF has no page numbers.
- Performance numbers come from in-browser timings, not Lighthouse throttling.
- The in-memory driver loses data on restart.

**Future work.** The architecture leaves room for these, but none are built yet:

- repository and API audits
- test-coverage analysis
- scheduled monitoring
- a client dashboard
- white-label reports
- email delivery
- Slack/Jira integration

---

## Glossary

- **Finding:** one detected issue, with evidence, severity, confidence and a recommendation.
- **Passed check:** a check that ran and found nothing wrong.
- **Evidence:** what was observed vs. what was expected, plus raw (redacted) details.
- **Confidence:** how sure the scanner is (High / Medium / Low). It affects the score weight
  and the severity caps.
- **Snapshot:** everything the crawler recorded about one page; the only input scanners read.
- **SSRF:** Server-Side Request Forgery, i.e. tricking a server into fetching internal
  resources.
- **Mock mode:** the crawler is replaced by generated data; all other stages run for real.
- **Lead:** a prospect's contact details captured with an audit, tracked through follow-up
  statuses.
