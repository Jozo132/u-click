'use strict'

const http = require('http')
const path = require('path')
const fs = require('fs')
const express = require('express')
const { WebSocketServer } = require('ws')
const cors = require('cors')
const rateLimit = require('express-rate-limit')
const Database = require('better-sqlite3')

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'analytics.db')
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    page_url    TEXT NOT NULL,
    page_title  TEXT,
    referrer    TEXT,
    user_agent  TEXT,
    screen_w    INTEGER,
    screen_h    INTEGER,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    type        TEXT NOT NULL,
    page_url    TEXT NOT NULL,
    target_tag  TEXT,
    target_id   TEXT,
    target_cls  TEXT,
    target_text TEXT,
    target_name TEXT,
    x           INTEGER,
    y           INTEGER,
    scroll_pct  INTEGER,
    extra       TEXT,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
  CREATE INDEX IF NOT EXISTS idx_events_type    ON events(type);
  CREATE INDEX IF NOT EXISTS idx_events_page    ON events(page_url);
  CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(created_at);
`)

// Prepared statements
const stmts = {
    upsertSession: db.prepare(`
    INSERT INTO sessions (id, page_url, page_title, referrer, user_agent, screen_w, screen_h, created_at, updated_at)
    VALUES (@id, @page_url, @page_title, @referrer, @user_agent, @screen_w, @screen_h, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      page_url   = excluded.page_url,
      page_title = excluded.page_title,
      updated_at = excluded.updated_at
  `),
    insertEvent: db.prepare(`
    INSERT INTO events (session_id, type, page_url, target_tag, target_id, target_cls, target_text, target_name, x, y, scroll_pct, extra, created_at)
    VALUES (@session_id, @type, @page_url, @target_tag, @target_id, @target_cls, @target_text, @target_name, @x, @y, @scroll_pct, @extra, @created_at)
  `),
}

// Batch insert helper
const insertBatch = db.transaction((rows) => {
    for (const row of rows) {
        stmts.upsertSession.run({
            id: row.session_id,
            page_url: row.page_url,
            page_title: row.page_title || null,
            referrer: row.referrer || null,
            user_agent: row.user_agent || null,
            screen_w: row.screen_w || null,
            screen_h: row.screen_h || null,
            created_at: row.session_start || row.ts,
            updated_at: row.ts,
        })
        stmts.insertEvent.run({
            session_id: row.session_id,
            type: row.type,
            page_url: row.page_url,
            target_tag: row.target_tag || null,
            target_id: row.target_id || null,
            target_cls: row.target_cls || null,
            target_text: row.target_text || null,
            target_name: row.target_name || null,
            x: row.x || null,
            y: row.y || null,
            scroll_pct: row.scroll_pct || null,
            extra: row.extra ? JSON.stringify(row.extra) : null,
            created_at: row.ts,
        })
    }
})

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express()
// CORS is intentionally permissive: the tracker script must be able to POST
// events from any domain that embeds it. Restrict CORS_ORIGIN via the
// environment variable if you want to limit which domains can send events.
app.use(cors({ origin: CORS_ORIGIN }))
app.use(express.json({ limit: '1mb' }))
app.use(express.static(path.join(__dirname, 'public')))

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------
// Tracker ingestion: generous limit (2000 req/min per IP) to allow high-traffic sites
const ingestLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 2000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'Too many events — please slow down.' },
})

// Analytics API (read): moderate limit (120 req/min per IP) for dashboard queries
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'Too many requests.' },
})

// Serve Chart.js from node_modules (so it doesn't need to be committed)
app.get('/chart.min.js', apiLimiter, (req, res) => {
    res.sendFile(path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js'))
})

// Serve u-click tracker script directly at root for easy embedding
app.get('/u-click.js', apiLimiter, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'u-click.js'))
})

// ---------------------------------------------------------------------------
// REST API — event ingestion (fetch fallback)
// ---------------------------------------------------------------------------
app.post('/api/events', ingestLimiter, (req, res) => {
    const payload = req.body
    const rows = Array.isArray(payload) ? payload : [payload]
    try {
        insertBatch(rows)
        broadcastToAdmin({ type: 'new_events', count: rows.length, events: rows })
        res.json({ ok: true, count: rows.length })
    } catch (err) {
        console.error('Error inserting events:', err.message)
        res.status(500).json({ ok: false, error: err.message })
    }
})

// ---------------------------------------------------------------------------
// REST API — analytics queries
// ---------------------------------------------------------------------------

// Summary stats
app.get('/api/stats/summary', apiLimiter, (req, res) => {
    const { since = 0, until = Date.now() } = req.query
    const result = db.prepare(`
    SELECT
      COUNT(DISTINCT session_id)          AS total_sessions,
      COUNT(DISTINCT page_url)            AS total_pages,
      COUNT(*)                            AS total_events,
      SUM(CASE WHEN type='click' THEN 1 ELSE 0 END)     AS total_clicks,
      SUM(CASE WHEN type='pageview' THEN 1 ELSE 0 END)  AS total_pageviews
    FROM events
    WHERE created_at BETWEEN ? AND ?
  `).get(Number(since), Number(until))
    res.json(result)
})

// Events over time (hourly buckets)
app.get('/api/stats/timeline', apiLimiter, (req, res) => {
    const { since, until = Date.now(), interval = '3600000' } = req.query
    const bucket = Number(interval)
    const from = since ? Number(since) : Number(until) - 86400000 * 7
    const rows = db.prepare(`
    SELECT
      (created_at / ?) * ? AS bucket,
      COUNT(*)             AS count,
      type
    FROM events
    WHERE created_at BETWEEN ? AND ?
    GROUP BY bucket, type
    ORDER BY bucket
  `).all(bucket, bucket, from, Number(until))
    res.json(rows)
})

// Top pages
app.get('/api/stats/pages', apiLimiter, (req, res) => {
    const { since, until = Date.now(), limit = 20 } = req.query
    const from = since ? Number(since) : 0
    const rows = db.prepare(`
    SELECT
      page_url,
      COUNT(DISTINCT session_id) AS sessions,
      COUNT(*) AS events,
      SUM(CASE WHEN type='click' THEN 1 ELSE 0 END) AS clicks
    FROM events
    WHERE created_at BETWEEN ? AND ?
    GROUP BY page_url
    ORDER BY sessions DESC
    LIMIT ?
  `).all(from, Number(until), Number(limit))
    res.json(rows)
})

// Top clicked elements
app.get('/api/stats/elements', apiLimiter, (req, res) => {
    const { since, until = Date.now(), page_url, limit = 30 } = req.query
    const from = since ? Number(since) : 0
    let query = `
    SELECT
      target_tag, target_id, target_cls, target_text, target_name,
      COUNT(*) AS clicks
    FROM events
    WHERE type = 'click' AND created_at BETWEEN ? AND ?
  `
    const params = [from, Number(until)]
    if (page_url) { query += ' AND page_url = ?'; params.push(page_url) }
    query += ' GROUP BY target_tag, target_id, target_cls, target_text ORDER BY clicks DESC LIMIT ?'
    params.push(Number(limit))
    res.json(db.prepare(query).all(...params))
})

// Event type breakdown
app.get('/api/stats/event-types', apiLimiter, (req, res) => {
    const { since, until = Date.now() } = req.query
    const from = since ? Number(since) : 0
    const rows = db.prepare(`
    SELECT type, COUNT(*) AS count
    FROM events
    WHERE created_at BETWEEN ? AND ?
    GROUP BY type
    ORDER BY count DESC
  `).all(from, Number(until))
    res.json(rows)
})

// Recent events feed
app.get('/api/events/recent', apiLimiter, (req, res) => {
    const { limit = 50, page_url } = req.query
    let query = `
    SELECT e.*, s.user_agent, s.screen_w, s.screen_h
    FROM events e
    LEFT JOIN sessions s ON s.id = e.session_id
    WHERE 1=1
  `
    const params = []
    if (page_url) { query += ' AND e.page_url = ?'; params.push(page_url) }
    query += ' ORDER BY e.created_at DESC LIMIT ?'
    params.push(Number(limit))
    res.json(db.prepare(query).all(...params))
})

// Click positions for heatmap
app.get('/api/stats/clicks', apiLimiter, (req, res) => {
    const { since, until = Date.now(), page_url } = req.query
    const from = since ? Number(since) : 0
    let query = `
    SELECT x, y, page_url, target_tag, target_id, target_cls, target_text
    FROM events
    WHERE type = 'click' AND x IS NOT NULL AND created_at BETWEEN ? AND ?
  `
    const params = [from, Number(until)]
    if (page_url) { query += ' AND page_url = ?'; params.push(page_url) }
    res.json(db.prepare(query).all(...params))
})

// Sessions list
app.get('/api/stats/sessions', apiLimiter, (req, res) => {
    const { since, until = Date.now(), limit = 50 } = req.query
    const from = since ? Number(since) : 0
    const rows = db.prepare(`
    SELECT s.*,
      COUNT(e.id) AS event_count,
      SUM(CASE WHEN e.type='click' THEN 1 ELSE 0 END) AS click_count
    FROM sessions s
    LEFT JOIN events e ON e.session_id = s.id
    WHERE s.created_at BETWEEN ? AND ?
    GROUP BY s.id
    ORDER BY s.created_at DESC
    LIMIT ?
  `).all(from, Number(until), Number(limit))
    res.json(rows)
})

// ---------------------------------------------------------------------------
// Admin SPA — serve admin/index.html for /admin route
// ---------------------------------------------------------------------------
app.get('/admin', apiLimiter, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'))
})
app.get('/admin/*', apiLimiter, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'))
})

// ---------------------------------------------------------------------------
// HTTP server + WebSocket server
// ---------------------------------------------------------------------------
const server = http.createServer(app)

const wss = new WebSocketServer({ server, path: '/ws' })

// Track admin dashboard subscribers
const adminSockets = new Set()

function broadcastToAdmin(data) {
    const msg = JSON.stringify(data)
    for (const ws of adminSockets) {
        if (ws.readyState === 1 /* OPEN */) {
            ws.send(msg)
        }
    }
}

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://localhost`)
    const role = url.searchParams.get('role') || 'tracker'

    if (role === 'admin') {
        adminSockets.add(ws)
        ws.on('close', () => adminSockets.delete(ws))
        return
    }

    // Tracker client connection
    let buffer = []
    let flushTimer = null

    function flush() {
        if (buffer.length === 0) return
        const rows = buffer.splice(0)
        try {
            insertBatch(rows)
            broadcastToAdmin({ type: 'new_events', count: rows.length, events: rows })
        } catch (err) {
            console.error('DB batch insert error:', err.message)
        }
    }

    ws.on('message', (raw) => {
        let payload
        try {
            payload = JSON.parse(raw)
        } catch {
            return
        }
        const rows = Array.isArray(payload) ? payload : [payload]
        buffer.push(...rows)
        clearTimeout(flushTimer)
        // Flush immediately if buffer is large, otherwise debounce
        if (buffer.length >= 20) {
            flush()
        } else {
            flushTimer = setTimeout(flush, 500)
        }
    })

    ws.on('close', () => {
        clearTimeout(flushTimer)
        flush()
    })

    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message)
    })
})

// ---------------------------------------------------------------------------
// Start — only auto-listen when run directly (not when required in tests)
// ---------------------------------------------------------------------------
if (require.main === module) {
    server.listen(PORT, () => {
        console.log(`u-click server running at http://localhost:${PORT}`)
        console.log(`  Tracker: <script src="http://localhost:${PORT}/u-click.js" data-server="http://localhost:${PORT}"></script>`)
        console.log(`  Admin:   http://localhost:${PORT}/admin`)
    })
}

module.exports = { app, server, db }
