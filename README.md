# 90 Minutos — Animatek Timer

Timer de sesiones de productividad con dashboard, control de luces Govee, bot de Telegram con IA, overlay para OBS y sincronizacion con Google Calendar/Sheets.

## Arquitectura

```
90Minutos/
  server/          Express + WebSocket (timer, API, integraciones)
    index.js         Servidor principal, rutas API, logica del timer
    google.js        OAuth2, Calendar, Sheets
    telegram.js      Bot Telegram con comandos y NLP via Ollama
    govee.js         Control de luces Govee (presets, colores, brillo)
    ollama.js        Interprete de lenguaje natural (llama3.2:3b)
    storage.js       Lectura/escritura atomica de JSON
    data/            Config, sesiones, tokens (gitignored)
  dashboard/       Panel de control web
    index.html       UI principal
    dashboard.js     Logica del dashboard
    dashboard.css    Estilos (dark/light mode)
  overlay/         Browser source para OBS
  scripts/         Scripts auxiliares (auth, packaging, shell)
  icon/            Icono de la app
```

## Requisitos

- Node.js >= 18
- (Opcional) Ollama con `llama3.2:3b` para IA en Telegram
- (Opcional) Cuenta Google para Calendar/Sheets
- (Opcional) API Key de Govee para luces

## Instalacion

```bash
git clone <repo> && cd 90Minutos
npm install
cp .env.example .env
# Editar .env con tus credenciales
npm run dev
```

El servidor arranca en `http://127.0.0.1:5173`. El dashboard esta en `/dashboard/index.html`.

## Variables de entorno

| Variable | Descripcion | Requerida |
|----------|-------------|-----------|
| `PORT` | Puerto HTTP (default: 5173) | No |
| `HOST` | Host de escucha (default: 127.0.0.1) | No |
| `BASE_URL` | URL base para OAuth callback | No |
| `GOOGLE_CLIENT_ID` | Client ID de Google OAuth | Para Calendar/Sheets |
| `GOOGLE_CLIENT_SECRET` | Client Secret de Google OAuth | Para Calendar/Sheets |
| `SHEET_ID` | ID del Google Sheet | Para sync Sheets |
| `GOOGLE_CALENDAR_ID` | ID del calendario (default: primary) | No |
| `GOVEE_API_KEY` | API Key de Govee Developer | Para luces |
| `TELEGRAM_BOT_TOKEN` | Token del bot de Telegram | Para bot |
| `TELEGRAM_USER_ID` | Tu user ID de Telegram (unico autorizado) | Para bot |

## Comandos

```bash
npm run dev          # Iniciar servidor
npm run stop         # Detener servidor
npm run google:auth  # Abrir flujo OAuth de Google
npm run plugin:pack  # Empaquetar plugin Stream Deck
```

## Dashboard

Panel de control accesible en `http://127.0.0.1:5173/dashboard/index.html`.

### Funcionalidades

- **Control remoto** del timer (start/pause/resume/reset/finish) con WebSocket en tiempo real
- **Templates** de sesion — inicio rapido con categoria, duracion y tipo preconfigurados
- **KPI Cards** — horas totales, sesiones esta semana, duracion media, dia mas productivo
- **Heatmap de actividad** — calendario estilo GitHub contributions (~6 meses)
- **Graficos** — distribucion por categoria (donut), ultimos 7 dias (barras), tendencia mensual (line chart con area fill), radar de categorias
- **Gamificacion** — sistema de XP/niveles (10h = 1 nivel), racha diaria y mejor racha
- **Historial de sesiones** — tabla con filtros (mes, anio, categoria, tipo, URL), busqueda, paginacion (20/pagina), seleccion multiple y borrado en lote
- **Gestion de categorias** — crear, renombrar, color picker, eliminar
- **Control de luces** — encender/apagar por zona + presets (Focus, Streaming, Movie, Romantic)
- **Export CSV** — descarga de sesiones filtradas
- **Sync Google Sheets** — importar sesiones desde el Sheet configurado
- **Notas por sesion** — texto libre asociado a cada sesion
- **Dark/Light mode** — toggle con persistencia en localStorage
- **Atajos de teclado** — Space (play/pause), R (reset), Ctrl+S (guardar), ? (ayuda)

## Bot de Telegram

El bot responde solo al `TELEGRAM_USER_ID` configurado. Comandos:

