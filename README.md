# u-click

**Minimalistic portable web analytics** — drop one `<script>` tag on any page and instantly start tracking clicks, events, scroll depth, and form interactions. Data streams in real time to a self-hosted backend and is visualised in a built-in admin dashboard.

| Admin Dashboard | Demo Page |
|---|---|
| ![Admin Dashboard](https://github.com/user-attachments/assets/aa604fd0-7296-447e-8cc7-2555838a598f) | ![Demo Page](https://github.com/user-attachments/assets/ad5c8c00-9e79-4f7b-91b5-0272884e697f) |

---

## Features

| Feature | Detail |
|---|---|
| **Zero-config tracking** | Drop the script tag — auto-detects every button, link, form, and interactive element via event delegation + `MutationObserver` |
| **Click tracking** | Records tag, id, class, text, and exact `(x, y)` viewport coordinates |
| **Rage-click detection** | Fires an `extra.rage` flag after ≥ 3 clicks within 500 ms |
| **Scroll depth** | Fires milestones at 25 %, 50 %, 75 %, 90 %, 100 % |
| **Form interactions** | Captures `form_submit` and `field_change` events (passwords excluded) |
| **Page views** | Works for traditional multi-page apps *and* SPAs (patches `history.pushState`) |
| **Idle / active** | Fires `idle` after 30 s of inactivity, `active` on resume |
| **Real-time WebSocket stream** | Events sent over WebSocket; falls back to `fetch`/`sendBeacon` |
| **Sampling** | Set `data-sample="0.1"` to track only 10 % of visitors |
| **Admin dashboard** | Dark-theme SPA with timeline chart, doughnut chart, top-pages table, top-elements table, click heatmap, live feed, sessions table |
| **Portable** | Node.js + SQLite (no external database). Single `node server.js` to run |

---

## Quick start

### 1 — Run the server

```bash
git clone https://github.com/Jozo132/u-click.git
cd u-click
npm install
node server.js
# → http://localhost:3000
```

**Environment variables:**

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `analytics.db` | Path to the SQLite database file |
| `CORS_ORIGIN` | `*` | Allowed CORS origin(s) |

### 2 — Embed the tracker

Add **one line** to the `<head>` of any HTML page:

```html
<script src="https://your-server.com/u-click.js"
        data-server="https://your-server.com"></script>
```

That's it. The tracker self-initialises, auto-detects all interactive elements, and starts streaming events.

### 3 — Open the dashboard

```
http://localhost:3000/admin/
```

---

## Tracker configuration

All options are set via `data-*` attributes on the script tag **or** via `window.uclick = { ... }` declared before the script loads.

| Attribute | Default | Description |
|---|---|---|
| `data-server` | *(same origin)* | URL of the u-click backend |
| `data-app` | *(hostname)* | Application / site label |
| `data-session` | *(auto)* | Force a specific session ID |
| `data-sample` | `1` | Sampling rate 0–1 (1 = 100 %) |
| `data-batch-ms` | `2000` | Event batch flush interval (ms) |
| `data-scroll` | `true` | Enable scroll-depth events |
| `data-rage` | `true` | Enable rage-click detection |
| `data-idle-ms` | `30000` | Idle timeout before `idle` event fires |

### Manual tracking API

After the script loads, `window.uclick` exposes:

```js
// Fire a custom event
window.uclick.track('signup_started', { plan: 'pro' })

// Get the current session ID
console.log(window.uclick.sessionId)

// Force-flush pending events (e.g. before a page transition)
window.uclick.flush()
```

---

## REST API

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/events` | Ingest one event or an array of events (fetch fallback) |
| `GET` | `/api/stats/summary` | Totals: sessions, page views, events, clicks |
| `GET` | `/api/stats/timeline` | Events bucketed over time (stacked by type) |
| `GET` | `/api/stats/pages` | Top pages by sessions |
| `GET` | `/api/stats/elements` | Top clicked elements |
| `GET` | `/api/stats/event-types` | Event type breakdown |
| `GET` | `/api/stats/clicks` | Click positions for heatmap |
| `GET` | `/api/stats/sessions` | Recent session list |
| `GET` | `/api/events/recent` | Live event feed |

All `GET` endpoints accept `?since=<ms>&until=<ms>` query params.

### WebSocket

Connect to `ws://your-server/ws?role=tracker` to stream events.  
Connect to `ws://your-server/ws?role=admin` to receive live push notifications as new events arrive.

---

## Project structure

```
u-click/
├── server.js            # Express + WebSocket + SQLite backend
├── package.json
├── public/
│   ├── u-click.js       # Self-contained client tracker (< 5 KB)
│   ├── chart.min.js     # Chart.js (served locally, no CDN needed)
│   ├── admin/
│   │   └── index.html   # Admin analytics dashboard SPA
│   └── demo/
│       └── index.html   # Interactive demo page
└── test/
    └── server.test.js   # Integration tests (node test/server.test.js)
```

---

## Running tests

```bash
node test/server.test.js
```

Tests use an in-memory SQLite database — no files written to disk.

---

## License

MIT
