#!/usr/bin/env bash
# 90 Minutos — start / stop / status
set -euo pipefail

APP_DIR="/mnt/SPEED/CODE/90Minutos"
PID_FILE="$APP_DIR/.server.pid"
URL="http://127.0.0.1:5173"

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

case "${1:-start}" in
  start)
    if is_running; then
      echo "[90Minutos] Ya está corriendo (PID $(cat "$PID_FILE"))"
    else
      cd "$APP_DIR"
      nohup node server/index.js > /tmp/90minutos.log 2>&1 &
      sleep 1
      if is_running; then
        echo "[90Minutos] Servidor iniciado (PID $(cat "$PID_FILE"))"
      else
        echo "[90Minutos] Error al iniciar — ver /tmp/90minutos.log"
        exit 1
      fi
    fi
    xdg-open "$URL" 2>/dev/null || true
    ;;
  stop)
    if is_running; then
      kill "$(cat "$PID_FILE")"
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
    if is_running; then
      # Query the health endpoint for live info
      HEALTH=$(curl -s --max-time 2 "$URL/api/health" 2>/dev/null)
      if [ -n "$HEALTH" ] && command -v jq &>/dev/null; then
        TIMER_STATE=$(echo "$HEALTH" | jq -r '.timer.state')
        REMAINING=$(echo "$HEALTH" | jq -r '.timer.remaining')
        CATEGORY=$(echo "$HEALTH" | jq -r '.timer.category')
        UPTIME=$(echo "$HEALTH" | jq -r '.uptime')
        WS=$(echo "$HEALTH" | jq -r '.wsClients')

        case "$TIMER_STATE" in
          running) ICON="▶️";; paused) ICON="⏸️";; *) ICON="⏹️";;
        esac

        BODY="$ICON Timer: $TIMER_STATE — $REMAINING\n🎹 $CATEGORY\n🔌 $WS clientes WS\n⏱️ Uptime: $UPTIME"
      else
        BODY="Corriendo (PID $(cat "$PID_FILE"))"
      fi
      # Desktop notification
      notify-send -i "$APP_DIR/icon/90.png" "90 Minutos" "$(echo -e "$BODY")" 2>/dev/null
      # Trigger Telegram /status report
      curl -s --max-time 5 -X POST "$URL/api/telegram/status" >/dev/null 2>&1 &
      echo -e "[90Minutos] $BODY"
    else
      notify-send -i "$APP_DIR/icon/90.png" "90 Minutos" "Servidor detenido" 2>/dev/null
      echo "[90Minutos] Detenido"
    fi
    ;;
  *)
    echo "Uso: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac
