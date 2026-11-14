# Qualovix QA Auditor

Automated QA health check for public websites, **reviewed by Qualovix QA engineers** before
anything reaches a client.

A prospect submits a URL. The engine crawls up to ten pages in a real browser, runs nine
independent QA scanners over what it finds, scores the result, and produces a branded PDF
report. Between the scan and the client sits a QA engineer, who keeps, edits, re-rates or
discards every finding.

That review step is the product. Without it this is another website scanner.

---

## Quick start (no database, no Redis)

```bash
git clone <this-repo> qualo-auditor && cd qualo-auditor
npm install
npx playwright install chromium     # the crawler needs a real browser
cp .env.example .env
npm run dev
```

Open <http://localhost:5000> and submit `https://example.com`.

Out of the box `.env` sets `AUDIT_MOCK_MODE=true`, `PERSISTENCE_DRIVER=memory` and
`QUEUE_DRIVER=inline`, so the whole application runs with no infrastructure at all. Mock
mode swaps out **only the crawler** — every scanner, the normalizer, the severity engine,
the scorer, the review workflow and the PDF generator run their real code paths, so you are
exercising the actual system, just not the network.

To audit real websites, set `AUDIT_MOCK_MODE=false` in `.env` and restart.

The QA dashboard is at <http://localhost:5000/admin> (`qa@qualovix.com` / `qualovix-admin`
by default — change `ADMIN_EMAIL` and `ADMIN_PASSWORD` before deploying anywhere).

> With `PERSISTENCE_DRIVER=memory` everything is lost on restart. The admin UI says so on
> every page. Use the full stack below for anything you want to keep.

---

## Full local stack (PostgreSQL + Redis)

The production path: audits are persisted in Postgres and processed by a separate worker,
so a scan survives a web-server restart and browser work never blocks a request.

1. **Clone the project**

   ```bash
   git clone <this-repo> qualo-auditor && cd qualo-auditor
   ```

2. **Install dependencies**

   ```bash
   npm install
   npx playwright install chromium --with-deps
   ```

3. **Configure `.env`**

   ```bash
   cp .env.example .env
   ```

   Then set:

   ```ini
   PERSISTENCE_DRIVER=prisma
   QUEUE_DRIVER=bullmq
   AUDIT_MOCK_MODE=false
   AUTH_SECRET=<openssl rand -base64 48>
   ADMIN_PASSWORD=<something you chose>
   ```

4. **Start PostgreSQL**

   ```bash
   npm run infra:up        # docker compose up -d (starts Postgres and Redis)
   ```

5. **Start Redis** — the same command starts it. To check both are healthy:

   ```bash
   docker compose ps
   ```

6. **Run migrations**

   ```bash
   npm run prisma:migrate  # creates the schema
   npm run db:seed         # creates the admin account from ADMIN_EMAIL/ADMIN_PASSWORD
   ```

7. **Start the application**

   ```bash
   npm run dev             # http://localhost:5000
   ```

8. **Start the worker** (separate terminal — required when `QUEUE_DRIVER=bullmq`)

   ```bash
   npm run worker
   ```

   Or run both together: `npm run dev:all`.

9. **Run the tests**

   ```bash
   npm test                # unit + integration (no infrastructure needed)
   npm run test:e2e        # Playwright end-to-end
   npm run typecheck
   npm run lint
   ```

---

## How it works

```
Browser
   │  POST /api/audits          URL validated for SSRF before anything is written
   ▼
Next.js API ──► Job queue ──► Audit engine
                (BullMQ        │
                 or inline)    ├─ 1. URL guard      protocol, port, DNS, private-range checks
                               ├─ 2. Crawler        Playwright, ≤10 same-domain pages, one pass
                               ├─ 3. Scanners ×9    all reading the same crawl snapshot
                               ├─ 4. Normalizer     merges duplicates across scanners
                               ├─ 5. Severity       deterministic, site-wide adjustments
                               ├─ 6. Scorer         weighted category scores → QA Health Score
                               └─ 7. AI analysis    optional; report is complete without it
                                      │
                                      ▼
                               Repository (Postgres or in-memory)
                                      │
                      ┌───────────────┴────────────────┐
                      ▼                                ▼
            Human QA review                   PDF report generator
            (keep / ignore / edit /           (only approved findings)
             change severity + notes)
```

### The crawl-once design

The crawler visits each page exactly once and records everything the scanners need: DOM
inventory, console output, network activity, performance timings, axe-core results and
layout measurements at three viewports. Scanners are then functions over that snapshot.

Nine scanners each loading the page would mean nine times the traffic against a prospect's
site — neither polite nor faster. It also makes every scanner trivially unit-testable and
means adding a scanner costs no extra requests.

### Adding a scanner

Implement the `Scanner` interface and add it to the registry. Nothing else changes.

