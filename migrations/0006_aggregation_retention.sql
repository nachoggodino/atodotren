-- Milestone 4: deterministic aggregate facts, finalization, monthly sealing, and retention safety.
-- Migrations 0001-0005 are immutable. This migration is stock PostgreSQL 16/18 only.

SET LOCAL ROLE atodotren_migration_admin;

CREATE TABLE analytics.dirty_scope (
  service_date date NOT NULL,
  family text NOT NULL CHECK (family IN ('daily', 'schedule')),
  dirty_since timestamptz NOT NULL DEFAULT clock_timestamp(),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 120),
  PRIMARY KEY (service_date, family)
);
CREATE INDEX dirty_scope_open_idx ON analytics.dirty_scope (dirty_since, service_date);

CREATE TABLE analytics.aggregation_run (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  service_date date NOT NULL,
  family text NOT NULL CHECK (family IN ('daily', 'schedule')),
  aggregate_algorithm_version text NOT NULL CHECK (aggregate_algorithm_version ~ '^[a-z0-9_.-]{1,40}$'),
  generation bigint NOT NULL CHECK (generation > 0),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL CHECK (status IN ('succeeded', 'blocked', 'failed')),
  source_row_count bigint NOT NULL DEFAULT 0 CHECK (source_row_count >= 0),
  aggregate_row_count bigint NOT NULL DEFAULT 0 CHECK (aggregate_row_count >= 0),
  source_checksum text CHECK (source_checksum IS NULL OR source_checksum ~ '^[0-9a-f]{64}$'),
  aggregate_checksum text CHECK (aggregate_checksum IS NULL OR aggregate_checksum ~ '^[0-9a-f]{64}$'),
  blocker text,
  CHECK (completed_at >= started_at)
);
CREATE INDEX aggregation_run_scope_idx
  ON analytics.aggregation_run (service_date, family, aggregate_algorithm_version, completed_at DESC);

-- The provisional h30-v1 histogram has 72 integer bins:
--   [0] < -300 seconds; [1..70] 30-second bins covering [-300, 1800); [71] >= 1800 seconds.
-- Exact counters/min/max/sums remain authoritative; histogram bounds can be versioned in a later methodology.
CREATE OR REPLACE FUNCTION analytics.histogram_30s(input_values integer[])
RETURNS integer[]
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $function$
DECLARE
  result integer[] := array_fill(0, ARRAY[72]);
  value integer;
  bucket integer;
BEGIN
  IF input_values IS NULL THEN
    RETURN result;
  END IF;
  FOREACH value IN ARRAY input_values LOOP
    CONTINUE WHEN value IS NULL;
    IF value < -300 THEN
      bucket := 1;
    ELSIF value >= 1800 THEN
      bucket := 72;
    ELSE
      bucket := floor((value + 300) / 30.0)::integer + 2;
    END IF;
    result[bucket] := result[bucket] + 1;
  END LOOP;
  RETURN result;
END
$function$;

CREATE OR REPLACE FUNCTION analytics.histogram_add(left_values integer[], right_values integer[])
RETURNS integer[]
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $function$
DECLARE
  result integer[] := array_fill(0, ARRAY[72]);
  index_value integer;
BEGIN
  FOR index_value IN 1..72 LOOP
    result[index_value] := COALESCE(left_values[index_value], 0) + COALESCE(right_values[index_value], 0);
  END LOOP;
  RETURN result;
END
$function$;

CREATE AGGREGATE analytics.histogram_sum(integer[]) (
  SFUNC = analytics.histogram_add,
  STYPE = integer[]
);

-- Daily aggregate tables deliberately remain unpartitioned: they are compact and retained indefinitely.
CREATE TABLE analytics.daily_stop_call_hour (
  network_id bigint NOT NULL REFERENCES core.network(id),
  service_date date NOT NULL,
  station_id bigint NOT NULL REFERENCES core.station(id),
  line_id bigint NOT NULL REFERENCES core.line(id),
  branch_id bigint NOT NULL REFERENCES core.branch(id),
  direction smallint NOT NULL CHECK (direction IN (0, 1)),
  scheduled_hour smallint NOT NULL CHECK (scheduled_hour BETWEEN 0 AND 23),
  scheduled_opportunities bigint NOT NULL CHECK (scheduled_opportunities >= 0),
  valid_delay_observations bigint NOT NULL CHECK (valid_delay_observations >= 0),
  punctual_count bigint NOT NULL CHECK (punctual_count >= 0),
  early_count bigint NOT NULL CHECK (early_count >= 0),
  zero_to_two_count bigint NOT NULL CHECK (zero_to_two_count >= 0),
  over_two_to_five_count bigint NOT NULL CHECK (over_two_to_five_count >= 0),
  over_five_to_ten_count bigint NOT NULL CHECK (over_five_to_ten_count >= 0),
  over_ten_to_fifteen_count bigint NOT NULL CHECK (over_ten_to_fifteen_count >= 0),
  over_fifteen_count bigint NOT NULL CHECK (over_fifteen_count >= 0),
  canceled_count bigint NOT NULL CHECK (canceled_count >= 0),
  skipped_count bigint NOT NULL CHECK (skipped_count >= 0),
  missing_evidence_count bigint NOT NULL CHECK (missing_evidence_count >= 0),
  pending_count bigint NOT NULL CHECK (pending_count >= 0),
  reported_only_count bigint NOT NULL CHECK (reported_only_count >= 0),
  observed_presence_count bigint NOT NULL CHECK (observed_presence_count >= 0),
  discrepancy_count bigint NOT NULL CHECK (discrepancy_count >= 0),
  signed_delay_sum bigint NOT NULL DEFAULT 0,
  squared_delay_sum numeric NOT NULL DEFAULT 0 CHECK (squared_delay_sum >= 0),
  minimum_delay_seconds integer,
  maximum_delay_seconds integer,
  histogram_version text NOT NULL DEFAULT 'h30-v1' CHECK (histogram_version = 'h30-v1'),
  delay_histogram integer[] NOT NULL CHECK (array_length(delay_histogram, 1) = 72),
  source_coverage numeric(9,8) NOT NULL CHECK (source_coverage BETWEEN 0 AND 1),
  aggregate_algorithm_version text NOT NULL CHECK (aggregate_algorithm_version ~ '^[a-z0-9_.-]{1,40}$'),
  PRIMARY KEY (network_id, station_id, line_id, branch_id, direction, scheduled_hour, service_date)
);
CREATE INDEX daily_stop_call_station_range_idx
  ON analytics.daily_stop_call_hour (station_id, line_id, direction, scheduled_hour, service_date);
CREATE INDEX daily_stop_call_line_range_idx
  ON analytics.daily_stop_call_hour (line_id, direction, scheduled_hour, service_date);

CREATE TABLE analytics.daily_journey_hour (
  network_id bigint NOT NULL REFERENCES core.network(id),
  service_date date NOT NULL,
  line_id bigint NOT NULL REFERENCES core.line(id),
  branch_id bigint NOT NULL REFERENCES core.branch(id),
  direction smallint NOT NULL CHECK (direction IN (0, 1)),
  scheduled_start_hour smallint NOT NULL CHECK (scheduled_start_hour BETWEEN 0 AND 23),
  scheduled_opportunities bigint NOT NULL CHECK (scheduled_opportunities >= 0),
  valid_delay_observations bigint NOT NULL CHECK (valid_delay_observations >= 0),
  punctual_count bigint NOT NULL CHECK (punctual_count >= 0),
  early_count bigint NOT NULL CHECK (early_count >= 0),
  zero_to_two_count bigint NOT NULL CHECK (zero_to_two_count >= 0),
  over_two_to_five_count bigint NOT NULL CHECK (over_two_to_five_count >= 0),
  over_five_to_ten_count bigint NOT NULL CHECK (over_five_to_ten_count >= 0),
  over_ten_to_fifteen_count bigint NOT NULL CHECK (over_ten_to_fifteen_count >= 0),
  over_fifteen_count bigint NOT NULL CHECK (over_fifteen_count >= 0),
  canceled_count bigint NOT NULL CHECK (canceled_count >= 0),
  skipped_count bigint NOT NULL CHECK (skipped_count >= 0),
  missing_evidence_count bigint NOT NULL CHECK (missing_evidence_count >= 0),
  pending_count bigint NOT NULL CHECK (pending_count >= 0),
  reported_only_count bigint NOT NULL CHECK (reported_only_count >= 0),
  observed_presence_count bigint NOT NULL CHECK (observed_presence_count >= 0),
  discrepancy_count bigint NOT NULL CHECK (discrepancy_count >= 0),
  signed_delay_sum bigint NOT NULL DEFAULT 0,
  squared_delay_sum numeric NOT NULL DEFAULT 0 CHECK (squared_delay_sum >= 0),
  minimum_delay_seconds integer,
  maximum_delay_seconds integer,
  histogram_version text NOT NULL DEFAULT 'h30-v1' CHECK (histogram_version = 'h30-v1'),
  delay_histogram integer[] NOT NULL CHECK (array_length(delay_histogram, 1) = 72),
  source_coverage numeric(9,8) NOT NULL CHECK (source_coverage BETWEEN 0 AND 1),
  aggregate_algorithm_version text NOT NULL CHECK (aggregate_algorithm_version ~ '^[a-z0-9_.-]{1,40}$'),
  PRIMARY KEY (network_id, line_id, branch_id, direction, scheduled_start_hour, service_date)
);
CREATE INDEX daily_journey_line_range_idx
  ON analytics.daily_journey_hour (line_id, direction, scheduled_start_hour, service_date);

CREATE TABLE analytics.daily_segment_hour (
  network_id bigint NOT NULL REFERENCES core.network(id),
  service_date date NOT NULL,
  segment_id bigint NOT NULL REFERENCES core.segment(id),
  line_id bigint NOT NULL REFERENCES core.line(id),
  branch_id bigint NOT NULL REFERENCES core.branch(id),
  direction smallint NOT NULL CHECK (direction IN (0, 1)),
  upstream_scheduled_hour smallint NOT NULL CHECK (upstream_scheduled_hour BETWEEN 0 AND 23),
  scheduled_opportunities bigint NOT NULL CHECK (scheduled_opportunities >= 0),
  valid_delay_observations bigint NOT NULL CHECK (valid_delay_observations >= 0),
  punctual_count bigint NOT NULL CHECK (punctual_count >= 0),
  early_count bigint NOT NULL CHECK (early_count >= 0),
  zero_to_two_count bigint NOT NULL CHECK (zero_to_two_count >= 0),
  over_two_to_five_count bigint NOT NULL CHECK (over_two_to_five_count >= 0),
  over_five_to_ten_count bigint NOT NULL CHECK (over_five_to_ten_count >= 0),
  over_ten_to_fifteen_count bigint NOT NULL CHECK (over_ten_to_fifteen_count >= 0),
  over_fifteen_count bigint NOT NULL CHECK (over_fifteen_count >= 0),
  canceled_count bigint NOT NULL CHECK (canceled_count >= 0),
  skipped_count bigint NOT NULL CHECK (skipped_count >= 0),
  missing_evidence_count bigint NOT NULL CHECK (missing_evidence_count >= 0),
  pending_count bigint NOT NULL CHECK (pending_count >= 0),
  reported_only_count bigint NOT NULL CHECK (reported_only_count >= 0),
  observed_presence_count bigint NOT NULL CHECK (observed_presence_count >= 0),
  discrepancy_count bigint NOT NULL CHECK (discrepancy_count >= 0),
  signed_delay_sum bigint NOT NULL DEFAULT 0,
  squared_delay_sum numeric NOT NULL DEFAULT 0 CHECK (squared_delay_sum >= 0),
  minimum_delay_seconds integer,
  maximum_delay_seconds integer,
  histogram_version text NOT NULL DEFAULT 'h30-v1' CHECK (histogram_version = 'h30-v1'),
  delay_histogram integer[] NOT NULL CHECK (array_length(delay_histogram, 1) = 72),
  source_coverage numeric(9,8) NOT NULL CHECK (source_coverage BETWEEN 0 AND 1),
  aggregate_algorithm_version text NOT NULL CHECK (aggregate_algorithm_version ~ '^[a-z0-9_.-]{1,40}$'),
  PRIMARY KEY (network_id, segment_id, line_id, branch_id, direction, upstream_scheduled_hour, service_date)
);
CREATE INDEX daily_segment_range_idx
  ON analytics.daily_segment_hour (segment_id, line_id, direction, upstream_scheduled_hour, service_date);

CREATE TABLE analytics.daily_line_summary (
  network_id bigint NOT NULL REFERENCES core.network(id),
  service_date date NOT NULL,
  line_id bigint NOT NULL REFERENCES core.line(id),
  scheduled_opportunities bigint NOT NULL CHECK (scheduled_opportunities >= 0),
  valid_delay_observations bigint NOT NULL CHECK (valid_delay_observations >= 0),
  punctual_count bigint NOT NULL CHECK (punctual_count >= 0),
  early_count bigint NOT NULL CHECK (early_count >= 0),
  zero_to_two_count bigint NOT NULL CHECK (zero_to_two_count >= 0),
  over_two_to_five_count bigint NOT NULL CHECK (over_two_to_five_count >= 0),
  over_five_to_ten_count bigint NOT NULL CHECK (over_five_to_ten_count >= 0),
  over_ten_to_fifteen_count bigint NOT NULL CHECK (over_ten_to_fifteen_count >= 0),
  over_fifteen_count bigint NOT NULL CHECK (over_fifteen_count >= 0),
  canceled_count bigint NOT NULL CHECK (canceled_count >= 0),
  skipped_count bigint NOT NULL CHECK (skipped_count >= 0),
  missing_evidence_count bigint NOT NULL CHECK (missing_evidence_count >= 0),
  pending_count bigint NOT NULL CHECK (pending_count >= 0),
  reported_only_count bigint NOT NULL CHECK (reported_only_count >= 0),
  observed_presence_count bigint NOT NULL CHECK (observed_presence_count >= 0),
  discrepancy_count bigint NOT NULL CHECK (discrepancy_count >= 0),
  signed_delay_sum bigint NOT NULL DEFAULT 0,
  squared_delay_sum numeric NOT NULL DEFAULT 0 CHECK (squared_delay_sum >= 0),
  minimum_delay_seconds integer,
  maximum_delay_seconds integer,
  histogram_version text NOT NULL DEFAULT 'h30-v1' CHECK (histogram_version = 'h30-v1'),
  delay_histogram integer[] NOT NULL CHECK (array_length(delay_histogram, 1) = 72),
  source_coverage numeric(9,8) NOT NULL CHECK (source_coverage BETWEEN 0 AND 1),
  aggregate_algorithm_version text NOT NULL CHECK (aggregate_algorithm_version ~ '^[a-z0-9_.-]{1,40}$'),
  PRIMARY KEY (network_id, line_id, service_date)
);
CREATE INDEX daily_line_summary_range_idx ON analytics.daily_line_summary (line_id, service_date);

