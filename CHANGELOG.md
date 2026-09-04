# Changelog — 90 Minutos

## 2026-07-25 — v4.0.0

### feat: de cronómetro de streaming a registro de tiempo por temas

Reescritura del núcleo. La app pedía saber la duración *antes* de empezar y guardaba
en JSON con Google Sheets de hecho como base de datos. Ahora eliges un tema, cuenta,
y paras cuando quieras.

**Dos modos**

- **Abierto** — cuenta arriba en un tema hasta que paras.
- **Sprint** — cuenta atrás con alarma (90 min por defecto). Al llegar al objetivo
  guarda y para, o avisa y sigue en prórroga (configurable).

Cambiar de tema cierra la sesión anterior y abre la nueva en un solo gesto.

**El tiempo se calcula, no se decrementa**

Una sesión guarda segmentos de trabajo (`segments`) y la duración es su suma.

- **Corregido: el tiempo en pausa se contaba como trabajado.** `completeSession`
  hacía `fin - inicio`, así que pausar 40 min para comer añadía 40 min a la sesión.
- **Corregido: el contador derivaba y se perdía al suspender.** Restaba un segundo
  por tick con `setInterval`; ahora todo sale de timestamps.
- **Corregido: una sesión activa se perdía al reiniciar.** El estado vivía en
  variables de memoria. Ahora la sesión activa *es* la fila con `ended_at IS NULL`.
- **Nuevo: recuperación tras un corte brusco.** Se escribe `heartbeat_at` cada 15 s;
  al arrancar, el segmento abierto se cierra en el último latido y la sesión queda en
  pausa. Máximo 15 s perdidos, en vez de registrar las horas que el equipo pasó apagado.

**SQLite en lugar de JSON + Sheets**

- Un solo archivo en `~/.local/share/90minutos/90minutos.db`, fuera del repo:
  ajustes, temas y sesiones. Mudarlo es copiar un archivo.
- Usa el SQLite integrado en Node (>= 22): **cero dependencias nativas**, nada que
  compilar al pasar a ARM.
- **Corregido: 36 ids duplicados afectaban a 110 de 149 sesiones.** El import de
  Sheets usaba el mediodía de la fecha como id, así que todas las sesiones de un
  mismo día compartían id y `DELETE /api/sessions/:id` borraba el día entero.
- **Eliminado `importFromSheets`**, que sobreescribía `sessions.json` completo y
  perdía notas, URLs y horas reales.
- Migración con `--dry-run`, copia de seguridad previa y verificación de que las
  sesiones y las horas cuadran exactamente con el JSON original.

**Temas en lugar de categorías de texto libre**

- Tabla `topics` con color, archivado y fusión. 33 categorías escritas a mano se
  unificaron en 32 temas (`B2.1 Inglés` + `Inglés B2.1` → un solo tema de 33 sesiones,
  `Streaming ` con espacio final, `bitwig`, `Obisidan`).
- Borrar un tema con historial devuelve `409` y propone archivar o fusionar.
- **Corregido: `deleteTopic` nunca comprobaba si el tema tenía sesiones** (`getTopic`
  no traía `session_count`), así que el borrado llegaba a estrellarse contra la clave
  ajena con un error incomprensible.

**Google fuera**

Eliminados `server/google.js`, `scripts/open-auth.mjs`, OAuth, tokens y la
dependencia `googleapis`. El export a CSV es local. Una pieza menos que reconfigurar
al mudar el servidor.

**Panel**

- Rejilla de temas para arrancar con un clic, selector de modo y estado por color.
- Control principal reorganizado en reloj, modo y rejilla de temas; las acciones
  muestran solo lo que aplica y los detalles aprovechan todo el ancho disponible.
- Campo «Tema nuevo» bajo Abierto/Sprint: crea el tema y empieza a contar con el
  modo elegido en un solo gesto. La sección inferior queda para renombrar,
  archivar, fusionar y recolorear.
- Idioma y tipo de sesión desaparecen del panel por no aportar ya al flujo; se
  conservan en importaciones y backups antiguos por compatibilidad.
- El historial permite editar tema, fecha, duración, URL de vídeo y notas. Las
  filas sin enlace muestran «Añadir URL» directamente.
