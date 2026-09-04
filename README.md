# 90 Minutos

Registro de tiempo por temas, con SQLite local, panel web y overlay para OBS.

Dos modos de trabajo:

- **Abierto** — eliges un tema y cuenta arriba hasta que paras. El modo del día a día.
- **Sprint** — cuenta atrás con alarma (90 min por defecto), para sesiones con objetivo.

## Cómo funciona por dentro

Una sesión no guarda una duración: guarda **segmentos de trabajo**. Cada pausa cierra
un segmento y cada reanudación abre otro, y la duración es la suma de esos segmentos.

Esto tiene tres consecuencias que son el motivo del diseño:

- **El tiempo en pausa no cuenta como trabajado.** Pausar para comer no infla la sesión.
- **No hay estado en memoria que perder.** «Hay sesión activa» es la fila con
  `ended_at IS NULL`; «está corriendo» es que tenga un segmento sin cerrar. Si el
  servidor se reinicia, al arrancar lo encuentra y sigue.
- **Un corte brusco no inventa horas.** Mientras corre se escribe un `heartbeat_at`
  cada 15 s; al recuperar, el segmento abierto se cierra en ese último latido y la
  sesión queda **en pausa** para que decidas. Se pierden 15 s como máximo, en vez de
  registrar las ocho horas que el equipo pasó apagado.

## Arquitectura

```
server/
  config.js     Rutas y variables de entorno. Cero rutas fijas.
  db.js         SQLite: esquema, migraciones, consultas
  timer.js      Máquina de estados (abierto | sprint), basada en timestamps
  index.js      HTTP + WebSocket
dashboard/      Panel web (index.html, dashboard.js, charts.js, panel.css)
overlay/        Browser source para OBS
migrate/        JSON → SQLite y reparto de colores
test/           Pruebas de la lógica de duración
scripts/        Arranque y parada
```

### Dónde viven los datos

Todo en **un solo archivo**, fuera del repo:

```
~/.local/share/90minutos/90minutos.db
```

Ajustes, temas y sesiones están dentro. Mudar la app a otro equipo (o a una
Raspberry Pi) es copiar el repo y ese archivo. Se cambia con `DATA_DIR` o `DB_PATH`
en el `.env`.

> **No pongas el `.db` en Dropbox, Drive, Nextcloud ni Syncthing.** Sincronizan el
> archivo completo sin entender cómo escribe SQLite y lo corrompen. Para varios
> equipos, sirve el servidor en la red (ver más abajo).

### Esquema

```sql
topics    (id, name, color, palette_slot, archived, sort_order, created_at)
sessions  (id, topic_id, mode, planned_sec, started_at, ended_at,
           heartbeat_at, notes, url, language, session_type, source)
segments  (id, session_id, started_at, ended_at)
settings  (key, value)
```

La vista `v_sessions` añade la duración calculada; un segmento sin cerrar cuenta
hasta ahora mismo, así que la sesión en curso siempre reporta su duración real.

## Requisitos

Node.js >= 22. **Sin dependencias nativas**: usa el SQLite integrado en Node, así
que no hay nada que compilar al cambiar de arquitectura.

## Instalación

```bash
npm install
cp .env.example .env      # opcional: por defecto ya funciona
npm run dev
```

Panel en `http://127.0.0.1:5173/dashboard/index.html`.

El panel tiene dos vistas:

- **Control** — timer, creación de temas, historial editable y ajustes.
- **Estadísticas** — progreso semanal/mensual/anual, KPIs, horas por tema,
  últimos días, mapa de actividad y calendario.

El objetivo semanal se configura en Ajustes; los objetivos mensual y anual se
derivan multiplicándolo por 4 y por 52.

### Migrar desde la versión anterior (JSON + Google Sheets)

```bash
npm run migrate -- --dry-run   # informe: qué categorías se unifican, sin escribir
npm run migrate                # migra, con copia de seguridad previa
npm run recolor                # reparte la paleta validada entre los temas top
```

La migración deduplica los ids que colisionaban, unifica las categorías escritas a
mano y **verifica que el número de sesiones y las horas cuadran exactamente** con el
JSON original; si no cuadran, aborta sin dejar la base a medias.

## Comandos

```bash
npm run dev          # arrancar
npm test             # pruebas de la lógica de duración
scripts/90minutos.sh start|stop|restart|status
```