CREATE TABLE analytics.daily_network_summary (
  network_id bigint NOT NULL REFERENCES core.network(id),
  service_date date NOT NULL,
  scheduled_opportunities bigint NOT NULL CHECK (scheduled_opportunities >= 0),
  valid_delay_observations bigint NOT NULL CHECK (valid_delay_observations >= 0),
  punctual_count bigint NOT NULL CHECK (punctual_count >= 0),
  early_count bigint NOT NULL CHECK (early_count >= 0),
  zero_to_two_count bigint NOT NULL CHECK (zero_to_two_count >= 0),
  over_two_to_five_count bigint NOT NULL CHECK (over_two_to_five_count >= 0),
  over_five_to_ten_count bigint NOT NULL CHECK (over_five_to_ten_count >= 0),
  over_ten_to_fifteen_count bigint NOT NULL CHECK (over_ten_to_fifteen_count >= 0),
  over_fifteen_count bigint NOT NULL CHECK (over_fifteen_count >= 0),
  canceled_count bigint NOT NULL CHECK (canceled_count >= 0),
  skipped_count bigint NOT NULL CHECK (skipped_count >= 0),
  missing_evidence_count bigint NOT NULL CHECK (missing_evidence_count >= 0),
  pending_count bigint NOT NULL CHECK (pending_count >= 0),
  reported_only_count bigint NOT NULL CHECK (reported_only_count >= 0),
  observed_presence_count bigint NOT NULL CHECK (observed_presence_count >= 0),
  discrepancy_count bigint NOT NULL CHECK (discrepancy_count >= 0),
  signed_delay_sum bigint NOT NULL DEFAULT 0,
  squared_delay_sum numeric NOT NULL DEFAULT 0 CHECK (squared_delay_sum >= 0),
  minimum_delay_seconds integer,
  maximum_delay_seconds integer,
  histogram_version text NOT NULL DEFAULT 'h30-v1' CHECK (histogram_version = 'h30-v1'),
  delay_histogram integer[] NOT NULL CHECK (array_length(delay_histogram, 1) = 72),
  source_coverage numeric(9,8) NOT NULL CHECK (source_coverage BETWEEN 0 AND 1),
  aggregate_algorithm_version text NOT NULL CHECK (aggregate_algorithm_version ~ '^[a-z0-9_.-]{1,40}$'),
  PRIMARY KEY (network_id, service_date)
);

-- Anonymous, replaceable per-finalized-day contributions for an open calendar month.
CREATE TABLE analytics.daily_schedule_contribution (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  service_date date NOT NULL,
  family text NOT NULL CHECK (family IN ('stop', 'segment', 'journey')),
  weekday_class text NOT NULL CHECK (weekday_class IN ('monday','tuesday','wednesday','thursday','friday','saturday','sunday')),
  network_id bigint NOT NULL REFERENCES core.network(id),
  feed_version_id bigint NOT NULL REFERENCES gtfs_static.feed_version(id),
  service_pattern_id bigint NOT NULL REFERENCES core.service_pattern(id),
  line_id bigint NOT NULL REFERENCES core.line(id),
  branch_id bigint NOT NULL REFERENCES core.branch(id),
  direction smallint NOT NULL CHECK (direction IN (0, 1)),
  station_id bigint REFERENCES core.station(id),
  segment_id bigint REFERENCES core.segment(id),
  scheduled_seconds integer NOT NULL CHECK (scheduled_seconds BETWEEN 0 AND 359999),
  scheduled_opportunities bigint NOT NULL CHECK (scheduled_opportunities >= 0),
  valid_delay_observations bigint NOT NULL CHECK (valid_delay_observations >= 0),
  punctual_count bigint NOT NULL CHECK (punctual_count >= 0),
  early_count bigint NOT NULL CHECK (early_count >= 0),
  zero_to_two_count bigint NOT NULL CHECK (zero_to_two_count >= 0),
  over_two_to_five_count bigint NOT NULL CHECK (over_two_to_five_count >= 0),
  over_five_to_ten_count bigint NOT NULL CHECK (over_five_to_ten_count >= 0),
  over_ten_to_fifteen_count bigint NOT NULL CHECK (over_ten_to_fifteen_count >= 0),
  over_fifteen_count bigint NOT NULL CHECK (over_fifteen_count >= 0),
  canceled_count bigint NOT NULL CHECK (canceled_count >= 0),
  skipped_count bigint NOT NULL CHECK (skipped_count >= 0),
  missing_evidence_count bigint NOT NULL CHECK (missing_evidence_count >= 0),
  pending_count bigint NOT NULL CHECK (pending_count >= 0),
  reported_only_count bigint NOT NULL CHECK (reported_only_count >= 0),
  observed_presence_count bigint NOT NULL CHECK (observed_presence_count >= 0),
  discrepancy_count bigint NOT NULL CHECK (discrepancy_count >= 0),
  signed_delay_sum bigint NOT NULL DEFAULT 0,
  squared_delay_sum numeric NOT NULL DEFAULT 0 CHECK (squared_delay_sum >= 0),
  minimum_delay_seconds integer,
  maximum_delay_seconds integer,
  histogram_version text NOT NULL DEFAULT 'h30-v1' CHECK (histogram_version = 'h30-v1'),
  delay_histogram integer[] NOT NULL CHECK (array_length(delay_histogram, 1) = 72),
  source_coverage numeric(9,8) NOT NULL CHECK (source_coverage BETWEEN 0 AND 1),
  aggregate_algorithm_version text NOT NULL CHECK (aggregate_algorithm_version ~ '^[a-z0-9_.-]{1,40}$'),
  UNIQUE NULLS NOT DISTINCT (
    service_date, family, weekday_class, network_id, feed_version_id, service_pattern_id,
    line_id, branch_id, direction, station_id, segment_id, scheduled_seconds,
    aggregate_algorithm_version
  ),
  CHECK ((family = 'stop' AND station_id IS NOT NULL AND segment_id IS NULL)
      OR (family = 'segment' AND station_id IS NULL AND segment_id IS NOT NULL)
      OR (family = 'journey' AND station_id IS NULL AND segment_id IS NULL))
);
CREATE INDEX daily_schedule_contribution_month_idx
  ON analytics.daily_schedule_contribution (aggregate_algorithm_version, service_date);

CREATE TABLE analytics.monthly_stop_schedule (
  calendar_month date NOT NULL CHECK (calendar_month = date_trunc('month', calendar_month)::date),
  weekday_class text NOT NULL,
  network_id bigint NOT NULL REFERENCES core.network(id),
  feed_version_id bigint NOT NULL REFERENCES gtfs_static.feed_version(id),
  service_pattern_id bigint NOT NULL REFERENCES core.service_pattern(id),
  line_id bigint NOT NULL REFERENCES core.line(id),
  branch_id bigint NOT NULL REFERENCES core.branch(id),
  direction smallint NOT NULL CHECK (direction IN (0, 1)),
  station_id bigint NOT NULL REFERENCES core.station(id),
  scheduled_arrival_seconds integer NOT NULL CHECK (scheduled_arrival_seconds BETWEEN 0 AND 359999),
  scheduled_opportunities bigint NOT NULL, valid_delay_observations bigint NOT NULL,
  punctual_count bigint NOT NULL, early_count bigint NOT NULL, zero_to_two_count bigint NOT NULL,
  over_two_to_five_count bigint NOT NULL, over_five_to_ten_count bigint NOT NULL,
  over_ten_to_fifteen_count bigint NOT NULL, over_fifteen_count bigint NOT NULL,
  canceled_count bigint NOT NULL, skipped_count bigint NOT NULL, missing_evidence_count bigint NOT NULL,
  pending_count bigint NOT NULL, reported_only_count bigint NOT NULL, observed_presence_count bigint NOT NULL,
  discrepancy_count bigint NOT NULL, signed_delay_sum bigint NOT NULL, squared_delay_sum numeric NOT NULL,
  minimum_delay_seconds integer, maximum_delay_seconds integer,
  histogram_version text NOT NULL CHECK (histogram_version = 'h30-v1'),
  delay_histogram integer[] NOT NULL CHECK (array_length(delay_histogram, 1) = 72),
  source_coverage numeric(9,8) NOT NULL CHECK (source_coverage BETWEEN 0 AND 1),
  aggregate_algorithm_version text NOT NULL,
  PRIMARY KEY (calendar_month, weekday_class, network_id, feed_version_id, service_pattern_id,
    line_id, branch_id, direction, station_id, scheduled_arrival_seconds, aggregate_algorithm_version)
);
CREATE INDEX monthly_stop_schedule_query_idx
  ON analytics.monthly_stop_schedule (station_id, line_id, weekday_class, scheduled_arrival_seconds, calendar_month);

CREATE TABLE analytics.monthly_segment_schedule (
  calendar_month date NOT NULL CHECK (calendar_month = date_trunc('month', calendar_month)::date),
  weekday_class text NOT NULL,
  network_id bigint NOT NULL REFERENCES core.network(id),
  feed_version_id bigint NOT NULL REFERENCES gtfs_static.feed_version(id),
  service_pattern_id bigint NOT NULL REFERENCES core.service_pattern(id),
  line_id bigint NOT NULL REFERENCES core.line(id),
  branch_id bigint NOT NULL REFERENCES core.branch(id),
  direction smallint NOT NULL CHECK (direction IN (0, 1)),
  segment_id bigint NOT NULL REFERENCES core.segment(id),
  upstream_scheduled_seconds integer NOT NULL CHECK (upstream_scheduled_seconds BETWEEN 0 AND 359999),
  scheduled_opportunities bigint NOT NULL, valid_delay_observations bigint NOT NULL,
  punctual_count bigint NOT NULL, early_count bigint NOT NULL, zero_to_two_count bigint NOT NULL,
  over_two_to_five_count bigint NOT NULL, over_five_to_ten_count bigint NOT NULL,
  over_ten_to_fifteen_count bigint NOT NULL, over_fifteen_count bigint NOT NULL,
  canceled_count bigint NOT NULL, skipped_count bigint NOT NULL, missing_evidence_count bigint NOT NULL,
  pending_count bigint NOT NULL, reported_only_count bigint NOT NULL, observed_presence_count bigint NOT NULL,
  discrepancy_count bigint NOT NULL, signed_delay_sum bigint NOT NULL, squared_delay_sum numeric NOT NULL,
  minimum_delay_seconds integer, maximum_delay_seconds integer,
  histogram_version text NOT NULL CHECK (histogram_version = 'h30-v1'),
  delay_histogram integer[] NOT NULL CHECK (array_length(delay_histogram, 1) = 72),
  source_coverage numeric(9,8) NOT NULL CHECK (source_coverage BETWEEN 0 AND 1),
  aggregate_algorithm_version text NOT NULL,
  PRIMARY KEY (calendar_month, weekday_class, network_id, feed_version_id, service_pattern_id,
    line_id, branch_id, direction, segment_id, upstream_scheduled_seconds, aggregate_algorithm_version)
);
CREATE INDEX monthly_segment_schedule_query_idx
  ON analytics.monthly_segment_schedule (segment_id, line_id, weekday_class, upstream_scheduled_seconds, calendar_month);

CREATE TABLE analytics.monthly_journey_schedule (
  calendar_month date NOT NULL CHECK (calendar_month = date_trunc('month', calendar_month)::date),
  weekday_class text NOT NULL,
  network_id bigint NOT NULL REFERENCES core.network(id),
  feed_version_id bigint NOT NULL REFERENCES gtfs_static.feed_version(id),
  service_pattern_id bigint NOT NULL REFERENCES core.service_pattern(id),
  line_id bigint NOT NULL REFERENCES core.line(id),
  branch_id bigint NOT NULL REFERENCES core.branch(id),
  direction smallint NOT NULL CHECK (direction IN (0, 1)),
  scheduled_start_seconds integer NOT NULL CHECK (scheduled_start_seconds BETWEEN 0 AND 359999),
  scheduled_opportunities bigint NOT NULL, valid_delay_observations bigint NOT NULL,
  punctual_count bigint NOT NULL, early_count bigint NOT NULL, zero_to_two_count bigint NOT NULL,
  over_two_to_five_count bigint NOT NULL, over_five_to_ten_count bigint NOT NULL,
  over_ten_to_fifteen_count bigint NOT NULL, over_fifteen_count bigint NOT NULL,
  canceled_count bigint NOT NULL, skipped_count bigint NOT NULL, missing_evidence_count bigint NOT NULL,
  pending_count bigint NOT NULL, reported_only_count bigint NOT NULL, observed_presence_count bigint NOT NULL,
  discrepancy_count bigint NOT NULL, signed_delay_sum bigint NOT NULL, squared_delay_sum numeric NOT NULL,
  minimum_delay_seconds integer, maximum_delay_seconds integer,
  histogram_version text NOT NULL CHECK (histogram_version = 'h30-v1'),
  delay_histogram integer[] NOT NULL CHECK (array_length(delay_histogram, 1) = 72),
  source_coverage numeric(9,8) NOT NULL CHECK (source_coverage BETWEEN 0 AND 1),
  aggregate_algorithm_version text NOT NULL,
  PRIMARY KEY (calendar_month, weekday_class, network_id, feed_version_id, service_pattern_id,
    line_id, branch_id, direction, scheduled_start_seconds, aggregate_algorithm_version)
);
CREATE INDEX monthly_journey_schedule_query_idx
  ON analytics.monthly_journey_schedule (line_id, weekday_class, scheduled_start_seconds, calendar_month);

CREATE TABLE operations.verification_result (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope_kind text NOT NULL CHECK (scope_kind IN ('service_day', 'month')),
  service_date date,
  calendar_month date,
  aggregate_algorithm_version text NOT NULL,
  passed boolean NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source_row_count bigint NOT NULL DEFAULT 0,
  aggregate_row_count bigint NOT NULL DEFAULT 0,
  source_checksum text CHECK (source_checksum IS NULL OR source_checksum ~ '^[0-9a-f]{64}$'),
  aggregate_checksum text CHECK (aggregate_checksum IS NULL OR aggregate_checksum ~ '^[0-9a-f]{64}$'),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  CHECK ((scope_kind = 'service_day' AND service_date IS NOT NULL AND calendar_month IS NULL)
      OR (scope_kind = 'month' AND service_date IS NULL AND calendar_month IS NOT NULL))
);
CREATE INDEX verification_scope_idx
  ON operations.verification_result (scope_kind, service_date, calendar_month, aggregate_algorithm_version, checked_at DESC);

CREATE TABLE operations.service_day_finalization (
  service_date date NOT NULL,
  aggregate_algorithm_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('verified', 'failed')),
  verification_id bigint NOT NULL REFERENCES operations.verification_result(id),
  finalized_at timestamptz NOT NULL,
  source_journey_count bigint NOT NULL CHECK (source_journey_count >= 0),
  source_stop_count bigint NOT NULL CHECK (source_stop_count >= 0),
  source_segment_count bigint NOT NULL CHECK (source_segment_count >= 0),
  source_checksum text NOT NULL CHECK (source_checksum ~ '^[0-9a-f]{64}$'),
  aggregate_checksum text NOT NULL CHECK (aggregate_checksum ~ '^[0-9a-f]{64}$'),
  schedule_contribution_checksum text NOT NULL CHECK (schedule_contribution_checksum ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (service_date, aggregate_algorithm_version)
);

CREATE TABLE operations.month_seal (
  calendar_month date NOT NULL CHECK (calendar_month = date_trunc('month', calendar_month)::date),
  aggregate_algorithm_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('sealed', 'failed')),
  verification_id bigint NOT NULL REFERENCES operations.verification_result(id),
  service_day_count integer NOT NULL CHECK (service_day_count >= 0),
  contribution_row_count bigint NOT NULL CHECK (contribution_row_count >= 0),
  monthly_row_count bigint NOT NULL CHECK (monthly_row_count >= 0),
  aggregate_checksum text NOT NULL CHECK (aggregate_checksum ~ '^[0-9a-f]{64}$'),
  sealed_at timestamptz NOT NULL,
  PRIMARY KEY (calendar_month, aggregate_algorithm_version)
);

