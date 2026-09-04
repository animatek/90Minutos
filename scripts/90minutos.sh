#!/usr/bin/env bash
# 90 Minutos — start / stop / restart / status
#
# Sin rutas fijas: el directorio de la app se deduce de la ubicación del propio
# script, así que mover el repo (o clonarlo en una Raspberry Pi) no obliga a
# editar nada aquí.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="${XDG_RUNTIME_DIR:-/tmp}/90minutos.pid"
LOG_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/90minutos.log"
ICON="$APP_DIR/icon/90.png"

# El puerto sale del .env si está definido; si no, el de por defecto.
PORT="$(grep -sE '^PORT=' "$APP_DIR/.env" | tail -1 | cut -d= -f2 | tr -d '[:space:]' || true)"
PORT="${PORT:-5173}"
URL="http://127.0.0.1:$PORT"

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

notify() {
  if command -v notify-send >/dev/null 2>&1; then
    notify-send -i "$ICON" "90 Minutos" "$1" || true
  fi
}

case "${1:-start}" in
  start)
    if is_running; then
      echo "[90Minutos] Ya está corriendo (PID $(cat "$PID_FILE"))"
    else
      mkdir -p "$(dirname "$LOG_FILE")"
      cd "$APP_DIR"
      nohup node --disable-warning=ExperimentalWarning server/index.js >>"$LOG_FILE" 2>&1 &
      # El servidor escribe su propio PID al arrancar; esperamos a que aparezca.
      for _ in $(seq 1 10); do
        sleep 0.3
        is_running && break
      done
      if is_running; then
        echo "[90Minutos] Servidor iniciado (PID $(cat "$PID_FILE"))"
      else
        echo "[90Minutos] Error al iniciar — mira $LOG_FILE"
        exit 1
      fi
    fi
    command -v xdg-open >/dev/null 2>&1 && xdg-open "$URL" >/dev/null 2>&1 || true
    ;;

  stop)
    if is_running; then
      PID="$(cat "$PID_FILE")"
      kill "$PID"
      # SIGTERM da tiempo a cerrar la base de datos y guardar el último latido.
      for _ in $(seq 1 10); do
        kill -0 "$PID" 2>/dev/null || break
        sleep 0.3
      done
      echo "[90Minutos] Servidor detenido"
    else
      echo "[90Minutos] No hay servidor corriendo"
      rm -f "$PID_FILE"
    fi
    ;;

  restart)
    "$0" stop
    sleep 1
    "$0" start
    ;;

  status)
    if ! is_running; then
      notify "Servidor detenido"
      echo "[90Minutos] Detenido"
      exit 0
    fi

    HEALTH="$(curl -s --max-time 2 "$URL/api/health" 2>/dev/null || true)"
    if [ -n "$HEALTH" ] && command -v jq >/dev/null 2>&1; then
      STATE=$(echo "$HEALTH" | jq -r '.timer.state')
      TOPIC=$(echo "$HEALTH" | jq -r '.timer.topic // "—"')
      MODE=$(echo "$HEALTH" | jq -r '.timer.mode')
      ELAPSED=$(echo "$HEALTH" | jq -r '.timer.elapsed')
      REMAINING=$(echo "$HEALTH" | jq -r '.timer.remaining // "—"')
      TODAY=$(echo "$HEALTH" | jq -r '.timer.today')
      UPTIME=$(echo "$HEALTH" | jq -r '.uptime')

      case "$STATE" in
        running) MARK="▶";; paused) MARK="⏸";; *) MARK="⏹";;
      esac

      if [ "$MODE" = "sprint" ] && [ "$STATE" != "idle" ]; then
        LINE2="⏱ $ELAPSED trabajado · quedan $REMAINING"
      else
        LINE2="⏱ $ELAPSED trabajado"
      fi
      BODY="$MARK $STATE — $TOPIC\n$LINE2\n📅 Hoy: $TODAY\n⚙ Uptime: $UPTIME"
    else
      BODY="Corriendo (PID $(cat "$PID_FILE"))"
    fi

    notify "$(echo -e "$BODY")"
    echo -e "[90Minutos] $BODY"
    ;;

  *)
    echo "Uso: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac
