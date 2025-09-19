# Animatek Timer — v2.5.1

Cambios:
- **Abrir base de datos** arreglado: el enlace se arma con `/api/sheet/id` y tu `SHEET_ID` del `.env`.
- Botón **Sincronizar desde Sheets** (convierte filas A–E en sesiones locales). Útil para traer cambios manuales del Sheet.

## Uso
```powershell
npm i
npm run dev
```
Panel: `http://127.0.0.1:5173/dashboard/`

### `.env`
```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
BASE_URL=http://127.0.0.1:5173
SHEET_ID=<tu id de hoja>
```

### Importar desde Sheets
Pulsa **Sincronizar desde Sheets** (requiere OAuth a Sheets). Se reconstruye `server/data/sessions.json` con sesiones sintéticas (fecha = día de la fila a las 12:00 y duración = minutos).

### OBS y Stream Deck
Como en versiones anteriores.
