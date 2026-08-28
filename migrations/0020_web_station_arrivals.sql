-- Live station arrivals: expose only trains present in the latest successful vehicle-position snapshot.
-- Existing migrations are immutable; this migration extends the public web read model only.

SET LOCAL ROLE atodotren_migration_admin;

CREATE VIEW api.upcoming_station_live_vehicle
WITH (security_barrier = true)
AS
WITH latest_vehicle_poll AS (
  SELECT poll.captured_at
  FROM ingest.poll_run AS poll
  WHERE poll.feed_kind = 'vehicle_positions'
    AND poll.result_class = 'success'
  ORDER BY poll.captured_at DESC, poll.id DESC
  LIMIT 1
)
SELECT
  vehicle.*,
  target_station.public_id AS target_station_id,
  target_station.slug_es AS target_station_slug_es,
  target_station.slug_en AS target_station_slug_en,
  target_station.name_es AS target_station_name_es,
  target_station.name_en AS target_station_name_en,
  target_stop.stop_sequence AS target_stop_sequence,
  target_stop.scheduled_arrival_at AS station_scheduled_arrival_at,
  target_stop.scheduled_arrival_at
    + make_interval(secs => COALESCE(vehicle.latest_usable_delay, vehicle.latest_stop_delay, 0))
      AS station_expected_arrival_at
FROM api.active_live_vehicle AS vehicle
JOIN latest_vehicle_poll AS latest_poll
  ON latest_poll.captured_at = vehicle.captured_at
JOIN core.journey_stop AS target_stop
  ON target_stop.service_date = vehicle.service_date
  AND target_stop.journey_id = vehicle.journey_id
JOIN core.station AS target_station
  ON target_station.id = target_stop.station_id
WHERE vehicle.current_stop_sequence IS NOT NULL
  AND target_stop.scheduled_arrival_at IS NOT NULL
  AND target_stop.evidence_status NOT IN ('skipped', 'canceled')
  AND (
    (vehicle.current_status = 'STOPPED_AT' AND target_stop.stop_sequence > vehicle.current_stop_sequence)
    OR (
      vehicle.current_status IN ('INCOMING_AT', 'IN_TRANSIT_TO', 'UNKNOWN')
      AND target_stop.stop_sequence >= vehicle.current_stop_sequence
    )
  );

REVOKE ALL ON api.upcoming_station_live_vehicle FROM PUBLIC;
GRANT SELECT ON api.upcoming_station_live_vehicle TO atodotren_web_reader;
