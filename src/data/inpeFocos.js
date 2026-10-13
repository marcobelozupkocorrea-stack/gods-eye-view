/**
 * INPE (Programa Queimadas) fire-foci CSV → the record shape produced by
 * `parseFirmsCsv`, so INPE detections can flow through the existing fire layer.
 *
 * Source: https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/diario/Brasil/
 * Header (2026): id,lat,lon,data_hora_gmt,satelite,municipio,estado,pais,
 *   municipio_id,estado_id,pais_id,numero_dias_sem_chuva,precipitacao,
 *   risco_fogo,bioma,frp
 *
 * Pure module: no I/O, no globals.
 */

const REQUIRED = ['lat', 'lon', 'data_hora_gmt', 'satelite'];

/**
 * Satellites whose detections NASA FIRMS already publishes (VIIRS on
 * NOAA-20/21 and Suomi NPP, MODIS on Aqua/Terra). When the FIRMS feed is also
 * active these are skipped so the same fire is not drawn twice.
 */
export const INPE_SATELLITES_IN_FIRMS = Object.freeze(
  new Set([
    'NOAA-20',
    'NOAA-21',
    'NPP-375',
    'NPP',
    'AQUA_M-T',
    'AQUA_M-M',
    'TERRA_M-T',
    'TERRA_M-M',
  ]),
);

/** Daily file name for a UTC date, e.g. focos_diario_br_20261013.csv. */
export function inpeDailyFileName(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `focos_diario_br_${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}.csv`;
}

/**
 * Parse an INPE daily CSV into FIRMS-shaped records.
 * @param {string} text CSV body.
 * @param {{ skipSatellites?: Set<string> }} [options]
 * @returns {Array<object>|null} Records, or null when the body is not an INPE CSV.
 */
export function parseInpeFocosCsv(text, { skipSatellites } = {}) {
  if (typeof text !== 'string') return null;
  const body = text.replace(/^﻿/, '');
  const firstBreak = body.indexOf('\n');
  const headerLine = (firstBreak === -1 ? body : body.slice(0, firstBreak))
    .trim()
    .toLowerCase();
  if (!headerLine || headerLine[0] === '<') return null;
  const header = headerLine.split(',').map((h) => h.trim());
  const col = new Map(header.map((name, i) => [name, i]));
  if (!REQUIRED.every((name) => col.has(name))) return null;

  const iLat = col.get('lat');
  const iLon = col.get('lon');
  const iWhen = col.get('data_hora_gmt');
  const iSat = col.get('satelite');
  const iFrp = col.get('frp');
  const iMun = col.get('municipio');
  const iUf = col.get('estado');
  const iBioma = col.get('bioma');
  const iRisco = col.get('risco_fogo');
  const iSemChuva = col.get('numero_dias_sem_chuva');

  const records = [];
  const lines = body.split('\n');
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < header.length) continue;
    const satellite = cell(parts, iSat).toUpperCase();
    if (skipSatellites?.has(satellite)) continue;
    const lat = Number(parts[iLat]);
    const lon = Number(parts[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const when = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(
      cell(parts, iWhen),
    );
    if (!when) continue;
    records.push({
      lat,
      lon,
      frp: finiteOrZero(parts[iFrp]),
      confidence: 'nominal',
      brightness: 0,
      brightnessTi5: 0,
      daynight: '',
      acqDate: when[1],
      acqTime: `${when[2]}${when[3]}`,
      satellite,
      instrument: 'INPE',
      provider: 'INPE',
      municipio: cell(parts, iMun),
      estado: cell(parts, iUf),
      bioma: cell(parts, iBioma),
      riscoFogo: cell(parts, iRisco),
      diasSemChuva: cell(parts, iSemChuva),
    });
  }
  return records;
}

function cell(parts, index) {
  if (index === undefined || parts[index] === undefined) return '';
  return parts[index].trim();
}

function finiteOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
