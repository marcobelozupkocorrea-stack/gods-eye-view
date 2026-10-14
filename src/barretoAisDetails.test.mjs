import assert from 'node:assert/strict';
import test from 'node:test';
import { ingestAisStreamEnvelope, readAisVesselDetails } from '../server/providers/vessels/ais-store.js';

test('static and position extras are kept per MMSI', () => {
  const now = new Date().toISOString();
  ingestAisStreamEnvelope({
    MessageType: 'ShipStaticData',
    MetaData: { MMSI: 710999001, ShipName: 'TESTE', time_utc: now },
    Message: {
      ShipStaticData: {
        UserID: 710999001,
        Name: 'TESTE',
        CallSign: 'PP01',
        Dimension: { A: 80, B: 20, C: 8, D: 8 },
        MaximumStaticDraught: 6.2,
        Eta: { Month: 0, Day: 0, Hour: 24, Minute: 60 },
        Destination: 'RIO',
        Type: 60,
        MessageID: 5,
      },
    },
  });
  ingestAisStreamEnvelope({
    MessageType: 'PositionReport',
    MetaData: {
      MMSI: 710999001,
      latitude: -22.9,
      longitude: -43.1,
      time_utc: now,
    },
    Message: {
      PositionReport: {
        UserID: 710999001,
        Latitude: -22.9,
        Longitude: -43.1,
        Sog: 9,
        Cog: 90,
        TrueHeading: 91,
        NavigationalStatus: 5,
        MessageID: 1,
      },
    },
  });
  const d = readAisVesselDetails('710999001');
  assert.equal(d.callSign, 'PP01');
  assert.equal(d.lengthM, 100);
  assert.equal(d.beamM, 16);
  assert.equal(d.draughtM, 6.2);
  assert.equal(d.eta, undefined, 'month 0 means "no ETA"');
  assert.equal(d.navStatus, 'Atracado');
  assert.equal(d.aisClass, 'A');
  assert.equal(d.lat, -22.9);
  assert.equal(readAisVesselDetails('123456789'), null);
});
