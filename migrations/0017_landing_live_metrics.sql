-- Landing live metrics: current active delay and a half-hour cumulative delay timeline.
-- Existing migrations are immutable; this adds the bounded public read model required by the landing page.
-- Each journey contributes its latest usable positive delay at each point in time; early running never cancels delay elsewhere.

SET LOCAL ROLE atodotren_migration_admin;

CREATE OR REPLACE FUNCTION api.landing_delay_timeline(
  requested_network_slug text,
  requested_at timestamptz DEFAULT clock_timestamp()
)
RETURNS TABLE (
  bucket_at timestamptz,
  accumulated_delay_seconds bigint,
  current_total_delay_seconds bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, core
AS $function$
  WITH target AS (
    SELECT
      network.id AS network_id,
      network.timezone,
      (requested_at AT TIME ZONE network.timezone)::date AS service_date
    FROM core.network AS network
    WHERE network.slug = requested_network_slug AND network.is_active
    LIMIT 1
  ), bounds AS (
    SELECT
      ((target.service_date::timestamp + interval '5 hours') AT TIME ZONE target.timezone) AS starts_at,
      ((target.service_date::timestamp + interval '1 day 2 hours') AT TIME ZONE target.timezone) AS ends_at
    FROM target
  ), buckets AS (
    SELECT generate_series(bounds.starts_at, bounds.ends_at, interval '30 minutes') AS bucket_at
    FROM bounds
  ), evidence AS (
    SELECT
      journey.id AS journey_id,
      stop.stop_sequence,
      stop.evidence_selected_captured_at AS observed_at,
      greatest(stop.selected_delay_seconds, 0)::bigint AS delay_seconds
    FROM target
    JOIN core.journey AS journey
      ON journey.network_id = target.network_id
      AND journey.service_date = target.service_date
    JOIN core.journey_stop AS stop
      ON stop.service_date = journey.service_date
      AND stop.journey_id = journey.id
    WHERE stop.evidence_status IN ('reported_only', 'observed_presence')
      AND stop.selected_delay_seconds IS NOT NULL
      AND stop.evidence_selected_captured_at IS NOT NULL
  ), evidence_intervals AS (
    SELECT
      evidence.journey_id,
      evidence.observed_at,
      lead(evidence.observed_at) OVER (
        PARTITION BY evidence.journey_id
        ORDER BY evidence.observed_at, evidence.stop_sequence
      ) AS next_observed_at,
      evidence.delay_seconds
    FROM evidence
  ), current_total AS (
    SELECT coalesce(sum(evidence_intervals.delay_seconds), 0)::bigint AS total
    FROM evidence_intervals
    WHERE evidence_intervals.observed_at <= requested_at
      AND (evidence_intervals.next_observed_at > requested_at OR evidence_intervals.next_observed_at IS NULL)
  ), bucket_totals AS (
    SELECT buckets.bucket_at, sum(evidence_intervals.delay_seconds)::bigint AS total
    FROM buckets
    JOIN evidence_intervals
      ON evidence_intervals.observed_at <= buckets.bucket_at
      AND (evidence_intervals.next_observed_at > buckets.bucket_at OR evidence_intervals.next_observed_at IS NULL)
    WHERE buckets.bucket_at <= requested_at
    GROUP BY buckets.bucket_at
  )
  SELECT
    buckets.bucket_at,
    CASE
      WHEN buckets.bucket_at > requested_at THEN NULL
      ELSE coalesce(bucket_totals.total, 0)::bigint
    END AS accumulated_delay_seconds,
    current_total.total AS current_total_delay_seconds
  FROM buckets
  CROSS JOIN current_total
  LEFT JOIN bucket_totals ON bucket_totals.bucket_at = buckets.bucket_at
  ORDER BY buckets.bucket_at
$function$;

REVOKE ALL ON FUNCTION api.landing_delay_timeline(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.landing_delay_timeline(text, timestamptz) TO atodotren_web_reader;