CREATE TABLE operations.daily_feed_coverage (
  service_date date NOT NULL,
  feed_kind text NOT NULL,
  poll_count bigint NOT NULL CHECK (poll_count >= 0),
  successful_poll_count bigint NOT NULL CHECK (successful_poll_count >= 0),
  matched_madrid_count bigint NOT NULL CHECK (matched_madrid_count >= 0),
  non_madrid_count bigint NOT NULL CHECK (non_madrid_count >= 0),
  unmatched_count bigint NOT NULL CHECK (unmatched_count >= 0),
  invalid_count bigint NOT NULL CHECK (invalid_count >= 0),
  evidence_changed_count bigint NOT NULL CHECK (evidence_changed_count >= 0),
  response_bytes bigint NOT NULL CHECK (response_bytes >= 0),
  first_poll_at timestamptz,
  last_poll_at timestamptz,
  source_checksum text NOT NULL CHECK (source_checksum ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (service_date, feed_kind)
);

CREATE TABLE operations.daily_quarantine_summary (
  service_date date NOT NULL,
  reason_code text NOT NULL,
  entity_count bigint NOT NULL CHECK (entity_count >= 0),
  source_checksum text NOT NULL CHECK (source_checksum ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (service_date, reason_code)
);

CREATE TABLE operations.retention_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family text NOT NULL CHECK (family IN ('filtered_payload', 'stop_evidence', 'poll_run', 'quarantined_entity', 'canonical_detail')),
  target_date date NOT NULL,
  partition_names text[] NOT NULL CHECK (cardinality(partition_names) BETWEEN 1 AND 2),
  aggregate_algorithm_version text NOT NULL,
  source_row_count bigint NOT NULL CHECK (source_row_count >= 0),
  source_checksum text NOT NULL CHECK (source_checksum ~ '^[0-9a-f]{64}$'),
  aggregate_checksum text CHECK (aggregate_checksum IS NULL OR aggregate_checksum ~ '^[0-9a-f]{64}$'),
  verification_id bigint REFERENCES operations.verification_result(id),
  authorization_checksum text NOT NULL CHECK (authorization_checksum ~ '^[0-9a-f]{64}$'),
  authorized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_at timestamptz,
  revoked_at timestamptz,
  dropped_row_count bigint CHECK (dropped_row_count IS NULL OR dropped_row_count >= 0),
  UNIQUE (family, target_date, aggregate_algorithm_version, authorization_checksum)
);
CREATE INDEX retention_ledger_open_idx
  ON operations.retention_ledger (target_date, family)
  WHERE applied_at IS NULL AND revoked_at IS NULL;

CREATE OR REPLACE FUNCTION analytics.weekday_class(value date)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $function$
  SELECT CASE extract(isodow FROM value)::integer
    WHEN 1 THEN 'monday' WHEN 2 THEN 'tuesday' WHEN 3 THEN 'wednesday'
    WHEN 4 THEN 'thursday' WHEN 5 THEN 'friday' WHEN 6 THEN 'saturday' ELSE 'sunday' END
$function$;

CREATE OR REPLACE FUNCTION analytics.canonical_source_checksum(target_date date)
RETURNS text
LANGUAGE sql
STABLE
STRICT
PARALLEL SAFE
AS $function$
  WITH source_rows AS (
    SELECT 'j|' || j.id || '|' || j.network_id || '|' || j.feed_version_id || '|' || j.source_trip_id || '|' ||
      COALESCE(j.start_time, '') || '|' || j.line_id || '|' || j.branch_id || '|' || COALESCE(j.direction::text, '') || '|' ||
      j.service_pattern_id || '|' || j.scheduled_start_seconds || '|' || j.scheduled_end_seconds || '|' || j.lifecycle_status || '|' ||
      j.canonical_algorithm_version || '|' || j.revision || '|' || j.repair_version AS payload
    FROM core.journey AS j WHERE j.service_date = target_date
    UNION ALL
    SELECT 's|' || s.journey_id || '|' || s.stop_sequence || '|' || s.station_id || '|' || s.feed_version_id || '|' ||
      s.source_trip_id || '|' || s.source_stop_id || '|' || s.scheduled_arrival_seconds || '|' ||
      COALESCE(s.selected_delay_seconds::text, '') || '|' || s.evidence_status || '|' ||
      COALESCE(s.delay_discrepancy_seconds::text, '') || '|' || s.canonical_algorithm_version || '|' || s.revision || '|' || s.repair_version
    FROM core.journey_stop AS s WHERE s.service_date = target_date
  )
  SELECT encode(sha256(convert_to(COALESCE(string_agg(payload, E'\n' ORDER BY payload), ''), 'UTF8')), 'hex')
  FROM source_rows
$function$;

CREATE OR REPLACE FUNCTION analytics.daily_checksum(target_date date, algorithm_version text)
RETURNS text
LANGUAGE sql
STABLE
STRICT
PARALLEL SAFE
AS $function$
  WITH rows AS (
    SELECT 'stop|' || row_to_json(value)::text AS payload
    FROM analytics.daily_stop_call_hour AS value
    WHERE service_date = target_date AND aggregate_algorithm_version = algorithm_version
    UNION ALL
    SELECT 'journey|' || row_to_json(value)::text FROM analytics.daily_journey_hour AS value
    WHERE service_date = target_date AND aggregate_algorithm_version = algorithm_version
    UNION ALL
    SELECT 'segment|' || row_to_json(value)::text FROM analytics.daily_segment_hour AS value
    WHERE service_date = target_date AND aggregate_algorithm_version = algorithm_version
    UNION ALL
    SELECT 'line|' || row_to_json(value)::text FROM analytics.daily_line_summary AS value
    WHERE service_date = target_date AND aggregate_algorithm_version = algorithm_version
    UNION ALL
    SELECT 'network|' || row_to_json(value)::text FROM analytics.daily_network_summary AS value
    WHERE service_date = target_date AND aggregate_algorithm_version = algorithm_version
  )
  SELECT encode(sha256(convert_to(COALESCE(string_agg(payload, E'\n' ORDER BY payload), ''), 'UTF8')), 'hex')
  FROM rows
$function$;

CREATE OR REPLACE FUNCTION analytics.schedule_contribution_checksum(target_date date, algorithm_version text)
RETURNS text
LANGUAGE sql
STABLE
STRICT
PARALLEL SAFE
AS $function$
  SELECT encode(sha256(convert_to(COALESCE(string_agg(row_to_json(value)::text, E'\n' ORDER BY row_to_json(value)::text), ''), 'UTF8')), 'hex')
  FROM analytics.daily_schedule_contribution AS value
  WHERE service_date = target_date AND aggregate_algorithm_version = algorithm_version
$function$;

CREATE OR REPLACE FUNCTION analytics.mark_dirty(target_date date, dirty_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, analytics, operations
AS $function$
BEGIN
  IF target_date IS NULL OR dirty_reason IS NULL OR length(btrim(dirty_reason)) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Dirty aggregation scope requires a service date and bounded reason';
  END IF;
  INSERT INTO analytics.dirty_scope (service_date, family, reason)
  VALUES (target_date, 'daily', dirty_reason), (target_date, 'schedule', dirty_reason)
  ON CONFLICT (service_date, family) DO UPDATE SET
    dirty_since = LEAST(analytics.dirty_scope.dirty_since, EXCLUDED.dirty_since),
    generation = analytics.dirty_scope.generation + 1,
    reason = EXCLUDED.reason;

  UPDATE operations.retention_ledger
  SET revoked_at = clock_timestamp()
  WHERE family = 'canonical_detail' AND target_date = analytics.mark_dirty.target_date
    AND applied_at IS NULL AND revoked_at IS NULL;
END
$function$;

-- Seed existing canonical days so upgrading from Milestone 3 cannot leave an unaggregated day looking clean.
INSERT INTO analytics.dirty_scope (service_date, family, reason)
SELECT DISTINCT journey.service_date, family.value, 'migration-0006-seed'
FROM core.journey AS journey
CROSS JOIN (VALUES ('daily'::text), ('schedule'::text)) AS family(value)
ON CONFLICT (service_date, family) DO NOTHING;

CREATE OR REPLACE FUNCTION analytics.recompute_daily(target_date date, algorithm_version text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, analytics, operations, core
AS $function$
DECLARE
  dirty_generation bigint;
  source_rows bigint;
  aggregate_rows bigint;
  source_checksum_value text;
  aggregate_checksum_value text;
  run_started timestamptz := clock_timestamp();
BEGIN
  IF algorithm_version !~ '^[a-z0-9_.-]{1,40}$' THEN
    RAISE EXCEPTION 'Invalid aggregate algorithm version';
  END IF;
  SELECT generation INTO dirty_generation
  FROM analytics.dirty_scope
  WHERE service_date = target_date AND family = 'daily'
  FOR UPDATE;
  IF dirty_generation IS NULL THEN
    RETURN jsonb_build_object(
      'serviceDate', target_date, 'status', 'noop', 'sourceRows', 0, 'aggregateRows', 0
    );
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('aggregate:daily:' || target_date::text, 0));

  DELETE FROM analytics.daily_stop_call_hour WHERE service_date = target_date;
  DELETE FROM analytics.daily_journey_hour WHERE service_date = target_date;
  DELETE FROM analytics.daily_segment_hour WHERE service_date = target_date;
  DELETE FROM analytics.daily_line_summary WHERE service_date = target_date;
  DELETE FROM analytics.daily_network_summary WHERE service_date = target_date;

  INSERT INTO analytics.daily_stop_call_hour (
    network_id, service_date, station_id, line_id, branch_id, direction, scheduled_hour,
    scheduled_opportunities, valid_delay_observations, punctual_count, early_count, zero_to_two_count,
    over_two_to_five_count, over_five_to_ten_count, over_ten_to_fifteen_count, over_fifteen_count,
    canceled_count, skipped_count, missing_evidence_count, pending_count, reported_only_count,
    observed_presence_count, discrepancy_count, signed_delay_sum, squared_delay_sum,
    minimum_delay_seconds, maximum_delay_seconds, delay_histogram, source_coverage,
    aggregate_algorithm_version
  )
  SELECT
    j.network_id, target_date, s.station_id, j.line_id, j.branch_id, COALESCE(j.direction, pattern.direction),
    extract(hour FROM s.scheduled_arrival_at AT TIME ZONE network.timezone)::smallint,
    count(*)::bigint,
    count(*) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence') AND s.selected_delay_seconds IS NOT NULL)::bigint,
    count(*) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence') AND s.selected_delay_seconds <= 120)::bigint,
    count(*) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence') AND s.selected_delay_seconds < 0)::bigint,
    count(*) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence') AND s.selected_delay_seconds BETWEEN 0 AND 120)::bigint,
    count(*) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence') AND s.selected_delay_seconds > 120 AND s.selected_delay_seconds <= 300)::bigint,
    count(*) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence') AND s.selected_delay_seconds > 300 AND s.selected_delay_seconds <= 600)::bigint,
    count(*) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence') AND s.selected_delay_seconds > 600 AND s.selected_delay_seconds <= 900)::bigint,
    count(*) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence') AND s.selected_delay_seconds > 900)::bigint,
    count(*) FILTER (WHERE s.evidence_status = 'canceled')::bigint,
    count(*) FILTER (WHERE s.evidence_status = 'skipped')::bigint,
    count(*) FILTER (WHERE s.evidence_status = 'missing_evidence')::bigint,
    count(*) FILTER (WHERE s.evidence_status = 'pending')::bigint,
    count(*) FILTER (WHERE s.evidence_status = 'reported_only')::bigint,
    count(*) FILTER (WHERE s.evidence_status = 'observed_presence')::bigint,
    count(*) FILTER (WHERE s.delay_discrepancy_seconds IS NOT NULL AND s.delay_discrepancy_seconds <> 0)::bigint,
    COALESCE(sum(s.selected_delay_seconds) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence')), 0)::bigint,
    COALESCE(sum(s.selected_delay_seconds::numeric * s.selected_delay_seconds::numeric)
      FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence')), 0),
    min(s.selected_delay_seconds) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence')),
    max(s.selected_delay_seconds) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence')),
    analytics.histogram_30s(array_agg(s.selected_delay_seconds)
      FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence') AND s.selected_delay_seconds IS NOT NULL)),
    (count(*) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence') AND s.selected_delay_seconds IS NOT NULL)::numeric / count(*)::numeric)::numeric(9,8),
    algorithm_version
  FROM core.journey AS j
  JOIN core.journey_stop AS s ON s.service_date = j.service_date AND s.journey_id = j.id
  JOIN core.network AS network ON network.id = j.network_id
  JOIN core.service_pattern AS pattern ON pattern.id = j.service_pattern_id
  WHERE j.service_date = target_date
  GROUP BY j.network_id, s.station_id, j.line_id, j.branch_id, COALESCE(j.direction, pattern.direction),
    extract(hour FROM s.scheduled_arrival_at AT TIME ZONE network.timezone);

  WITH journey_measure AS (
    SELECT j.*, COALESCE(j.direction, pattern.direction) AS aggregate_direction,
      extract(hour FROM j.scheduled_start_at AT TIME ZONE network.timezone)::smallint AS scheduled_hour,
      final_stop.evidence_status AS final_status,
      final_stop.selected_delay_seconds AS delay_seconds,
      final_stop.delay_discrepancy_seconds AS discrepancy_seconds,
      CASE WHEN j.lifecycle_status IN ('canceled','partially_canceled') THEN true ELSE false END AS journey_canceled
    FROM core.journey AS j
    JOIN core.network AS network ON network.id = j.network_id
    JOIN core.service_pattern AS pattern ON pattern.id = j.service_pattern_id
    LEFT JOIN LATERAL (
      SELECT s.evidence_status, s.selected_delay_seconds, s.delay_discrepancy_seconds
      FROM core.journey_stop AS s
      WHERE s.service_date = j.service_date AND s.journey_id = j.id
      ORDER BY s.stop_sequence DESC LIMIT 1
    ) AS final_stop ON true
    WHERE j.service_date = target_date
  )
  INSERT INTO analytics.daily_journey_hour (
    network_id, service_date, line_id, branch_id, direction, scheduled_start_hour,
    scheduled_opportunities, valid_delay_observations, punctual_count, early_count, zero_to_two_count,
    over_two_to_five_count, over_five_to_ten_count, over_ten_to_fifteen_count, over_fifteen_count,
    canceled_count, skipped_count, missing_evidence_count, pending_count, reported_only_count,
    observed_presence_count, discrepancy_count, signed_delay_sum, squared_delay_sum,
    minimum_delay_seconds, maximum_delay_seconds, delay_histogram, source_coverage,
    aggregate_algorithm_version
  )
  SELECT network_id, target_date, line_id, branch_id, aggregate_direction, scheduled_hour,
    count(*)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds IS NOT NULL)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds <= 120)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds < 0)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds BETWEEN 0 AND 120)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds > 120 AND delay_seconds <= 300)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds > 300 AND delay_seconds <= 600)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds > 600 AND delay_seconds <= 900)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds > 900)::bigint,
    count(*) FILTER (WHERE journey_canceled)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status = 'skipped')::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status = 'missing_evidence')::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND (final_status = 'pending' OR final_status IS NULL))::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status = 'reported_only')::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status = 'observed_presence')::bigint,
    count(*) FILTER (WHERE discrepancy_seconds IS NOT NULL AND discrepancy_seconds <> 0)::bigint,
    COALESCE(sum(delay_seconds) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence')), 0)::bigint,
    COALESCE(sum(delay_seconds::numeric * delay_seconds::numeric)
      FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence')), 0),
    min(delay_seconds) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence')),
    max(delay_seconds) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence')),
    analytics.histogram_30s(array_agg(delay_seconds)
      FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds IS NOT NULL)),
    (count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds IS NOT NULL)::numeric / count(*)::numeric)::numeric(9,8),
    algorithm_version
  FROM journey_measure
  GROUP BY network_id, line_id, branch_id, aggregate_direction, scheduled_hour;

  WITH ordered AS (
    SELECT j.network_id, j.line_id, j.branch_id, COALESCE(j.direction, pattern.direction) AS aggregate_direction,
      j.service_pattern_id, s.journey_id, s.stop_sequence, s.station_id, s.scheduled_arrival_at,
      s.scheduled_arrival_seconds, s.evidence_status, s.selected_delay_seconds, s.delay_discrepancy_seconds,
      row_number() OVER (PARTITION BY s.journey_id ORDER BY s.stop_sequence) - 1 AS segment_order,
      lead(s.station_id) OVER (PARTITION BY s.journey_id ORDER BY s.stop_sequence) AS downstream_station_id,
      lead(s.evidence_status) OVER (PARTITION BY s.journey_id ORDER BY s.stop_sequence) AS downstream_status,
      lead(s.selected_delay_seconds) OVER (PARTITION BY s.journey_id ORDER BY s.stop_sequence) AS downstream_delay,
      lead(s.delay_discrepancy_seconds) OVER (PARTITION BY s.journey_id ORDER BY s.stop_sequence) AS downstream_discrepancy
    FROM core.journey AS j
    JOIN core.journey_stop AS s ON s.service_date = j.service_date AND s.journey_id = j.id
    JOIN core.service_pattern AS pattern ON pattern.id = j.service_pattern_id
    WHERE j.service_date = target_date
  ), segment_measure AS (
    SELECT ordered.*, segment.id AS segment_id,
      extract(hour FROM ordered.scheduled_arrival_at AT TIME ZONE network.timezone)::smallint AS upstream_hour,
      CASE WHEN ordered.evidence_status IN ('reported_only','observed_presence')
             AND ordered.downstream_status IN ('reported_only','observed_presence')
             AND ordered.selected_delay_seconds IS NOT NULL AND ordered.downstream_delay IS NOT NULL
        THEN ordered.downstream_delay - ordered.selected_delay_seconds END AS delay_change,
      CASE
        WHEN ordered.evidence_status = 'canceled' OR ordered.downstream_status = 'canceled' THEN 'canceled'
        WHEN ordered.evidence_status = 'skipped' OR ordered.downstream_status = 'skipped' THEN 'skipped'
        WHEN ordered.evidence_status = 'missing_evidence' OR ordered.downstream_status = 'missing_evidence' THEN 'missing_evidence'
        WHEN ordered.evidence_status = 'pending' OR ordered.downstream_status = 'pending' THEN 'pending'
        WHEN ordered.downstream_status = 'observed_presence' THEN 'observed_presence'
        ELSE 'reported_only' END AS aggregate_status
    FROM ordered
    JOIN core.segment AS segment
      ON segment.service_pattern_id = ordered.service_pattern_id
     AND segment.segment_order = ordered.segment_order
     AND segment.from_station_id = ordered.station_id
     AND segment.to_station_id = ordered.downstream_station_id
    JOIN core.network AS network ON network.id = ordered.network_id
    WHERE ordered.downstream_station_id IS NOT NULL
  )
  INSERT INTO analytics.daily_segment_hour (
    network_id, service_date, segment_id, line_id, branch_id, direction, upstream_scheduled_hour,
    scheduled_opportunities, valid_delay_observations, punctual_count, early_count, zero_to_two_count,
    over_two_to_five_count, over_five_to_ten_count, over_ten_to_fifteen_count, over_fifteen_count,
    canceled_count, skipped_count, missing_evidence_count, pending_count, reported_only_count,
    observed_presence_count, discrepancy_count, signed_delay_sum, squared_delay_sum,
    minimum_delay_seconds, maximum_delay_seconds, delay_histogram, source_coverage,
    aggregate_algorithm_version
  )
  SELECT network_id, target_date, segment_id, line_id, branch_id, aggregate_direction, upstream_hour,
    count(*)::bigint, count(delay_change)::bigint,
    count(*) FILTER (WHERE delay_change <= 120)::bigint,
    count(*) FILTER (WHERE delay_change < 0)::bigint,
    count(*) FILTER (WHERE delay_change BETWEEN 0 AND 120)::bigint,
    count(*) FILTER (WHERE delay_change > 120 AND delay_change <= 300)::bigint,
    count(*) FILTER (WHERE delay_change > 300 AND delay_change <= 600)::bigint,
    count(*) FILTER (WHERE delay_change > 600 AND delay_change <= 900)::bigint,
    count(*) FILTER (WHERE delay_change > 900)::bigint,
    count(*) FILTER (WHERE aggregate_status = 'canceled')::bigint,
    count(*) FILTER (WHERE aggregate_status = 'skipped')::bigint,
    count(*) FILTER (WHERE aggregate_status = 'missing_evidence')::bigint,
    count(*) FILTER (WHERE aggregate_status = 'pending')::bigint,
    count(*) FILTER (WHERE aggregate_status = 'reported_only' AND delay_change IS NOT NULL)::bigint,
    count(*) FILTER (WHERE aggregate_status = 'observed_presence' AND delay_change IS NOT NULL)::bigint,
    count(*) FILTER (WHERE COALESCE(delay_discrepancy_seconds, 0) <> 0 OR COALESCE(downstream_discrepancy, 0) <> 0)::bigint,
    COALESCE(sum(delay_change), 0)::bigint,
    COALESCE(sum(delay_change::numeric * delay_change::numeric), 0),
    min(delay_change), max(delay_change), analytics.histogram_30s(array_agg(delay_change) FILTER (WHERE delay_change IS NOT NULL)),
    (count(delay_change)::numeric / count(*)::numeric)::numeric(9,8), algorithm_version
  FROM segment_measure
  GROUP BY network_id, segment_id, line_id, branch_id, aggregate_direction, upstream_hour;

  -- Headline summaries use the journey statistical unit directly. They never sum station distinct counts.
  WITH journey_measure AS (
    SELECT j.network_id, j.line_id, j.lifecycle_status,
      final_stop.evidence_status AS final_status, final_stop.selected_delay_seconds AS delay_seconds,
      final_stop.delay_discrepancy_seconds AS discrepancy_seconds,
      j.lifecycle_status IN ('canceled','partially_canceled') AS journey_canceled
    FROM core.journey AS j
    LEFT JOIN LATERAL (
      SELECT s.evidence_status, s.selected_delay_seconds, s.delay_discrepancy_seconds
      FROM core.journey_stop AS s WHERE s.service_date = j.service_date AND s.journey_id = j.id
      ORDER BY s.stop_sequence DESC LIMIT 1
    ) AS final_stop ON true
    WHERE j.service_date = target_date
  )
  INSERT INTO analytics.daily_line_summary (
    network_id, service_date, line_id, scheduled_opportunities, valid_delay_observations, punctual_count,
    early_count, zero_to_two_count, over_two_to_five_count, over_five_to_ten_count,
    over_ten_to_fifteen_count, over_fifteen_count, canceled_count, skipped_count,
    missing_evidence_count, pending_count, reported_only_count, observed_presence_count,
    discrepancy_count, signed_delay_sum, squared_delay_sum, minimum_delay_seconds, maximum_delay_seconds,
    delay_histogram, source_coverage, aggregate_algorithm_version
  )
  SELECT network_id, target_date, line_id, count(*)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds IS NOT NULL)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds <= 120)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds < 0)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds BETWEEN 0 AND 120)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds > 120 AND delay_seconds <= 300)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds > 300 AND delay_seconds <= 600)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds > 600 AND delay_seconds <= 900)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds > 900)::bigint,
    count(*) FILTER (WHERE journey_canceled)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status = 'skipped')::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status = 'missing_evidence')::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND (final_status = 'pending' OR final_status IS NULL))::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status = 'reported_only')::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status = 'observed_presence')::bigint,
    count(*) FILTER (WHERE discrepancy_seconds IS NOT NULL AND discrepancy_seconds <> 0)::bigint,
    COALESCE(sum(delay_seconds) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence')), 0)::bigint,
    COALESCE(sum(delay_seconds::numeric * delay_seconds::numeric)
      FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence')), 0),
    min(delay_seconds) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence')),
    max(delay_seconds) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence')),
    analytics.histogram_30s(array_agg(delay_seconds)
      FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds IS NOT NULL)),
    (count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds IS NOT NULL)::numeric / count(*)::numeric)::numeric(9,8),
    algorithm_version
  FROM journey_measure GROUP BY network_id, line_id;

  WITH journey_measure AS (
    SELECT j.network_id, j.lifecycle_status,
      final_stop.evidence_status AS final_status, final_stop.selected_delay_seconds AS delay_seconds,
      final_stop.delay_discrepancy_seconds AS discrepancy_seconds,
      j.lifecycle_status IN ('canceled','partially_canceled') AS journey_canceled
    FROM core.journey AS j
    LEFT JOIN LATERAL (
      SELECT s.evidence_status, s.selected_delay_seconds, s.delay_discrepancy_seconds
      FROM core.journey_stop AS s WHERE s.service_date = j.service_date AND s.journey_id = j.id
      ORDER BY s.stop_sequence DESC LIMIT 1
    ) AS final_stop ON true
    WHERE j.service_date = target_date
  )
  INSERT INTO analytics.daily_network_summary (
    network_id, service_date, scheduled_opportunities, valid_delay_observations, punctual_count,
    early_count, zero_to_two_count, over_two_to_five_count, over_five_to_ten_count,
    over_ten_to_fifteen_count, over_fifteen_count, canceled_count, skipped_count,
    missing_evidence_count, pending_count, reported_only_count, observed_presence_count,
    discrepancy_count, signed_delay_sum, squared_delay_sum, minimum_delay_seconds, maximum_delay_seconds,
    delay_histogram, source_coverage, aggregate_algorithm_version
  )
  SELECT network_id, target_date, count(*)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds IS NOT NULL)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds <= 120)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds < 0)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds BETWEEN 0 AND 120)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds > 120 AND delay_seconds <= 300)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds > 300 AND delay_seconds <= 600)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds > 600 AND delay_seconds <= 900)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds > 900)::bigint,
    count(*) FILTER (WHERE journey_canceled)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status = 'skipped')::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status = 'missing_evidence')::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND (final_status = 'pending' OR final_status IS NULL))::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status = 'reported_only')::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status = 'observed_presence')::bigint,
    count(*) FILTER (WHERE discrepancy_seconds IS NOT NULL AND discrepancy_seconds <> 0)::bigint,
    COALESCE(sum(delay_seconds) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence')), 0)::bigint,
    COALESCE(sum(delay_seconds::numeric * delay_seconds::numeric)
      FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence')), 0),
    min(delay_seconds) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence')),
    max(delay_seconds) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence')),
    analytics.histogram_30s(array_agg(delay_seconds)
      FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds IS NOT NULL)),
    (count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds IS NOT NULL)::numeric / count(*)::numeric)::numeric(9,8),
    algorithm_version
  FROM journey_measure GROUP BY network_id;

  SELECT count(*) INTO source_rows
  FROM core.journey_stop WHERE service_date = target_date;
  SELECT
    (SELECT count(*) FROM analytics.daily_stop_call_hour WHERE service_date = target_date) +
    (SELECT count(*) FROM analytics.daily_journey_hour WHERE service_date = target_date) +
    (SELECT count(*) FROM analytics.daily_segment_hour WHERE service_date = target_date) +
    (SELECT count(*) FROM analytics.daily_line_summary WHERE service_date = target_date) +
    (SELECT count(*) FROM analytics.daily_network_summary WHERE service_date = target_date)
  INTO aggregate_rows;
  source_checksum_value := analytics.canonical_source_checksum(target_date);
  aggregate_checksum_value := analytics.daily_checksum(target_date, algorithm_version);

  INSERT INTO analytics.aggregation_run (
    service_date, family, aggregate_algorithm_version, generation, started_at, completed_at,
    status, source_row_count, aggregate_row_count, source_checksum, aggregate_checksum
  ) VALUES (
    target_date, 'daily', algorithm_version, dirty_generation, run_started, clock_timestamp(),
    'succeeded', source_rows, aggregate_rows, source_checksum_value, aggregate_checksum_value
  );
  DELETE FROM analytics.dirty_scope
  WHERE service_date = target_date AND family = 'daily' AND generation = dirty_generation;

  RETURN jsonb_build_object(
    'serviceDate', target_date, 'status', 'succeeded', 'sourceRows', source_rows,
    'aggregateRows', aggregate_rows, 'sourceChecksum', source_checksum_value,
    'aggregateChecksum', aggregate_checksum_value
  );
