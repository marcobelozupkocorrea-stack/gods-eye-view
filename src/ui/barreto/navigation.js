/**
 * barreto.top: simple turn-by-turn mode for a planned route.
 *
 * Big next-step card on top, time and distance left at the bottom, the map
 * following the GPS from slightly behind, the screen kept on (Wake Lock) and
 * the next instruction spoken in Portuguese. Off the route for a few fixes →
 * "Recalcular" from where you are.
 */
import * as Cesium from 'cesium';

/** Material Symbols arrow for a step. */
export function maneuverIcon(step) {
  const t = String(step?.type || '');
  const m = String(step?.modifier || '');
  if (t === 'arrive') return 'flag';
  if (t === 'depart') return 'navigation';
  if (/roundabout|rotary/.test(t))
    return m.includes('left') ? 'roundabout_left' : 'roundabout_right';
  if (m === 'uturn') return 'u_turn_left';
  if (m === 'sharp left' || m === 'left') return 'turn_left';
  if (m === 'sharp right' || m === 'right') return 'turn_right';
  if (m === 'slight left')
    return t === 'fork' ? 'fork_left' : 'turn_slight_left';
  if (m === 'slight right')
    return t === 'fork' ? 'fork_right' : 'turn_slight_right';
  if (t === 'merge') return 'merge';
  return 'straight';
}

export function distanceM(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) *
      Math.cos(lat2 * r) *
      Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12_742_000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Shortest distance (m) from a point to a [lon, lat] polyline, roughly. */
export function distanceToLine(lat, lon, line) {
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110_540;
  let best = Infinity;
  for (let i = 1; i < (line?.length || 0); i += 1) {
    const ax = (line[i - 1][0] - lon) * kx;
    const ay = (line[i - 1][1] - lat) * ky;
    const bx = (line[i][0] - lon) * kx;
    const by = (line[i][1] - lat) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) best = d;
  }
  return best;
}

/** "em 300 m", "em 1,2 km", "agora". */
export function inText(m) {
  if (!Number.isFinite(m)) return '';
  if (m < 30) return 'agora';
  if (m < 1000) return `em ${Math.round(m / 10) * 10} m`;
  return `em ${(m / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km`;
}

/**
 * Which step is next for a position: the first step not passed yet. A step
 * counts as passed once we got within `reachM` of it.
 */
export function advance(steps, nextIndex, lat, lon, reachM = 30) {
  let i = nextIndex;
  while (
    i < steps.length - 1 &&
    distanceM(lat, lon, steps[i].lat, steps[i].lon) <= reachM
  )
    i += 1;
  return i;
}

const fmtDur = (s) => {
  const m = Math.max(1, Math.round(s / 60));
  return m < 60
    ? `${m} min`
    : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
};
const fmtKm = (m) =>
  m < 1000
    ? `${Math.round(m)} m`
    : `${(m / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km`;
const CLOCK = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
});

