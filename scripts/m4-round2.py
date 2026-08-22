from pathlib import Path

acceptance = Path('tests/integration/milestone4.test.ts')
text = acceptance.read_text()
text = text.replace(
    "        analytics.histogram_30s(ARRAY[-301,-300,120,121,1800,2000])[1] AS underflow,",
    "        (analytics.histogram_30s(ARRAY[-301,-300,120,121,1800,2000]))[1] AS underflow,",
)
text = text.replace(
    "        analytics.histogram_30s(ARRAY[-301,-300,120,121,1800,2000])[72] AS overflow",
    "        (analytics.histogram_30s(ARRAY[-301,-300,120,121,1800,2000]))[72] AS overflow",
)
acceptance.write_text(text)

integration = Path('tests/integration/postgres.test.ts')
text = integration.read_text()
old = """        const weak = await canonicalizeJourneys({ pool, serviceDate, limit: 10 });
        assert.deepEqual(weak.errors, {}, JSON.stringify(weak));
"""
new = """        const weakErrors: unknown[] = [];
        const weak = await canonicalizeJourneys({
          pool, serviceDate, limit: 10, onError: (error) => weakErrors.push(error),
        });
        assert.deepEqual(
          weak.errors,
          {},
          `${JSON.stringify(weak)} ${weakErrors.map((error) => error instanceof Error ? `${error.name}:${error.message}` : String(error)).join('; ')}`,
        );
"""
if old in text:
    text = text.replace(old, new, 1)
integration.write_text(text)