Para instalar el lanzador del menú de aplicaciones sin depender de dónde esté
clonado el repo:

```bash
scripts/install-desktop.sh
```

## Variables de entorno

| Variable | Descripción | Por defecto |
|----------|-------------|-------------|
| `PORT` | Puerto HTTP | `5173` |
| `WS_PORT` | Puerto WebSocket | `8765` |
| `HOST` | Interfaz de escucha | `127.0.0.1` |
| `AUTH_TOKEN` | Token de acceso. **Obligatorio si `HOST` no es loopback** | vacío |
| `DATA_DIR` | Directorio de datos | `~/.local/share/90minutos` |
| `DB_PATH` | Ruta del `.db` | `$DATA_DIR/90minutos.db` |

## Acceso desde otros dispositivos

Por defecto el servidor solo escucha en `127.0.0.1`. Para llegar desde el móvil o el
portátil:

```bash
# .env
HOST=0.0.0.0
AUTH_TOKEN=…        # node -e "console.log(crypto.randomUUID())"
```

Si `HOST` no es loopback y `AUTH_TOKEN` está vacío, **el servidor se niega a
arrancar** en lugar de quedar abierto en la red. Entra una vez con
`http://tu-host:5173/dashboard/index.html?token=EL_TOKEN` y queda en una cookie.

Para acceder desde fuera de casa, Tailscale es la opción que no obliga a abrir puertos.

## API

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/state` | Estado del timer |
| `POST` | `/api/timer/start` | Arrancar (`topicId` o `topic`, `mode`, `plannedMin`). Con sesión activa, la cierra y abre la nueva |
| `POST` | `/api/timer/pause` · `resume` · `stop` | Pausar · reanudar · guardar |
| `POST` | `/api/timer/discard` | Descartar sin guardar |
| `POST` | `/api/timer/extend` | Mover el objetivo del sprint (`min` o `sec`) |
| `POST` | `/api/timer/mode` | Cambiar de modo en caliente |
| `POST` | `/api/timer/meta` | URL, notas, idioma, tipo o tema de la sesión en curso |
| `GET` | `/api/topics` | Listar temas (`?all=true` incluye archivados) |
| `POST` `PATCH` `DELETE` | `/api/topics[/:id]` | Crear, editar, borrar |
| `POST` | `/api/topics/:id/merge` | Fusionar en otro tema (`targetId`) |
| `GET` | `/api/sessions` | Historial (`from`, `to`, `topicId`, `limit`, `offset`) |
| `POST` `PATCH` `DELETE` | `/api/sessions[/:id]` | Crear manual, editar, borrar |
| `POST` | `/api/sessions/bulk-delete` | Borrado múltiple |
| `GET` | `/api/stats` | Totales por tema y por día |
| `GET` | `/api/export.csv` | Exportar CSV |
| `GET` `POST` | `/api/settings` | Ajustes |
| `GET` `POST` | `/api/backup` · `/api/restore` | Backup completo |
| `GET` | `/api/health` | Estado del servidor |

Borrar un tema con historial devuelve `409`: hay que archivarlo o fusionarlo, para
que no se lleve sesiones por delante.

## WebSocket

Puerto `8765` por defecto, configurable con `WS_PORT`. El panel y el overlay
consultan el puerto real al servidor; los clientes solo escuchan.

- `{ type: "state", payload: { state, mode, topic, elapsedSec, remainingSec, overtimeSec, todaySec, … } }`
- `{ type: "session:complete", payload: <sesión> }`
- `{ type: "alarm", payload: <estado> }` — objetivo del sprint alcanzado en modo prórroga
- `{ type: "topics:update" }` · `{ type: "settings:update", payload: <ajustes> }`

## Overlay OBS

Browser source en `http://127.0.0.1:5173/overlay/index.html`. Muestra la cuenta atrás
en sprint y el tiempo acumulado en modo abierto, con alarma al finalizar.

## Colores

Los temas usan una paleta categórica de ocho tonos con pasos propios para claro y
oscuro, comprobada con un validador (banda de luminosidad, croma, separación para
daltonismo y contraste). Los temas más allá del octavo se agrupan en «Otros» en las
gráficas en lugar de repetir tonos. Elegir un color a mano libera el slot y manda el
color elegido.

El panel acepta `?theme=light` o `?theme=dark` para forzar el tema sin tocar la
preferencia guardada.

## Licencia

Ver [LICENSE](LICENSE).
