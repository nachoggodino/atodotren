from pathlib import Path

migration = Path('migrations/0006_aggregation_retention.sql')
sql = migration.read_text()

replacements = [
    (
        """  candidate_date date;
  candidate_expired boolean;
""",
        """  candidate_family text;
  candidate_date date;
  candidate_source_rows bigint;
  candidate_source_checksum text;
  candidate_partition_names text[];
  candidate_expired boolean;
""",
    ),
    (
        """    family := item.family_name;
    target_date := item.partition_date;
    candidate_blockers := ARRAY[]::text[];
    candidate_expired := CASE family
      WHEN 'filtered_payload' THEN target_date + 1 <= (as_of - interval '48 hours')::date
      WHEN 'stop_evidence' THEN target_date + 1 <= (as_of - interval '7 days')::date
      ELSE target_date + 1 <= (as_of - interval '30 days')::date END;
    IF NOT candidate_expired THEN candidate_blockers := array_append(candidate_blockers, 'not_expired'); END IF;
    SELECT * INTO signature FROM operations.partition_signature(family, target_date);
    source_rows := signature.source_rows; source_checksum := signature.source_checksum; partition_names := signature.partition_names;

    IF family = 'stop_evidence' AND candidate_expired THEN
      child_name := 'stop_evidence_' || to_char(target_date, 'YYYYMMDD');
""",
        """    candidate_family := item.family_name;
    candidate_date := item.partition_date;
    candidate_blockers := ARRAY[]::text[];
    candidate_expired := CASE candidate_family
      WHEN 'filtered_payload' THEN candidate_date + 1 <= (as_of - interval '48 hours')::date
      WHEN 'stop_evidence' THEN candidate_date + 1 <= (as_of - interval '7 days')::date
      ELSE candidate_date + 1 <= (as_of - interval '30 days')::date END;
    IF NOT candidate_expired THEN candidate_blockers := array_append(candidate_blockers, 'not_expired'); END IF;
    SELECT * INTO signature FROM operations.partition_signature(candidate_family, candidate_date);
    candidate_source_rows := signature.source_rows;
    candidate_source_checksum := signature.source_checksum;
    candidate_partition_names := signature.partition_names;

    IF candidate_family = 'stop_evidence' AND candidate_expired THEN
      child_name := 'stop_evidence_' || to_char(candidate_date, 'YYYYMMDD');
""",
    ),
    (
        """    ELSIF family = 'poll_run' AND source_rows > 0 THEN
      IF COALESCE((SELECT sum(poll_count) FROM operations.daily_feed_coverage WHERE service_date = target_date), 0) <> source_rows THEN
        candidate_blockers := array_append(candidate_blockers, 'coverage_summary_missing_or_stale');
      END IF;
    ELSIF family = 'quarantined_entity' AND source_rows > 0 THEN
      IF COALESCE((SELECT sum(entity_count) FROM operations.daily_quarantine_summary WHERE service_date = target_date), 0) <> source_rows THEN
        candidate_blockers := array_append(candidate_blockers, 'quarantine_summary_missing_or_stale');
      END IF;
    END IF;
    candidate_authorized := EXISTS (
      SELECT 1 FROM operations.retention_ledger ledger
      WHERE ledger.family = family AND ledger.target_date = target_date
        AND ledger.aggregate_algorithm_version = algorithm_version
        AND ledger.source_checksum = source_checksum AND ledger.applied_at IS NULL AND ledger.revoked_at IS NULL
    );
    IF NOT candidate_authorized THEN candidate_blockers := array_append(candidate_blockers, 'authorization_missing'); END IF;
    expired := candidate_expired; authorized := candidate_authorized; blockers := candidate_blockers;
    RETURN NEXT;
""",
        """    ELSIF candidate_family = 'poll_run' AND candidate_source_rows > 0 THEN
      IF COALESCE((SELECT sum(poll_count) FROM operations.daily_feed_coverage WHERE service_date = candidate_date), 0) <> candidate_source_rows THEN
        candidate_blockers := array_append(candidate_blockers, 'coverage_summary_missing_or_stale');
      END IF;
    ELSIF candidate_family = 'quarantined_entity' AND candidate_source_rows > 0 THEN
      IF COALESCE((SELECT sum(entity_count) FROM operations.daily_quarantine_summary WHERE service_date = candidate_date), 0) <> candidate_source_rows THEN
        candidate_blockers := array_append(candidate_blockers, 'quarantine_summary_missing_or_stale');
      END IF;
    END IF;
    candidate_authorized := EXISTS (
      SELECT 1 FROM operations.retention_ledger AS ledger
      WHERE ledger.family = candidate_family AND ledger.target_date = candidate_date
        AND ledger.aggregate_algorithm_version = algorithm_version
        AND ledger.source_checksum = candidate_source_checksum
        AND ledger.applied_at IS NULL AND ledger.revoked_at IS NULL
    );
    IF NOT candidate_authorized THEN candidate_blockers := array_append(candidate_blockers, 'authorization_missing'); END IF;
    family := candidate_family;
    target_date := candidate_date;
    partition_names := candidate_partition_names;
    expired := candidate_expired;
    authorized := candidate_authorized;
    blockers := candidate_blockers;
    source_rows := candidate_source_rows;
    source_checksum := candidate_source_checksum;
    RETURN NEXT;
""",
    ),
    (
        """    family := 'canonical_detail'; target_date := item.partition_date; candidate_blockers := ARRAY[]::text[];
    candidate_expired := target_date < ((as_of AT TIME ZONE 'Europe/Madrid')::date - 30);
    IF NOT candidate_expired THEN candidate_blockers := array_append(candidate_blockers, 'not_expired'); END IF;
    BEGIN
      SELECT * INTO signature FROM operations.partition_signature(family, target_date);
      source_rows := signature.source_rows; source_checksum := signature.source_checksum; partition_names := signature.partition_names;
    EXCEPTION WHEN OTHERS THEN
      source_rows := 0; source_checksum := repeat('0', 64);
      partition_names := ARRAY['core.journey_stop_' || to_char(target_date, 'YYYYMMDD'), 'core.journey_' || to_char(target_date, 'YYYYMMDD')];
      candidate_blockers := array_append(candidate_blockers, 'paired_partition_missing');
    END;
    IF EXISTS (SELECT 1 FROM analytics.dirty_scope WHERE service_date = target_date) THEN
      candidate_blockers := array_append(candidate_blockers, 'aggregation_dirty');
    END IF;
    SELECT * INTO finalization FROM operations.service_day_finalization
    WHERE service_date = target_date AND aggregate_algorithm_version = algorithm_version AND status = 'verified';
""",
        """    candidate_family := 'canonical_detail';
    candidate_date := item.partition_date;
    candidate_blockers := ARRAY[]::text[];
    candidate_expired := candidate_date < ((as_of AT TIME ZONE 'Europe/Madrid')::date - 30);
    IF NOT candidate_expired THEN candidate_blockers := array_append(candidate_blockers, 'not_expired'); END IF;
    BEGIN
      SELECT * INTO signature FROM operations.partition_signature(candidate_family, candidate_date);
      candidate_source_rows := signature.source_rows;
      candidate_source_checksum := signature.source_checksum;
      candidate_partition_names := signature.partition_names;
    EXCEPTION WHEN OTHERS THEN
      candidate_source_rows := 0;
      candidate_source_checksum := repeat('0', 64);
      candidate_partition_names := ARRAY['core.journey_stop_' || to_char(candidate_date, 'YYYYMMDD'), 'core.journey_' || to_char(candidate_date, 'YYYYMMDD')];
      candidate_blockers := array_append(candidate_blockers, 'paired_partition_missing');
    END;
    IF EXISTS (SELECT 1 FROM analytics.dirty_scope WHERE service_date = candidate_date) THEN
      candidate_blockers := array_append(candidate_blockers, 'aggregation_dirty');
    END IF;
    SELECT * INTO finalization FROM operations.service_day_finalization
    WHERE service_date = candidate_date AND aggregate_algorithm_version = algorithm_version AND status = 'verified';
""",
    ),
    (
        """      IF finalization.source_checksum <> analytics.canonical_source_checksum(target_date) THEN
        candidate_blockers := array_append(candidate_blockers, 'source_checksum_changed');
      END IF;
      IF finalization.aggregate_checksum <> analytics.daily_checksum(target_date, algorithm_version) THEN
        candidate_blockers := array_append(candidate_blockers, 'aggregate_checksum_changed');
      END IF;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM operations.month_seal
      WHERE calendar_month = date_trunc('month', target_date)::date
        AND aggregate_algorithm_version = algorithm_version AND status = 'sealed'
    ) THEN candidate_blockers := array_append(candidate_blockers, 'month_not_sealed'); END IF;
    candidate_authorized := EXISTS (
      SELECT 1 FROM operations.retention_ledger ledger
      WHERE ledger.family = family AND ledger.target_date = target_date
        AND ledger.aggregate_algorithm_version = algorithm_version
        AND ledger.source_checksum = source_checksum
        AND ledger.aggregate_checksum IS NOT DISTINCT FROM finalization.aggregate_checksum
        AND ledger.applied_at IS NULL AND ledger.revoked_at IS NULL
    );
    IF NOT candidate_authorized THEN candidate_blockers := array_append(candidate_blockers, 'authorization_missing'); END IF;
    expired := candidate_expired; authorized := candidate_authorized; blockers := candidate_blockers;
    RETURN NEXT;
""",
        """      IF finalization.source_checksum <> analytics.canonical_source_checksum(candidate_date) THEN
        candidate_blockers := array_append(candidate_blockers, 'source_checksum_changed');
      END IF;
      IF finalization.aggregate_checksum <> analytics.daily_checksum(candidate_date, algorithm_version) THEN
        candidate_blockers := array_append(candidate_blockers, 'aggregate_checksum_changed');
      END IF;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM operations.month_seal
      WHERE calendar_month = date_trunc('month', candidate_date)::date
        AND aggregate_algorithm_version = algorithm_version AND status = 'sealed'
    ) THEN candidate_blockers := array_append(candidate_blockers, 'month_not_sealed'); END IF;
    candidate_authorized := EXISTS (
      SELECT 1 FROM operations.retention_ledger AS ledger
      WHERE ledger.family = candidate_family AND ledger.target_date = candidate_date
        AND ledger.aggregate_algorithm_version = algorithm_version
        AND ledger.source_checksum = candidate_source_checksum
        AND ledger.aggregate_checksum IS NOT DISTINCT FROM finalization.aggregate_checksum
        AND ledger.applied_at IS NULL AND ledger.revoked_at IS NULL
    );
    IF NOT candidate_authorized THEN candidate_blockers := array_append(candidate_blockers, 'authorization_missing'); END IF;
    family := candidate_family;
    target_date := candidate_date;
    partition_names := candidate_partition_names;
    expired := candidate_expired;
    authorized := candidate_authorized;
    blockers := candidate_blockers;
    source_rows := candidate_source_rows;
    source_checksum := candidate_source_checksum;
    RETURN NEXT;
""",
    ),
]

for old, new in replacements:
    if new in sql:
        continue
    if old not in sql:
        raise SystemExit('retention_candidates refactor anchor missing')
    sql = sql.replace(old, new, 1)

migration.write_text(sql)
