-- Frontend alpha: align SQL search normalization with the public web alias rules.

SET LOCAL ROLE atodotren_migration_admin;

CREATE OR REPLACE FUNCTION api.normalize_search(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $function$
  SELECT regexp_replace(
    translate(lower(value),
      'áàäâãåéèëêíìïîóòöôõúùüûñç',
      'aaaaaaeeeeiiiiooooouuuunc'),
    '[^a-z0-9]+', '', 'g'
  )
$function$;
