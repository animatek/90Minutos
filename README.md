# 90 Minutos — Animatek Timer

Timer de sesiones de productividad con dashboard, sincronización con Google Calendar/Sheets y overlay para OBS.

## Arquitectura

```
90Minutos/
  server/          Express + WebSocket (timer, API, integraciones)
    index.js         Servidor principal, rutas API, lógica del timer
    google.js        OAuth2, Calendar, Sheets
    storage.js       Lectura/escritura atómica de JSON
    data/            Config, sesiones, tokens (gitignored)
  dashboard/       Panel de control web
    index.html       UI principal
    dashboard.js     Lógica del dashboard
    dashboard.css    Estilos (dark/light mode)
  overlay/         Browser source para OBS
  scripts/         Scripts auxiliares (auth, packaging, shell)
  icon/            Icono de la app
```

## Requisitos

- Node.js >= 18
- (Opcional) Cuenta Google para Calendar/Sheets

## Instalación

```bash
git clone <repo> && cd 90Minutos
npm install
cp .env.example .env
# Editar .env con tus credenciales
npm run dev
```

El servidor arranca en `http://127.0.0.1:5173`. El dashboard está en `/dashboard/index.html`.

## Variables de entorno

| Variable | Descripción | Requerida |
|----------|-------------|-----------|
| `PORT` | Puerto HTTP (default: 5173) | No |
| `HOST` | Host de escucha (default: 127.0.0.1) | No |
| `BASE_URL` | URL base para OAuth callback | No |
| `GOOGLE_CLIENT_ID` | Client ID de Google OAuth | Para Calendar/Sheets |
| `GOOGLE_CLIENT_SECRET` | Client Secret de Google OAuth | Para Calendar/Sheets |
| `SHEET_ID` | ID del Google Sheet | Para sync Sheets |
| `GOOGLE_CALENDAR_ID` | ID del calendario (default: primary) | No |

## Comandos

```bash
npm run dev          # Iniciar servidor
npm run stop         # Detener servidor
npm run google:auth  # Abrir flujo OAuth de Google
```

## Dashboard

Panel de control accesible en `http://127.0.0.1:5173/dashboard/index.html`.

### Funcionalidades

- **Control remoto** del timer (start/pause/resume/reset/finish) con WebSocket en tiempo real
- **Templates** de sesión — inicio rápido con categoría, duración y tipo preconfigurados
- **KPI Cards** — horas totales, sesiones esta semana, duración media, día más productivo
- **Heatmap de actividad** — calendario estilo GitHub contributions (~6 meses)
- **Gráficos** — distribución por categoría (donut), últimos 7 días (barras), tendencia mensual (line chart), radar de categorías
- **Gamificación** — sistema de XP/niveles (10h = 1 nivel), racha diaria y mejor racha
- **Achievements** — 13 badges desbloqueables
- **Vista calendario mensual** — navegación mes a mes con horas por día
- **Comparativa semanal** — esta semana vs anterior con delta porcentual
- **Historial de sesiones** — tabla con filtros, búsqueda, paginación (20/página), selección múltiple y borrado en lote
- **Gestión de categorías** — crear, renombrar, color picker, eliminar
- **Export CSV** — descarga de sesiones filtradas
- **Sync Google Sheets** — importar sesiones desde el Sheet configurado
- **Backup/Restore** — exportar/importar config + sesiones como JSON
- **Duplicar sesión** — clonar una sesión existente
- **Notas por sesión** — texto libre asociado a cada sesión
- **Modo Pomodoro** — ciclos trabajo/descanso configurables
- **Dark/Light mode** — toggle con persistencia en localStorage
- **Atajos de teclado** — Space (play/pause), R (reset), Ctrl+S (guardar), ? (ayuda)

## API REST

Todos los endpoints escuchan en `127.0.0.1:5173`.

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/state` | Estado actual del timer |
| `GET` | `/api/config` | Configuración |
| `POST` | `/api/config` | Actualizar configuración |
| `GET` | `/api/sessions` | Listar sesiones |
| `POST` | `/api/sessions` | Crear/duplicar sesión |
| `PUT` | `/api/sessions/:id` | Editar sesión |
| `DELETE` | `/api/sessions/:id` | Borrar sesión |
| `DELETE` | `/api/sessions` | Borrar todas (requiere header `X-Confirm-Delete: true`) |
| `POST` | `/api/sessions/bulk-delete` | Borrado múltiple |
| `POST` | `/api/sessions/importFromSheets` | Importar desde Google Sheets |
| `GET` | `/api/stats` | Estadísticas por categoría |
| `GET` | `/api/health` | Health check del servidor |
| `GET` | `/api/backup` | Exportar backup completo |
| `POST` | `/api/restore` | Restaurar desde backup |
| `GET` | `/api/google/auth` | Iniciar flujo OAuth |
| `GET` | `/api/google/callback` | Callback OAuth |
| `GET` | `/api/sheet/id` | Obtener Sheet ID configurado |

## WebSocket

Puerto `8765` en `127.0.0.1`. Mensajes JSON:

**Server → Client:**
- `{ type: "state", payload: { state, durationSec, remainingSec, category, ... } }`
- `{ type: "session:complete", payload: { ... } }`
- `{ type: "config:update", payload: { ... } }`

**Client → Server:**
- `{ type: "command", action: "start|pause|resume|reset|finish|add|setCategory|setDurationSec|setLanguage|setSessionType|setSessionUrl", payload: ... }`

## Seguridad

- El servidor solo escucha en `127.0.0.1` (no accesible desde la red)
- CORS restringido a orígenes exactos (`http://127.0.0.1:5173`, `http://localhost:5173`)
- Borrado masivo requiere header de confirmación `X-Confirm-Delete`
- POST /api/config filtra solo keys permitidas (whitelist)
- Notificaciones de escritorio usan `execFile` (sin shell) para evitar inyección de comandos
- Dashboard sanitiza HTML en todas las interpolaciones dinámicas
- `server/data/` y `.env` están en `.gitignore`

## Overlay OBS

Browser source en `http://127.0.0.1:5173/overlay/index.html`. Se conecta vía WebSocket y muestra el timer en tiempo real con dial de progreso y alarma sonora al finalizar.

## Licencia

Ver [LICENSE](LICENSE).
