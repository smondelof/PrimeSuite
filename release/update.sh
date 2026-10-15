#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Prime Suite · cambiar de versión una instalación hecha con install.sh
#
#   bash update.sh 1.1.0                         # desde la carpeta de la instalación
#   bash update.sh --dir /opt/primesuite-prod    # desde un paquete nuevo descomprimido:
#                                                #   actualiza también docker-compose.yml y
#                                                #   los scripts, e instala la versión del paquete
# Qué hace:
#   1. Descarga la imagen de la versión pedida (si no existe, no cambia nada).
#   2. Copia de seguridad de los datos en DIR/backups (npm run backup).
#   3. Cambia PRIME_VERSION en .env y reinicia la app.
#   4. Comprueba /api/health; si falla, vuelve a la versión anterior.
# Nunca toca .env (salvo PRIME_VERSION y, desde un paquete, PRIME_IMAGE), certs/, backups/ ni el volumen de datos.
# Para volver atrás basta con: bash update.sh <versión anterior>
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ok()   { printf '\e[32m✔ %s\e[0m\n' "$*"; }
info() { printf '\e[36m→ %s\e[0m\n' "$*"; }
warn() { printf '\e[33m! %s\e[0m\n' "$*"; }
die()  { printf '\e[31m✘ %b\e[0m\n' "$*" >&2; exit 1; }

DIR="$PKG" VERSION="" KEEP_BACKUPS="${KEEP_BACKUPS:-15}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    -*) die "Opción desconocida: $1" ;;
    *) VERSION="$1"; shift ;;
  esac
done
DIR="$(cd "$DIR" 2>/dev/null && pwd)" || die "No existe la carpeta de la instalación."
FROM_PKG=""; [[ "$PKG" != "$DIR" ]] && FROM_PKG=1
[[ -z "$VERSION" && -n "$FROM_PKG" ]] && VERSION="$(cat "$PKG/VERSION" 2>/dev/null || true)"

[[ -f "$DIR/.env" ]] || die "No hay instalación en $DIR (falta .env). Instala primero con install.sh."
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Indica la versión: bash update.sh X.Y.Z"
docker info >/dev/null 2>&1 || die "Este usuario no puede usar Docker (¿está en el grupo docker?)."

getv() { grep -E "^$1=" "$DIR/.env" | tail -n1 | cut -d= -f2- || true; }
setv() {
  local k="$1" v="$2" f="$DIR/.env"
  awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k{print k"="v; s=1; next} {print} END{if(!s) print k"="v}' "$f" > "$f.tmp" \
    && cat "$f.tmp" > "$f" && rm -f "$f.tmp"   # cat > conserva permisos y dueño de .env
}

NAME="$(getv COMPOSE_PROJECT_NAME)"; OLD="$(getv PRIME_VERSION)"; PORT="$(getv APP_PORT)"
[[ -n "$NAME" && -n "$OLD" && -n "$PORT" ]] || die "Al .env le falta COMPOSE_PROJECT_NAME, PRIME_VERSION o APP_PORT."
cd "$DIR"
info "Instalación $NAME: $OLD → $VERSION"

# Imagen: si el paquete trae otra (p. ej. porque el repo cambió de dueño), se adopta.
OLD_IMAGE="$(getv PRIME_IMAGE)"; IMAGE="$OLD_IMAGE"
if [[ -n "$FROM_PKG" ]]; then
  PKG_IMAGE="$(grep -E '^PRIME_IMAGE=' "$PKG/.env.example" 2>/dev/null | cut -d= -f2- || true)"
  if [[ -n "$PKG_IMAGE" && "$PKG_IMAGE" != "$OLD_IMAGE" ]]; then
    IMAGE="$PKG_IMAGE"
    info "Imagen: ${OLD_IMAGE:-(por defecto)} → $IMAGE"
  fi
fi

# ─── 1. Descargar la versión nueva (sin tocar nada todavía) ──────────────────
PRIME_IMAGE="$IMAGE" PRIME_VERSION="$VERSION" docker compose pull app \
  || die "No se pudo descargar la versión $VERSION. No se ha cambiado nada."
ok "Imagen $VERSION descargada"

# ─── 2. Copia de seguridad ───────────────────────────────────────────────────
mkdir -p "$DIR/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
if docker compose ps --status running --services 2>/dev/null | grep -qx app; then
  if docker compose exec -T app npm run --silent backup /data/backup-preupdate.json >/dev/null 2>&1 \
     && docker compose cp app:/data/backup-preupdate.json "$DIR/backups/$NAME-$OLD-$STAMP.json" >/dev/null 2>&1; then
    ok "Backup: $DIR/backups/$NAME-$OLD-$STAMP.json"
  else
    warn "No se pudo hacer el backup con 'npm run backup'; se continúa (el volumen de datos no se toca)."
  fi
fi
ls -1t "$DIR/backups/$NAME"-*.json 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -f || true

# ─── 3. Ficheros del paquete nuevo (si se ejecuta desde uno) ─────────────────
if [[ -n "$FROM_PKG" ]]; then
  mkdir -p "$DIR/.previous"
  for f in docker-compose.yml Caddyfile .env.example install.sh update.sh LEEME.md VERSION; do
    if [[ -f "$DIR/$f" ]]; then cp -p "$DIR/$f" "$DIR/.previous/$f"; fi
    if [[ -f "$PKG/$f" ]]; then cp "$PKG/$f" "$DIR/$f"; fi
  done
  ok "Ficheros de la instalación actualizados (copia de los anteriores en .previous/)"
fi

# ─── 4. Cambiar de versión y reiniciar ───────────────────────────────────────
setv PRIME_VERSION "$VERSION"
if [[ "$IMAGE" != "$OLD_IMAGE" ]]; then setv PRIME_IMAGE "$IMAGE"; fi
docker compose up -d
health() {
  for _ in $(seq 1 40); do
    if out="$(curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null)" && grep -q "\"version\":\"$1\"" <<<"$out"; then
      echo "$out"; return 0
    fi
    sleep 3
  done
  return 1
}
info "Esperando a que responda http://127.0.0.1:$PORT/api/health…"
if out="$(health "$VERSION")"; then
  ok "Prime Suite $VERSION en marcha: $out"
  echo "$VERSION $(date '+%F %T') (antes $OLD)" >> "$DIR/versiones.log"
  docker image prune -f >/dev/null 2>&1 || true
  exit 0
fi

# ─── 5. Vuelta atrás ─────────────────────────────────────────────────────────
docker compose logs --tail=60 app || true
warn "La versión $VERSION no responde. Volviendo a $OLD…"
setv PRIME_VERSION "$OLD"
if [[ "$IMAGE" != "$OLD_IMAGE" ]]; then setv PRIME_IMAGE "$OLD_IMAGE"; fi
if [[ -n "$FROM_PKG" ]]; then
  for f in "$DIR"/.previous/*; do if [[ -f "$f" ]]; then cp -p "$f" "$DIR/$(basename "$f")"; fi; done
fi
docker compose up -d
health "$OLD" >/dev/null && die "Actualización a $VERSION FALLIDA: se ha restaurado la versión $OLD." \
  || die "Actualización a $VERSION FALLIDA y la versión $OLD tampoco responde. Revisa: cd $DIR && docker compose logs app"
