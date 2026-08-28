# Testing architecture

This document is the authoritative testing policy for Atodotren. It exists to keep the suite useful as the project grows and to prevent incremental feature work from producing duplicated, brittle or implementation-driven tests.

The goal is **high regression value with the smallest reliable test surface**. Test count and line coverage are not goals by themselves.

## Principles

1. **Test observable contracts, not implementation trivia.** A test should fail because behavior, data semantics, safety or an explicit compatibility contract changed unexpectedly.
2. **One invariant, one owner.** Boundaries such as delay bands, freshness rules, lifecycle-state precedence and configuration safety are tested exhaustively once at their owning layer. Higher layers only prove that they consume the contract correctly.
3. **Use the cheapest capable layer.** Pure functions belong in unit tests. SQL semantics and privileges belong in PostgreSQL integration. Browser behavior belongs in Playwright.
4. **A test should have one main reason to fail.** Avoid acceptance tests that simultaneously lock copy, CSS, layout, routing, persistence and data semantics.
5. **Names describe the subsystem, not the history.** `trip-matching.test.ts` is good. `milestone5-corrections.test.ts`, `regression-123.test.ts` and `misc.test.ts` are not.
6. **Fixtures are infrastructure, not product behavior.** Keep only enough fixture-contract coverage to trust the scenarios consumed by other tests.
7. **Performance gates must be deterministic.** Prefer structural bounds (bounded DOM, bounded query result, index use) over wall-clock thresholds on shared CI hardware.

## Test layers and ownership

### Core and worker unit tests — `tests/unit/`

Use for deterministic TypeScript logic and isolated failure modes: parsing, normalization, matching, canonical evidence rules, retry/state machines, logging/redaction, shutdown, configuration and migration inventory logic.

Good examples:

- DST and `>24:00` Madrid service-time conversion;
- exact/fallback trip matching and ambiguity;
- evidence precedence and stale/duplicate handling;
- secret redaction and serialization failure;
- retry/backoff or incident-state transitions;
- strict CLI option parsing when the test does not need a real database.

Do not use unit tests to read repository files and assert that particular strings still exist in `package.json`, Compose or migrations. Those are repository contracts or integration behavior.

Prefer one file per cohesive subsystem. A soft ceiling of roughly 500 lines is a signal to split a suite; the repository guardrail rejects extreme unit-test monoliths above 1,200 lines. Shared helpers should be extracted only when they remove meaningful duplication across closely related suites.

### PostgreSQL integration — `tests/integration/`

Use a real PostgreSQL instance for contracts that PostgreSQL itself owns:

- migrations and rollback/serialization behavior;
- roles, grants and least privilege;
- SQL functions/views and authoritative data semantics;
- canonicalization/aggregation/finalization/retention interactions;
- constraints, triggers and transactional integrity;
- representative query plans where an index/plan shape is part of the production contract.

Keep capabilities independently diagnosable. Do not create one giant chronological acceptance scenario merely because features were delivered together. A setup step may be shared, but unrelated assertions should not depend on prior tests mutating the same database into an undocumented state.

Integration filenames describe capabilities such as `aggregation-retention.test.ts`, `reporting-telegram.test.ts` or `postgres.test.ts`; never milestones.

### Web unit tests — `apps/web/tests/unit/`

Use for web-domain policies, adapters, row parsing, request/filter policy, cache behavior, semantic presentation mapping and fixture contracts.

Important ownership examples:

- `delay-policy.test.ts` owns numeric delay-band boundaries;
- `live-status.test.ts` owns semantic status thresholds;
- `matrix-presentation.test.ts` owns lifecycle-state precedence and verifies representative consumption of delay policy, but does not duplicate every delay boundary;
- `data-policy.test.ts` owns the distinction between feed health and vehicle freshness;
- adapter-contract tests own the frontend-facing semantic contract shared by fixture and PostgreSQL adapters.

Do not promote a pure mapping to Playwright just because it eventually affects UI text or color.

### Browser acceptance — `apps/web/tests/e2e/`

Playwright is reserved for behavior that needs an actual browser or a full rendered application:

- routing and navigation;
- keyboard/focus behavior;
- accessible interaction contracts;
- service worker, cache and offline behavior;
- browser persistence such as theme/refresh preferences;
- virtualized matrix scrolling/interactivity;
- a small representative accessibility smoke set;
- a genuinely engine-specific WebKit acceptance path.

Playwright must **not** lock implementation styling. Forbidden patterns include:

