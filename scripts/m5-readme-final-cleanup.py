from pathlib import Path

path = Path("README.md")
text = path.read_text()

old_one = """`HEARTBEAT_URL` is optional and is called only after a successful fetch plus
durable PostgreSQL or spool persistence. Telegram (`TELEGRAM_BOT_TOKEN` plus
`TELEGRAM_CHAT_ID`) and SMTP (`SMTP_HOST`, `SMTP_FROM`, `SMTP_TO`, with optional
credentials) are independent. Each incident key is a sequence of independent
episodes. An episode normally sends ACTIVE once after three consecutive bad
observations; a pending episode that recovers earlier closes silently. RECOVERY is
sent once, and only through channels that delivered ACTIVE for that episode. A
new episode starts at occurrence one without inheriting prior notification state.
Partial delivery is tracked per channel in the running worker, so a successful
Telegram delivery is not repeated while only a failed SMTP delivery is retried.
`heartbeat.failure` covers failed delivery attempts and is observed healthy after
the next successful delivery; `heartbeat.stale` separately covers elapsed time
without a success. Ordinary tests use fake transports and never send messages.
"""
new_one = """`HEARTBEAT_URL` is optional and is called only after a successful fetch plus
durable PostgreSQL or spool persistence. SMTP (`SMTP_HOST`, `SMTP_FROM`, `SMTP_TO`,
with optional credentials) remains an optional worker-owned delivery channel. The
ingestion worker never receives Telegram credentials or calls the Telegram Bot API;
it persists incident facts only. `telegram-ops` reads those facts and exclusively
owns Telegram ACTIVE/RECOVERY delivery through its durable delivery ledger. Each
incident key remains a sequence of independent episodes. `heartbeat.failure` covers
failed delivery attempts and is observed healthy after the next successful delivery;
`heartbeat.stale` separately covers elapsed time without a success. Ordinary tests
use fake transports and never send messages.
"""

old_two = """Incident metadata failures and channel failures emit credential-safe structured
`notification.*_failed` events while durable RENFE ingestion continues. Per-channel
delivery state is retained while failed database markers retry on later
observations; zero-row state updates are treated as failures. Retry state remains
process-local: a crash after a channel send but before its database marker can
rarely duplicate that delivery. A durable per-channel outbox is deferred to
Milestone 6.
"""
new_two = """Ingestion incident persistence failures plus worker-owned SMTP/heartbeat failures
emit credential-safe structured events while durable RENFE ingestion continues.
Telegram delivery failures belong to `telegram-ops`; its bounded PostgreSQL state
tracks attempts and successful message IDs without retaining message bodies, rendered
reports, chart bytes, Bot API responses, or credentials.
"""

old_three = """Explicitly test the configured real channels from the built Compose worker only
when sending a labelled test message and heartbeat is intended:

```sh
docker compose --env-file .env run --rm --no-deps worker \\
  test-notifications --confirm-send
```

The command reports Telegram, SMTP, and heartbeat as delivered, failed, or
skipped and exits nonzero if a configured channel fails. It never creates an
operational incident or prints credentials. `ATODOTREN_NOTIFICATION_TEST=1` is an
alternative explicit opt-in; the command refuses to send without one of these
confirmations.
"""
new_three = """Explicitly test the worker-owned real SMTP/heartbeat channels from the built
Compose worker only when a labelled test and heartbeat call are intended:

```sh
docker compose --env-file .env run --rm --no-deps worker \\
  test-notifications --confirm-send
```

The worker command never sends Telegram in Milestone 5. It exits nonzero if a
configured worker-owned channel fails, never creates an operational incident, and
never prints credentials. `ATODOTREN_NOTIFICATION_TEST=1` is an alternative explicit
opt-in. Real Telegram delivery is validated separately during the `telegram-ops` Pi
acceptance phase.
"""

for label, old, new in (
    ("alert ownership", old_one, new_one),
    ("delivery state", old_two, new_two),
    ("notification test", old_three, new_three),
):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected {label} block once, found {count}")
    text = text.replace(old, new)

if "Partial delivery is tracked per channel in the running worker" in text:
    raise SystemExit("legacy worker Telegram retry wording remains")

path.write_text(text)
