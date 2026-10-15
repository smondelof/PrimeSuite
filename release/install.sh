#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Prime Suite · instalación desde el paquete publicado
#
#   bash install.sh --dir /opt/primesuite-prod --issuer https://dominio:8443 --port 18081
#
# Opciones:
#   --dir DIR          carpeta de la instalación          (por defecto /opt/primesuite-prod)
#   --name NOMBRE      nombre de la instalación           (por defecto, el de la carpeta)
#   --issuer URL       URL https exacta de acceso, con puerto si no es 443   (obligatoria)
#   --port PUERTO      puerto interno publicado en el host                   (por defecto 18081)
#   --bind IP          127.0.0.1 (por defecto) o 0.0.0.0
#   --version X.Y.Z    versión a instalar                 (por defecto, la de este paquete)
#   --cookie NOMBRE    cookie de sesión (ps_…)            (por defecto ps_session_<nombre>)
#   --tls              HTTPS directo con Caddy (certificado en DIR/certs/)
#   --certs CARPETA    HTTPS directo con el certificado de otra carpeta (implica --tls)
#   --https-port P     puerto HTTPS público del modo --tls (por defecto, el de --issuer)
#   --yes              no preguntar nada
#
# Nunca toca otras instalaciones: si el nombre, el contenedor, el volumen de datos o el
# puerto ya existen, se detiene sin cambiar nada.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ok()   { printf '\e[32m✔ %s\e[0m\n' "$*"; }
info() { printf '\e[36m→ %s\e[0m\n' "$*"; }
warn() { printf '\e[33m! %s\e[0m\n' "$*"; }
die()  { printf '\e[31m✘ %b\e[0m\n' "$*" >&2; exit 1; }

DIR=/opt/primesuite-prod NAME="" ISSUER="" PORT=18081 BIND=127.0.0.1 VERSION="" COOKIE="" TLS="" CERTS="" HTTPS_PORT="" YES=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --issuer) ISSUER="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --bind) BIND="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --cookie) COOKIE="$2"; shift 2 ;;
    --tls) TLS=1; shift ;;
    --certs) CERTS="${2%/}"; TLS=1; shift 2 ;;
    --https-port) HTTPS_PORT="$2"; shift 2 ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) die "Opción desconocida: $1 (usa --help)" ;;
  esac
done

DIR="${DIR%/}"
NAME="${NAME:-$(basename "$DIR")}"
VERSION="${VERSION:-$(cat "$PKG/VERSION" 2>/dev/null || true)}"
COOKIE="${COOKIE:-ps_session_${NAME//-/_}}"

if [[ -z "$ISSUER" && -z "$YES" && -t 0 ]]; then
  read -rp "URL de acceso (https://dominio[:puerto]): " ISSUER
fi
ISSUER="${ISSUER%/}"

