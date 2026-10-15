#!/bin/sh
# barreto.top: run God's Eye View with near-zero downtime across deploys.
#
# Layout on the gev_app volume:
#   /app/releases/<ref>-<keys>/   one built checkout per commit + browser keys
#   /app/releases/current         symlink to the release being served
#
# On start the current release is served at once; when GEV_REF (or a
# browser-baked key) changed, the new release is built next to it and the
# server is swapped only after the build succeeded (a few seconds of
# restart). A failed build keeps the old release online.
set -eu

REPO="${GEV_TARBALL_BASE:-https://codeload.github.com/marcobelozupkocorrea-stack/gods-eye-view/tar.gz}"
APP="${GEV_APP_DIR:-/app}"
REL="$APP/releases"
REF="${GEV_REF:?GEV_REF is required}"
KEYS=$(printf '%s' "${CESIUM_ION_TOKEN:-}${GOOGLE_MAPS_API_KEY:-}${MAPILLARY_CLIENT_TOKEN:-}" | md5sum | cut -c1-8)
WANT="$REF-$KEYS"
PID=""

log() { echo "[gev-run] $*"; }

mkdir -p "$REL"

# One-time migration from the old in-place layout (/app/.built-* marker):
# move that build into a release so it keeps serving while the new one builds.
if [ ! -e "$REL/current" ] && ls "$APP"/.built-* >/dev/null 2>&1; then
  log "migrando build antigo para $REL/legacy"
  rm -rf "$REL/legacy"
  mkdir -p "$REL/legacy"
  find "$APP" -mindepth 1 -maxdepth 1 ! -name releases ! -name 'run-*.sh' \
    -exec mv {} "$REL/legacy/" \;
  ln -sfn "$REL/legacy" "$REL/current"
fi

start() {
  dir=$(readlink -f "$REL/current")
  log "servindo $(basename "$dir")"
  # setsid + setpriv exec straight into node: $PID is the server itself.
  setsid setpriv --reuid=node --regid=node --init-groups env HOME=/home/node \
    sh -c "cd '$dir' && exec node node_modules/vite/bin/vite.js preview --host 0.0.0.0 --port 4173 --strictPort" &
  PID=$!
  i=0
  until curl -fsS -o /dev/null http://127.0.0.1:4173/ 2>/dev/null; do
    i=$((i + 1))
    if [ $i -gt 60 ] || ! kill -0 "$PID" 2>/dev/null; then
      log "servidor não respondeu"
      return 1
    fi
    sleep 1
  done
  log "no ar em ${i}s"
}

stop() {
  [ -n "$PID" ] || return 0
  kill -TERM "$PID" 2>/dev/null || true
  i=0
  while kill -0 "$PID" 2>/dev/null && [ $i -lt 20 ]; do
    sleep 0.5
    i=$((i + 1))
  done
  kill -KILL "$PID" 2>/dev/null || true
  PID=""
}

trap 'stop; exit 0' TERM INT

build() {
  tmp="$REL/.$WANT.tmp"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  log "compilando $REF"
  curl -fsSL "$REPO/$REF" -o "$tmp.tgz" || return 1
  tar xzf "$tmp.tgz" --strip-components=1 -C "$tmp" || return 1
  rm -f "$tmp.tgz"
  cur=$(readlink -f "$REL/current" 2>/dev/null || true)
  if [ -n "$cur" ] && [ -d "$cur/node_modules" ] &&
    cmp -s "$cur/package-lock.json" "$tmp/package-lock.json"; then
    # Same lockfile: reuse the installed packages instead of downloading again.
    log "pacotes iguais aos da versão atual; reaproveitando"
    cp -a "$cur/node_modules" "$tmp/" || return 1
  else
    log "instalando pacotes"
    (cd "$tmp" && timeout 900 npm ci --no-audit --no-fund --no-progress </dev/null) ||
      { log "npm ci falhou ou passou de 15 min"; return 1; }
  fi
  log "gerando build"
  (cd "$tmp" && timeout 900 npm run build </dev/null) ||
    { log "build falhou ou passou de 15 min"; return 1; }
  # Smaller copies for browsers that accept Brotli; optional.
  (cd "$tmp" && timeout 600 nice node scripts/barreto-precompress.mjs dist </dev/null) ||
    log "pré-compressão falhou; segue sem ela"
  chown -R node:node "$tmp" || return 1
  rm -rf "${REL:?}/$WANT"
  mv "$tmp" "$REL/$WANT" || return 1
  log "compilado $WANT"
}

prune() {
  keep_now=$(readlink -f "$REL/current")
  keep_prev=$(readlink -f "$REL/previous" 2>/dev/null || true)
  for d in "$REL"/*/ "$REL"/.*.tmp; do
    d=${d%/}
    [ -L "$d" ] && continue
    [ -d "$d" ] || continue
    [ "$d" = "$keep_now" ] && continue
    [ "$d" = "$keep_prev" ] && continue
    case "$d" in *.tmp) [ "$d" = "$REL/.$WANT.tmp" ] && continue ;; esac
    log "removendo $(basename "$d")"
    rm -rf "$d"
  done
}

if [ -e "$REL/current" ]; then
  start || stop
fi

if [ "$(basename "$(readlink -f "$REL/current" 2>/dev/null || echo none)")" != "$WANT" ]; then
  if [ ! -d "$REL/$WANT" ]; then
    if ! build; then
      log "FALHA ao compilar $REF; mantendo a versão anterior"
      rm -rf "$REL/.$WANT.tmp" "$REL/.$WANT.tmp.tgz"
    fi
  fi
  if [ -d "$REL/$WANT" ]; then
    old=$(readlink -f "$REL/current" 2>/dev/null || true)
    stop
    [ -n "$old" ] && ln -sfn "$old" "$REL/previous"
    ln -sfn "$REL/$WANT" "$REL/current.new"
    mv -T "$REL/current.new" "$REL/current"
    start
    prune
  fi
fi

[ -n "$PID" ] || start

# Keep the slow upstream caches warm (fires, alerts, cameras, launches…) so
# no visitor is the one waiting for a cold refresh. Disable with
# GEV_WARM_PATHS="" ; GEV_WARM_SECONDS sets the cadence.
WARM_PATHS="${GEV_WARM_PATHS-/api/firms /api/defesacivil/alerts /api/inmet/alerts /api/deter/alerts /api/cemaden/alerts /api/cctv/sources /api/launches /api/cyclones /api/vessels}"
WARM_HOST=$(printf %s "${GEV_ALLOWED_HOSTS:-localhost}" | cut -d, -f1)
if [ -n "$WARM_PATHS" ]; then
  (
    sleep 15
    while :; do
      for p in $WARM_PATHS; do
        curl -s -o /dev/null -m 180 -H "Host: ${WARM_HOST:-localhost}" \
          "http://127.0.0.1:4173$p" || true
      done
      sleep "${GEV_WARM_SECONDS:-240}"
    done
  ) </dev/null >/dev/null 2>&1 &
  log "aquecimento de cache ativo a cada ${GEV_WARM_SECONDS:-240}s"
fi

# Stay in the foreground; if the server dies, exit so Docker restarts us.
while kill -0 "$PID" 2>/dev/null; do
  sleep 5 &
  wait $! || true
done
log "servidor parou; reiniciando contêiner"
exit 1
