#!/usr/bin/env bash
# Instala el lanzador calculando la ruta actual del repo. El archivo generado
# puede usar una ruta absoluta porque vive fuera del código y pertenece a esta
# instalación concreta.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPLICATIONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
TARGET="$APPLICATIONS_DIR/90minutos.desktop"

escaped_app_dir="${APP_DIR//\\/\\\\}"
escaped_app_dir="${escaped_app_dir//&/\\&}"
escaped_app_dir="${escaped_app_dir//|/\\|}"

mkdir -p "$APPLICATIONS_DIR"
sed "s|@APP_DIR@|$escaped_app_dir|g" "$APP_DIR/90minutos.desktop" >"$TARGET"
chmod 755 "$TARGET"

echo "[90Minutos] Lanzador instalado en $TARGET"