END
$function$;

CREATE OR REPLACE FUNCTION analytics.recompute_schedule_contribution(target_date date, algorithm_version text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, analytics, operations, core
AS $function$
DECLARE
  dirty_generation bigint;
  contribution_rows bigint;
  checksum_value text;
BEGIN
  SELECT generation INTO dirty_generation
  FROM analytics.dirty_scope
  WHERE service_date = target_date AND family = 'schedule'
  FOR UPDATE;
  IF dirty_generation IS NULL THEN
    RETURN jsonb_build_object('serviceDate', target_date, 'status', 'noop', 'contributionRows', 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM operations.service_day_finalization
    WHERE service_date = target_date AND aggregate_algorithm_version = algorithm_version AND status = 'verified'
  ) THEN
    RETURN jsonb_build_object('serviceDate', target_date, 'status', 'blocked', 'blocker', 'service_day_not_verified');
  END IF;
  IF EXISTS (
    SELECT 1 FROM operations.month_seal
    WHERE calendar_month = date_trunc('month', target_date)::date
      AND aggregate_algorithm_version = algorithm_version AND status = 'sealed'
  ) THEN
    RAISE EXCEPTION 'Sealed month requires a newer aggregate algorithm version for repair';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('aggregate:schedule:' || target_date::text, 0));
  DELETE FROM analytics.daily_schedule_contribution
  WHERE service_date = target_date AND aggregate_algorithm_version = algorithm_version;

  INSERT INTO analytics.daily_schedule_contribution (
    service_date, family, weekday_class, network_id, feed_version_id, service_pattern_id,
    line_id, branch_id, direction, station_id, segment_id, scheduled_seconds,
    scheduled_opportunities, valid_delay_observations, punctual_count, early_count, zero_to_two_count,
    over_two_to_five_count, over_five_to_ten_count, over_ten_to_fifteen_count, over_fifteen_count,
    canceled_count, skipped_count, missing_evidence_count, pending_count, reported_only_count,
    observed_presence_count, discrepancy_count, signed_delay_sum, squared_delay_sum,
    minimum_delay_seconds, maximum_delay_seconds, delay_histogram, source_coverage,
    aggregate_algorithm_version
  )
  SELECT target_date, 'stop', analytics.weekday_class(target_date), j.network_id, j.feed_version_id,
    j.service_pattern_id, j.line_id, j.branch_id, COALESCE(j.direction, pattern.direction), s.station_id, NULL,
    s.scheduled_arrival_seconds,
    count(*)::bigint,
    count(*) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence') AND s.selected_delay_seconds IS NOT NULL)::bigint,
    count(*) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence') AND s.selected_delay_seconds <= 120)::bigint,
    count(*) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence') AND s.selected_delay_seconds < 0)::bigint,
    count(*) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence') AND s.selected_delay_seconds BETWEEN 0 AND 120)::bigint,
    count(*) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence') AND s.selected_delay_seconds > 120 AND s.selected_delay_seconds <= 300)::bigint,
    count(*) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence') AND s.selected_delay_seconds > 300 AND s.selected_delay_seconds <= 600)::bigint,
    count(*) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence') AND s.selected_delay_seconds > 600 AND s.selected_delay_seconds <= 900)::bigint,
    count(*) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence') AND s.selected_delay_seconds > 900)::bigint,
    count(*) FILTER (WHERE s.evidence_status = 'canceled')::bigint,
    count(*) FILTER (WHERE s.evidence_status = 'skipped')::bigint,
    count(*) FILTER (WHERE s.evidence_status = 'missing_evidence')::bigint,
    count(*) FILTER (WHERE s.evidence_status = 'pending')::bigint,
    count(*) FILTER (WHERE s.evidence_status = 'reported_only')::bigint,
    count(*) FILTER (WHERE s.evidence_status = 'observed_presence')::bigint,
    count(*) FILTER (WHERE s.delay_discrepancy_seconds IS NOT NULL AND s.delay_discrepancy_seconds <> 0)::bigint,
    COALESCE(sum(s.selected_delay_seconds) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence')), 0)::bigint,
    COALESCE(sum(s.selected_delay_seconds::numeric * s.selected_delay_seconds::numeric)
      FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence')), 0),
    min(s.selected_delay_seconds) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence')),
    max(s.selected_delay_seconds) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence')),
    analytics.histogram_30s(array_agg(s.selected_delay_seconds)
      FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence') AND s.selected_delay_seconds IS NOT NULL)),
    (count(*) FILTER (WHERE s.evidence_status IN ('reported_only','observed_presence') AND s.selected_delay_seconds IS NOT NULL)::numeric / count(*)::numeric)::numeric(9,8),
    algorithm_version
  FROM core.journey AS j
  JOIN core.journey_stop AS s ON s.service_date = j.service_date AND s.journey_id = j.id
  JOIN core.service_pattern AS pattern ON pattern.id = j.service_pattern_id
  WHERE j.service_date = target_date
  GROUP BY j.network_id, j.feed_version_id, j.service_pattern_id, j.line_id, j.branch_id,
    COALESCE(j.direction, pattern.direction), s.station_id, s.scheduled_arrival_seconds;

  WITH journey_measure AS (
    SELECT j.*, COALESCE(j.direction, pattern.direction) AS aggregate_direction,
      final_stop.evidence_status AS final_status, final_stop.selected_delay_seconds AS delay_seconds,
      final_stop.delay_discrepancy_seconds AS discrepancy_seconds,
      j.lifecycle_status IN ('canceled','partially_canceled') AS journey_canceled
    FROM core.journey AS j
    JOIN core.service_pattern AS pattern ON pattern.id = j.service_pattern_id
    LEFT JOIN LATERAL (
      SELECT s.evidence_status, s.selected_delay_seconds, s.delay_discrepancy_seconds
      FROM core.journey_stop AS s WHERE s.service_date = j.service_date AND s.journey_id = j.id
      ORDER BY s.stop_sequence DESC LIMIT 1
    ) AS final_stop ON true
    WHERE j.service_date = target_date
  )
  INSERT INTO analytics.daily_schedule_contribution (
    service_date, family, weekday_class, network_id, feed_version_id, service_pattern_id,
    line_id, branch_id, direction, station_id, segment_id, scheduled_seconds,
    scheduled_opportunities, valid_delay_observations, punctual_count, early_count, zero_to_two_count,
    over_two_to_five_count, over_five_to_ten_count, over_ten_to_fifteen_count, over_fifteen_count,
    canceled_count, skipped_count, missing_evidence_count, pending_count, reported_only_count,
    observed_presence_count, discrepancy_count, signed_delay_sum, squared_delay_sum,
    minimum_delay_seconds, maximum_delay_seconds, delay_histogram, source_coverage,
    aggregate_algorithm_version
  )
  SELECT target_date, 'journey', analytics.weekday_class(target_date), network_id, feed_version_id,
    service_pattern_id, line_id, branch_id, aggregate_direction, NULL, NULL, scheduled_start_seconds,
    count(*)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds IS NOT NULL)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds <= 120)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds < 0)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds BETWEEN 0 AND 120)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds > 120 AND delay_seconds <= 300)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds > 300 AND delay_seconds <= 600)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds > 600 AND delay_seconds <= 900)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds > 900)::bigint,
    count(*) FILTER (WHERE journey_canceled)::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status = 'skipped')::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status = 'missing_evidence')::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND (final_status = 'pending' OR final_status IS NULL))::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status = 'reported_only')::bigint,
    count(*) FILTER (WHERE NOT journey_canceled AND final_status = 'observed_presence')::bigint,
    count(*) FILTER (WHERE discrepancy_seconds IS NOT NULL AND discrepancy_seconds <> 0)::bigint,
    COALESCE(sum(delay_seconds) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence')), 0)::bigint,
    COALESCE(sum(delay_seconds::numeric * delay_seconds::numeric)
      FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence')), 0),
    min(delay_seconds) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence')),
    max(delay_seconds) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence')),
    analytics.histogram_30s(array_agg(delay_seconds)
      FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds IS NOT NULL)),
    (count(*) FILTER (WHERE NOT journey_canceled AND final_status IN ('reported_only','observed_presence') AND delay_seconds IS NOT NULL)::numeric / count(*)::numeric)::numeric(9,8), algorithm_version
  FROM journey_measure
  GROUP BY network_id, feed_version_id, service_pattern_id, line_id, branch_id, aggregate_direction, scheduled_start_seconds;

  WITH ordered AS (
    SELECT j.network_id, j.feed_version_id, j.line_id, j.branch_id,
      COALESCE(j.direction, pattern.direction) AS aggregate_direction, j.service_pattern_id,
      s.journey_id, s.stop_sequence, s.station_id, s.scheduled_arrival_seconds,
      s.evidence_status, s.selected_delay_seconds, s.delay_discrepancy_seconds,
      row_number() OVER (PARTITION BY s.journey_id ORDER BY s.stop_sequence) - 1 AS segment_order,
      lead(s.station_id) OVER (PARTITION BY s.journey_id ORDER BY s.stop_sequence) AS downstream_station_id,
      lead(s.evidence_status) OVER (PARTITION BY s.journey_id ORDER BY s.stop_sequence) AS downstream_status,
      lead(s.selected_delay_seconds) OVER (PARTITION BY s.journey_id ORDER BY s.stop_sequence) AS downstream_delay,
      lead(s.delay_discrepancy_seconds) OVER (PARTITION BY s.journey_id ORDER BY s.stop_sequence) AS downstream_discrepancy
    FROM core.journey AS j
    JOIN core.journey_stop AS s ON s.service_date = j.service_date AND s.journey_id = j.id
    JOIN core.service_pattern AS pattern ON pattern.id = j.service_pattern_id
    WHERE j.service_date = target_date
  ), segment_measure AS (
    SELECT ordered.*, segment.id AS segment_id,
      CASE WHEN ordered.evidence_status IN ('reported_only','observed_presence')
             AND ordered.downstream_status IN ('reported_only','observed_presence')
             AND ordered.selected_delay_seconds IS NOT NULL AND ordered.downstream_delay IS NOT NULL
        THEN ordered.downstream_delay - ordered.selected_delay_seconds END AS delay_change,
      CASE
        WHEN ordered.evidence_status = 'canceled' OR ordered.downstream_status = 'canceled' THEN 'canceled'
        WHEN ordered.evidence_status = 'skipped' OR ordered.downstream_status = 'skipped' THEN 'skipped'
        WHEN ordered.evidence_status = 'missing_evidence' OR ordered.downstream_status = 'missing_evidence' THEN 'missing_evidence'
        WHEN ordered.evidence_status = 'pending' OR ordered.downstream_status = 'pending' THEN 'pending'
        WHEN ordered.downstream_status = 'observed_presence' THEN 'observed_presence'
        ELSE 'reported_only' END AS aggregate_status
    FROM ordered
    JOIN core.segment AS segment
      ON segment.service_pattern_id = ordered.service_pattern_id
     AND segment.segment_order = ordered.segment_order
     AND segment.from_station_id = ordered.station_id
     AND segment.to_station_id = ordered.downstream_station_id
    WHERE ordered.downstream_station_id IS NOT NULL
  )
  INSERT INTO analytics.daily_schedule_contribution (
    service_date, family, weekday_class, network_id, feed_version_id, service_pattern_id,
    line_id, branch_id, direction, station_id, segment_id, scheduled_seconds,
    scheduled_opportunities, valid_delay_observations, punctual_count, early_count, zero_to_two_count,
    over_two_to_five_count, over_five_to_ten_count, over_ten_to_fifteen_count, over_fifteen_count,
    canceled_count, skipped_count, missing_evidence_count, pending_count, reported_only_count,
    observed_presence_count, discrepancy_count, signed_delay_sum, squared_delay_sum,
    minimum_delay_seconds, maximum_delay_seconds, delay_histogram, source_coverage,
    aggregate_algorithm_version
  )
  SELECT target_date, 'segment', analytics.weekday_class(target_date), network_id, feed_version_id,
    service_pattern_id, line_id, branch_id, aggregate_direction, NULL, segment_id, scheduled_arrival_seconds,
    count(*)::bigint, count(delay_change)::bigint,
    count(*) FILTER (WHERE delay_change <= 120)::bigint, count(*) FILTER (WHERE delay_change < 0)::bigint,
    count(*) FILTER (WHERE delay_change BETWEEN 0 AND 120)::bigint,
    count(*) FILTER (WHERE delay_change > 120 AND delay_change <= 300)::bigint,
    count(*) FILTER (WHERE delay_change > 300 AND delay_change <= 600)::bigint,
    count(*) FILTER (WHERE delay_change > 600 AND delay_change <= 900)::bigint,
    count(*) FILTER (WHERE delay_change > 900)::bigint,
    count(*) FILTER (WHERE aggregate_status = 'canceled')::bigint,
    count(*) FILTER (WHERE aggregate_status = 'skipped')::bigint,
    count(*) FILTER (WHERE aggregate_status = 'missing_evidence')::bigint,
    count(*) FILTER (WHERE aggregate_status = 'pending')::bigint,
    count(*) FILTER (WHERE aggregate_status = 'reported_only' AND delay_change IS NOT NULL)::bigint,
    count(*) FILTER (WHERE aggregate_status = 'observed_presence' AND delay_change IS NOT NULL)::bigint,
    count(*) FILTER (WHERE COALESCE(delay_discrepancy_seconds, 0) <> 0 OR COALESCE(downstream_discrepancy, 0) <> 0)::bigint,
    COALESCE(sum(delay_change), 0)::bigint, COALESCE(sum(delay_change::numeric * delay_change::numeric), 0),
    min(delay_change), max(delay_change), analytics.histogram_30s(array_agg(delay_change) FILTER (WHERE delay_change IS NOT NULL)),
    (count(delay_change)::numeric / count(*)::numeric)::numeric(9,8), algorithm_version
  FROM segment_measure
  GROUP BY network_id, feed_version_id, service_pattern_id, line_id, branch_id,
    aggregate_direction, segment_id, scheduled_arrival_seconds;

  SELECT count(*) INTO contribution_rows FROM analytics.daily_schedule_contribution
  WHERE service_date = target_date AND aggregate_algorithm_version = algorithm_version;
  checksum_value := analytics.schedule_contribution_checksum(target_date, algorithm_version);
  DELETE FROM analytics.dirty_scope
  WHERE service_date = target_date AND family = 'schedule' AND generation = dirty_generation;
  RETURN jsonb_build_object(
    'serviceDate', target_date, 'status', 'succeeded', 'contributionRows', contribution_rows,
    'checksum', checksum_value
  );
END
$function$;

CREATE OR REPLACE FUNCTION operations.finalize_service_day(
  target_date date,
  algorithm_version text,
  checked_at timestamptz,
  grace_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, analytics, operations, core
AS $function$
DECLARE
  existing operations.service_day_finalization%ROWTYPE;
  source_journeys bigint;
  source_stops bigint;
  source_segments bigint;
  aggregate_journeys bigint;
  aggregate_stops bigint;
  aggregate_segments bigint;
  line_journeys bigint;
  network_journeys bigint;
  status_total bigint;
  pending_total bigint;
  open_journeys bigint;
  last_scheduled_end timestamptz;
  source_checksum_value text;
  aggregate_checksum_value text;
  schedule_result jsonb;
  schedule_checksum_value text;
  verification_id_value bigint;
  blockers text[] := ARRAY[]::text[];
BEGIN
  IF grace_seconds < 0 OR grace_seconds > 86400 THEN
    RAISE EXCEPTION 'Finalization grace must be from 0 through 86400 seconds';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('finalize:' || target_date::text, 0)) THEN
    RETURN jsonb_build_object('serviceDate', target_date, 'status', 'locked', 'blockers', jsonb_build_array('advisory_lock_busy'));
  END IF;

  SELECT * INTO existing FROM operations.service_day_finalization
  WHERE service_date = target_date AND aggregate_algorithm_version = algorithm_version;
  IF FOUND THEN
    IF EXISTS (SELECT 1 FROM analytics.dirty_scope WHERE service_date = target_date) THEN
      RETURN jsonb_build_object(
        'serviceDate', target_date, 'status', 'blocked',
        'blockers', jsonb_build_array('verified_version_became_dirty_use_new_algorithm_version')
      );
    END IF;
    RETURN jsonb_build_object(
      'serviceDate', target_date, 'status', 'already_verified', 'verificationId', existing.verification_id,
      'sourceJourneyCount', existing.source_journey_count, 'sourceStopCount', existing.source_stop_count,
      'sourceSegmentCount', existing.source_segment_count, 'sourceChecksum', existing.source_checksum,
      'aggregateChecksum', existing.aggregate_checksum
    );
  END IF;

  SELECT count(*) FILTER (WHERE finalized_at IS NULL), count(*), max(scheduled_end_at)
  INTO open_journeys, source_journeys, last_scheduled_end
  FROM core.journey WHERE service_date = target_date;
  IF source_journeys = 0 THEN blockers := array_append(blockers, 'no_canonical_journeys'); END IF;
  IF open_journeys > 0 THEN blockers := array_append(blockers, 'canonical_journeys_open'); END IF;
  IF last_scheduled_end IS NOT NULL AND last_scheduled_end + make_interval(secs => grace_seconds) > checked_at THEN
    blockers := array_append(blockers, 'service_day_grace_not_elapsed');
  END IF;
  IF EXISTS (SELECT 1 FROM analytics.dirty_scope WHERE service_date = target_date AND family = 'daily') THEN
    blockers := array_append(blockers, 'daily_aggregates_dirty');
  END IF;

  SELECT count(*) INTO source_stops FROM core.journey_stop WHERE service_date = target_date;
  WITH ordered AS (
    SELECT j.service_pattern_id, s.journey_id, s.station_id,
      row_number() OVER (PARTITION BY s.journey_id ORDER BY s.stop_sequence) - 1 AS segment_order,
      lead(s.station_id) OVER (PARTITION BY s.journey_id ORDER BY s.stop_sequence) AS downstream_station_id
    FROM core.journey AS j
    JOIN core.journey_stop AS s ON s.service_date = j.service_date AND s.journey_id = j.id
    WHERE j.service_date = target_date
  )
  SELECT count(*) INTO source_segments
  FROM ordered
  JOIN core.segment AS segment
    ON segment.service_pattern_id = ordered.service_pattern_id
   AND segment.segment_order = ordered.segment_order
   AND segment.from_station_id = ordered.station_id
   AND segment.to_station_id = ordered.downstream_station_id
  WHERE ordered.downstream_station_id IS NOT NULL;

  SELECT COALESCE(sum(scheduled_opportunities), 0),
    COALESCE(sum(reported_only_count + observed_presence_count + skipped_count + canceled_count + missing_evidence_count + pending_count), 0),
    COALESCE(sum(pending_count), 0)
  INTO aggregate_stops, status_total, pending_total
  FROM analytics.daily_stop_call_hour
  WHERE service_date = target_date AND aggregate_algorithm_version = algorithm_version;
  SELECT COALESCE(sum(scheduled_opportunities), 0) INTO aggregate_journeys
  FROM analytics.daily_journey_hour
  WHERE service_date = target_date AND aggregate_algorithm_version = algorithm_version;
  SELECT COALESCE(sum(scheduled_opportunities), 0) INTO aggregate_segments
  FROM analytics.daily_segment_hour
  WHERE service_date = target_date AND aggregate_algorithm_version = algorithm_version;
  SELECT COALESCE(sum(scheduled_opportunities), 0) INTO line_journeys
  FROM analytics.daily_line_summary
  WHERE service_date = target_date AND aggregate_algorithm_version = algorithm_version;
  SELECT COALESCE(sum(scheduled_opportunities), 0) INTO network_journeys
  FROM analytics.daily_network_summary
  WHERE service_date = target_date AND aggregate_algorithm_version = algorithm_version;

  IF source_stops <> aggregate_stops THEN blockers := array_append(blockers, 'stop_opportunity_mismatch'); END IF;
  IF source_stops <> status_total THEN blockers := array_append(blockers, 'stop_status_mismatch'); END IF;
  IF pending_total <> 0 THEN blockers := array_append(blockers, 'pending_stop_status'); END IF;
  IF source_journeys <> aggregate_journeys THEN blockers := array_append(blockers, 'journey_opportunity_mismatch'); END IF;
  IF source_journeys <> line_journeys THEN blockers := array_append(blockers, 'line_journey_total_mismatch'); END IF;
  IF source_journeys <> network_journeys THEN blockers := array_append(blockers, 'network_journey_total_mismatch'); END IF;
  IF source_segments <> aggregate_segments THEN blockers := array_append(blockers, 'segment_opportunity_mismatch'); END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT aggregate_algorithm_version FROM analytics.daily_stop_call_hour WHERE service_date = target_date
      UNION ALL SELECT aggregate_algorithm_version FROM analytics.daily_journey_hour WHERE service_date = target_date
      UNION ALL SELECT aggregate_algorithm_version FROM analytics.daily_segment_hour WHERE service_date = target_date
      UNION ALL SELECT aggregate_algorithm_version FROM analytics.daily_line_summary WHERE service_date = target_date
      UNION ALL SELECT aggregate_algorithm_version FROM analytics.daily_network_summary WHERE service_date = target_date
    ) AS versions WHERE aggregate_algorithm_version <> algorithm_version
  ) THEN blockers := array_append(blockers, 'aggregate_algorithm_version_mismatch'); END IF;

  source_checksum_value := analytics.canonical_source_checksum(target_date);
  aggregate_checksum_value := analytics.daily_checksum(target_date, algorithm_version);
  IF NOT EXISTS (
    SELECT 1 FROM analytics.aggregation_run
    WHERE service_date = target_date AND family = 'daily' AND status = 'succeeded'
      AND aggregate_algorithm_version = algorithm_version
      AND source_checksum = source_checksum_value AND aggregate_checksum = aggregate_checksum_value
  ) THEN blockers := array_append(blockers, 'verified_aggregation_run_missing'); END IF;

  INSERT INTO operations.verification_result (
    scope_kind, service_date, aggregate_algorithm_version, passed,
    source_row_count, aggregate_row_count, source_checksum, aggregate_checksum, details
  ) VALUES (
    'service_day', target_date, algorithm_version, cardinality(blockers) = 0,
    source_stops, aggregate_stops, source_checksum_value, aggregate_checksum_value,
    jsonb_build_object(
      'blockers', blockers, 'sourceJourneys', source_journeys, 'sourceStops', source_stops,
      'sourceSegments', source_segments, 'aggregateJourneys', aggregate_journeys,
      'aggregateStops', aggregate_stops, 'aggregateSegments', aggregate_segments,
      'lineJourneyTotal', line_journeys, 'networkJourneyTotal', network_journeys,
      'statusTotal', status_total, 'pendingTotal', pending_total
    )
  ) RETURNING id INTO verification_id_value;

  IF cardinality(blockers) > 0 THEN
    RETURN jsonb_build_object(
      'serviceDate', target_date, 'status', 'failed', 'verificationId', verification_id_value,
      'sourceJourneyCount', source_journeys, 'sourceStopCount', source_stops,
      'sourceSegmentCount', source_segments, 'sourceChecksum', source_checksum_value,
      'aggregateChecksum', aggregate_checksum_value, 'blockers', to_jsonb(blockers)
    );
  END IF;

  INSERT INTO operations.service_day_finalization (
    service_date, aggregate_algorithm_version, status, verification_id, finalized_at,
    source_journey_count, source_stop_count, source_segment_count,
    source_checksum, aggregate_checksum, schedule_contribution_checksum
  ) VALUES (
    target_date, algorithm_version, 'verified', verification_id_value, checked_at,
    source_journeys, source_stops, source_segments, source_checksum_value, aggregate_checksum_value,
    repeat('0', 64)
  );

  schedule_result := analytics.recompute_schedule_contribution(target_date, algorithm_version);
  IF schedule_result->>'status' NOT IN ('succeeded', 'noop') THEN
    RAISE EXCEPTION 'Schedule contribution recomputation failed after service-day verification';
  END IF;
  schedule_checksum_value := analytics.schedule_contribution_checksum(target_date, algorithm_version);
  UPDATE operations.service_day_finalization
  SET schedule_contribution_checksum = schedule_checksum_value
  WHERE service_date = target_date AND aggregate_algorithm_version = algorithm_version;

  RETURN jsonb_build_object(
    'serviceDate', target_date, 'status', 'verified', 'verificationId', verification_id_value,
    'sourceJourneyCount', source_journeys, 'sourceStopCount', source_stops,
    'sourceSegmentCount', source_segments, 'sourceChecksum', source_checksum_value,
    'aggregateChecksum', aggregate_checksum_value
  );
