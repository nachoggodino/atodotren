import { createServer } from 'node:http';

import { protobufTypes } from '@atodotren/gtfs-realtime';

const port = Number(process.env.FAKE_FEED_PORT ?? '4010');
let tripRequests = 0;

function message(entity: readonly object[]): Uint8Array {
  return protobufTypes.FeedMessage.encode({
    header: { gtfsRealtimeVersion: '2.0', timestamp: Math.floor(Date.now() / 1_000) },
    entity: [...entity] as never,
  }).finish();
}

const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
    return;
  }
  let body: Uint8Array | undefined;
  if (request.url === '/trip_updates.pb') {
    tripRequests += 1;
    const delay = tripRequests < 3 ? -30 : 90;
    body = message([
      {
        id: 'madrid-trip-update',
        tripUpdate: {
          trip: { tripId: '10TRIP-A', routeId: '10T0001C1' },
          timestamp: Math.floor(Date.now() / 1_000),
          stopTimeUpdate: [
            { stopSequence: 1, stopId: '10STOP-A', arrival: { delay } },
            { stopSequence: 2, stopId: '10STOP-B', scheduleRelationship: 1 },
          ],
        },
      },
      {
        id: 'national-trip-update',
        tripUpdate: { trip: { tripId: '20TRIP-A', routeId: '20T0001C1' }, stopTimeUpdate: [] },
      },
    ]);
  } else if (request.url === '/vehicle_positions.pb') {
    body = message([{
      id: 'madrid-vehicle',
      vehicle: {
        trip: { tripId: '10TRIP-A', routeId: '10T0001C1' }, vehicle: { id: 'fake-vehicle' },
        timestamp: Math.floor(Date.now() / 1_000), currentStatus: 1,
        currentStopSequence: 1, stopId: '10STOP-A',
        position: { latitude: 40.406, longitude: -3.689, speed: 0 },
      },
    }]);
  } else if (request.url === '/alerts.pb') {
    body = message([{
      id: 'madrid-alert',
      alert: {
        informedEntity: [{ routeId: '10T0001C1', stopId: '10STOP-A' }],
        headerText: { translation: [{ text: 'Incidencia de prueba', language: 'es' }] },
        descriptionText: { translation: [{ text: 'Alerta determinista local', language: 'es' }] },
      },
    }]);
  }
  if (body === undefined) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, {
    'content-type': 'application/x-protobuf',
    'content-length': String(body.byteLength),
  });
  response.end(body);
});

server.listen(port, '0.0.0.0');

const stop = (): void => {
  server.close(() => process.exit(0));
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