- Navegación separada en **Control** y **Estadísticas**, inspirada en la página
  pública de Laboratorio 90: el trabajo diario ya no se mezcla con el análisis.
- Resumen de progreso semanal, mensual y anual con barras y objetivo semanal
  configurable; mes y año se derivan ×4 y ×52.
- El tema claro se aplica antes de cargar el CSS, eliminando el destello oscuro
  que aparecía al recargar la página.
- Layout comprobado en escritorio, tablet y móvil.
- Gráficas en SVG propio: se elimina Chart.js desde CDN, que rompía el panel sin red.
- Paleta categórica de ocho tonos con pasos propios para claro y oscuro, verificada
  con validador. **Corregido: los colores se repartían al azar entre 32 categorías,
  así que los dos temas con más horas podían compartir tono.**
- Los temas más allá del octavo se agrupan en «Otros» en vez de repetir colores.
- `?theme=light|dark` para forzar el tema.

**Red**

- `HOST` y `AUTH_TOKEN` configurables. Si `HOST` no es loopback y falta el token,
  el servidor **se niega a arrancar** en lugar de quedar abierto en la red.
- El overlay y el panel deducen el host de la página, así que funcionan igual
  servidos por Tailscale.
- El panel y el overlay descubren `WS_PORT` desde `/api/health`; ya no pueden
  conectarse por accidente a otra instancia que esté escuchando en `8765`.

**Sin rutas fijas**

`scripts/90minutos.sh` deduce el directorio de la app de su propia ubicación;
`/mnt/SPEED/CODE/90Minutos` ya no está escrito a mano en el código.

**Pruebas**

`npm test` — 20 pruebas sobre la lógica de duración: exclusión de pausas,
recuperación tras cortes, ciclo de vida, sprint, fusión y borrado de temas.

**Eliminado**

Pomodoro (lo cubre el modo sprint con duración configurable), templates de sesión
(los sustituye la rejilla de temas + modos), y código muerto del panel: lista de
tareas y controles de luces Govee cuyos elementos HTML ya no existían.

## 2026-02-12

### feat: dashboard v4 — Pomodoro, auto-luces, calendario, achievements, backup

**Nuevas funcionalidades:**

- **Modo Pomodoro** — ciclos trabajo/descanso configurables con rounds, estado sincronizado server-side via WebSocket
- **Auto-preset luces por categoria** — mapeo categoria→preset que aplica iluminacion automaticamente al iniciar sesion
- **Vista calendario mensual** — calendario con navegacion mes a mes, horas por dia, puntos de color por categoria, responsive
- **Comparativa semanal** — widget "esta semana vs anterior" con delta porcentual en horas y sesiones
- **Sistema de Achievements** — 13 badges desbloqueables (Primera sesion, Maraton, Noctambulo, etc.) con iconos y tooltips
- **Color del timer** — verde running, amarillo paused, glow animado segun estado
- **Backup/Restore** — exportar/importar config + sesiones como JSON
- **Duplicar sesion** — boton en tabla para clonar una sesion existente

**Archivos modificados:**

| Archivo | Cambios |
|---------|---------|
| `server/index.js` | Pomodoro state + WS commands, autoLightsForCategory(), POST /api/sessions (duplicate), GET /api/backup, POST /api/restore |
| `dashboard/index.html` | Pomodoro controls, calendar section, achievements container, backup/restore buttons, week comparison widget, auto-lights mapping |
| `dashboard/dashboard.css` | Timer state colors, pomodoro styles, calendar grid/day styles, achievements badges, week comparison, light mapping, responsive calendar |
| `dashboard/dashboard.js` | renderCalendar(), Pomodoro UI sync, achievements system, renderLightMapping(), backup/restore/duplicate handlers, week comparison in renderKPIs() |

---

### feat: dashboard v3 — KPIs, heatmap, charts mejorados, paginacion, busqueda

**Nuevas funcionalidades:**

- **KPI Cards** — 4 tarjetas resumen: horas totales, sesiones esta semana, duracion media, dia mas productivo
- **Heatmap de actividad** — calendario estilo GitHub contributions (~26 semanas), coloreado por intensidad de horas, con tooltip por dia
- **Busqueda de sesiones** — input de busqueda que filtra por categoria, notas, URL y nombre de sesion con debounce 300ms
- **Paginacion** — 20 sesiones por pagina con navegacion completa (anterior/siguiente, numeros, info "X-Y de Z"), reset al cambiar filtros
- **Boton "Borrar todo"** conectado — con doble confirmacion

