import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  defaultStaticImportLimits,
  hashServicePattern,
  normalizeMadridGtfs,
  renfeMadridMapping,
  StaticImportError,
} from '@atodotren/gtfs-static';

const fixtureDirectory = resolve('tests/fixtures/gtfs-static/representative');
const fixtureFiles = () => new Map(
  ['agency.txt', 'routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt', 'calendar.txt', 'shapes.txt']
    .map((name) => [name, join(fixtureDirectory, name)]),
);

void test('representative fixture retains only explicitly mapped Madrid facts and builds deterministic topology', async () => {
  const feed = await normalizeMadridGtfs(fixtureFiles(), {
    ...renfeMadridMapping,
    canaries: {
      requiredLineCodes: ['C-1'],
      requiredStationPublicIds: ['atocha', 'aeropuerto-t4'],
      minimumStations: 3,
      minimumTrips: 1,
      requireReferencedShapes: true,
    },
  }, defaultStaticImportLimits);
  assert.deepEqual(feed.retained, {
    routes: 1,
    trips: 1,
    stops: 3,
    stopTimes: 4,
    calendarServices: 1,
    calendarExceptions: 0,
    shapes: 1,
    shapePoints: 3,
  });
  assert.equal(feed.discarded.routes, 1);
  assert.equal(feed.discarded.trips, 3);
  assert.equal(feed.discarded.stopTimes, 3);
  assert.equal(feed.trips[0]?.directionId, null);
  assert.deepEqual(feed.stopTimes.map((item) => item.arrivalSeconds), [86_399, 87_300, 90_000, 90_960]);
  assert.equal(feed.patterns.length, 1);
  assert.equal(feed.patterns[0]?.hash, hashServicePattern(['atocha', 'nuevos-ministerios', 'aeropuerto-t4']));
  assert.deepEqual(feed.patterns[0]?.stationPublicIds, ['atocha', 'nuevos-ministerios', 'aeropuerto-t4']);
  assert.equal(feed.branches.length, 1);
  assert.ok(feed.warnings.some((warning) => /Discarded 2 Madrid trip records/u.test(warning)));
  assert.ok(feed.warnings.some((warning) => /direction_id absent/u.test(warning)));
  assert.ok(feed.warnings.some((warning) => /Collapsed 1 consecutive duplicate canonical-station call/u.test(warning)));
});

void test('Madrid mapping rejects ambiguous route candidates', async () => {
  await assert.rejects(
    normalizeMadridGtfs(fixtureFiles(), {
      ...renfeMadridMapping,
      routeRules: [...renfeMadridMapping.routeRules, { ...renfeMadridMapping.routeRules[0]!, id: 'duplicate-rule' }],
    }, defaultStaticImportLimits),
    (error) => error instanceof StaticImportError && error.code === 'mapping.route.ambiguous',
  );
});
