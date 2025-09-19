# Repository Guidelines

## Project Structure & Module Organization
- `server/`: Node.js + Express backend; central timer state, Google integrations, data files in `server/data/`.
- `dashboard/`: static control panel served at `/dashboard/index.html`; updates timer config and sessions.
- `overlay/`: browser source assets for OBS; `overlay/sounds/` holds alarm audio.
- `streamdeck-plugin/`: Stream Deck plugin sources and packaged artifacts.
- `scripts/`: helper scripts for OAuth and plugin packaging.
- `sessions/`: sample ICS exports and CSV logs for manual imports.

## Build, Test, and Development Commands
- `npm install` once per environment to sync dependencies.
- `npm run dev` starts the Express server, websocket hub (port 8765), and serves dashboard/overlay from `http://127.0.0.1:5173/`.
- `npm run google:auth` opens the OAuth consent flow using the active `.env` values.
- `npm run plugin:pack` archives `streamdeck-plugin/` into `animatek-timer.streamDeckPlugin`.
- `powershell scripts/start_dev_console.ps1` opens a dev console and browser tabs with sensible defaults.

## Coding Style & Naming Conventions
- JavaScript files use ES modules, 2 space indentation, and semicolons (see `server/index.js`).
- Keep function braces tight (`function startTimer(){`) and favor small helper functions for repeated logic.
- Persisted JSON keys stay lowerCamelCase; timer config keys mirror those in `server/data/config.json`.
- Keep env variables uppercase with underscores (`SHEET_ID`, `BASE_URL`).
- No automated linting; run Prettier manually if desired but avoid reformatting unrelated blocks.

## Testing Guidelines
- There is no automated test suite today; rely on manual flows that cover dashboard, overlay, and Stream Deck behaviors.
- After changes run `npm run dev`, load `http://127.0.0.1:5173/dashboard/`, and watch websocket logs in the server console.
- Use `curl http://127.0.0.1:5173/api/state` to confirm timer state shape before shipping.
- For Google Sheets integration, trigger `Importar desde Sheets` and check `server/data/sessions.json` plus the dashboard table.
- Validate Stream Deck packaging by running `npm run plugin:pack` and installing the generated plugin in a test profile.

## Commit & Pull Request Guidelines
- The repo ships without git history in this workspace; follow concise, present-tense messages such as `feat: add recurring session support`.
- Reference related issues in the body and call out changes that affect Google OAuth, file formats, or OBS overlays.
- Pull requests should describe testing performed, list impacted directories, and attach screenshots for dashboard or overlay tweaks.
- Include `.env` expectations in the PR if new variables are introduced; never commit secrets.

## Configuration & Security Notes
- Copy `.env.example` to `.env` and fill Google credentials; the server also reads `server/.env` when present.
- Keep `server/data/tokens.json` out of version control and rotate tokens after testing.
- Overlay and dashboard assets are served publicly once deployed; avoid embedding private URLs or API keys.