- exact Tailwind utility classes;
- `toHaveCSS(...)` for palette, pixel sizes, borders or typography;
- geometry checks via `boundingBox()` for ordinary layout;
- exact pixel alignment or computed-style assertions;
- repeating pure domain thresholds/symbol mappings already covered by unit tests.

A visual change should not make functional CI red unless it breaks an explicit accessibility or interaction contract. Screenshots may be retained as diagnostic artifacts, but should not become manual snapshot assertions by default.

Chromium desktop and mobile are not two independent engines. Run both only where viewport behavior matters. If a behavior is engine-level rather than viewport-level, one Chromium project is enough. `@webkit` is reserved for browser-engine risk; do not use it as a second copy of an ordinary Chromium scenario.

## What to test when adding a feature

Before writing a new test, answer these questions in order:

1. What concrete regression would this test catch?
2. Which existing test owns the underlying invariant?
3. Can the new behavior be added to that owner instead of creating another suite?
4. What is the cheapest layer that can prove the behavior?
5. Is this assertion about behavior, or merely about how the current implementation happens to render it?
6. Would deleting this assertion materially reduce confidence? If not, do not add it.

Typical decisions:

- New numeric boundary in domain policy → unit test at the policy owner.
- Same boundary shown in a card → no extra E2E threshold test; one acceptance path proving the card renders is enough.
- New SQL freshness rule → real PostgreSQL contract, plus adapter semantic contract if mapping changes.
- New keyboard interaction → browser acceptance.
- New Tailwind spacing or icon size → no functional test; inspect visually.
- New repository naming/immutability rule → repository contract script.

## Merge, delete or keep?

Delete a test/assertion when it only:

- mirrors implementation structure without protecting behavior;
- checks a static string already exercised by real build/integration behavior;
- duplicates an invariant owned at a lower layer;
- locks CSS/pixels that product iteration is expected to change;
- tests a fixture more thoroughly than the production contract it supports.

Merge tests when they represent one user flow or one state-machine contract and share setup without obscuring failure meaning.

Keep tests separate when failures should route to different owners or subsystems, even if setup looks similar.

## Fixtures

Fixture scenarios exist to make browser and adapter acceptance deterministic. Their unit suite should only prove that the named scenarios expose the essential states relied upon elsewhere (for example healthy/stale/outage, history filters materially changing data, or an explicitly unavailable capability).

Do not re-test every train position, matrix symbol and aggregate value inside `fixtures.test.ts` if schematic, presentation or adapter-contract suites already own those semantics.

## Browser matrix policy

The default Playwright projects are:

- desktop Chromium for the main acceptance surface;
- mobile Chromium for viewport-sensitive behavior;
- WebKit for a deliberately small browser-engine acceptance subset.

Tests that only need one Chromium project should skip the other viewport explicitly and state why. A test should carry `@webkit` only when the underlying behavior is plausibly browser-engine sensitive (for example offline bootstrap or virtualization/interaction behavior).

## PostgreSQL version matrix

PostgreSQL 18 is the production target and receives the full worker/database acceptance contract. PostgreSQL 16 is a compatibility target and should prove migration, privilege and representative public/runtime query compatibility without rerunning every expensive production acceptance scenario.

Do not mutate the checked-out migration directory to run a historical migration inventory. Historical worker acceptance must use an isolated worktree or other isolated inventory.

## Repository contracts

`scripts/check-test-architecture.sh` is intentionally simple and runs before expensive CI work. It rejects:

- test filenames based on milestones/corrections/miscellaneous chronology;
- CSS/class/geometry implementation assertions in Playwright;
- unit tests that grep tracked migration/Compose/package source as a substitute for behavior;
- extreme unit-test monoliths.

When a source-shape invariant is genuinely necessary, add it to an explicit repository contract check rather than disguising it as a unit test.

## Agent checklist

Before finishing any change that touches tests:

- [ ] Read this document.
- [ ] Search for an existing owner of the invariant before adding a new test.
- [ ] Remove obsolete assertions created by the change; do not only append more coverage.
- [ ] Keep browser assertions semantic and interaction-oriented.
- [ ] Keep WebKit coverage intentionally small.
- [ ] Avoid milestone/ticket/correction filenames.
- [ ] Run `./scripts/check-test-architecture.sh`.
- [ ] Run the relevant unit tests and type/lint checks.
- [ ] Run PostgreSQL/browser acceptance when the change touches those contracts.
- [ ] Leave no temporary fixtures, traces, generated outputs or migration mutations in the worktree.

## Non-goals

Atodotren does not target a particular global coverage percentage, one test per function, one test per component, or snapshot coverage of the UI. More tests are not automatically safer. The suite should remain small enough that a failing test provides a precise, actionable signal.
