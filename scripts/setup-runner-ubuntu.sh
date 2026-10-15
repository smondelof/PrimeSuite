#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Prime Suite · instala el runner de GitHub Actions en el servidor Ubuntu
# (se hace UNA sola vez).
#
# El runner abre una conexión saliente HTTPS hacia GitHub y espera trabajos:
# no hace falta abrir SSH ni ningún puerto de entrada.
#
# Uso:
#   1. En GitHub: repo › Settings › Actions › Runners › New self-hosted runner
#      › Linux. Copia el TOKEN que aparece en el comando "./config.sh ... --token XXXX".
#      (Caduca en 1 hora; hace falta ser administrador del repo.)
#   2. En el servidor:
#        sudo RUNNER_TOKEN=XXXX bash setup-runner-ubuntu.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/smondelof/PrimeSuite}"
RUNNER_USER="${RUNNER_USER:-gh-runner}"
RUNNER_DIR="${RUNNER_DIR:-/opt/actions-runner}"
RUNNER_NAME="${RUNNER_NAME:-$(hostname)-primesuite}"
RUNNER_LABELS="primesuite"
INSTALL_DIR="${INSTALL_DIR:-/opt/primesuite}"

ok()   { printf '\e[32m✔ %s\e[0m\n' "$*"; }
info() { printf '\e[36m→ %s\e[0m\n' "$*"; }
die()  { printf '\e[31m✘ %b\e[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Ejecútalo con sudo."
[[ -n "${RUNNER_TOKEN:-}" ]] || die "Falta RUNNER_TOKEN.  Uso: sudo RUNNER_TOKEN=XXXX bash $0"
[[ -f "$INSTALL_DIR/deploy/docker-compose.yml" ]] || die "No encuentro $INSTALL_DIR/deploy. ¿Está Prime Suite instalado?"
command -v docker >/dev/null || die "Docker no está instalado."

# ─── 1. Paquetes ─────────────────────────────────────────────────────────────
need=()
for p in curl tar rsync git python3; do command -v "$p" >/dev/null || need+=("$p"); done
if ((${#need[@]})); then
  info "Instalando: ${need[*]}"
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need[@]}"
fi

# ─── 2. Usuario del runner ───────────────────────────────────────────────────
if ! id "$RUNNER_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash "$RUNNER_USER"
  ok "Usuario $RUNNER_USER creado"
fi
usermod -aG docker "$RUNNER_USER"
ok "$RUNNER_USER puede usar Docker"

# El runner tiene que poder escribir el código y leer deploy/.env
mkdir -p "$INSTALL_DIR/backups"
chown -R "$RUNNER_USER:$RUNNER_USER" "$INSTALL_DIR"
ok "Permisos de $INSTALL_DIR asignados a $RUNNER_USER"

# ─── 3. Descargar el runner ──────────────────────────────────────────────────
case "$(uname -m)" in
  x86_64)  ARCH=x64 ;;
  aarch64) ARCH=arm64 ;;
  *) die "Arquitectura no soportada: $(uname -m)" ;;
esac
VERSION="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"].lstrip("v"))')"
[[ -n "$VERSION" ]] || die "No se pudo averiguar la última versión del runner."

mkdir -p "$RUNNER_DIR"
chown "$RUNNER_USER:$RUNNER_USER" "$RUNNER_DIR"
if [[ ! -f "$RUNNER_DIR/config.sh" ]]; then
  info "Descargando actions-runner $VERSION ($ARCH)…"
  TGZ="actions-runner-linux-$ARCH-$VERSION.tar.gz"
  sudo -u "$RUNNER_USER" curl -fsSL -o "$RUNNER_DIR/$TGZ" \
    "https://github.com/actions/runner/releases/download/v$VERSION/$TGZ"
  sudo -u "$RUNNER_USER" tar xzf "$RUNNER_DIR/$TGZ" -C "$RUNNER_DIR"
  rm -f "$RUNNER_DIR/$TGZ"
  "$RUNNER_DIR/bin/installdependencies.sh" >/dev/null
fi
ok "Runner descargado en $RUNNER_DIR"

# ─── 4. Registrar y arrancar como servicio ───────────────────────────────────
cd "$RUNNER_DIR"
if [[ -f .runner ]]; then
  ./svc.sh stop >/dev/null 2>&1 || true
  ./svc.sh uninstall >/dev/null 2>&1 || true
fi
sudo -u "$RUNNER_USER" ./config.sh --unattended --replace \
  --url "$REPO_URL" --token "$RUNNER_TOKEN" \
  --name "$RUNNER_NAME" --labels "$RUNNER_LABELS" --work _work
./svc.sh install "$RUNNER_USER"
./svc.sh start
ok "Runner '$RUNNER_NAME' registrado y en marcha como servicio"

cat <<EOF

────────────────────────────────────────────────────────────────────
 Runner instalado. En GitHub › Settings › Actions › Runners debe
 aparecer '$RUNNER_NAME' como "Idle".

 A partir de ahora cada push a main despliega en $INSTALL_DIR.
 Estado del servicio:  sudo $RUNNER_DIR/svc.sh status
 Logs del runner:      journalctl -u 'actions.runner.*' -f
────────────────────────────────────────────────────────────────────
EOF