| Comando | Accion |
|---------|--------|
| `/90min` | Iniciar sesion de 90 min + luces Focus |
| `/pause` `/resume` `/stop` `/reset` | Control del timer |
| `/status` | Estado del timer + luces + IA |
| `/category <nombre>` | Cambiar categoria |
| `/duration <minutos>` | Cambiar duracion |
| `/stats` | Estadisticas por categoria |
| `/sessions` | Ultimas 5 sesiones |
| `/lights` | Panel de luces con botones inline |
| `/lightson` `/lightsoff` | Encender/apagar todas |
| `/estudioon` `/estudiooff` | Control estudio |
| `/salonon` `/salonoff` | Control salon |
| `/aiload` `/aiunload` | Cargar/descargar modelo en VRAM |
| `/restart` `/kill` | Reiniciar/apagar servidor |
| *(texto libre)* | Interpretado por Ollama — controla timer y luces en lenguaje natural |

## Luces Govee

Presets disponibles:

| Preset | Estudio | Salon |
|--------|---------|-------|
| Focus | Azul claro 50% | Off |
| Streaming | Blanco 100% | Verde 10% |
| Movie | Off | Azul 5% |
| Romantic | Rojo carmesi 20% | Rojo carmesi 20% |

## API REST

Todos los endpoints escuchan en `127.0.0.1:5173`.

| Metodo | Ruta | Descripcion |
|--------|------|-------------|
| `GET` | `/api/state` | Estado actual del timer |
| `GET` | `/api/config` | Configuracion |
| `POST` | `/api/config` | Actualizar configuracion |
| `GET` | `/api/sessions` | Listar sesiones |
| `PUT` | `/api/sessions/:id` | Editar sesion |
| `DELETE` | `/api/sessions/:id` | Borrar sesion |
| `DELETE` | `/api/sessions` | Borrar todas (requiere header `X-Confirm-Delete: true`) |
| `POST` | `/api/sessions/bulk-delete` | Borrado multiple |
| `POST` | `/api/sessions/importFromSheets` | Importar desde Google Sheets |
| `GET` | `/api/stats` | Estadisticas por categoria |
| `GET` | `/api/health` | Health check del servidor |
| `GET` | `/api/google/auth` | Iniciar flujo OAuth |
| `GET` | `/api/google/callback` | Callback OAuth |
| `GET` | `/api/sheet/id` | Obtener Sheet ID configurado |
| `POST` | `/api/lights/on` `/api/lights/off` | Encender/apagar todas |
| `POST` | `/api/lights/:device/on` `/:device/off` | Control por dispositivo |
| `POST` | `/api/lights/preset/:name` | Aplicar preset |
| `GET` | `/api/lights/devices` | Listar dispositivos |
| `GET` | `/api/lights/presets` | Listar presets |
| `POST` | `/api/telegram/status` | Enviar status via Telegram |

## WebSocket

Puerto `8765` en `127.0.0.1`. Mensajes JSON:

**Server -> Client:**
- `{ type: "state", payload: { state, durationSec, remainingSec, category, ... } }`
- `{ type: "session:complete", payload: { ... } }`
- `{ type: "config:update", payload: { ... } }`

**Client -> Server:**
- `{ type: "command", action: "start|pause|resume|reset|finish|add|setCategory|setDurationSec|setLanguage|setSessionType|setSessionUrl", payload: ... }`

## Seguridad

- El servidor solo escucha en `127.0.0.1` (no accesible desde la red)
- CORS restringido a origenes exactos (`http://127.0.0.1:5173`, `http://localhost:5173`)
- Borrado masivo requiere header de confirmacion `X-Confirm-Delete`
- POST /api/config filtra solo keys permitidas (whitelist)
- Bot de Telegram solo acepta comandos del `TELEGRAM_USER_ID` configurado
- Notificaciones de escritorio usan `execFile` (sin shell) para evitar inyeccion de comandos
- Dashboard sanitiza HTML en todas las interpolaciones dinamicas
- `server/data/` y `.env` estan en `.gitignore`

## Overlay OBS

Browser source en `http://127.0.0.1:5173/overlay/index.html`. Se conecta via WebSocket y muestra el timer en tiempo real. Incluye alarma sonora al finalizar.

## Licencia

Ver [LICENSE](LICENSE).