```ts
// packages/scanners/src/my-check/index.ts
export const myScanner: Scanner = {
  id: 'my-check',
  name: 'My Check',
  category: 'TECHNICAL',
  description: '…',
  scan(context) {
    const collector = new FindingCollector('my-check', 'TECHNICAL');
    for (const page of context.crawl.pages) {
      if (somethingIsWrong(page)) {
        collector.add({
          ruleId: 'my-check.problem',
          title: '…',
          description: '…',
          severity: 'MEDIUM',
          confidence: 'HIGH',
          url: page.url,
          evidence: { summary: 'What was observed.', observed: '…', expected: '…' },
          recommendation: '…',
        });
      }
    }
    return collector.result();
  },
};
```

Then add it to `SCANNERS` in `packages/scanners/src/registry.ts`.

`FindingCollector` enforces two invariants for you: a finding without evidence is dropped
rather than reported, and everything user-visible is passed through the redaction layer on
the way in.

---

## Project structure

```
apps/
  web/                  Next.js app — public funnel, results, admin, REST API
  worker/               BullMQ consumer that runs audits out of process
packages/
  shared/               Finding model, Zod schemas, scoring constants, redaction
  audit-engine/         SSRF guard, crawler, normalizer, severity, scoring, AI layer
  scanners/             The nine QA scanners, each behind one interface
  reporting/            Qualovix-branded PDF report
  data/                 Repository + queue abstractions (Prisma / memory, BullMQ / inline)
prisma/                 Schema and seed
tests/                  unit · integration · e2e
```

---

## What it checks

| Scanner | Category | What it looks at |
|---|---|---|
| `broken-links` | Functional | 4xx/5xx, DNS, TLS and timeout failures on every link and page resource |
| `console` | Functional | `console.error`, uncaught exceptions, grouped by error signature |
| `forms` | Functional | Labels, input types, submit controls, action targets — **never submits** |
| `accessibility` | Accessibility | axe-core, WCAG 2.0/2.1 A and AA rule sets, plus best practice |
| `performance` | Performance | LCP, CLS, TBT, TTFB, page weight, render-blocking, oversized images |
| `responsive` | Responsive | Overflow, overlaps, tap targets and text size at 375 / 768 / 1440 |
| `technical` | Technical | Titles, meta, duplicate ids, broken images, lang, canonical, redirects |
| `security` | Security | HTTPS, headers, cookie flags, mixed content — **passive only** |
| `ux` | UX | Accessible names, link text, heading structure, empty pages |

### Scoring

Each category starts at 100 and loses points per finding, scaled by confidence and damped
for repeat occurrences. The overall score is the weighted mean:

| Category | Weight |
|---|---|
| Functional Quality | 25% |
| Performance | 15% |
| Accessibility | 15% |
| Responsive Quality | 15% |
| Technical Quality | 10% |
| Security Baseline | 10% |
| UX Heuristics | 10% |

| Score | Band |
|---|---|
| 0–49 | Needs Significant Attention |
| 50–69 | Needs Improvement |
| 70–84 | Good |
| 85–94 | Very Good |
| 95–100 | Excellent |

The score is deterministic: the same findings always produce the same number. It is an
internal heuristic indicator, never a certification, and every surface that shows it says so.

---

## What it deliberately will not do

These are enforced in code and covered by tests, not just documented.

- **Never submits a form.** Forms are inspected structurally and reported as
  *"Form detected — manual functional testing recommended."* No accounts are created, no
  payments made, no messages sent, no files uploaded, no passwords changed.
- **Never performs penetration testing.** The security scanner reads response headers and
  transport behaviour observed during a normal page load. No brute force, no injection, no
  authentication bypass, no fuzzing, no denial of service.
- **Never follows a destructive link.** Logout, delete-account, unsubscribe,
  cancel-subscription and reset-password paths are excluded from the crawl.
- **Never invents a finding.** A finding without evidence is dropped by the collector and
  again by the normalizer. The AI layer's output is validated against the real finding set,
  so a hallucinated id cannot reach a report.
- **Never claims certification.** Accessibility results are "automated accessibility
  findings", not WCAG compliance. Performance results state that they vary with environment.
- **Never reports what it could not determine.** An inconclusive probe produces a warning,
  not a finding.
- **Never emails a lead automatically.** Follow-up is a manual decision, tracked in the
  dashboard.

### SSRF protection

The engine fetches URLs supplied by anonymous users, so containment is layered:

1. **Structural** — protocol allowlist, no credentials in URL, standard web ports only.
2. **Hostname** — blocks `localhost`, internal DNS suffixes, single-label names and numeric
   host encodings (`2130706433`, `0x7f000001`) that decode to loopback.
3. **DNS** — every A/AAAA record classified; one private record fails the whole lookup.
4. **Connect-time** — a custom `lookup` hook re-checks the address actually being dialled,
   which is what defeats DNS rebinding.
5. **Redirects** — followed manually and re-validated at every hop.
6. **Browser** — Playwright request interception applies the same checks to every
   subresource, since the browser resolves DNS itself.

Blocked: loopback, RFC1918, CGNAT, link-local, multicast, reserved ranges, IPv6 unique-local
and link-local, IPv4-mapped IPv6 wrapping a private address, and cloud metadata endpoints
for AWS, GCP, Azure, Alibaba and Oracle.

