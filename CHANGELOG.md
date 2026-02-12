# Changelog — 90 Minutos

## 2026-02-12

### feat: "Ver estado" con notificación de escritorio + Telegram

El botón derecho > **Ver estado** del `.desktop` ahora hace algo útil:

- Consulta `/api/health` para obtener el estado real del servidor
- Muestra una **notificación de escritorio** (`notify-send`) con: estado del timer, tiempo restante, categoría, clientes WS y uptime
- Dispara el **/status de Telegram** en background, que envía el reporte completo (timer + luces + IA) al móvil
- Ya no abre una terminal vacía esperando "Pulsa Enter"

**Archivos modificados:**

| Archivo | Cambio |
|---------|--------|
| `server/index.js` | Nuevos endpoints `GET /api/health` y `POST /api/telegram/status` |
| `server/telegram.js` | Extraída `buildStatusText()` como función reutilizable; nueva función exportada `sendStatus()` |
| `scripts/90minutos.sh` | Comando `status` mejorado: consulta API, `notify-send`, dispara Telegram |
| `90minutos.desktop` | Acción "Ver estado" ejecuta el script directamente (sin terminal) |

---

### feat: notificaciones de escritorio al iniciar y completar sesión

El servidor ahora envía notificaciones nativas de escritorio:

- **Al iniciar sesión** (desde idle): `"90 Minutos — Sesión iniciada"` con categoría y duración
- **Al completar el tiempo**: `"90 Minutos — Sesión completada"` con categoría y duración real
- No notifica al hacer resume tras una pausa (solo inicio fresh)
- Usa el icono de la app (`icon/90.png`)

**Archivos modificados:**

| Archivo | Cambio |
|---------|--------|
| `server/index.js` | Import `exec` de `child_process`; función `notify(title, body)`; llamadas en `startTimer()` y `completeSession()` |

---

### fix: enlace Laboratorio90 en dashboard

Actualizado el enlace del botón "Laboratorio 90" en el nav del dashboard.

- Antes: `animatek.net/laboratorio90/`
- Ahora: `animatek.net/90-minutos/`

**Archivos modificados:**

| Archivo | Cambio |
|---------|--------|
| `dashboard/index.html` | URL del enlace actualizada (línea 17) |
