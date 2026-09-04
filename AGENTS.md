# Guía del repositorio

## Estructura

- `server/`: backend Node + Express. `config.js` (rutas y env), `db.js` (SQLite:
  esquema, migraciones, consultas), `timer.js` (máquina de estados), `index.js`
  (HTTP + WebSocket).
- `dashboard/`: panel estático servido en `/dashboard/index.html`. `charts.js` son
  las gráficas SVG, `panel.css` los componentes nuevos y `dashboard.css` la base
  heredada (variables, tarjetas, tablas, toasts).
- `overlay/`: browser source para OBS; `overlay/sounds/` la alarma.
- `migrate/`: scripts de un solo uso (JSON → SQLite, reparto de colores). Todos
  admiten `--dry-run`.
- `test/`: pruebas con `node:test`.
- `scripts/`: arranque, parada y estado.

## Dónde están los datos

`~/.local/share/90minutos/90minutos.db` (configurable con `DATA_DIR` / `DB_PATH`).
**Nunca dentro del repo**, y nunca en una carpeta sincronizada por Dropbox, Drive,
Nextcloud o Syncthing: corrompen los archivos SQLite.

## Comandos

- `npm install` una vez por entorno.
- `npm run dev` arranca HTTP (5173) y WebSocket (8765).
- `npm test` ejecuta las pruebas.
- `npm run migrate -- --dry-run` antes de cualquier migración de datos.
- `scripts/90minutos.sh status` muestra el estado por notificación de escritorio.

## Invariantes que no se deben romper

1. **La duración se calcula sumando segmentos, nunca `fin - inicio`.** Si algún
   cálculo usa el reloj de pared, el tiempo en pausa vuelve a contar como trabajado.
2. **El estado del timer no se guarda en memoria.** Sesión activa = fila con
   `ended_at IS NULL`; corriendo = tiene un segmento sin cerrar. Añadir una variable
   de estado paralela reintroduce la pérdida de sesiones al reiniciar.
3. **El tick solo publica y vigila.** Nunca decrementa un contador; si se retrasa o
   se salta, el tiempo sigue siendo correcto porque sale de los timestamps.
4. **El heartbeat es la red de seguridad ante cortes.** Si se quita, un `kill -9`
   deja un segmento abierto sin fin conocido.
5. **El color sigue al tema, no a su posición en un ranking.** Está guardado en la
   tabla, así que filtrar no repinta lo que queda. Más de ocho temas van a «Otros»;
   no se generan tonos nuevos.
6. **Borrar nunca es la salida fácil.** Un tema con historial se archiva o se
   fusiona, y las rutas destructivas piden confirmación explícita.
7. **Sin rutas absolutas al repo** en código ni en scripts.

## Estilo

- ES modules, 2 espacios, punto y coma. Sin linter automático.
- Claves de la API en `lowerCamelCase`; columnas SQL en `snake_case`. La conversión
  vive en `normalizeSession` / `normalizeTopic`.
- Variables de entorno en mayúsculas con guión bajo.
- Comentarios en español y solo donde expliquen *por qué*, no *qué*.
- El panel interpola datos con `textContent` o escapando; nada de `innerHTML` con
  nombres de tema o notas sin escapar.

## Pruebas manuales

Tras cambios en el timer:

1. `npm test`.
2. `npm run dev`, arrancar un tema en modo abierto, pausar y comprobar que
   `elapsedSec` no avanza.
3. `kill -9 $(cat $XDG_RUNTIME_DIR/90minutos.pid)`, rearrancar y comprobar que la
   sesión se recupera en pausa con el tiempo del último latido.
4. `curl localhost:5173/api/health` para ver la forma del estado.
5. Abrir el overlay y comprobar que muestra tiempo acumulado en modo abierto y
   cuenta atrás en sprint.

## Commits

- Mensajes en presente y concisos: `feat: añadir modo abierto`.
- Señalar los cambios que afecten al esquema de la base de datos, al formato de los
  datos o al overlay.
- Nunca subir `.env` ni archivos `.db`.
