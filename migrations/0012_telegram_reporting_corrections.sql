-- Pilot reporting corrections: permit the reporting lookup views to execute their
-- immutable text normalizer. Migration 0009 intentionally revoked PUBLIC access.

SET LOCAL ROLE atodotren_migration_admin;

GRANT EXECUTE ON FUNCTION operations.report_normalize(text)
TO atodotren_reporting_reader;