END
$function$;

CREATE OR REPLACE FUNCTION analytics.monthly_checksum(target_month date, algorithm_version text)
RETURNS text
LANGUAGE sql
STABLE
STRICT
PARALLEL SAFE
AS $function$
  WITH rows AS (
    SELECT 'stop|' || row_to_json(value)::text AS payload
    FROM analytics.monthly_stop_schedule AS value
    WHERE calendar_month = target_month AND aggregate_algorithm_version = algorithm_version
    UNION ALL
    SELECT 'segment|' || row_to_json(value)::text FROM analytics.monthly_segment_schedule AS value
    WHERE calendar_month = target_month AND aggregate_algorithm_version = algorithm_version
    UNION ALL
    SELECT 'journey|' || row_to_json(value)::text FROM analytics.monthly_journey_schedule AS value
    WHERE calendar_month = target_month AND aggregate_algorithm_version = algorithm_version
  )
  SELECT encode(sha256(convert_to(COALESCE(string_agg(payload, E'\n' ORDER BY payload), ''), 'UTF8')), 'hex')
  FROM rows
$function$;

CREATE OR REPLACE FUNCTION operations.seal_month(
  target_month date,
  algorithm_version text,
  checked_at timestamptz,
  grace_hours integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, analytics, operations, core
AS $function$
DECLARE
  normalized_month date := date_trunc('month', target_month)::date;
  existing operations.month_seal%ROWTYPE;
  source_days integer;
  verified_days integer;
  contribution_rows bigint;
  monthly_rows bigint;
  contribution_opportunities bigint;
  monthly_opportunities bigint;
  checksum_value text;
  verification_id_value bigint;
  blockers text[] := ARRAY[]::text[];
BEGIN
  IF target_month <> normalized_month THEN
    RAISE EXCEPTION 'Month sealing requires the first day of a calendar month';
  END IF;
  IF grace_hours < 0 OR grace_hours > 168 THEN
    RAISE EXCEPTION 'Month sealing grace must be from 0 through 168 hours';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('seal-month:' || target_month::text, 0)) THEN
    RETURN jsonb_build_object('month', target_month, 'status', 'locked', 'blockers', jsonb_build_array('advisory_lock_busy'));
  END IF;
  SELECT * INTO existing FROM operations.month_seal
  WHERE calendar_month = target_month AND aggregate_algorithm_version = algorithm_version;
  IF FOUND AND existing.status = 'sealed' THEN
    RETURN jsonb_build_object(
      'month', target_month, 'status', 'already_sealed', 'serviceDays', existing.service_day_count,
      'contributionRows', existing.contribution_row_count, 'monthlyRows', existing.monthly_row_count,
      'checksum', existing.aggregate_checksum
    );
  END IF;
  IF target_month + interval '1 month' + make_interval(hours => grace_hours) > checked_at THEN
    blockers := array_append(blockers, 'month_sealing_grace_not_elapsed');
  END IF;

  SELECT count(DISTINCT service_date)::integer INTO source_days
  FROM core.journey
  WHERE service_date >= target_month AND service_date < target_month + interval '1 month';
  SELECT count(*)::integer INTO verified_days
  FROM operations.service_day_finalization
  WHERE service_date >= target_month AND service_date < target_month + interval '1 month'
    AND aggregate_algorithm_version = algorithm_version AND status = 'verified';
  IF source_days <> verified_days THEN blockers := array_append(blockers, 'not_all_service_days_verified'); END IF;
  IF EXISTS (
    SELECT 1 FROM analytics.dirty_scope
    WHERE service_date >= target_month AND service_date < target_month + interval '1 month'
  ) THEN blockers := array_append(blockers, 'month_contains_dirty_scope'); END IF;

  SELECT count(*), COALESCE(sum(scheduled_opportunities), 0)
  INTO contribution_rows, contribution_opportunities
  FROM analytics.daily_schedule_contribution
  WHERE service_date >= target_month AND service_date < target_month + interval '1 month'
    AND aggregate_algorithm_version = algorithm_version;
  IF source_days > 0 AND contribution_rows = 0 THEN blockers := array_append(blockers, 'daily_schedule_contributions_missing'); END IF;

  IF cardinality(blockers) > 0 THEN
    INSERT INTO operations.verification_result (
      scope_kind, calendar_month, aggregate_algorithm_version, passed,
      source_row_count, aggregate_row_count, details
    ) VALUES (
      'month', target_month, algorithm_version, false, contribution_rows, 0,
      jsonb_build_object('blockers', blockers, 'sourceDays', source_days, 'verifiedDays', verified_days)
    ) RETURNING id INTO verification_id_value;
    RETURN jsonb_build_object(
      'month', target_month, 'status', 'blocked', 'serviceDays', source_days,
      'contributionRows', contribution_rows, 'blockers', to_jsonb(blockers)
    );
  END IF;

  DELETE FROM analytics.monthly_stop_schedule
  WHERE calendar_month = target_month AND aggregate_algorithm_version = algorithm_version;
  DELETE FROM analytics.monthly_segment_schedule
  WHERE calendar_month = target_month AND aggregate_algorithm_version = algorithm_version;
  DELETE FROM analytics.monthly_journey_schedule
  WHERE calendar_month = target_month AND aggregate_algorithm_version = algorithm_version;

  INSERT INTO analytics.monthly_stop_schedule (
    calendar_month, weekday_class, network_id, feed_version_id, service_pattern_id, line_id, branch_id,
    direction, station_id, scheduled_arrival_seconds, scheduled_opportunities, valid_delay_observations,
    punctual_count, early_count, zero_to_two_count, over_two_to_five_count, over_five_to_ten_count,
    over_ten_to_fifteen_count, over_fifteen_count, canceled_count, skipped_count, missing_evidence_count,
    pending_count, reported_only_count, observed_presence_count, discrepancy_count, signed_delay_sum,
    squared_delay_sum, minimum_delay_seconds, maximum_delay_seconds, histogram_version, delay_histogram,
    source_coverage, aggregate_algorithm_version
  )
  SELECT target_month, weekday_class, network_id, feed_version_id, service_pattern_id, line_id, branch_id,
    direction, station_id, scheduled_seconds,
    sum(scheduled_opportunities), sum(valid_delay_observations), sum(punctual_count), sum(early_count),
    sum(zero_to_two_count), sum(over_two_to_five_count), sum(over_five_to_ten_count),
    sum(over_ten_to_fifteen_count), sum(over_fifteen_count), sum(canceled_count), sum(skipped_count),
    sum(missing_evidence_count), sum(pending_count), sum(reported_only_count), sum(observed_presence_count),
    sum(discrepancy_count), sum(signed_delay_sum), sum(squared_delay_sum), min(minimum_delay_seconds),
    max(maximum_delay_seconds), 'h30-v1', analytics.histogram_sum(delay_histogram),
    CASE WHEN sum(scheduled_opportunities) = 0 THEN 0
      ELSE (sum(valid_delay_observations)::numeric / sum(scheduled_opportunities)::numeric)::numeric(9,8) END,
    algorithm_version
  FROM analytics.daily_schedule_contribution
  WHERE service_date >= target_month AND service_date < target_month + interval '1 month'
    AND aggregate_algorithm_version = algorithm_version AND family = 'stop'
  GROUP BY weekday_class, network_id, feed_version_id, service_pattern_id, line_id, branch_id,
    direction, station_id, scheduled_seconds;

  INSERT INTO analytics.monthly_segment_schedule (
    calendar_month, weekday_class, network_id, feed_version_id, service_pattern_id, line_id, branch_id,
    direction, segment_id, upstream_scheduled_seconds, scheduled_opportunities, valid_delay_observations,
    punctual_count, early_count, zero_to_two_count, over_two_to_five_count, over_five_to_ten_count,
    over_ten_to_fifteen_count, over_fifteen_count, canceled_count, skipped_count, missing_evidence_count,
    pending_count, reported_only_count, observed_presence_count, discrepancy_count, signed_delay_sum,
    squared_delay_sum, minimum_delay_seconds, maximum_delay_seconds, histogram_version, delay_histogram,
    source_coverage, aggregate_algorithm_version
  )
  SELECT target_month, weekday_class, network_id, feed_version_id, service_pattern_id, line_id, branch_id,
    direction, segment_id, scheduled_seconds,
    sum(scheduled_opportunities), sum(valid_delay_observations), sum(punctual_count), sum(early_count),
    sum(zero_to_two_count), sum(over_two_to_five_count), sum(over_five_to_ten_count),
    sum(over_ten_to_fifteen_count), sum(over_fifteen_count), sum(canceled_count), sum(skipped_count),
    sum(missing_evidence_count), sum(pending_count), sum(reported_only_count), sum(observed_presence_count),
    sum(discrepancy_count), sum(signed_delay_sum), sum(squared_delay_sum), min(minimum_delay_seconds),
    max(maximum_delay_seconds), 'h30-v1', analytics.histogram_sum(delay_histogram),
    CASE WHEN sum(scheduled_opportunities) = 0 THEN 0
      ELSE (sum(valid_delay_observations)::numeric / sum(scheduled_opportunities)::numeric)::numeric(9,8) END,
    algorithm_version
  FROM analytics.daily_schedule_contribution
  WHERE service_date >= target_month AND service_date < target_month + interval '1 month'
    AND aggregate_algorithm_version = algorithm_version AND family = 'segment'
  GROUP BY weekday_class, network_id, feed_version_id, service_pattern_id, line_id, branch_id,
    direction, segment_id, scheduled_seconds;

  INSERT INTO analytics.monthly_journey_schedule (
    calendar_month, weekday_class, network_id, feed_version_id, service_pattern_id, line_id, branch_id,
    direction, scheduled_start_seconds, scheduled_opportunities, valid_delay_observations,
    punctual_count, early_count, zero_to_two_count, over_two_to_five_count, over_five_to_ten_count,
    over_ten_to_fifteen_count, over_fifteen_count, canceled_count, skipped_count, missing_evidence_count,
    pending_count, reported_only_count, observed_presence_count, discrepancy_count, signed_delay_sum,
    squared_delay_sum, minimum_delay_seconds, maximum_delay_seconds, histogram_version, delay_histogram,
    source_coverage, aggregate_algorithm_version
  )
  SELECT target_month, weekday_class, network_id, feed_version_id, service_pattern_id, line_id, branch_id,
    direction, scheduled_seconds,
    sum(scheduled_opportunities), sum(valid_delay_observations), sum(punctual_count), sum(early_count),
    sum(zero_to_two_count), sum(over_two_to_five_count), sum(over_five_to_ten_count),
    sum(over_ten_to_fifteen_count), sum(over_fifteen_count), sum(canceled_count), sum(skipped_count),
    sum(missing_evidence_count), sum(pending_count), sum(reported_only_count), sum(observed_presence_count),
    sum(discrepancy_count), sum(signed_delay_sum), sum(squared_delay_sum), min(minimum_delay_seconds),
    max(maximum_delay_seconds), 'h30-v1', analytics.histogram_sum(delay_histogram),
    CASE WHEN sum(scheduled_opportunities) = 0 THEN 0
      ELSE (sum(valid_delay_observations)::numeric / sum(scheduled_opportunities)::numeric)::numeric(9,8) END,
    algorithm_version
  FROM analytics.daily_schedule_contribution
  WHERE service_date >= target_month AND service_date < target_month + interval '1 month'
    AND aggregate_algorithm_version = algorithm_version AND family = 'journey'
  GROUP BY weekday_class, network_id, feed_version_id, service_pattern_id, line_id, branch_id,
    direction, scheduled_seconds;

  SELECT
    (SELECT count(*) FROM analytics.monthly_stop_schedule WHERE calendar_month = target_month AND aggregate_algorithm_version = algorithm_version) +
    (SELECT count(*) FROM analytics.monthly_segment_schedule WHERE calendar_month = target_month AND aggregate_algorithm_version = algorithm_version) +
    (SELECT count(*) FROM analytics.monthly_journey_schedule WHERE calendar_month = target_month AND aggregate_algorithm_version = algorithm_version)
  INTO monthly_rows;
  SELECT
    COALESCE((SELECT sum(scheduled_opportunities) FROM analytics.monthly_stop_schedule WHERE calendar_month = target_month AND aggregate_algorithm_version = algorithm_version), 0) +
    COALESCE((SELECT sum(scheduled_opportunities) FROM analytics.monthly_segment_schedule WHERE calendar_month = target_month AND aggregate_algorithm_version = algorithm_version), 0) +
    COALESCE((SELECT sum(scheduled_opportunities) FROM analytics.monthly_journey_schedule WHERE calendar_month = target_month AND aggregate_algorithm_version = algorithm_version), 0)
  INTO monthly_opportunities;
  IF monthly_opportunities <> contribution_opportunities THEN
    RAISE EXCEPTION 'Monthly scheduled opportunity verification failed';
  END IF;
  checksum_value := analytics.monthly_checksum(target_month, algorithm_version);

  INSERT INTO operations.verification_result (
    scope_kind, calendar_month, aggregate_algorithm_version, passed,
    source_row_count, aggregate_row_count, aggregate_checksum, details
  ) VALUES (
    'month', target_month, algorithm_version, true, contribution_rows, monthly_rows, checksum_value,
    jsonb_build_object('sourceDays', source_days, 'scheduledOpportunities', monthly_opportunities)
  ) RETURNING id INTO verification_id_value;
  INSERT INTO operations.month_seal (
    calendar_month, aggregate_algorithm_version, status, verification_id, service_day_count,
    contribution_row_count, monthly_row_count, aggregate_checksum, sealed_at
  ) VALUES (
    target_month, algorithm_version, 'sealed', verification_id_value, source_days,
    contribution_rows, monthly_rows, checksum_value, checked_at
  );
  DELETE FROM analytics.daily_schedule_contribution
  WHERE service_date >= target_month AND service_date < target_month + interval '1 month'
    AND aggregate_algorithm_version = algorithm_version;

  RETURN jsonb_build_object(
    'month', target_month, 'status', 'sealed', 'serviceDays', source_days,
    'contributionRows', contribution_rows, 'monthlyRows', monthly_rows, 'checksum', checksum_value
  );
