import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeXmlText,
  isCurrentWarning,
  parseCapPolygon,
  parseInmetCap,
  parseInmetRssIds,
  thinRing,
} from './inmetCap.js';
import {
  buildInmetCard,
  formatBrasiliaTime,
  inmetAnchorDegrees,
} from '../layers/inmet/cards.js';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Avisos</title>
<item><title>Aviso de Tempestade. Severidade Grau: Perigo</title>
<link>https://apiprevmet3.inmet.gov.br/avisos/rss/56064</link>
<description><![CDATA[<table><tr><th>Evento</th><td>Tempestade</td></tr></table>]]></description>
<guid>https://apiprevmet3.inmet.gov.br/avisos/rss/56064</guid></item>
<item><title>Aviso 2</title><link>https://apiprevmet3.inmet.gov.br/avisos/rss/56063</link></item>
<item><title>dup</title><link>https://apiprevmet3.inmet.gov.br/avisos/rss/56064</link></item>
<item><title>bad</title><link>https://example.com/nothing</link></item>
</channel></rss>`;

const cap = ({
  msgType = 'Alert',
  polygon,
} = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>urn:oid:2.49.0.0.76.0.2026.56064.1</identifier>
  <sender>info.aviso@inmet.gov.br</sender>
  <sent>2026-10-14T00:01:00-03:00</sent>
  <status>Actual</status>
  <msgType>${msgType}</msgType>
  <scope>Public</scope>
  <info>
    <language>pt-BR</language>
    <category>Met</category>
    <event>Tempestade</event>
    <urgency>Immediate</urgency>
    <severity>Severe</severity>
    <certainty>Likely</certainty>
    <onset>2026-10-14T00:01:00-03:00</onset>
    <expires>2026-10-14T23:59:00-03:00</expires>
    <headline>Aviso de Tempestade. Severidade Grau: Perigo</headline>
    <description>Chuva entre 30 e 60 mm/h ou 50 e 100 mm/dia, ventos intensos (60-100 km/h) e queda de granizo.</description>
    <instruction>Em caso de rajadas de vento: n&#227;o se abrigue debaixo de &#225;rvores.</instruction>
    <web>https://alertas2.inmet.gov.br/56064</web>
    <parameter><valueName>ColorRisk</valueName><value>#FFA500</value></parameter>
    <parameter><valueName>Estados</valueName><value>Paraná, São Paulo</value></parameter>
    <area>
      <areaDesc>Aviso para as áreas: Metropolitana de Curitiba, Metropolitana de São Paulo</areaDesc>
      <polygon>${polygon ?? '-25.0,-49.0 -25.0,-48.0 -24.0,-48.0 -24.0,-49.0 -25.0,-49.0'}</polygon>
    </area>
  </info>
</alert>`;

test('INMET RSS yields unique warning ids in feed order', () => {
  assert.deepEqual(parseInmetRssIds(RSS), ['56064', '56063']);
  assert.deepEqual(parseInmetRssIds(''), []);
});

test('INMET CAP becomes a drawable warning row', () => {
  const row = parseInmetCap(cap(), '56064');
  assert.equal(row.stableId, '56064');
  assert.equal(row.event, 'Tempestade');
  assert.equal(row.severity, 'Severe');
  assert.equal(row.severityLabel, 'Perigo');
  assert.equal(row.severityRank, 2);
  assert.equal(row.color, '#FFA500');
  assert.equal(row.states, 'Paraná, São Paulo');
  assert.equal(
    row.areaDesc,
    'Metropolitana de Curitiba, Metropolitana de São Paulo',
  );
  assert.equal(row.onset, Date.parse('2026-10-14T03:01:00Z'));
  assert.equal(row.expires, Date.parse('2026-10-15T02:59:00Z'));
  assert.match(row.instruction, /não se abrigue debaixo de árvores/);
  assert.equal(row.polygons.length, 1);
  assert.deepEqual(row.polygons[0][0][0], [-49, -25]);
  assert.equal(row.polygons[0][0].length, 5);
});

test('INMET cancellations and areas without polygons are skipped', () => {
  assert.equal(parseInmetCap(cap({ msgType: 'Cancel' }), '1'), null);
  assert.equal(parseInmetCap(cap({ polygon: '1,2 3,4' }), '1'), null);
  assert.equal(parseInmetCap('<html>erro</html>', '1'), null);
});

test('CAP polygons close their ring and drop invalid vertices', () => {
  assert.deepEqual(parseCapPolygon('-10,-50 -10,-49 -9,-49'), [
    [-50, -10],
    [-49, -10],
    [-49, -9],
    [-50, -10],
  ]);
  assert.equal(parseCapPolygon('foo bar'), null);
  assert.equal(parseCapPolygon('-10,-50 999,0 -9,-49'), null);
});

test('XML text decoding handles CDATA and numeric entities', () => {
  assert.equal(decodeXmlText('<![CDATA[a < b]]>'), 'a < b');
  assert.equal(
    decodeXmlText('S&#227;o &amp; Paulo &#x2013; SP'),
    'São & Paulo – SP',
  );
});

test('Expired warnings are not current', () => {
  const row = parseInmetCap(cap(), '56064');
  assert.equal(isCurrentWarning(row, row.expires - 1), true);
  assert.equal(isCurrentWarning(row, row.expires), false);
});

test('INMET card reads in Portuguese with Brasília times', () => {
  const row = parseInmetCap(cap(), '56064');
  const card = buildInmetCard(row, row.onset + 60_000);
  assert.equal(card.title, '⚠ TEMPESTADE · Perigo');
  assert.equal(card.details[0], 'desde 14/10 00:01 · até 14/10 23:59');
  assert.equal(card.details[1], 'Paraná, São Paulo');
  assert.equal(card.accent, '#FFA500');
  assert.equal(card.details.at(-1), 'Fonte: INMET');
  const upcoming = buildInmetCard(row, row.onset - 60_000);
  assert.match(upcoming.details[0], /^começa 14\/10 00:01/);
  assert.equal(formatBrasiliaTime(NaN), null);
});

test('INMET card anchor sits inside the warning area', () => {
  const row = parseInmetCap(cap(), '56064');
  const { lon, lat } = inmetAnchorDegrees(row.polygons);
  assert.equal(lon, -48.5);
  assert.equal(lat, -24.5);
});

test('Very detailed INMET rings are decimated but stay closed', () => {
  const ring = Array.from({ length: 2000 }, (_, i) => [
    Math.cos(i / 318),
    Math.sin(i / 318),
  ]);
  ring.push(ring[0]);
  const thin = thinRing(ring, 100);
  assert.equal(thin.length, 100);
  assert.deepEqual(thin[0], thin.at(-1));
  assert.equal(thinRing(ring.slice(0, 10)).length, 10);
});
