# ⏱️ Timer90 – Animatek (v1.2)

A **90-minute session system** with a web dashboard, streaming overlay, and Stream Deck plugin.  
Designed to measure, visualize, and organize focused work or music creation blocks.

---

## 🚀 Installation

Clone the repository and enter the folder:

```bash
git clone https://github.com/animatek/Timer90.git
cd Timer90
```

Install dependencies (use the Node.js version specified in `package.json`):

```bash
npm ci
```

---

## ⚙️ Configuration

Copy the example environment file and fill in your own values:

```bash
cp server/.env.example server/.env
```

Minimum variables required:

```ini
# server/.env
PORT=3000
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
# add more as needed
```

> ❗ Never commit your real `.env` file to GitHub. It is already included in `.gitignore`.

---

## 🖥️ Usage

### Start the server
```bash
npm run dev
```

The app will be available at `http://localhost:3000`.

### Dashboard
- Served from `/dashboard/`
- Displays sessions, statistics, and totals

### Overlay
- Designed for OBS or Streamlabs
- URL: `http://localhost:3000/overlay`

### 90’ Widget (standalone)
- Open `90Proyect.html` directly in a browser to preview the dashboard with sample data.
- To feed your own spreadsheet, publish it as CSV and append `?csv=https://tu-hoja.../output=csv` to the file URL (the file never stores that URL).
- Alternatively, define `window.ANIMATEK90_CSV_URL = 'https://tu-hoja...';` before the script tag to keep the secret URL out of git.
- Keep any variant that hardcodes private sheet URLs outside the repository or list it in `.gitignore` (e.g. store it under `Snippet/`, which is ignored by default).

### Stream Deck Plugin
- Located in `/streamdeck-plugin/`
- Package and load it into your Stream Deck
- Start/stop sessions directly from hardware

---


## 🔒 Notas de seguridad / GitHub

- No se suben `.env`, `server/data/*.json` ni la carpeta `Snippet/`; verifica con `git status` antes de `git push`.
- Si necesitas compartir un widget con datos reales, duplica `90Proyect.html` dentro de `Snippet/` y añade ahí la URL privada.
- Para pruebas locales, usa `90Proyect.html` (demo) y pasa `?csv=` con una URL pública temporal.

---

## ✨ Credits

Developed by [Animatek](https://animatek.net)  
YouTube: [@animatek](https://www.youtube.com/@animatek)  
Instagram: [@animatek](https://www.instagram.com/animatek/)  
