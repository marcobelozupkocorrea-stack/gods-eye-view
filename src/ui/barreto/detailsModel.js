/**
 * barreto.top: turns a selected map record into a Portuguese detail sheet —
 * { icon, kicker, title, subtitle, accent, photo, sections:[{title, rows}],
 *   links, note }. Pure: no DOM, no network, unit-tested directly.
 * Rows whose value is empty are dropped, so every sheet shows only what the
 * source actually sent.
 */

const TZ = 'America/Sao_Paulo';
const DATE_TIME = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TZ,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const NUM = (digits = 0) =>
  new Intl.NumberFormat('pt-BR', {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
export const fmtNum = (v, digits = 0) =>
  finite(v) ? NUM(digits).format(v) : null;
export const fmtWhen = (ms) =>
  finite(ms) && ms > 0 ? DATE_TIME.format(new Date(ms)).replace(',', '') : null;

/** "há 3 min" style age. */
export function fmtAge(ms, now = Date.now()) {
  if (!finite(ms) || ms <= 0) return null;
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `há ${s} s`;
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} dias`;
}

export const fmtCoords = (lat, lon) =>
  finite(lat) && finite(lon)
    ? `${Math.abs(lat).toFixed(4)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(4)}° ${lon < 0 ? 'O' : 'L'}`
    : null;

const mapsLink = (lat, lon) =>
  finite(lat) && finite(lon)
    ? {
        label: 'Abrir no Google Maps',
        href: `https://www.google.com/maps?q=${lat.toFixed(5)},${lon.toFixed(5)}`,
      }
    : null;

const COMPASS = ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'];
export const fmtHeading = (deg) =>
  finite(deg)
    ? `${Math.round(((deg % 360) + 360) % 360)}° (${COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]})`
    : null;

const FT_PER_M = 3.28084;
const KMH_PER_MS = 3.6;
const KT_PER_MS = 1.943844;

export function fmtAltitudeM(m) {
  if (!finite(m)) return null;
  return `${fmtNum(m)} m (${fmtNum(m * FT_PER_M)} pés)`;
}
export function fmtAltitudeFt(ft) {
  if (!finite(ft)) return null;
  return `${fmtNum(ft)} pés (${fmtNum(ft / FT_PER_M)} m)`;
}
export function fmtSpeedMs(ms) {
  if (!finite(ms)) return null;
  return `${fmtNum(ms * KMH_PER_MS)} km/h (${fmtNum(ms * KT_PER_MS)} nós)`;
}
export function fmtSpeedKt(kt) {
  if (!finite(kt)) return null;
  return `${fmtNum(kt * 1.852)} km/h (${fmtNum(kt)} nós)`;
}

const clean = (rows) =>
  rows.filter(
    ([, v]) => v !== null && v !== undefined && v !== '' && v !== false,
  );
const section = (title, rows) => {
  const kept = clean(rows);
  return kept.length ? { title, rows: kept } : null;
};
const sheet = (s) => ({
  ...s,
  sections: (s.sections || []).filter(Boolean),
  links: (s.links || []).filter(Boolean),
});

// ---------------------------------------------------------------- aircraft

const AIRCRAFT_CATEGORY = Object.freeze({
  A1: 'Leve (até 7 t)',
  A2: 'Pequeno (7–34 t)',
  A3: 'Grande (34–136 t)',
  A4: 'Grande de alto vórtice (ex.: B757)',
  A5: 'Pesado (acima de 136 t)',
  A6: 'Alta performance',
  A7: 'Helicóptero',
  B1: 'Planador',
  B2: 'Balão / dirigível',
  B3: 'Paraquedista',
  B4: 'Ultraleve',
  B6: 'Drone',
  B7: 'Veículo espacial',
  C1: 'Veículo de emergência (solo)',
  C2: 'Veículo de serviço (solo)',
  C3: 'Obstáculo fixo',
});

const SQUAWK = Object.freeze({
  7500: 'SEQUESTRO (7500)',
  7600: 'FALHA DE RÁDIO (7600)',
  7700: 'EMERGÊNCIA (7700)',
});

export function squawkMeaning(code) {
  if (!code) return null;
  return SQUAWK[String(code)] || String(code);
}

const EMERGENCY = Object.freeze({
  general: 'Emergência geral',
  lifeguard: 'Emergência médica',
  minfuel: 'Combustível mínimo',
  nordo: 'Sem rádio',
  unlawful: 'Interferência ilícita',
  downed: 'Aeronave abatida',
});

const airportText = (a) =>
  a
    ? [
        [a.iata, a.icao].filter(Boolean).join(' / '),
        a.name,
        [a.city, a.country].filter(Boolean).join(', '),
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

/**
 * @param {object} rec Layer record (getTrackedRecord) — position, speed…
 * @param {object|null} det /api/aircraft/details payload (may be null while loading).
 * @param {{military?: boolean, loading?: boolean}} opts
 */
export function aircraftSheet(
  rec = {},
  det = null,
  { military = false, loading = false } = {},
) {
  const live = det?.live || {};
  const ac = det?.aircraft || {};
  const route = det?.route || null;
  const callsign =
    (rec.callsign || live.callsign || det?.callsign || '').trim() || null;
  const registration =
    rec.registration || ac.registration || live.registration || null;
  const hex = (rec.icao24 || det?.hex || '').toUpperCase() || null;
  const typeName =
    [ac.manufacturer, ac.type].filter(Boolean).join(' ') ||
    live.description ||
    rec.typeName ||
    rec.type ||
    null;
  const typeCode = ac.icaoType || live.type || rec.typeCode || null;
  const emergency =
    live.emergency ||
    (SQUAWK[String(live.squawk)] ? SQUAWK[String(live.squawk)] : null);
  const altM = finite(rec.altitudeM)
    ? rec.altitudeM
    : finite(live.altBaroFt)
      ? live.altBaroFt / FT_PER_M
      : null;
  const vr = finite(rec.verticalRate)
    ? rec.verticalRate * 196.85
    : finite(rec.verticalRateMps)
      ? rec.verticalRateMps * 196.85
      : live.verticalRateFpm;
  const vrText = finite(vr)
    ? Math.abs(vr) < 64
      ? 'Nivelado'
      : `${vr > 0 ? 'Subindo' : 'Descendo'} ${fmtNum(Math.abs(vr))} pés/min (${fmtNum(Math.abs(vr) / 196.85, 1)} m/s)`
    : null;
  const airline = route?.airline?.name || rec.airline || null;
  const operator = ac.owner || live.operator || rec.operator || null;
  return sheet({
    icon: military ? 'military_tech' : 'flight',
    kicker: military ? 'AERONAVE MILITAR' : 'AERONAVE',
    title: callsign || registration || hex || 'Aeronave',
    subtitle:
      [typeName, airline || operator].filter(Boolean).join(' · ') || null,
    accent: military ? '#ffd166' : '#39d0ff',
    alert: emergency ? `⚠ ${EMERGENCY[emergency] || emergency}` : null,
    photo: det?.photo?.thumb
      ? {
          src: det.photo.thumb,
          href: det.photo.link,
          credit: det.photo.photographer
            ? `Foto: ${det.photo.photographer} · planespotters.net`
            : 'Foto: planespotters.net',
        }
      : null,
    loading,
    sections: [
      route?.origin || route?.destination
        ? section('Rota', [
            ['Companhia', airline],
            [
              'Voo',
              [callsign, route?.callsignIata].filter(Boolean).join(' / ') ||
                null,
            ],
            ['Origem', airportText(route.origin)],
            ['Destino', airportText(route.destination)],
          ])
        : null,
      section('Agora', [
        ['Situação', rec.onGround || live.onGround ? 'No solo' : 'Em voo'],
        ['Altitude', fmtAltitudeM(altM)],
        [
          'Altitude GPS',
          finite(rec.geoAltitudeM)
            ? fmtAltitudeM(rec.geoAltitudeM)
            : fmtAltitudeFt(live.altGeomFt),
        ],
        [
          'Velocidade',
          finite(rec.velocityMps)
            ? fmtSpeedMs(rec.velocityMps)
            : fmtSpeedKt(live.groundSpeedKt),
        ],
        ['Rumo', fmtHeading(finite(rec.track) ? rec.track : live.trackDeg)],
        ['Vertical', vrText],
        ['Altitude selecionada', fmtAltitudeFt(live.selectedAltitudeFt)],
        ['Velocidade indicada', fmtSpeedKt(live.iasKt)],
        ['Mach', fmtNum(live.mach, 2)],
        [
          'Vento',
          finite(live.windSpeedKt)
            ? `${fmtHeading(live.windDirDeg)} · ${fmtSpeedKt(live.windSpeedKt)}`
            : null,
        ],
        [
          'Temperatura externa',
          finite(live.outsideTempC) ? `${fmtNum(live.outsideTempC)} °C` : null,
        ],
        [
          'Ajuste altímetro (QNH)',
          finite(live.qnhHpa) ? `${fmtNum(live.qnhHpa, 1)} hPa` : null,
        ],
        ['Squawk', squawkMeaning(live.squawk)],
        ['Posição', fmtCoords(rec.latitude, rec.longitude)],
        ['Último sinal', fmtAge(rec.lastContactEpochMs)],
      ]),
      section('Aeronave', [
        ['Matrícula', registration],
        ['Modelo', typeName],
        ['Código ICAO do tipo', typeCode],
        [
          'Categoria',
          AIRCRAFT_CATEGORY[live.category] ||
            AIRCRAFT_CATEGORY[rec.category] ||
            null,
        ],
        ['Proprietário / operador', operator],
        ['País de registro', ac.ownerCountry || rec.originCountry || null],
        ['Ano de fabricação', live.year],
        ['Transponder (ICAO)', hex],
        [
          'Origem do sinal',
          live.source ? live.source.replace(/_/g, ' ').toUpperCase() : null,
        ],
      ]),
    ],
    links: [
      hex
        ? {
            label: 'ADS-B Exchange',
            href: `https://globe.adsbexchange.com/?icao=${hex.toLowerCase()}`,
          }
        : null,
      callsign && !military
        ? {
            label: 'FlightAware',
            href: `https://www.flightaware.com/live/flight/${encodeURIComponent(callsign)}`,
          }
        : null,
      det?.photo?.link ? { label: 'Mais fotos', href: det.photo.link } : null,
      mapsLink(rec.latitude, rec.longitude),
    ],
    note: 'Fontes: OpenSky / ADSB.lol (posição), adsbdb (registro e rota), planespotters.net (foto).',
  });
}

// ---------------------------------------------------------------- vessels

export function vesselTypeLabel(code) {
  const n = Number.parseInt(code, 10);
  if (!Number.isFinite(n)) return code ? String(code) : null;
  if (n === 30) return 'Pesqueiro';
  if (n === 31 || n === 32) return 'Rebocador (reboque)';
  if (n === 33) return 'Dragagem / obras submarinas';
  if (n === 34) return 'Mergulho';
  if (n === 35) return 'Militar';
  if (n === 36) return 'Veleiro';
  if (n === 37) return 'Lazer';
  if (n >= 40 && n <= 49) return 'Alta velocidade';
  if (n === 50) return 'Praticagem';
  if (n === 51) return 'Busca e salvamento';
  if (n === 52) return 'Rebocador';
  if (n === 53) return 'Apoio portuário';
  if (n === 54) return 'Antipoluição';
  if (n === 55) return 'Polícia / fiscalização';
  if (n === 58) return 'Transporte médico';
  if (n >= 60 && n <= 69) return 'Passageiros';
  if (n >= 70 && n <= 79) return 'Carga';
  if (n >= 80 && n <= 89) return 'Tanque (petroleiro/químico/gás)';
  if (n >= 20 && n <= 29) return 'Asa de efeito solo';
  return `Outro (código ${n})`;
}

const MID = Object.freeze({
  710: 'Brasil',
  701: 'Argentina',
  725: 'Chile',
  770: 'Uruguai',
  760: 'Peru',
  735: 'Equador',
  730: 'Colômbia',
  775: 'Venezuela',
  755: 'Paraguai',
  720: 'Bolívia',
  538: 'Ilhas Marshall',
  636: 'Libéria',
  637: 'Libéria',
  351: 'Panamá',
  352: 'Panamá',
  353: 'Panamá',
  354: 'Panamá',
  355: 'Panamá',
  356: 'Panamá',
  357: 'Panamá',
  370: 'Panamá',
  371: 'Panamá',
  372: 'Panamá',
  373: 'Panamá',
  374: 'Panamá',
  477: 'Hong Kong',
  563: 'Singapura',
  564: 'Singapura',
  565: 'Singapura',
  566: 'Singapura',
  215: 'Malta',
  229: 'Malta',
  248: 'Malta',
  249: 'Malta',
  256: 'Malta',
  255: 'Portugal (Madeira)',
  263: 'Portugal',
  209: 'Chipre',
  210: 'Chipre',
  212: 'Chipre',
  311: 'Bahamas',
  308: 'Bahamas',
  309: 'Bahamas',
  211: 'Alemanha',
  218: 'Alemanha',
  219: 'Dinamarca',
  220: 'Dinamarca',
  224: 'Espanha',
  225: 'Espanha',
  226: 'França',
  227: 'França',
  228: 'França',
  232: 'Reino Unido',
  233: 'Reino Unido',
  234: 'Reino Unido',
  235: 'Reino Unido',
  244: 'Holanda',
  245: 'Holanda',
  246: 'Holanda',
  247: 'Itália',
  257: 'Noruega',
  258: 'Noruega',
  259: 'Noruega',
  265: 'Suécia',
  266: 'Suécia',
  240: 'Grécia',
  241: 'Grécia',
  304: 'Antígua e Barbuda',
  305: 'Antígua e Barbuda',
  338: 'EUA',
  366: 'EUA',
  367: 'EUA',
  368: 'EUA',
  369: 'EUA',
  316: 'Canadá',
  412: 'China',
  413: 'China',
  414: 'China',
  431: 'Japão',
  432: 'Japão',
  440: 'Coreia do Sul',
  441: 'Coreia do Sul',
  419: 'Índia',
  533: 'Malásia',
  525: 'Indonésia',
  548: 'Filipinas',
  574: 'Vietnã',
  567: 'Tailândia',
  403: 'Arábia Saudita',
  470: 'Emirados Árabes',
  271: 'Turquia',
  273: 'Rússia',
  601: 'África do Sul',
  657: 'Nigéria',
  620: 'Comores',
  341: 'São Cristóvão e Névis',
  375: 'São Vicente e Granadinas',
  376: 'São Vicente e Granadinas',
  377: 'São Vicente e Granadinas',
  312: 'Belize',
  314: 'Barbados',
  345: 'México',
  503: 'Austrália',
  512: 'Nova Zelândia',
  667: 'Serra Leoa',
  613: 'Camarões',
  677: 'Tanzânia',
});

export const flagFromMmsi = (mmsi) => {
  const s = String(mmsi || '');
  return /^\d{9}$/.test(s) ? MID[Number(s.slice(0, 3))] || null : null;
};

export function vesselSheet(rec = {}, det = null, { loading = false } = {}) {
  const v = { ...rec, ...(det || {}) };
  const eta = v.eta
    ? `${String(v.eta.day).padStart(2, '0')}/${String(v.eta.month).padStart(2, '0')}${
        Number.isFinite(v.eta.hour)
          ? ` ${String(v.eta.hour).padStart(2, '0')}:${String(v.eta.minute ?? 0).padStart(2, '0')} UTC`
          : ''
      }`
    : null;
  const posMs = finite(v.last_position_epoch)
    ? v.last_position_epoch * 1000
    : finite(v.lastPositionEpoch)
      ? v.lastPositionEpoch * 1000
      : Date.parse(v.last_position_UTC || v.lastPositionUtc || '') || null;
  const name = String(v.name || '').trim();
  return sheet({
    icon: 'directions_boat',
    kicker: 'EMBARCAÇÃO',
    title: name && !/^MMSI /.test(name) ? name : `MMSI ${v.mmsi}`,
    subtitle:
      [vesselTypeLabel(v.type), flagFromMmsi(v.mmsi)]
        .filter(Boolean)
        .join(' · ') || null,
    accent: '#4dd0e1',
    loading,
    sections: [
      section('Viagem', [
        ['Destino', v.destination ? String(v.destination).trim() : null],
        ['Chegada prevista (ETA)', eta],
        ['Situação', v.navStatus || null],
      ]),
      section('Agora', [
        ['Velocidade', fmtSpeedKt(v.speed)],
        ['Rumo no fundo', fmtHeading(v.course)],
        [
          'Proa',
          finite(v.heading) && v.heading !== 511 ? fmtHeading(v.heading) : null,
        ],
        [
          'Taxa de guinada',
          finite(v.rateOfTurn) && v.rateOfTurn !== 0
            ? `${fmtNum(v.rateOfTurn)} (${v.rateOfTurn > 0 ? 'boreste' : 'bombordo'})`
            : null,
        ],
        ['Posição', fmtCoords(v.lat, v.lon)],
        [
          'Última posição',
          posMs ? `${fmtWhen(posMs)} (${fmtAge(posMs)})` : null,
        ],
      ]),
      section('Navio', [
        ['Tipo', vesselTypeLabel(v.type)],
        ['Bandeira', flagFromMmsi(v.mmsi)],
        [
          'Comprimento',
          finite(v.lengthM) && v.lengthM > 0 ? `${fmtNum(v.lengthM)} m` : null,
        ],
        [
          'Boca (largura)',
          finite(v.beamM) && v.beamM > 0 ? `${fmtNum(v.beamM)} m` : null,
        ],
        [
          'Calado máximo',
          finite(v.draughtM) ? `${fmtNum(v.draughtM, 1)} m` : null,
        ],
        ['Indicativo de chamada', v.callSign || null],
        ['IMO', v.imo && v.imo !== '0' ? v.imo : null],
        ['MMSI', v.mmsi ? String(v.mmsi) : null],
        ['Classe AIS', v.aisClass ? `Classe ${v.aisClass}` : null],
      ]),
    ],
    links: [
      v.mmsi
        ? {
            label: 'MarineTraffic',
            href: `https://www.marinetraffic.com/en/ais/details/ships/mmsi:${v.mmsi}`,
          }
        : null,
      v.mmsi
        ? {
            label: 'VesselFinder',
            href: `https://www.vesselfinder.com/vessels/details/${v.mmsi}`,
          }
        : null,
      mapsLink(v.lat, v.lon),
    ],
    note: 'Fonte: AISStream (rede de receptores AIS). Dados do navio são informados pela própria tripulação.',
  });
}

// ---------------------------------------------------------------- satellites

const SAT_GROUP = Object.freeze({
  stations: 'Estação espacial',
  visual: 'Visível a olho nu',
  'gps-ops': 'GPS',
  'glo-ops': 'GLONASS',
  galileo: 'Galileo',
  geo: 'Geoestacionário',
  starlink: 'Starlink',
  active: 'Ativo',
});

export function satelliteSheet(rec = {}) {
  const orbit =
    finite(rec.periodMin) && rec.periodMin > 1300 && rec.periodMin < 1560
      ? 'Geoestacionária / geossíncrona'
      : finite(rec.apogeeKm) && rec.apogeeKm < 2000
        ? 'Órbita baixa (LEO)'
        : finite(rec.apogeeKm) && rec.apogeeKm < 35000
          ? 'Órbita média (MEO)'
          : finite(rec.apogeeKm)
            ? 'Órbita alta'
            : null;
  return sheet({
    icon: 'satellite_alt',
    kicker: 'SATÉLITE',
    title: rec.name || `NORAD ${rec.noradId}`,
    subtitle:
      [SAT_GROUP[rec.group] || rec.group, orbit].filter(Boolean).join(' · ') ||
      null,
    accent: '#b388ff',
    sections: [
      section('Agora', [
        [
          'Altitude',
          finite(rec.altitudeM) ? `${fmtNum(rec.altitudeM / 1000)} km` : null,
        ],
        [
          'Velocidade',
          finite(rec.speedKmS)
            ? `${fmtNum(rec.speedKmS, 2)} km/s (${fmtNum(rec.speedKmS * 3600)} km/h)`
            : null,
        ],
        ['Sobre', fmtCoords(rec.latitude, rec.longitude)],
      ]),
      section('Órbita', [
        ['Tipo', orbit],
        [
          'Período',
          finite(rec.periodMin)
            ? `${fmtNum(rec.periodMin, 1)} min (${fmtNum(1440 / rec.periodMin, 1)} voltas/dia)`
            : null,
        ],
        ['Apogeu', finite(rec.apogeeKm) ? `${fmtNum(rec.apogeeKm)} km` : null],
        [
          'Perigeu',
          finite(rec.perigeeKm) ? `${fmtNum(rec.perigeeKm)} km` : null,
        ],
        [
          'Inclinação',
          finite(rec.inclinationDeg)
            ? `${fmtNum(rec.inclinationDeg, 2)}°`
            : null,
        ],
        [
          'Excentricidade',
          finite(rec.eccentricity) ? fmtNum(rec.eccentricity, 5) : null,
        ],
        ['Elementos orbitais de', fmtWhen(rec.tleEpochMs)],
      ]),
      section('Identificação', [
        ['Número NORAD', rec.noradId != null ? String(rec.noradId) : null],
        ['Grupo', SAT_GROUP[rec.group] || rec.group || null],
      ]),
    ],
    links: [
      rec.noradId != null
        ? {
            label: 'N2YO (passagens)',
            href: `https://www.n2yo.com/satellite/?s=${rec.noradId}`,
          }
        : null,
      rec.noradId != null
        ? {
            label: 'CelesTrak',
            href: `https://celestrak.org/satcat/table-satcat.php?CATNR=${rec.noradId}`,
          }
        : null,
    ],
    note: 'Fonte: CelesTrak (elementos orbitais TLE), posição calculada no navegador.',
  });
}

// ---------------------------------------------------------------- fires

export function fireSheet(f = {}) {
  const p = f.place || {};
  const conf =
    typeof f.confidence === 'string'
      ? {
          l: 'Baixa',
          low: 'Baixa',
          n: 'Nominal',
          nominal: 'Nominal',
          h: 'Alta',
          high: 'Alta',
        }[f.confidence.toLowerCase()] || f.confidence
      : finite(f.confidence)
        ? `${fmtNum(f.confidence)}%`
        : null;
  return sheet({
    icon: 'local_fire_department',
    kicker: 'FOCO DE QUEIMADA',
    title: p.municipio
      ? `${p.municipio}${p.estado ? ` / ${p.estado}` : ''}`
      : 'Foco de calor',
    subtitle:
      [finite(f.frp) ? `${fmtNum(f.frp, 1)} MW` : null, fmtAge(f.acqMs)]
        .filter(Boolean)
        .join(' · ') || null,
    accent: '#ff7043',
    sections: [
      section('Detecção', [
        ['Quando', fmtWhen(f.acqMs)],
        [
          'Potência radiativa (FRP)',
          finite(f.frp) ? `${fmtNum(f.frp, 1)} MW` : null,
        ],
        ['Confiança', conf],
        [
          'Temperatura de brilho',
          finite(f.brightness) ? `${fmtNum(f.brightness, 1)} K` : null,
        ],
        [
          'Período',
          f.night === true ? 'Noite' : f.night === false ? 'Dia' : null,
        ],
        [
          'Satélite / sensor',
          [f.satellite, f.sensor].filter(Boolean).join(' · ') || null,
        ],
      ]),
      section('Local', [
        ['Município', p.municipio || null],
        ['Estado', p.estado || null],
        ['Bioma', p.bioma || null],
        [
          'Risco de fogo',
          finite(p.riscoFogo) ? fmtNum(p.riscoFogo, 2) : p.riscoFogo || null,
        ],
        [
          'Dias sem chuva',
          finite(p.diasSemChuva)
            ? fmtNum(p.diasSemChuva)
            : p.diasSemChuva || null,
        ],
        ['Coordenadas', fmtCoords(f.lat, f.lon)],
      ]),
    ],
    links: [mapsLink(f.lat, f.lon)],
    note: 'Fontes: NASA FIRMS e INPE Queimadas. Um foco é um ponto quente visto por satélite, não necessariamente um incêndio confirmado.',
  });
}

// ---------------------------------------------------------------- Brazilian alerts

export function capAlertSheet(row = {}, { source = 'INMET' } = {}) {
  return sheet({
    icon: 'warning',
    kicker: source === 'defesa' ? 'ALERTA DA DEFESA CIVIL' : 'AVISO DO INMET',
    title: row.event || 'Alerta',
    subtitle:
      [row.severityLabel, row.states].filter(Boolean).join(' · ') || null,
    accent: row.color || '#ffd600',
    sections: [
      section('Quando', [
        ['Início', fmtWhen(row.onset)],
        ['Fim', fmtWhen(row.expires)],
        ['Emitido em', fmtWhen(row.sent)],
      ]),
      section('Onde', [
        ['Estados', row.states || null],
        ['Áreas', row.areaDesc || null],
      ]),
      section('O que diz', [
        ['Resumo', row.headline || null],
        ['Descrição', row.description || null],
        ['O que fazer', row.instruction || null],
        ['Gravidade', row.severityLabel || null],
        ['Emissor', row.senderName || null],
      ]),
    ],
    links: [
      row.web ? { label: 'Página oficial do alerta', href: row.web } : null,
      row.anchor ? mapsLink(row.anchor.lat, row.anchor.lon) : null,
    ],
    note:
      source === 'defesa'
        ? 'Fonte: Defesa Civil (IDAP, Ministério da Integração).'
        : 'Fonte: INMET (Instituto Nacional de Meteorologia).',
  });
}

export function cemadenSheet(row = {}) {
  return sheet({
    icon: 'flood',
    kicker: 'ALERTA CEMADEN',
    title: row.event || 'Alerta',
    subtitle:
      [row.level, [row.municipality, row.uf].filter(Boolean).join('/')]
        .filter(Boolean)
        .join(' · ') || null,
    accent: row.color || '#ffd60a',
    sections: [
      section('Alerta', [
        ['Tipo de risco', row.event || null],
        ['Nível', row.level || null],
        ['Município', row.municipality || null],
        ['Estado', row.uf || null],
        ['Emitido em', fmtWhen(row.created)],
        ['Atualizado em', fmtWhen(row.updated)],
        ['Coordenadas', fmtCoords(row.lat, row.lon)],
      ]),
    ],
    links: [
      mapsLink(row.lat, row.lon),
      {
        label: 'Painel do Cemaden',
        href: 'https://painelalertas.cemaden.gov.br/',
      },
    ],
    note: 'Fonte: Cemaden (Centro Nacional de Monitoramento e Alertas de Desastres Naturais).',
  });
}

export function deterSheet(row = {}) {
  return sheet({
    icon: 'forest',
    kicker: 'DESMATAMENTO (DETER)',
    title: row.label || 'Alerta DETER',
    subtitle:
      [[row.municipality, row.uf].filter(Boolean).join('/'), row.biome]
        .filter(Boolean)
        .join(' · ') || null,
    accent: row.color || '#ff3b30',
    sections: [
      section('Alerta', [
        ['Tipo', row.label || null],
        ['Classe INPE', row.className || null],
        [
          'Área',
          finite(row.areaKm2)
            ? `${fmtNum(row.areaKm2, 2)} km² (${fmtNum(row.areaKm2 * 100, 1)} ha)`
            : null,
        ],
        ['Detectado em', fmtWhen(row.date)?.slice(0, 10) || null],
        [
          'Satélite / sensor',
          [row.satellite, row.sensor].filter(Boolean).join(' · ') || null,
        ],
      ]),
      section('Local', [
        ['Município', row.municipality || null],
        ['Estado', row.uf || null],
        ['Bioma', row.biome || null],
        ['Área protegida', row.protectedArea || null],
        ['Coordenadas', fmtCoords(row.lat, row.lon)],
      ]),
    ],
    links: [
      mapsLink(row.lat, row.lon),
      {
        label: 'TerraBrasilis (INPE)',
        href: 'https://terrabrasilis.dpi.inpe.br/app/map/alerts',
      },
    ],
    note: 'Fonte: INPE DETER. Alertas indicam mudança na cobertura florestal vista por satélite.',
  });
}
