# Changelog — 90 Minutos

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