END
$function$;

CREATE OR REPLACE FUNCTION operations.ensure_retention_partitions(target_date date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ingest, core
AS $function$
BEGIN
  PERFORM ingest.ensure_realtime_partitions(target_date);
  PERFORM ingest.ensure_realtime_partitions(target_date + 1);
  PERFORM core.ensure_journey_partitions(target_date);
  PERFORM core.ensure_journey_partitions(target_date + 1);
END
$function$;

CREATE OR REPLACE FUNCTION operations.partition_signature(retention_family text, target_date date)
RETURNS TABLE(source_rows bigint, source_checksum text, partition_names text[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, operations, analytics, core, ingest
AS $function$
DECLARE
  schema_name text;
  parent_name text;
  child_name text;
  second_child text;
  checksum_sql text;
BEGIN
  IF retention_family = 'canonical_detail' THEN
    child_name := 'journey_stop_' || to_char(target_date, 'YYYYMMDD');
    second_child := 'journey_' || to_char(target_date, 'YYYYMMDD');
    IF to_regclass(format('%I.%I', 'core', child_name)) IS NULL
      OR to_regclass(format('%I.%I', 'core', second_child)) IS NULL THEN
      RAISE EXCEPTION 'Canonical retention partitions do not exist for %', target_date;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_inherits i
      JOIN pg_class child ON child.oid = i.inhrelid
      JOIN pg_class parent ON parent.oid = i.inhparent
      JOIN pg_namespace ns ON ns.oid = child.relnamespace
      WHERE ns.nspname = 'core' AND child.relname = child_name AND parent.relname = 'journey_stop'
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_inherits i
      JOIN pg_class child ON child.oid = i.inhrelid
      JOIN pg_class parent ON parent.oid = i.inhparent
      JOIN pg_namespace ns ON ns.oid = child.relnamespace
      WHERE ns.nspname = 'core' AND child.relname = second_child AND parent.relname = 'journey'
    ) THEN RAISE EXCEPTION 'Canonical retention target is not the expected partition pair'; END IF;
    EXECUTE format('SELECT (SELECT count(*) FROM core.%I) + (SELECT count(*) FROM core.%I)', child_name, second_child)
      INTO source_rows;
    source_checksum := analytics.canonical_source_checksum(target_date);
    partition_names := ARRAY['core.' || child_name, 'core.' || second_child];
    RETURN NEXT;
    RETURN;
  END IF;

  CASE retention_family
    WHEN 'filtered_payload' THEN schema_name := 'ingest'; parent_name := 'filtered_payload';
    WHEN 'stop_evidence' THEN schema_name := 'ingest'; parent_name := 'stop_evidence';
    WHEN 'poll_run' THEN schema_name := 'ingest'; parent_name := 'poll_run';
    WHEN 'quarantined_entity' THEN schema_name := 'ingest'; parent_name := 'quarantined_entity';
    ELSE RAISE EXCEPTION 'Unknown retention family %', retention_family;
  END CASE;
  child_name := parent_name || '_' || to_char(target_date, 'YYYYMMDD');
  IF to_regclass(format('%I.%I', schema_name, child_name)) IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_inherits i
    JOIN pg_class child ON child.oid = i.inhrelid
    JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    WHERE child_ns.nspname = schema_name AND parent_ns.nspname = schema_name
      AND child.relname = child_name AND parent.relname = parent_name
  ) THEN RAISE EXCEPTION 'Retention target is not an expected % partition for %', retention_family, target_date; END IF;

  IF retention_family = 'filtered_payload' THEN
    checksum_sql := format($sql$
      SELECT count(*)::bigint,
        encode(sha256(convert_to(COALESCE(string_agg(idempotency_key || ':' || content_checksum, E'\n' ORDER BY idempotency_key), ''), 'UTF8')), 'hex')
      FROM %I.%I$sql$, schema_name, child_name);
  ELSIF retention_family = 'stop_evidence' THEN
    checksum_sql := format($sql$
      SELECT count(*)::bigint,
        encode(sha256(convert_to(COALESCE(string_agg(idempotency_key || ':' || evidence_checksum, E'\n' ORDER BY idempotency_key), ''), 'UTF8')), 'hex')
      FROM %I.%I$sql$, schema_name, child_name);
  ELSIF retention_family = 'poll_run' THEN
    checksum_sql := format($sql$
      SELECT count(*)::bigint,
        encode(sha256(convert_to(COALESCE(string_agg(idempotency_key || ':' || result_class || ':' || matched_madrid_count || ':' || unmatched_count || ':' || invalid_count, E'\n' ORDER BY idempotency_key), ''), 'UTF8')), 'hex')
      FROM %I.%I$sql$, schema_name, child_name);
  ELSE
    checksum_sql := format($sql$
      SELECT count(*)::bigint,
        encode(sha256(convert_to(COALESCE(string_agg(idempotency_key || ':' || reason_code, E'\n' ORDER BY idempotency_key), ''), 'UTF8')), 'hex')
      FROM %I.%I$sql$, schema_name, child_name);
  END IF;
  EXECUTE checksum_sql INTO source_rows, source_checksum;
  partition_names := ARRAY[schema_name || '.' || child_name];
  RETURN NEXT;
END
$function$;

CREATE OR REPLACE FUNCTION operations.summarize_operations_date(target_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, operations, ingest
AS $function$
DECLARE
  poll_rows bigint;
  quarantine_rows bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('operations-summary:' || target_date::text, 0));
  DELETE FROM operations.daily_feed_coverage WHERE service_date = target_date;
  INSERT INTO operations.daily_feed_coverage (
    service_date, feed_kind, poll_count, successful_poll_count, matched_madrid_count,
    non_madrid_count, unmatched_count, invalid_count, evidence_changed_count,
    response_bytes, first_poll_at, last_poll_at, source_checksum
  )
  SELECT target_date, feed_kind, count(*)::bigint,
    count(*) FILTER (WHERE result_class = 'success')::bigint,
    sum(matched_madrid_count)::bigint, sum(non_madrid_count)::bigint, sum(unmatched_count)::bigint,
    sum(invalid_count)::bigint, sum(evidence_changed_count)::bigint, sum(response_bytes)::bigint,
    min(captured_at), max(captured_at),
    encode(sha256(convert_to(COALESCE(string_agg(idempotency_key || ':' || result_class || ':' || matched_madrid_count || ':' || unmatched_count || ':' || invalid_count, E'\n' ORDER BY idempotency_key), ''), 'UTF8')), 'hex')
  FROM ingest.poll_run
  WHERE captured_at >= target_date::timestamptz AND captured_at < (target_date + 1)::timestamptz
  GROUP BY feed_kind;
  GET DIAGNOSTICS poll_rows = ROW_COUNT;

  DELETE FROM operations.daily_quarantine_summary WHERE service_date = target_date;
  INSERT INTO operations.daily_quarantine_summary (service_date, reason_code, entity_count, source_checksum)
  SELECT target_date, reason_code, count(*)::bigint,
    encode(sha256(convert_to(COALESCE(string_agg(idempotency_key, E'\n' ORDER BY idempotency_key), ''), 'UTF8')), 'hex')
  FROM ingest.quarantined_entity
  WHERE captured_at >= target_date::timestamptz AND captured_at < (target_date + 1)::timestamptz
  GROUP BY reason_code;
  GET DIAGNOSTICS quarantine_rows = ROW_COUNT;
  RETURN jsonb_build_object('serviceDate', target_date, 'feedRows', poll_rows, 'quarantineRows', quarantine_rows);
END
$function$;

CREATE OR REPLACE FUNCTION operations.retention_candidates(as_of timestamptz, algorithm_version text)
RETURNS TABLE(
  family text,
  target_date date,
  partition_names text[],
  expired boolean,
  authorized boolean,
  blockers text[],
  source_rows bigint,
  source_checksum text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, operations, analytics, core, ingest
AS $function$
DECLARE
  item record;
  signature record;
  candidate_date date;
  candidate_expired boolean;
  candidate_blockers text[];
  candidate_authorized boolean;
  finalization operations.service_day_finalization%ROWTYPE;
  evidence_uncanonicalized bigint;
  child_name text;
BEGIN
  FOR item IN
    WITH parents(schema_name, parent_name, family_name) AS (
      VALUES
        ('ingest'::text, 'filtered_payload'::text, 'filtered_payload'::text),
        ('ingest', 'stop_evidence', 'stop_evidence'),
        ('ingest', 'poll_run', 'poll_run'),
        ('ingest', 'quarantined_entity', 'quarantined_entity')
    )
    SELECT parents.family_name, parents.parent_name, child.relname AS child_name,
      to_date(substring(child.relname FROM '([0-9]{8})$'), 'YYYYMMDD') AS partition_date
    FROM parents
    JOIN pg_namespace parent_ns ON parent_ns.nspname = parents.schema_name
    JOIN pg_class parent ON parent.relnamespace = parent_ns.oid AND parent.relname = parents.parent_name
    JOIN pg_inherits inheritance ON inheritance.inhparent = parent.oid
    JOIN pg_class child ON child.oid = inheritance.inhrelid
    WHERE child.relname ~ ('^' || parents.parent_name || '_[0-9]{8}$')
    ORDER BY partition_date, parents.family_name
  LOOP
    family := item.family_name;
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
      EXECUTE format($sql$
        SELECT count(*) FROM ingest.%I AS evidence
        WHERE evidence.service_date IS NULL OR NOT EXISTS (
          SELECT 1 FROM core.journey AS journey
          WHERE journey.service_date = evidence.service_date
            AND journey.feed_version_id = evidence.feed_version_id
            AND journey.source_trip_id = evidence.source_trip_id
            AND journey.start_time IS NOT DISTINCT FROM evidence.start_time
        )$sql$, child_name) INTO evidence_uncanonicalized;
      IF evidence_uncanonicalized > 0 THEN candidate_blockers := array_append(candidate_blockers, 'uncanonicalized_evidence'); END IF;
    ELSIF family = 'poll_run' AND source_rows > 0 THEN
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
  END LOOP;

  FOR item IN
    SELECT child.relname AS child_name,
      to_date(substring(child.relname FROM '([0-9]{8})$'), 'YYYYMMDD') AS partition_date
    FROM pg_namespace parent_ns
    JOIN pg_class parent ON parent.relnamespace = parent_ns.oid AND parent.relname = 'journey'
    JOIN pg_inherits inheritance ON inheritance.inhparent = parent.oid
    JOIN pg_class child ON child.oid = inheritance.inhrelid
    WHERE parent_ns.nspname = 'core' AND child.relname ~ '^journey_[0-9]{8}$'
    ORDER BY partition_date
  LOOP
    family := 'canonical_detail'; target_date := item.partition_date; candidate_blockers := ARRAY[]::text[];
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
    IF NOT FOUND THEN
      candidate_blockers := array_append(candidate_blockers, 'service_day_not_verified');
    ELSE
      IF finalization.source_checksum <> analytics.canonical_source_checksum(target_date) THEN
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
  END LOOP;
END
$function$;

CREATE OR REPLACE FUNCTION operations.authorize_retention_partition(
  retention_family text,
  target_date date,
  as_of timestamptz,
  algorithm_version text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, operations, analytics
AS $function$
DECLARE
  candidate record;
  finalization operations.service_day_finalization%ROWTYPE;
  verification_id_value bigint;
  aggregate_checksum_value text;
  authorization_checksum_value text;
  ledger_id bigint;
  remaining_blockers text[];
BEGIN
  SELECT candidate_row.* INTO candidate
  FROM operations.retention_candidates(as_of, algorithm_version) AS candidate_row
  WHERE candidate_row.family = retention_family
    AND candidate_row.target_date = authorize_retention_partition.target_date;
  IF NOT FOUND THEN RAISE EXCEPTION 'No known retention candidate % for %', retention_family, target_date; END IF;
  remaining_blockers := array_remove(candidate.blockers, 'authorization_missing');
  IF cardinality(remaining_blockers) > 0 THEN
    RAISE EXCEPTION 'Retention authorization blocked for % %: %', retention_family, target_date, remaining_blockers;
  END IF;
  IF retention_family = 'canonical_detail' THEN
    SELECT * INTO finalization FROM operations.service_day_finalization
    WHERE service_date = target_date AND aggregate_algorithm_version = algorithm_version AND status = 'verified';
    verification_id_value := finalization.verification_id;
    aggregate_checksum_value := finalization.aggregate_checksum;
  ELSE
    verification_id_value := NULL; aggregate_checksum_value := NULL;
  END IF;
  authorization_checksum_value := encode(sha256(convert_to(
    retention_family || '|' || target_date::text || '|' || array_to_string(candidate.partition_names, ',') || '|' ||
    candidate.source_rows || '|' || candidate.source_checksum || '|' || COALESCE(aggregate_checksum_value, '') || '|' || algorithm_version,
    'UTF8')), 'hex');
  INSERT INTO operations.retention_ledger (
    family, target_date, partition_names, aggregate_algorithm_version,
    source_row_count, source_checksum, aggregate_checksum, verification_id, authorization_checksum
  ) VALUES (
    retention_family, target_date, candidate.partition_names, algorithm_version,
    candidate.source_rows, candidate.source_checksum, aggregate_checksum_value,
    verification_id_value, authorization_checksum_value
  ) ON CONFLICT (family, target_date, aggregate_algorithm_version, authorization_checksum)
    DO UPDATE SET authorized_at = clock_timestamp(), revoked_at = NULL
  RETURNING id INTO ledger_id;
  RETURN ledger_id;
END
$function$;

CREATE OR REPLACE FUNCTION operations.drop_retention_partition(
  retention_family text,
  target_date date,
  as_of timestamptz,
  algorithm_version text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, operations, analytics, core, ingest
AS $function$
DECLARE
  candidate record;
  ledger operations.retention_ledger%ROWTYPE;
  dropped_rows bigint;
  partition_name text;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('retention:' || retention_family || ':' || target_date::text, 0)) THEN
    RETURN jsonb_build_object('status', 'locked', 'family', retention_family, 'targetDate', target_date);
  END IF;
  SELECT candidate_row.* INTO candidate
  FROM operations.retention_candidates(as_of, algorithm_version) AS candidate_row
  WHERE candidate_row.family = retention_family
    AND candidate_row.target_date = drop_retention_partition.target_date;
  IF NOT FOUND THEN RAISE EXCEPTION 'No known retention candidate % for %', retention_family, target_date; END IF;
  IF cardinality(candidate.blockers) > 0 THEN
    RAISE EXCEPTION 'Retention drop blocked for % %: %', retention_family, target_date, candidate.blockers;
  END IF;
  SELECT retention.* INTO ledger
  FROM operations.retention_ledger AS retention
  WHERE retention.family = retention_family
    AND retention.target_date = drop_retention_partition.target_date
    AND retention.aggregate_algorithm_version = algorithm_version
    AND retention.source_checksum = candidate.source_checksum
    AND retention.applied_at IS NULL AND retention.revoked_at IS NULL
  ORDER BY retention.authorized_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Authorizing retention ledger entry is required'; END IF;
  dropped_rows := ledger.source_row_count;

  IF retention_family = 'canonical_detail' THEN
    EXECUTE format('DROP TABLE core.%I', 'journey_stop_' || to_char(target_date, 'YYYYMMDD'));
    EXECUTE format('DROP TABLE core.%I', 'journey_' || to_char(target_date, 'YYYYMMDD'));
  ELSE
    partition_name := retention_family || '_' || to_char(target_date, 'YYYYMMDD');
    EXECUTE format('DROP TABLE ingest.%I', partition_name);
  END IF;
  UPDATE operations.retention_ledger
  SET applied_at = clock_timestamp(), dropped_row_count = dropped_rows
  WHERE id = ledger.id;
  RETURN jsonb_build_object(
    'status', 'dropped', 'family', retention_family, 'targetDate', target_date,
    'partitionNames', to_jsonb(ledger.partition_names), 'droppedRows', dropped_rows
  );
END
$function$;

CREATE OR REPLACE FUNCTION operations.cleanup_live_vehicle_state(
  as_of timestamptz,
  grace_seconds integer,
  apply_cleanup boolean
)
RETURNS TABLE(candidates bigint, deleted bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, operations, ingest, core
AS $function$
BEGIN
  IF grace_seconds < 0 OR grace_seconds > 86400 THEN
    RAISE EXCEPTION 'Live-state grace must be from 0 through 86400 seconds';
  END IF;
  SELECT count(*) INTO candidates
  FROM ingest.live_vehicle_state state
  WHERE EXISTS (
    SELECT 1 FROM core.journey journey
    WHERE journey.service_date = state.service_date
      AND journey.feed_version_id = state.feed_version_id
      AND journey.source_trip_id = state.source_trip_id
      AND journey.start_time IS NOT DISTINCT FROM state.start_time
      AND journey.finalized_at IS NOT NULL
      AND journey.finalized_at + make_interval(secs => grace_seconds) <= as_of
  );
  deleted := 0;
  IF apply_cleanup THEN
    DELETE FROM ingest.live_vehicle_state state
    WHERE EXISTS (
      SELECT 1 FROM core.journey journey
      WHERE journey.service_date = state.service_date
        AND journey.feed_version_id = state.feed_version_id
        AND journey.source_trip_id = state.source_trip_id
        AND journey.start_time IS NOT DISTINCT FROM state.start_time
        AND journey.finalized_at IS NOT NULL
        AND journey.finalized_at + make_interval(secs => grace_seconds) <= as_of
    );
    GET DIAGNOSTICS deleted = ROW_COUNT;
  END IF;
  RETURN NEXT;
END
$function$;

CREATE OR REPLACE VIEW operations.aggregation_health
WITH (security_invoker = true)
AS
SELECT
  (SELECT count(*) FROM analytics.dirty_scope WHERE family = 'daily') AS dirty_daily_scopes,
  (SELECT count(*) FROM analytics.dirty_scope WHERE family = 'schedule') AS dirty_schedule_scopes,
  (SELECT min(dirty_since) FROM analytics.dirty_scope) AS oldest_dirty_since,
  (SELECT max(completed_at) FROM analytics.aggregation_run WHERE status = 'succeeded') AS latest_successful_aggregate_at,
  (SELECT max(finalized_at) FROM operations.service_day_finalization WHERE status = 'verified') AS latest_verified_service_day_at,
  (SELECT max(sealed_at) FROM operations.month_seal WHERE status = 'sealed') AS latest_month_sealed_at;

REVOKE ALL ON ALL TABLES IN SCHEMA analytics FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA analytics FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA analytics FROM PUBLIC;
REVOKE ALL ON operations.verification_result, operations.service_day_finalization,
  operations.month_seal, operations.daily_feed_coverage, operations.daily_quarantine_summary,
  operations.retention_ledger, operations.aggregation_health FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.ensure_retention_partitions(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.partition_signature(text, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.summarize_operations_date(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.retention_candidates(timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.authorize_retention_partition(text, date, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.drop_retention_partition(text, date, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.cleanup_live_vehicle_state(timestamptz, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.finalize_service_day(date, text, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION operations.seal_month(date, text, timestamptz, integer) FROM PUBLIC;

GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO atodotren_ingest_writer;
GRANT SELECT ON operations.verification_result, operations.service_day_finalization,
  operations.month_seal, operations.daily_feed_coverage, operations.daily_quarantine_summary,
  operations.retention_ledger, operations.aggregation_health TO atodotren_ingest_writer;
GRANT EXECUTE ON FUNCTION analytics.mark_dirty(date, text) TO atodotren_ingest_writer;
GRANT EXECUTE ON FUNCTION analytics.recompute_daily(date, text) TO atodotren_ingest_writer;
GRANT EXECUTE ON FUNCTION analytics.canonical_source_checksum(date) TO atodotren_ingest_writer;
GRANT EXECUTE ON FUNCTION analytics.daily_checksum(date, text) TO atodotren_ingest_writer;
GRANT EXECUTE ON FUNCTION analytics.schedule_contribution_checksum(date, text) TO atodotren_ingest_writer;
GRANT EXECUTE ON FUNCTION analytics.recompute_schedule_contribution(date, text) TO atodotren_ingest_writer;
GRANT EXECUTE ON FUNCTION operations.ensure_retention_partitions(date) TO atodotren_ingest_writer;
GRANT EXECUTE ON FUNCTION operations.summarize_operations_date(date) TO atodotren_ingest_writer;
GRANT EXECUTE ON FUNCTION operations.retention_candidates(timestamptz, text) TO atodotren_ingest_writer;
GRANT EXECUTE ON FUNCTION operations.authorize_retention_partition(text, date, timestamptz, text) TO atodotren_ingest_writer;
GRANT EXECUTE ON FUNCTION operations.drop_retention_partition(text, date, timestamptz, text) TO atodotren_ingest_writer;
GRANT EXECUTE ON FUNCTION operations.cleanup_live_vehicle_state(timestamptz, integer, boolean) TO atodotren_ingest_writer;
GRANT EXECUTE ON FUNCTION operations.finalize_service_day(date, text, timestamptz, integer) TO atodotren_ingest_writer;
GRANT EXECUTE ON FUNCTION operations.seal_month(date, text, timestamptz, integer) TO atodotren_ingest_writer;

GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO atodotren_backup_reader;
GRANT SELECT ON operations.verification_result, operations.service_day_finalization,
  operations.month_seal, operations.daily_feed_coverage, operations.daily_quarantine_summary,
  operations.retention_ledger, operations.aggregation_health TO atodotren_backup_reader;
GRANT SELECT ON operations.aggregation_health TO atodotren_monitor_reader;
GRANT USAGE ON SCHEMA analytics TO atodotren_monitor_reader;

ALTER DEFAULT PRIVILEGES FOR ROLE atodotren_migration_admin IN SCHEMA analytics
  REVOKE ALL ON TABLES FROM atodotren_ingest_writer;
ALTER DEFAULT PRIVILEGES FOR ROLE atodotren_migration_admin IN SCHEMA analytics
  REVOKE ALL ON SEQUENCES FROM atodotren_ingest_writer;

-- Dirty tracking is statement-level, not row-level. Transition tables collect every
-- affected service date once and the upsert participates in the canonical write transaction.
CREATE OR REPLACE FUNCTION analytics.mark_canonical_insert_dirty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, analytics, operations
AS $function$
BEGIN
  INSERT INTO analytics.dirty_scope (service_date, family, reason)
  SELECT DISTINCT changed.service_date, family.value, 'canonical-insert'
  FROM new_rows AS changed
  CROSS JOIN (VALUES ('daily'::text), ('schedule'::text)) AS family(value)
  ON CONFLICT (service_date, family) DO UPDATE SET
    dirty_since = LEAST(analytics.dirty_scope.dirty_since, EXCLUDED.dirty_since),
    generation = analytics.dirty_scope.generation + 1,
    reason = EXCLUDED.reason;
  UPDATE operations.retention_ledger ledger
  SET revoked_at = clock_timestamp()
  WHERE ledger.family = 'canonical_detail' AND ledger.applied_at IS NULL AND ledger.revoked_at IS NULL
    AND ledger.target_date IN (SELECT DISTINCT service_date FROM new_rows);
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION analytics.mark_canonical_update_dirty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, analytics, operations
AS $function$
BEGIN
  INSERT INTO analytics.dirty_scope (service_date, family, reason)
  SELECT DISTINCT changed.service_date, family.value, 'canonical-update'
  FROM (
    SELECT service_date FROM new_rows UNION SELECT service_date FROM old_rows
  ) AS changed
  CROSS JOIN (VALUES ('daily'::text), ('schedule'::text)) AS family(value)
  ON CONFLICT (service_date, family) DO UPDATE SET
    dirty_since = LEAST(analytics.dirty_scope.dirty_since, EXCLUDED.dirty_since),
    generation = analytics.dirty_scope.generation + 1,
    reason = EXCLUDED.reason;
  UPDATE operations.retention_ledger ledger
  SET revoked_at = clock_timestamp()
  WHERE ledger.family = 'canonical_detail' AND ledger.applied_at IS NULL AND ledger.revoked_at IS NULL
    AND ledger.target_date IN (
      SELECT service_date FROM new_rows UNION SELECT service_date FROM old_rows
    );
  RETURN NULL;
END
$function$;

CREATE TRIGGER journey_aggregate_dirty_insert
AFTER INSERT ON core.journey
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION analytics.mark_canonical_insert_dirty();
CREATE TRIGGER journey_aggregate_dirty_update
AFTER UPDATE ON core.journey
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION analytics.mark_canonical_update_dirty();
CREATE TRIGGER journey_stop_aggregate_dirty_insert
AFTER INSERT ON core.journey_stop
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION analytics.mark_canonical_insert_dirty();
CREATE TRIGGER journey_stop_aggregate_dirty_update
AFTER UPDATE ON core.journey_stop
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION analytics.mark_canonical_update_dirty();

REVOKE ALL ON FUNCTION analytics.mark_canonical_insert_dirty() FROM PUBLIC;
REVOKE ALL ON FUNCTION analytics.mark_canonical_update_dirty() FROM PUBLIC;