**Charts rediseñados:**

- **Tendencia Mensual** — cambiado de bar chart plano a line chart con gradient area fill, puntos marcados, tooltips con formato
- **Categorias por Mes** — reemplazado stacked bar por radar/spider chart con horas totales por categoria, puntos coloreados

**Archivos modificados:**

| Archivo | Cambios |
|---------|---------|
| `dashboard/index.html` | KPI cards section, heatmap section, search input, pagination container, titulo radar chart |
| `dashboard/dashboard.css` | Estilos KPI grid/cards, heatmap grid/cells/legend, search container/input, pagination, responsive mobile |
| `dashboard/dashboard.js` | renderKPIs(), renderHeatmap(), applySearch(), renderPagination(), line chart + radar chart, paginacion en renderSessions(), search con debounce, clearAll handler |

---

### security: auditoria y fixes de seguridad

**Vulnerabilidades corregidas:**

- **[CRITICO] Command Injection** — `exec()` reemplazado por `execFile()` en `notify()` para evitar inyeccion de comandos via nombre de categoria
- **[CRITICO] CORS bypass** — `origin.includes('localhost')` reemplazado por Set exacto de origenes permitidos, evitando bypass via dominios como `evil-localhost.com`
- **[CRITICO] XSS en dashboard** — añadidas funciones `escapeHTML()` y `sanitizeUrl()`, aplicadas en todas las interpolaciones innerHTML (categoria, sessionType, URL, templates)
- **[ALTO] Config merge sin filtrar** — POST /api/config ahora filtra con whitelist de keys permitidas (`CONFIG_ALLOWED_KEYS`)
- **[ALTO] Borrado masivo sin proteccion** — DELETE /api/sessions requiere header `X-Confirm-Delete: true`

**Archivos modificados:**

| Archivo | Cambios |
|---------|---------|
| `server/index.js` | `exec` -> `execFile`, CORS con Set exacto, whitelist en POST config, header confirmacion en DELETE sessions |
| `dashboard/dashboard.js` | `escapeHTML()`, `sanitizeUrl()`, sanitizacion en renderSessions() y renderTemplateList() |

---

### fix+feat: dashboard — bugs + mejoras de alta prioridad

**Bugs corregidos:**

- **Export CSV implementado** — el botón existía pero no hacía nada; ahora descarga un `.csv` con todas las sesiones
- **Slider de duración con debounce** — antes mandaba un comando al servidor por cada pixel de drag (~100 cmds); ahora espera 400ms
- **Código muerto eliminado** — `renderLeader()` referenciaba elementos DOM inexistentes
- **Colores de charts corregidos** — hardcodeados para dark mode; ahora usan CSS variables (`--bg-body`, `--text-muted`, `--border-color`, `--accent-color`) y respetan light/dark
- **Memory leak del setInterval** — `setInterval(refreshAll, 20000)` ahora se limpia en `beforeunload`

**Mejoras de alta prioridad:**

- **Indicador WebSocket** — punto verde/rojo en el header que muestra si estás conectado al servidor en tiempo real
- **Sistema de toasts** — reemplaza los 8+ `alert()` bloqueantes con notificaciones no-bloqueantes (success/error/warning/info) con animación slide-in
- **Responsive mobile** — media queries `@media (max-width: 768px)`: header, controles, luces, charts, filtros y tabla se reorganizan en columna
- **Accesibilidad** — fuentes mínimas subidas de 11-12px a 12-13px en compact-badge, labels, XP text, timer meta

**Archivos modificados:**

| Archivo | Cambios |
|---------|---------|
| `dashboard/index.html` | Indicador WS en nav, contenedor de toasts |
| `dashboard/dashboard.css` | Estilos toast, WS indicator, responsive `@media 768px`, font-size fixes (5 reglas) |
| `dashboard/dashboard.js` | Toast + debounce + cssVar utils, export CSV handler, WS indicator, URL dinámica, 8x alert→toast, chart colors→CSS vars, cleanup memory leak, eliminar renderLeader |

---

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