`tests/unit/url-validation.test.ts` covers all of this adversarially.

---

## The human QA review

`/admin/audits/<id>` is where an engineer decides what the client sees. Per finding:

- **Keep** — confirmed, include it
- **Ignore** — false positive; excluded from the report *and* from the score
- **Edit** — rewrite the title and description in your own words
- **Change severity** — override the engine's rating

Plus a per-finding QA note (*"Confirmed manually — reproduces in Chrome and Firefox"*) and
an audit-level note that appears under the executive summary.

Approving recalculates the score from the kept findings only, so the number on the report
always matches the findings printed beneath it. The automated score is preserved separately
so the dashboard can show what the review changed.

---

## Configuration

Everything is environment-driven; see `.env.example` for the annotated list.

| Variable | Default | Purpose |
|---|---|---|
| `AUDIT_MOCK_MODE` | `true` | Generate realistic audit data without touching the network |
| `PERSISTENCE_DRIVER` | `memory` | `prisma` for PostgreSQL, `memory` for zero-infra dev |
| `QUEUE_DRIVER` | `inline` | `bullmq` for the Redis worker, `inline` to run in-process |
| `MAX_PAGES` | `10` | Pages crawled per free audit |
| `MAX_DEPTH` | `2` | Crawl depth from the submitted URL |
| `MAX_LINK_CHECKS` | `150` | Links probed per audit |
| `PAGE_TIMEOUT_MS` | `30000` | Per-page navigation timeout |
| `AUDIT_JOB_TIMEOUT_MS` | `600000` | Hard ceiling for one audit |
| `RATE_LIMIT_PER_IP_PER_DAY` | `3` | Free audits per IP |
| `RATE_LIMIT_PER_DOMAIN_PER_DAY` | `2` | Audits per target domain |
| `RATE_LIMIT_GLOBAL_PER_HOUR` | `60` | Service-wide ceiling |
| `AI_ENABLED` | `false` | Enable the Claude analysis layer |
| `ANTHROPIC_API_KEY` | — | Required when `AI_ENABLED=true` |
| `SSRF_ALLOWLIST` | — | Hostnames exempt from the public-IP check. **Testing only.** |

Rate limiting applies per IP, per target domain, per email and globally — a request must
pass all four. IPs and emails are hashed before storage, so the counters do not become a
log of who visited.

### The AI layer

Optional, and never load-bearing. It may rewrite descriptions, explain business impact,
suggest remediation, group related findings and write an executive summary. It may not
invent a finding, change a severity, or remove one — enforced by validating its output
against the real finding ids, not by asking it nicely in the prompt.

If the API is slow, rate-limited, misconfigured or down, the pipeline produces the full
deterministic report and records why the AI did not run.

---

## API

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/audits` | public | Start an audit (rate limited) |
| `GET` | `/api/audits/:id` | public | Progress while running, results when done |
| `GET` | `/api/audits/:id/findings` | public | Findings, filterable by severity and category |
| `GET` | `/api/audits/:id/report` | public | Download the PDF |
| `POST` | `/api/audits/:id/report` | admin | Regenerate and version a report |
| `POST` | `/api/audits/:id/review` | admin | Submit review decisions |
| `DELETE` | `/api/audits/:id` | admin | Delete an audit |
| `GET` | `/api/audits` | admin | List and filter audits |
| `GET` | `/api/leads` | admin | List leads |
| `POST` | `/api/leads` | public | Capture a lead (rate limited) |
| `PATCH` | `/api/leads/:id` | admin | Update follow-up status |
| `POST` | `/api/auth/login` | public | Sign in (rate limited) |

Audit ids are unguessable UUIDs and act as the capability to view a result, which is what
lets a visitor return to their report without an account. Lead contact details and the
internal review record are stripped for unauthenticated callers.

---

## Known limitations

- **The PDF has no page numbers.** A `render` callback on the footer makes
  @react-pdf/renderer run a second layout pass which corrupts the `wrap={false}` finding
  cards on reports longer than a few pages. Keeping findings unsplit was worth more than a
  page counter. See the comment on `Footer` in `packages/reporting/src/report-document.tsx`.
- **Performance metrics come from the browser, not Lighthouse.** Navigation Timing and
  PerformanceObserver data collected during the same crawl pass, so there is no simulated
  throttling. Thresholds still follow the published Core Web Vitals boundaries.
- **`prisma` CLI advisories.** `npm audit` reports advisories in `deepmerge-ts`, reached
  only through the Prisma CLI, which is a devDependency. The runtime `@prisma/client` is
  unaffected.
- **In-memory persistence is not durable.** Stated here, in `.env.example`, and on every
  admin page.

## Future work

The architecture leaves room for GitHub/GitLab repository audits, API and Postman
collection analysis, Cypress and Playwright test-coverage analysis, AI-generated test
scenarios, scheduled monitoring, a client dashboard, white-label reports, email delivery,
and Slack or Jira integration. None of it is implemented.
