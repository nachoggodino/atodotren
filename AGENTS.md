# Agent instructions

Read [`TESTING.md`](TESTING.md) before adding, deleting, moving, or materially changing tests.

Testing is intentionally organized by **current subsystem and observable contract**, never by milestone, ticket, fix, or implementation chronology. New agents must preserve that architecture.

Hard rules:

- Put a regression at the cheapest layer that can prove it.
- Give each invariant one authoritative owner; do not repeat the same boundary or mapping in unit, integration, and browser tests.
- Playwright protects browser/user behavior. Do not assert Tailwind classes, exact CSS values, pixel geometry, or other styling implementation details there.
- Use WebKit-only acceptance only for behavior that can genuinely differ by browser engine.
- Do not create catch-all files named after milestones, corrections, regressions, tickets, or miscellaneous work.
- Repository/source-shape rules belong in repository contract checks, not in unit tests that grep source files.
- Fixtures are test infrastructure. Test only the minimum contract needed to trust them; do not exhaustively test the fixture implementation itself.
- Prefer focused tests with one reason to fail over large bags of unrelated assertions.
- Keep existing migrations immutable. Test cleanup must not rewrite accepted migrations.

`scripts/check-test-architecture.sh` enforces the most important structural rules in CI. Do not weaken or bypass it to land a test; change the test design instead. If a real exception is necessary, document the reason in `TESTING.md` and make the exception narrow and explicit.