export function initNavigation({ styleManager, routePlanner, signal } = {}) {
  const viewer = () => styleManager?.viewer;
  const ui = document.createElement('div');
  ui.id = 'barreto-nav';
  ui.hidden = true;
  ui.innerHTML = `
    <section class="barreto-nav-step" aria-live="polite">
      <span class="material-symbols-outlined barreto-nav-arrow" aria-hidden="true">straight</span>
      <div><b class="barreto-nav-in"></b><p class="barreto-nav-text"></p></div>
    </section>
    <p class="barreto-nav-warn" hidden><span>Você saiu da rota.</span><button type="button" class="barreto-nav-reroute">Recalcular</button></p>
    <section class="barreto-nav-bar">
      <div class="barreto-nav-left"><b class="barreto-nav-eta"></b><span class="barreto-nav-rest"></span></div>
      <button type="button" class="barreto-nav-voice" aria-pressed="true" title="Voz"><span class="material-symbols-outlined" aria-hidden="true">volume_up</span></button>
      <button type="button" class="barreto-nav-end">Encerrar</button>
    </section>`;
  document.body.append(ui);
  const $ = (s) => ui.querySelector(s);

  let route = null;
  let next = 0;
  let watch = null;
  let lock = null;
  let dot = null;
  let offCount = 0;
  let voice = true;
  let spoken = new Set();
  let last = null;

  const say = (text) => {
    if (!voice || !text) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'pt-BR';
      u.rate = 1.02;
      globalThis.speechSynthesis?.cancel();
      globalThis.speechSynthesis?.speak(u);
    } catch {
      /* no voice */
    }
  };

  async function keepAwake() {
    try {
      lock = await navigator.wakeLock?.request('screen');
    } catch {
      lock = null;
    }
  }
  const onVisible = () => {
    if (route && document.visibilityState === 'visible') void keepAwake();
  };
  document.addEventListener('visibilitychange', onVisible, { signal });

  function render(lat, lon) {
    const steps = route.steps;
    const step = steps[next];
    const toStep =
      lat === undefined
        ? step.distanceM
        : distanceM(lat, lon, step.lat, step.lon);
    $('.barreto-nav-arrow').textContent = maneuverIcon(step);
    $('.barreto-nav-in').textContent =
      step.type === 'arrive' && toStep < 30 ? 'Você chegou' : inText(toStep);
    $('.barreto-nav-text').textContent = step.instruction || '';
    let rest = toStep;
    let restS = 0;
    for (let i = next; i < steps.length; i += 1) {
      if (i > next) rest += steps[i].distanceM || 0;
      restS += steps[i].durationS || 0;
    }
    // Scale the time left by the share of the current step still ahead.
    const cur = steps[next];
    if (cur?.distanceM)
      restS -= cur.durationS * Math.max(0, 1 - toStep / cur.distanceM);
    $('.barreto-nav-eta').textContent =
      `${fmtDur(restS)} · chegada ${CLOCK.format(new Date(Date.now() + restS * 1000))}`;
    $('.barreto-nav-rest').textContent = fmtKm(rest);
    // Speak at ~400 m and when close.
    const key400 = `${next}:far`;
    const keyNear = `${next}:near`;
    if (toStep < 450 && toStep > 120 && !spoken.has(key400)) {
      spoken.add(key400);
      say(`${inText(toStep)}, ${step.instruction}`);
    } else if (toStep <= 120 && !spoken.has(keyNear)) {
      spoken.add(keyNear);
      say(step.instruction);
    }
  }

  function follow(lat, lon, heading) {
    const v = viewer();
    if (!v) return;
    const h = Number.isFinite(heading) ? heading : last?.heading || 0;
    const height = 450;
    const back = 700; // metres behind the position
    const r = (h * Math.PI) / 180;
    const dLat = (-Math.cos(r) * back) / 111_320;
    const dLon =
      (-Math.sin(r) * back) / (111_320 * Math.cos((lat * Math.PI) / 180));
    v.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        lon + dLon,
        lat + dLat,
        height,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(h),
        pitch: Cesium.Math.toRadians(-32),
        roll: 0,
      },
      duration: 0.9,
      easingFunction: Cesium.EasingFunction.LINEAR_NONE,
    });
    if (!dot) {
      dot = v.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        point: {
          pixelSize: 16,
          color: Cesium.Color.fromCssColorString('#2f8cff'),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 3,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    } else dot.position = Cesium.Cartesian3.fromDegrees(lon, lat);
  }

  function onFix(pos) {
    if (!route) return;
    const { latitude: lat, longitude: lon, heading, speed } = pos.coords;
    let h = Number.isFinite(heading) && speed > 1.5 ? heading : null;
    if (h === null && last && distanceM(last.lat, last.lon, lat, lon) > 8) {
      const y =
        Math.sin(((lon - last.lon) * Math.PI) / 180) *
        Math.cos((lat * Math.PI) / 180);
      const x =
        Math.cos((last.lat * Math.PI) / 180) * Math.sin((lat * Math.PI) / 180) -
        Math.sin((last.lat * Math.PI) / 180) *
          Math.cos((lat * Math.PI) / 180) *
          Math.cos(((lon - last.lon) * Math.PI) / 180);
      h = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    }
    last = { lat, lon, heading: h ?? last?.heading ?? 0 };
    const before = next;
    next = advance(route.steps, next, lat, lon, speed > 15 ? 45 : 30);
    if (next !== before)
      spoken = new Set([...spoken].filter((k) => !k.startsWith(`${before}:`)));
    const off = distanceToLine(lat, lon, route.geometry) > 70;
    offCount = off ? offCount + 1 : 0;
    $('.barreto-nav-warn').hidden = offCount < 3;
    if (offCount === 3) say('Você saiu da rota.');
    render(lat, lon);
    follow(lat, lon, last.heading);
  }

  function start(r) {
    if (!r?.steps?.length) return;
    route = r;
    next = r.steps.length > 1 && r.steps[0].type === 'depart' ? 1 : 0;
    spoken = new Set();
    offCount = 0;
    last = null;
    ui.hidden = false;
    document.body.classList.add('barreto-navigating');
    render();
    void keepAwake();
    say(`Vamos lá. ${r.steps[next]?.instruction || ''}`);
    if (navigator.geolocation)
      watch = navigator.geolocation.watchPosition(onFix, () => {}, {
        enableHighAccuracy: true,
        maximumAge: 2000,
        timeout: 20_000,
      });
  }

  function stop() {
    route = null;
    if (watch !== null) navigator.geolocation?.clearWatch(watch);
    watch = null;
    try {
      lock?.release?.();
    } catch {
      /* already released */
    }
    lock = null;
    globalThis.speechSynthesis?.cancel?.();
    if (dot) viewer()?.entities?.remove(dot);
    dot = null;
    ui.hidden = true;
    document.body.classList.remove('barreto-navigating');
  }

  $('.barreto-nav-end').addEventListener('click', stop);
  $('.barreto-nav-voice').addEventListener('click', (e) => {
    voice = !voice;
    e.currentTarget.setAttribute('aria-pressed', String(voice));
    e.currentTarget.querySelector('span').textContent = voice
      ? 'volume_up'
      : 'volume_off';
    if (!voice) globalThis.speechSynthesis?.cancel?.();
  });
  $('.barreto-nav-reroute').addEventListener('click', () => {
    if (!last) return;
    offCount = 0;
    $('.barreto-nav-warn').hidden = true;
    routePlanner?.rerouteFrom?.(last.lat, last.lon);
  });
  // A recalculated route replaces the one being followed.
  globalThis.addEventListener(
    'barreto:route-changed',
    (event) => {
      const r = event.detail?.route;
      if (route && r?.steps?.length && r !== route) {
        route = r;
        next = advance(
          r.steps,
          r.steps[0]?.type === 'depart' ? 1 : 0,
          last?.lat ?? 0,
          last?.lon ?? 0,
        );
        spoken = new Set();
        render(last?.lat, last?.lon);
      }
    },
    { signal },
  );
  signal?.addEventListener('abort', () => {
    stop();
    ui.remove();
  });
  return {
    start,
    stop,
    get active() {
      return !!route;
    },
  };
}
