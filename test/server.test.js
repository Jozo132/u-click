'use strict'

/**
 * Basic integration tests for the u-click server.
 * Run with: node test/server.test.js
 */

// Use in-memory SQLite for tests (must be set before requiring the server)
process.env.DB_PATH = ':memory:'

const assert = require('assert')
const http = require('http')
const { app, server, db } = require('../server')

let base = ''
const PORT = 0  // OS-assigned

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function request(method, path, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null
        const opts = {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
            },
        }
        const url = new URL(base + path)
        opts.hostname = url.hostname
        opts.port = url.port
        opts.path = url.pathname + url.search

        const req = http.request(opts, (res) => {
            let raw = ''
            res.on('data', chunk => raw += chunk)
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(raw) }) }
                catch { resolve({ status: res.statusCode, body: raw }) }
            })
        })
        req.on('error', reject)
        if (data) req.write(data)
        req.end()
    })
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
let passed = 0
let failed = 0

async function test(name, fn) {
    try {
        await fn()
        console.log(`  ✓ ${name}`)
        passed++
    } catch (err) {
        console.error(`  ✗ ${name}`)
        console.error(`    ${err.message}`)
        failed++
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function runTests() {
    console.log('\nu-click server tests\n')

    const SAMPLE_EVENT = {
        session_id: 'test-session-001',
        session_start: Date.now() - 5000,
        type: 'click',
        page_url: 'http://localhost/test',
        page_title: 'Test Page',
        referrer: null,
        user_agent: 'TestAgent/1.0',
        screen_w: 1920,
        screen_h: 1080,
        target_tag: 'button',
        target_id: 'btn-test',
        target_cls: 'btn primary',
        target_text: 'Click me',
        x: 640,
        y: 360,
        ts: Date.now(),
    }

    // ── Core Event Ingestion ─────────────────────────────────────

    // 1. POST /api/events — single event
    await test('POST /api/events accepts a single event', async () => {
        const r = await request('POST', '/api/events', SAMPLE_EVENT)
        assert.strictEqual(r.status, 200)
        assert.strictEqual(r.body.ok, true)
        assert.strictEqual(r.body.count, 1)
    })

    // 2. POST /api/events — batch
    await test('POST /api/events accepts a batch of events', async () => {
        const batch = [
            { ...SAMPLE_EVENT, type: 'pageview', ts: Date.now() },
            { ...SAMPLE_EVENT, type: 'scroll',   ts: Date.now(), scroll_pct: 50 },
        ]
        const r = await request('POST', '/api/events', batch)
        assert.strictEqual(r.status, 200)
        assert.strictEqual(r.body.count, 2)
    })

    // 3. POST /api/events — event with extra data
    await test('POST /api/events stores extra JSON data', async () => {
        const evt = { ...SAMPLE_EVENT, type: 'click', ts: Date.now(), extra: { rage: true } }
        const r = await request('POST', '/api/events', evt)
        assert.strictEqual(r.status, 200)
        assert.strictEqual(r.body.ok, true)
    })

    // 4. POST /api/events — event with missing optional fields
    await test('POST /api/events accepts events with minimal fields', async () => {
        const minimal = {
            session_id: 'test-session-minimal',
            type: 'pageview',
            page_url: 'http://localhost/minimal',
            ts: Date.now(),
        }
        const r = await request('POST', '/api/events', minimal)
        assert.strictEqual(r.status, 200)
        assert.strictEqual(r.body.ok, true)
    })

    // 5. POST /api/events — multiple sessions
    await test('POST /api/events handles multiple distinct sessions', async () => {
        const batch = [
            { ...SAMPLE_EVENT, session_id: 'session-a', type: 'pageview', page_url: 'http://localhost/page-a', ts: Date.now() },
            { ...SAMPLE_EVENT, session_id: 'session-b', type: 'pageview', page_url: 'http://localhost/page-b', ts: Date.now() },
            { ...SAMPLE_EVENT, session_id: 'session-c', type: 'click', page_url: 'http://localhost/page-a', ts: Date.now() },
        ]
        const r = await request('POST', '/api/events', batch)
        assert.strictEqual(r.status, 200)
        assert.strictEqual(r.body.count, 3)
    })

    // ── Analytics Queries ─────────────────────────────────────────

    // 6. GET /api/stats/summary
    await test('GET /api/stats/summary returns stats object', async () => {
        const r = await request('GET', '/api/stats/summary?since=0&until=' + Date.now())
        assert.strictEqual(r.status, 200)
        assert.ok(typeof r.body.total_sessions === 'number')
        assert.ok(typeof r.body.total_events === 'number')
        assert.ok(r.body.total_events >= 3, 'should have at least the 3 inserted events')
    })

    // 7. GET /api/stats/summary — with time range filtering
    await test('GET /api/stats/summary respects time range filter', async () => {
        const futureTs = Date.now() + 86400000
        const r = await request('GET', '/api/stats/summary?since=' + futureTs + '&until=' + (futureTs + 1000))
        assert.strictEqual(r.status, 200)
        assert.strictEqual(r.body.total_events, 0, 'no events in future range')
    })

    // 8. GET /api/stats/summary — all fields present
    await test('GET /api/stats/summary returns all required fields', async () => {
        const r = await request('GET', '/api/stats/summary?since=0&until=' + Date.now())
        assert.strictEqual(r.status, 200)
        const fields = ['total_sessions', 'total_pages', 'total_events', 'total_clicks', 'total_pageviews']
        for (const f of fields) {
            assert.ok(r.body.hasOwnProperty(f), 'missing field: ' + f)
            assert.ok(typeof r.body[f] === 'number', f + ' should be a number')
        }
    })

    // 9. GET /api/stats/pages
    await test('GET /api/stats/pages returns page list', async () => {
        const r = await request('GET', '/api/stats/pages?since=0&until=' + Date.now())
        assert.strictEqual(r.status, 200)
        assert.ok(Array.isArray(r.body))
        assert.ok(r.body.length >= 1)
        assert.ok(r.body[0].page_url)
    })

    // 10. GET /api/stats/pages — limit parameter
    await test('GET /api/stats/pages respects limit parameter', async () => {
        const r = await request('GET', '/api/stats/pages?since=0&until=' + Date.now() + '&limit=1')
        assert.strictEqual(r.status, 200)
        assert.ok(Array.isArray(r.body))
        assert.strictEqual(r.body.length, 1, 'should respect limit=1')
    })

    // 11. GET /api/stats/pages — sorted by sessions desc
    await test('GET /api/stats/pages is sorted by sessions descending', async () => {
        const r = await request('GET', '/api/stats/pages?since=0&until=' + Date.now())
        assert.strictEqual(r.status, 200)
        for (let i = 1; i < r.body.length; i++) {
            assert.ok(r.body[i - 1].sessions >= r.body[i].sessions, 'pages should be sorted by sessions desc')
        }
    })

    // 12. GET /api/stats/elements
    await test('GET /api/stats/elements returns elements list', async () => {
        const r = await request('GET', '/api/stats/elements?since=0&until=' + Date.now())
        assert.strictEqual(r.status, 200)
        assert.ok(Array.isArray(r.body))
        assert.ok(r.body[0].target_tag === 'button')
    })

    // 13. GET /api/stats/elements — filter by page_url
    await test('GET /api/stats/elements filters by page_url', async () => {
        const r = await request('GET', '/api/stats/elements?since=0&until=' + Date.now() + '&page_url=http://localhost/test')
        assert.strictEqual(r.status, 200)
        assert.ok(Array.isArray(r.body))
        assert.ok(r.body.length >= 1, 'should have elements for the test page')
    })

    // 14. GET /api/stats/elements — sorted by clicks desc
    await test('GET /api/stats/elements is sorted by clicks descending', async () => {
        const r = await request('GET', '/api/stats/elements?since=0&until=' + Date.now())
        assert.strictEqual(r.status, 200)
        for (let i = 1; i < r.body.length; i++) {
            assert.ok(r.body[i - 1].clicks >= r.body[i].clicks, 'elements should be sorted by clicks desc')
        }
    })

    // 15. GET /api/stats/timeline
    await test('GET /api/stats/timeline returns timeline data', async () => {
        const r = await request('GET', '/api/stats/timeline?since=0&until=' + Date.now())
        assert.strictEqual(r.status, 200)
        assert.ok(Array.isArray(r.body))
    })

    // 16. GET /api/stats/timeline — custom interval
    await test('GET /api/stats/timeline supports custom interval', async () => {
        const r = await request('GET', '/api/stats/timeline?since=0&until=' + Date.now() + '&interval=60000')
        assert.strictEqual(r.status, 200)
        assert.ok(Array.isArray(r.body))
        // Each row should have bucket, count, type
        if (r.body.length > 0) {
            assert.ok(r.body[0].hasOwnProperty('bucket'))
            assert.ok(r.body[0].hasOwnProperty('count'))
            assert.ok(r.body[0].hasOwnProperty('type'))
        }
    })

    // 17. GET /api/stats/event-types
    await test('GET /api/stats/event-types returns type breakdown', async () => {
        const r = await request('GET', '/api/stats/event-types?since=0&until=' + Date.now())
        assert.strictEqual(r.status, 200)
        assert.ok(Array.isArray(r.body))
        const types = r.body.map(x => x.type)
        assert.ok(types.includes('click'), 'should include click type')
    })

    // 18. GET /api/stats/event-types — includes all ingested types
    await test('GET /api/stats/event-types includes all ingested event types', async () => {
        const r = await request('GET', '/api/stats/event-types?since=0&until=' + Date.now())
        assert.strictEqual(r.status, 200)
        const types = r.body.map(x => x.type)
        assert.ok(types.includes('pageview'), 'should include pageview')
        assert.ok(types.includes('scroll'), 'should include scroll')
    })

    // 19. GET /api/stats/event-types — sorted by count desc
    await test('GET /api/stats/event-types is sorted by count descending', async () => {
        const r = await request('GET', '/api/stats/event-types?since=0&until=' + Date.now())
        assert.strictEqual(r.status, 200)
        for (let i = 1; i < r.body.length; i++) {
            assert.ok(r.body[i - 1].count >= r.body[i].count, 'event types should be sorted by count desc')
        }
    })

    // 20. GET /api/events/recent
    await test('GET /api/events/recent returns recent events', async () => {
        const r = await request('GET', '/api/events/recent?limit=10&since=0&until=' + Date.now())
        assert.strictEqual(r.status, 200)
        assert.ok(Array.isArray(r.body))
        assert.ok(r.body.length >= 1)
    })

    // 21. GET /api/events/recent — respects limit
    await test('GET /api/events/recent respects limit parameter', async () => {
        const r = await request('GET', '/api/events/recent?limit=2')
        assert.strictEqual(r.status, 200)
        assert.ok(Array.isArray(r.body))
        assert.ok(r.body.length <= 2, 'should respect limit=2')
    })

    // 22. GET /api/events/recent — filter by page_url
    await test('GET /api/events/recent filters by page_url', async () => {
        const r = await request('GET', '/api/events/recent?limit=50&page_url=http://localhost/test')
        assert.strictEqual(r.status, 200)
        assert.ok(Array.isArray(r.body))
        r.body.forEach(e => {
            assert.strictEqual(e.page_url, 'http://localhost/test', 'all events should match filtered page_url')
        })
    })

    // 23. GET /api/events/recent — ordered by created_at desc
    await test('GET /api/events/recent is ordered by created_at descending', async () => {
        const r = await request('GET', '/api/events/recent?limit=50')
        assert.strictEqual(r.status, 200)
        for (let i = 1; i < r.body.length; i++) {
            assert.ok(r.body[i - 1].created_at >= r.body[i].created_at, 'recent events should be ordered desc')
        }
    })

    // 24. GET /api/events/recent — includes joined session data
    await test('GET /api/events/recent includes session data (user_agent, screen)', async () => {
        const r = await request('GET', '/api/events/recent?limit=5')
        assert.strictEqual(r.status, 200)
        if (r.body.length > 0) {
            const e = r.body[0]
            assert.ok(e.hasOwnProperty('user_agent'), 'should include user_agent from session join')
            assert.ok(e.hasOwnProperty('screen_w'), 'should include screen_w from session join')
        }
    })

    // 25. GET /api/stats/clicks
    await test('GET /api/stats/clicks returns click positions', async () => {
        const r = await request('GET', '/api/stats/clicks?since=0&until=' + Date.now())
        assert.strictEqual(r.status, 200)
        assert.ok(Array.isArray(r.body))
        assert.ok(r.body[0].x != null)
    })

    // 26. GET /api/stats/clicks — filter by page_url
    await test('GET /api/stats/clicks filters by page_url', async () => {
        const r = await request('GET', '/api/stats/clicks?since=0&until=' + Date.now() + '&page_url=http://localhost/test')
        assert.strictEqual(r.status, 200)
        assert.ok(Array.isArray(r.body))
        r.body.forEach(c => {
            assert.strictEqual(c.page_url, 'http://localhost/test', 'clicks should match filtered page_url')
        })
    })

    // 27. GET /api/stats/clicks — only returns click events with coordinates
    await test('GET /api/stats/clicks only returns events with coordinates', async () => {
        const r = await request('GET', '/api/stats/clicks?since=0&until=' + Date.now())
        assert.strictEqual(r.status, 200)
        r.body.forEach(c => {
            assert.ok(c.x != null, 'x should not be null')
            assert.ok(c.y != null, 'y should not be null')
        })
    })

    // 28. GET /api/stats/sessions
    await test('GET /api/stats/sessions returns session list', async () => {
        const r = await request('GET', '/api/stats/sessions?since=0&until=' + Date.now())
        assert.strictEqual(r.status, 200)
        assert.ok(Array.isArray(r.body))
        assert.ok(r.body.length > 0, 'should have at least one session')
        // Verify the test session exists somewhere in the list
        const testSession = r.body.find(s => s.id === 'test-session-001')
        assert.ok(testSession, 'test-session-001 should be in the sessions list')
    })

    // 29. GET /api/stats/sessions — includes event counts
    await test('GET /api/stats/sessions includes event and click counts', async () => {
        const r = await request('GET', '/api/stats/sessions?since=0&until=' + Date.now())
        assert.strictEqual(r.status, 200)
        assert.ok(r.body.length > 0)
        const session = r.body.find(s => s.id === 'test-session-001')
        assert.ok(session, 'test session should exist')
        assert.ok(typeof session.event_count === 'number', 'should have event_count')
        assert.ok(typeof session.click_count === 'number', 'should have click_count')
        assert.ok(session.event_count > 0, 'event_count should be > 0')
        assert.ok(session.click_count > 0, 'click_count should be > 0')
    })

    // 30. GET /api/stats/sessions — respects limit
    await test('GET /api/stats/sessions respects limit parameter', async () => {
        const r = await request('GET', '/api/stats/sessions?since=0&until=' + Date.now() + '&limit=1')
        assert.strictEqual(r.status, 200)
        assert.strictEqual(r.body.length, 1, 'should respect limit=1')
    })

    // ── Static Asset Serving ─────────────────────────────────────

    // 31. Admin redirect
    await test('GET /admin serves or redirects to admin HTML', async () => {
        const r = await request('GET', '/admin')
        // Express static redirects /admin → /admin/ (301), which then serves the HTML
        assert.ok(r.status === 200 || r.status === 301, `Expected 200 or 301, got ${r.status}`)
    })

    // 32. Tracker script
    await test('GET /u-click.js serves the tracker script', async () => {
        const r = await request('GET', '/u-click.js')
        assert.strictEqual(r.status, 200)
    })

    // 33. Chart.js served from node_modules
    await test('GET /chart.min.js serves Chart.js from node_modules', async () => {
        const r = await request('GET', '/chart.min.js')
        assert.strictEqual(r.status, 200)
    })

    // ── Edge Cases & Error Handling ──────────────────────────────

    // 34. POST /api/events — empty array
    await test('POST /api/events handles empty array gracefully', async () => {
        const r = await request('POST', '/api/events', [])
        assert.strictEqual(r.status, 200)
        assert.strictEqual(r.body.ok, true)
        assert.strictEqual(r.body.count, 0)
    })

    // 35. POST /api/events — session upsert (same session, updated data)
    await test('POST /api/events upserts session on duplicate session_id', async () => {
        const evt1 = { ...SAMPLE_EVENT, session_id: 'upsert-test', page_url: 'http://localhost/page1', ts: Date.now() }
        const evt2 = { ...SAMPLE_EVENT, session_id: 'upsert-test', page_url: 'http://localhost/page2', ts: Date.now() + 1000 }
        await request('POST', '/api/events', evt1)
        const r = await request('POST', '/api/events', evt2)
        assert.strictEqual(r.status, 200)

        // Session should exist and be updated
        const sessions = await request('GET', '/api/stats/sessions?since=0&until=' + (Date.now() + 2000) + '&limit=100')
        const upsertSession = sessions.body.find(s => s.id === 'upsert-test')
        assert.ok(upsertSession, 'upserted session should exist')
        assert.strictEqual(upsertSession.page_url, 'http://localhost/page2', 'session page_url should be updated')
    })

    // 36. POST /api/events — different event types
    await test('POST /api/events handles all standard event types', async () => {
        const types = ['click', 'pageview', 'scroll', 'form_submit', 'field_change', 'idle', 'active', 'page_hide', 'page_show']
        const batch = types.map(type => ({
            ...SAMPLE_EVENT,
            session_id: 'type-test-session',
            type,
            ts: Date.now(),
        }))
        const r = await request('POST', '/api/events', batch)
        assert.strictEqual(r.status, 200)
        assert.strictEqual(r.body.count, types.length)
    })

    // 37. GET /api/stats/summary — default until is Date.now()
    await test('GET /api/stats/summary works without explicit until parameter', async () => {
        const r = await request('GET', '/api/stats/summary?since=0')
        assert.strictEqual(r.status, 200)
        assert.ok(r.body.total_events >= 0)
    })

    // 38. GET /api/stats/timeline — default parameters
    await test('GET /api/stats/timeline works with default parameters', async () => {
        const r = await request('GET', '/api/stats/timeline')
        assert.strictEqual(r.status, 200)
        assert.ok(Array.isArray(r.body))
    })

    // 39. GET /api/stats/elements — limit parameter
    await test('GET /api/stats/elements respects limit parameter', async () => {
        const r = await request('GET', '/api/stats/elements?since=0&until=' + Date.now() + '&limit=1')
        assert.strictEqual(r.status, 200)
        assert.ok(r.body.length <= 1, 'should respect limit=1')
    })

    // 40. Verify scroll events stored scroll_pct
    await test('Scroll events have scroll_pct stored correctly', async () => {
        // Insert a scroll event with explicit scroll_pct
        const scrollEvt = { ...SAMPLE_EVENT, session_id: 'scroll-test', type: 'scroll', scroll_pct: 75, ts: Date.now() }
        await request('POST', '/api/events', scrollEvt)

        // Query recent events and find the scroll event
        const r = await request('GET', '/api/events/recent?limit=100')
        assert.strictEqual(r.status, 200)
        const scrollEvents = r.body.filter(e => e.session_id === 'scroll-test' && e.type === 'scroll')
        assert.ok(scrollEvents.length > 0, 'should have scroll events')
        assert.strictEqual(scrollEvents[0].scroll_pct, 75, 'scroll_pct should be stored correctly')
    })

    // ---------------------------------------------------------------------------
    console.log(`\n${passed} passed, ${failed} failed\n`)
    return failed
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
;(async () => {
    await new Promise((resolve) => {
        server.listen(PORT, '127.0.0.1', () => {
            const { port } = server.address()
            base = `http://127.0.0.1:${port}`
            resolve()
        })
    })

    let exitCode = 1
    try {
        exitCode = await runTests() > 0 ? 1 : 0
    } finally {
        server.close()
        db.close()
        process.exit(exitCode)
    }
})()
