import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAP_SEVERITY,
  parseAtomCapEntries,
  parseCapAlert,
} from './capAlerts.js';
import { buildAlertCard } from '../layers/alerts/cards.js';

// Shapes taken from the national IDAP feed (idapfile.mdr.gov.br/idap/api/rss/cap):
// an Atom feed whose entries embed a CAP 1.2 <alert>, either with a default
// namespace or with a prefix.
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <title>Rss Idap</title>
  <entry>
    <title>CHUVAS INTENSAS</title>
    <id>193467/2026</id>
    <content type="text/xml">
      <alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
        <identifier>193467/2026</identifier>
        <sender>CENAD-SEDEC</sender>
        <sent>2026-10-13T08:53:06-03:00</sent>
        <status>Actual</status>
        <msgType>Alert</msgType>
        <scope>Public</scope>
        <info>
          <event>CHUVAS INTENSAS</event>
          <severity>Severe</severity>
          <onset>2026-10-13T08:53:06-03:00</onset>
          <expires>2026-10-13T21:00:00-03:00</expires>
          <senderName>Defesa Civil Estadual de Goiás</senderName>
          <headline>Defesa Civil:Chuvas Intensas: risco de alagamento e raios. Emergencia 193</headline>
          <instruction>Evite transitar em áreas alagadas.</instruction>
          <area>
            <areaDesc>GOIÁS/GO</areaDesc>
            <polygon>-16.1,-49.1 -16.1,-49.0 -16.0,-49.0 -16.0,-49.1 -16.1,-49.1</polygon>
            <polygon>-17.1,-50.1 -17.1,-50.0 -17.0,-50.0 -17.1,-50.1</polygon>
          </area>
          <area>
            <areaDesc>GOIÁS/GO</areaDesc>
            <polygon>-15.123456,-48.987654 -15.1,-48.9 -15.0,-48.9</polygon>
          </area>
        </info>
      </alert>
    </content>
  </entry>
  <entry>
    <id>180470/2026</id>
    <content type="text/xml">
      <ns2:alert xmlns:ns2="urn:oasis:names:tc:emergency:cap:1.2">
        <ns2:identifier>180470/2026</ns2:identifier>
        <ns2:status>Actual</ns2:status>
        <ns2:msgType>Alert</ns2:msgType>
        <ns2:info>
          <ns2:event>CHUVAS INTENSAS</ns2:event>
          <ns2:severity>Extreme</ns2:severity>
          <ns2:expires>2026-06-08T21:00:00-03:00</ns2:expires>
          <ns2:area>
            <ns2:areaDesc>ESPÍRITO SANTO/ES</ns2:areaDesc>
            <ns2:polygon>-20.9,-41.5 -20.9,-41.4 -20.8,-41.4 -20.9,-41.5</ns2:polygon>
          </ns2:area>
        </ns2:info>
      </ns2:alert>
    </content>
  </entry>
  <entry><id>no-alert</id><content>nothing here</content></entry>
</feed>`;

test('IDAP Atom entries yield embedded CAP alerts with their identifiers', () => {
  const entries = parseAtomCapEntries(FEED);
  assert.deepEqual(
    entries.map((e) => e.id),
    ['193467/2026', '180470/2026'],
  );
  assert.match(entries[1].xml, /^<ns2:alert/);
});

test('Defesa Civil alerts parse with sender, all polygons and generic grades', () => {
  const [entry] = parseAtomCapEntries(FEED);
  const row = parseCapAlert(entry.xml, entry.id);
  assert.equal(row.event, 'CHUVAS INTENSAS');
  assert.equal(row.severityLabel, 'Severo');
  assert.equal(row.color, CAP_SEVERITY.Severe.color);
  assert.equal(row.senderName, 'Defesa Civil Estadual de Goiás');
  assert.equal(row.areaDesc, 'GOIÁS/GO', 'repeated area names collapse');
  assert.equal(row.polygons.length, 3);
  assert.deepEqual(row.polygons[2][0][0], [-48.9877, -15.1235], 'rounded');
});

test('Prefixed CAP alerts parse the same way', () => {
  const [, entry] = parseAtomCapEntries(FEED);
  const row = parseCapAlert(entry.xml, entry.id);
  assert.equal(row.severityLabel, 'Extremo');
  assert.equal(row.areaDesc, 'ESPÍRITO SANTO/ES');
  assert.equal(row.polygons.length, 1);
});

test('Ring budget is honoured per alert', () => {
  const ring = Array.from(
    { length: 900 },
    (_, i) => `${-10 - i / 1000},${-50 + Math.sin(i) / 10}`,
  ).join(' ');
  const xml = `<alert><status>Actual</status><msgType>Alert</msgType><info><severity>Moderate</severity><area><polygon>${ring}</polygon></area></info></alert>`;
  const row = parseCapAlert(xml, 'x', { maxRingVertices: 250 });
  assert.equal(row.polygons[0][0].length, 250);
});

test('Defesa Civil card credits the issuing state and strips the prefix', () => {
  const [entry] = parseAtomCapEntries(FEED);
  const row = parseCapAlert(entry.xml, entry.id);
  const card = buildAlertCard(row, row.onset + 1000, {
    idPrefix: 'defesa-civil-card',
    source: 'Defesa Civil',
  });
  assert.equal(card.title, '⚠ CHUVAS INTENSAS · Severo');
  assert.equal(card.details[1], 'GOIÁS/GO');
  assert.equal(
    card.details[2],
    'Chuvas Intensas: risco de alagamento e raios. Emergencia 193',
  );
  assert.equal(card.details.at(-1), 'Fonte: Defesa Civil Estadual de Goiás');
  assert.equal(card.id, 'defesa-civil-card:193467/2026');
});