# ─── Comprobaciones (no se cambia nada si algo falla aquí) ──────────────────
[[ "$NAME" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || die "Nombre de instalación no válido: «$NAME» (minúsculas, números y guiones)."
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Versión no válida: «$VERSION»."
[[ "$ISSUER" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || die "Indica --issuer con la URL https exacta, sin ruta (p. ej. https://primesuite.empresa.com:8443)."
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || die "Puerto no válido: $PORT"
[[ "$BIND" == 127.0.0.1 || "$BIND" == 0.0.0.0 ]] || die "--bind debe ser 127.0.0.1 o 0.0.0.0"
[[ "$COOKIE" =~ ^ps_[A-Za-z0-9_]{1,40}$ ]] || die "La cookie debe empezar por ps_ (letras, números y _)."
DOMAIN="$(sed -E 's#^https://([^:/]+).*#\1#' <<<"$ISSUER")"
ISSUER_PORT="$(sed -nE 's#^https://[^:/]+:([0-9]+)$#\1#p' <<<"$ISSUER")"
HTTPS_PORT="${HTTPS_PORT:-${ISSUER_PORT:-443}}"

command -v docker >/dev/null || die "Falta Docker."
docker compose version >/dev/null 2>&1 || die "Falta Docker Compose v2 (docker compose)."
docker info >/dev/null 2>&1 || die "Este usuario no puede usar Docker (¿está en el grupo docker?)."
command -v curl >/dev/null || die "Falta curl."

[[ -e "$DIR/.env" ]] && die "Ya hay una instalación en $DIR. Para cambiar de versión usa update.sh."
docker ps -a --format '{{.Names}}' | grep -qx "$NAME" && die "Ya existe un contenedor llamado «$NAME». Elige otro --name."
docker volume ls --format '{{.Name}}' | grep -qx "${NAME}_prime-data" \
  && die "Ya existe el volumen de datos «${NAME}_prime-data» (¿una instalación anterior?). No se reutiliza para no mezclar datos."
port_busy() { if command -v ss >/dev/null; then ss -Hltn "sport = :$1" | grep -q .; else (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; fi; }
port_busy "$PORT" && die "El puerto $PORT ya está en uso en este servidor. Elige otro --port."
if [[ -n "$TLS" ]]; then
  port_busy "$HTTPS_PORT" && die "El puerto HTTPS $HTTPS_PORT ya está en uso. Elige otro."
  if [[ -n "$CERTS" ]]; then
    [[ "$CERTS" == /* ]] || die "--certs debe ser una ruta absoluta."
    [[ -r "$CERTS/fullchain.pem" && -r "$CERTS/privkey.pem" ]] \
      || die "No se pueden leer $CERTS/fullchain.pem y $CERTS/privkey.pem con este usuario."
  fi
fi
IMAGE="$(grep -E '^PRIME_IMAGE=' "$PKG/.env.example" | cut -d= -f2-)"
IMAGE="${IMAGE:-ghcr.io/smondelof/primesuite}"

cat <<EOF

  Instalación     $NAME
  Carpeta         $DIR
  Versión         $VERSION
  URL de acceso   $ISSUER
  Puerto interno  $BIND:$PORT
  Cookie sesión   $COOKIE
  HTTPS directo   $([[ -n "$TLS" ]] && echo "sí, puerto $HTTPS_PORT (certificado en ${CERTS:-$DIR/certs})" || echo "no (lo termina vuestro balanceador/proxy)")

EOF
if [[ -z "$YES" && -t 0 ]]; then
  read -rp "¿Continuar? [s/N] " r; [[ "$r" =~ ^[sSyY]$ ]] || die "Cancelado."
fi

# ─── Descargar la imagen antes de escribir nada ─────────────────────────────
info "Descargando la imagen $IMAGE:$VERSION…"
docker pull "$IMAGE:$VERSION" \
  || die "No se pudo descargar $IMAGE:$VERSION. ¿Existe la versión y la imagen es pública? No se ha cambiado nada."

# ─── Ficheros de la instalación ─────────────────────────────────────────────
mkdir -p "$DIR/backups" || die "No se puede crear $DIR (¿permisos? sudo mkdir -p $DIR && sudo chown \$USER $DIR)."
if [[ "$PKG" != "$(cd "$DIR" && pwd)" ]]; then
  for f in docker-compose.yml Caddyfile .env.example install.sh update.sh LEEME.md VERSION; do
    if [[ -f "$PKG/$f" ]]; then cp "$PKG/$f" "$DIR/$f"; fi
  done
fi
if [[ -n "$TLS" && -z "$CERTS" ]]; then
  mkdir -p "$DIR/certs"
  [[ -f "$DIR/certs/fullchain.pem" && -f "$DIR/certs/privkey.pem" ]] \
    || warn "Falta el certificado: copia fullchain.pem y privkey.pem en $DIR/certs/ antes de usar HTTPS."
fi

if command -v openssl >/dev/null; then SECRET="$(openssl rand -base64 48 | tr -d '\n')"
else SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '\n')"; fi

setv() { # setv CLAVE VALOR  (sustituye la línea CLAVE=… o la añade)
  local k="$1" v="$2" f="$DIR/.env"
  if grep -qE "^$k=" "$f"; then
    awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  else echo "$k=$v" >> "$f"; fi
}
umask 077
cp "$DIR/.env.example" "$DIR/.env"
setv COMPOSE_PROJECT_NAME "$NAME"
setv PRIME_VERSION "$VERSION"
setv PRIME_ISSUER "$ISSUER"
setv PRIME_SECRET_KEY "$SECRET"
setv PRIME_COOKIE_NAME "$COOKIE"
setv APP_PORT "$PORT"
setv APP_BIND "$BIND"
setv PRIME_DOMAIN "$DOMAIN"
setv HTTPS_PORT "$HTTPS_PORT"
if [[ -n "$TLS" ]]; then setv COMPOSE_PROFILES tls; fi
if [[ -n "$CERTS" ]]; then setv CERTS_DIR "$CERTS"; fi
chmod 600 "$DIR/.env"
ok "Configuración creada en $DIR/.env"

# ─── Arranque ───────────────────────────────────────────────────────────────
cd "$DIR"
docker compose pull -q 2>/dev/null || true
docker compose up -d || die "No se pudo arrancar. La configuración queda en $DIR/.env; revisa y ejecuta: cd $DIR && docker compose up -d"
info "Esperando a que responda http://127.0.0.1:$PORT/api/health…"
for _ in $(seq 1 40); do
  if out="$(curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null)"; then
    ok "Prime Suite $VERSION en marcha: $out"
    cat <<EOF

  Siguiente paso: abre $ISSUER y completa el asistente de primera configuración.

  IMPORTANTE: guarda una copia segura de $DIR/.env (contiene PRIME_SECRET_KEY,
  sin la que no se pueden leer los secretos guardados).
  Cambiar de versión:  bash $DIR/update.sh X.Y.Z

EOF
    exit 0
  fi
  sleep 3
done
docker compose logs --tail=60 app || true
die "La app no responde en el puerto $PORT. Revisa los logs de arriba (cd $DIR && docker compose logs app)."
