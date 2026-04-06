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

    // 3. GET /api/stats/summary
    await test('GET /api/stats/summary returns stats object', async () => {
        const r = await request('GET', '/api/stats/summary?since=0&until=' + Date.now())
        assert.strictEqual(r.status, 200)
        assert.ok(typeof r.body.total_sessions === 'number')
        assert.ok(typeof r.body.total_events === 'number')
        assert.ok(r.body.total_events >= 3, 'should have at least the 3 inserted events')
    })

    // 4. GET /api/stats/pages
    await test('GET /api/stats/pages returns page list', async () => {
        const r = await request('GET', '/api/stats/pages?since=0&until=' + Date.now())
        assert.strictEqual(r.status, 200)
        assert.ok(Array.isArray(r.body))
        assert.ok(r.body.length >= 1)
        assert.ok(r.body[0].page_url)
    })

    // 5. GET /api/stats/elements
    await test('GET /api/stats/elements returns elements list', async () => {
        const r = await request('GET', '/api/stats/elements?since=0&until=' + Date.now())
        assert.strictEqual(r.status, 200)
        assert.ok(Array.isArray(r.body))
        assert.ok(r.body[0].target_tag === 'button')
    })

    // 6. GET /api/stats/timeline
    await test('GET /api/stats/timeline returns timeline data', async () => {
        const r = await request('GET', '/api/stats/timeline?since=0&until=' + Date.now())
        assert.strictEqual(r.status, 200)
        assert.ok(Array.isArray(r.body))
    })

    // 7. GET /api/stats/event-types
    await test('GET /api/stats/event-types returns type breakdown', async () => {
        const r = await request('GET', '/api/stats/event-types?since=0&until=' + Date.now())
        assert.strictEqual(r.status, 200)
        assert.ok(Array.isArray(r.body))
        const types = r.body.map(x => x.type)
        assert.ok(types.includes('click'), 'should include click type')
    })

    // 8. GET /api/events/recent
    await test('GET /api/events/recent returns recent events', async () => {
        const r = await request('GET', '/api/events/recent?limit=10&since=0&until=' + Date.now())
        assert.strictEqual(r.status, 200)
        assert.ok(Array.isArray(r.body))
        assert.ok(r.body.length >= 1)
    })

    // 9. GET /api/stats/clicks
    await test('GET /api/stats/clicks returns click positions', async () => {
        const r = await request('GET', '/api/stats/clicks?since=0&until=' + Date.now())
        assert.strictEqual(r.status, 200)
        assert.ok(Array.isArray(r.body))
        assert.ok(r.body[0].x != null)
    })

    // 10. GET /api/stats/sessions
    await test('GET /api/stats/sessions returns session list', async () => {
        const r = await request('GET', '/api/stats/sessions?since=0&until=' + Date.now())
        assert.strictEqual(r.status, 200)
        assert.ok(Array.isArray(r.body))
        assert.ok(r.body[0].id === 'test-session-001')
    })

    // 11. Admin redirect
    await test('GET /admin serves or redirects to admin HTML', async () => {
        const r = await request('GET', '/admin')
        // Express static redirects /admin → /admin/ (301), which then serves the HTML
        assert.ok(r.status === 200 || r.status === 301, `Expected 200 or 301, got ${r.status}`)
    })

    // 12. Tracker script
    await test('GET /u-click.js serves the tracker script', async () => {
        const r = await request('GET', '/u-click.js')
        assert.strictEqual(r.status, 200)
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
