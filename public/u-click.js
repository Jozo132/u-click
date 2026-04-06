/**
 * u-click.js — Portable universal web analytics tracker
 *
 * Drop this script tag on any page to start tracking:
 *   <script src="/u-click.js" data-server="https://your-server.com"></script>
 *
 * Optional attributes:
 *   data-server     — URL of the u-click backend  (default: same origin)
 *   data-app        — Application / site name     (default: hostname)
 *   data-session    — Force a session ID          (auto-generated if omitted)
 *   data-sample     — Sampling rate 0-1           (default: 1 = 100%)
 *   data-batch-ms   — Batch flush interval in ms  (default: 2000)
 *   data-scroll     — Enable scroll depth events  (default: true)
 *   data-rage       — Enable rage-click detection (default: true)
 *   data-idle-ms    — Idle timeout ms             (default: 30000)
 *
 * Or configure via window.uclick before the script loads:
 *   window.uclick = { server: '...', app: '...' }
 */
;(function (global) {
    'use strict'

    // -------------------------------------------------------------------------
    // Config resolution
    // -------------------------------------------------------------------------
    var script = document.currentScript ||
        (function () {
            var scripts = document.querySelectorAll('script[data-server], script[src*="u-click"]')
            return scripts[scripts.length - 1]
        })()

    function attr(name, fallback) {
        return (script && script.getAttribute('data-' + name)) || fallback
    }

    var cfg = Object.assign({
        server: attr('server', global.location.origin),
        app: attr('app', global.location.hostname),
        session: attr('session', null),
        sample: parseFloat(attr('sample', '1')),
        batchMs: parseInt(attr('batch-ms', '2000'), 10),
        scroll: attr('scroll', 'true') !== 'false',
        rage: attr('rage', 'true') !== 'false',
        idleMs: parseInt(attr('idle-ms', '30000'), 10),
    }, global.uclick || {})

    // Sampling gate
    if (Math.random() > cfg.sample) return

    // -------------------------------------------------------------------------
    // Session / storage helpers
    // -------------------------------------------------------------------------
    var STORAGE_KEY = 'uck_sid'

    function generateId() {
        var arr = new Uint8Array(9)
        ;(global.crypto || global.msCrypto).getRandomValues(arr)
        var hex = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
        return Date.now().toString(36) + '-' + hex
    }

    function getSessionId() {
        if (cfg.session) return cfg.session
        try {
            var existing = sessionStorage.getItem(STORAGE_KEY)
            if (existing) return existing
            var id = generateId()
            sessionStorage.setItem(STORAGE_KEY, id)
            return id
        } catch (_) {
            return generateId()
        }
    }

    var SESSION_ID = getSessionId()
    var SESSION_START = Date.now()

    // -------------------------------------------------------------------------
    // Transport — WebSocket with fetch fallback
    // -------------------------------------------------------------------------
    var wsUrl = (cfg.server.replace(/^http/, 'ws')) + '/ws?role=tracker'
    var ws = null
    var wsReady = false
    var wsQueue = []
    var fetchQueue = []
    var batchTimer = null
    var retryDelay = 1000
    var maxRetry = 30000

    function connectWS() {
        try {
            ws = new WebSocket(wsUrl)
        } catch (_) {
            ws = null
            return
        }

        ws.onopen = function () {
            wsReady = true
            retryDelay = 1000
            // Flush queued events
            if (wsQueue.length) {
                ws.send(JSON.stringify(wsQueue.splice(0)))
            }
        }

        ws.onclose = function () {
            wsReady = false
            ws = null
            // Retry with exponential back-off
            setTimeout(connectWS, retryDelay)
            retryDelay = Math.min(retryDelay * 2, maxRetry)
        }

        ws.onerror = function () {
            ws && ws.close()
        }

        ws.onmessage = function () { /* server acknowledgements ignored */ }
    }

    connectWS()

    function flushFetch() {
        if (!fetchQueue.length) return
        var rows = fetchQueue.splice(0)
        var url = cfg.server + '/api/events'
        try {
            if (navigator.sendBeacon) {
                navigator.sendBeacon(url, JSON.stringify(rows))
            } else {
                fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(rows),
                    keepalive: true,
                }).catch(function () { })
            }
        } catch (_) { }
    }

    function send(events) {
        if (!events.length) return
        if (wsReady && ws) {
            ws.send(JSON.stringify(events))
        } else {
            fetchQueue.push.apply(fetchQueue, events)
        }
    }

    // Buffer and batch
    var pendingBatch = []

    function enqueue(event) {
        pendingBatch.push(event)
        scheduleBatch()
    }

    function scheduleBatch() {
        if (batchTimer) return
        batchTimer = setTimeout(flush, cfg.batchMs)
    }

    function flush() {
        batchTimer = null
        if (!pendingBatch.length) return
        var events = pendingBatch.splice(0)
        send(events)
        if (fetchQueue.length) flushFetch()
    }

    // Flush on page hide / unload
    function forceFlush() {
        clearTimeout(batchTimer)
        batchTimer = null
        var all = pendingBatch.splice(0)
        if (all.length) {
            if (wsReady && ws) {
                ws.send(JSON.stringify(all))
            } else {
                fetchQueue.push.apply(fetchQueue, all)
            }
        }
        flushFetch()
    }

    // -------------------------------------------------------------------------
    // Event builder
    // -------------------------------------------------------------------------
    function now() { return Date.now() }

    function baseEvent(type, extra) {
        return Object.assign({
            session_id: SESSION_ID,
            session_start: SESSION_START,
            type: type,
            page_url: global.location.href,
            page_title: document.title,
            referrer: document.referrer || null,
            user_agent: navigator.userAgent,
            screen_w: screen.width,
            screen_h: screen.height,
            ts: now(),
        }, extra || {})
    }

    // -------------------------------------------------------------------------
    // Element info extraction
    // -------------------------------------------------------------------------
    function elementInfo(el) {
        if (!el) return {}
        var info = {
            target_tag: el.tagName ? el.tagName.toLowerCase() : null,
            target_id: el.id || null,
            target_cls: el.className && typeof el.className === 'string'
                ? el.className.trim().split(/\s+/).slice(0, 5).join(' ') || null
                : null,
            target_name: el.name || el.getAttribute && el.getAttribute('name') || null,
            target_text: null,
        }
        // Collect meaningful text (limit to 80 chars)
        var text = el.getAttribute && (
            el.getAttribute('aria-label') ||
            el.getAttribute('title') ||
            el.getAttribute('placeholder') ||
            el.getAttribute('alt')
        )
        if (!text) {
            text = (el.innerText || el.textContent || '').trim().slice(0, 80)
        }
        info.target_text = text || null
        return info
    }

    // Walk up the DOM to find the best interactive ancestor
    function findInteractive(el) {
        var INTERACTIVE = { A: 1, BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, LABEL: 1, SUMMARY: 1 }
        var node = el
        for (var i = 0; i < 5 && node && node !== document.body; i++) {
            if (INTERACTIVE[node.tagName]) return node
            if (node.getAttribute && (node.getAttribute('role') === 'button' ||
                node.getAttribute('onclick') ||
                node.getAttribute('data-action') ||
                node.getAttribute('data-click'))) return node
            node = node.parentElement
        }
        return el
    }

    // -------------------------------------------------------------------------
    // Click tracking
    // -------------------------------------------------------------------------
    var rageClicks = []
    var RAGE_WINDOW = 500
    var RAGE_COUNT = 3

    document.addEventListener('click', function (e) {
        var target = findInteractive(e.target)
        var info = elementInfo(target)
        var event = baseEvent('click', Object.assign({
            x: Math.round(e.clientX),
            y: Math.round(e.clientY),
        }, info))

        // Rage click detection
        if (cfg.rage) {
            var t = now()
            rageClicks = rageClicks.filter(function (ts) { return t - ts < RAGE_WINDOW })
            rageClicks.push(t)
            if (rageClicks.length >= RAGE_COUNT) {
                rageClicks = []
                event.extra = { rage: true }
            }
        }

        enqueue(event)
    }, true)

    // -------------------------------------------------------------------------
    // Form interaction tracking
    // -------------------------------------------------------------------------
    document.addEventListener('submit', function (e) {
        var info = elementInfo(e.target)
        enqueue(baseEvent('form_submit', info))
    }, true)

    document.addEventListener('change', function (e) {
        var el = e.target
        // Don't track values for password/sensitive fields
        var safe = el.type !== 'password' && el.type !== 'hidden'
        enqueue(baseEvent('field_change', Object.assign(elementInfo(el), {
            extra: safe && el.type ? { input_type: el.type } : null,
        })))
    }, true)

    // -------------------------------------------------------------------------
    // Scroll depth tracking
    // -------------------------------------------------------------------------
    if (cfg.scroll) {
        var scrollMilestones = [25, 50, 75, 90, 100]
        var reached = {}
        var scrollTimer = null

        function onScroll() {
            clearTimeout(scrollTimer)
            scrollTimer = setTimeout(function () {
                var scrolled = global.scrollY || global.pageYOffset || 0
                var total = Math.max(
                    document.body.scrollHeight - global.innerHeight,
                    1
                )
                var pct = Math.min(100, Math.round((scrolled / total) * 100))
                for (var i = 0; i < scrollMilestones.length; i++) {
                    var m = scrollMilestones[i]
                    if (pct >= m && !reached[m]) {
                        reached[m] = true
                        enqueue(baseEvent('scroll', { scroll_pct: m }))
                    }
                }
            }, 200)
        }

        global.addEventListener('scroll', onScroll, { passive: true })
    }

    // -------------------------------------------------------------------------
    // Page visibility & idle tracking
    // -------------------------------------------------------------------------
    var idleTimer = null
    var isIdle = false

    function resetIdle() {
        if (isIdle) {
            isIdle = false
            enqueue(baseEvent('active'))
        }
        clearTimeout(idleTimer)
        idleTimer = setTimeout(function () {
            isIdle = true
            enqueue(baseEvent('idle'))
        }, cfg.idleMs)
    }

    ;['mousemove', 'keydown', 'touchstart', 'click'].forEach(function (ev) {
        document.addEventListener(ev, resetIdle, { passive: true })
    })
    resetIdle()

    document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
            enqueue(baseEvent('page_hide'))
            forceFlush()
        } else {
            enqueue(baseEvent('page_show'))
        }
    })

    // -------------------------------------------------------------------------
    // Page view
    // -------------------------------------------------------------------------
    enqueue(baseEvent('pageview'))

    // -------------------------------------------------------------------------
    // SPA navigation support (history API patching)
    // -------------------------------------------------------------------------
    function patchHistory(method) {
        var orig = history[method]
        history[method] = function () {
            orig.apply(history, arguments)
            enqueue(baseEvent('pageview'))
            // Reset scroll milestones on navigation
            if (cfg.scroll) { reached = {}; }
        }
    }
    patchHistory('pushState')
    patchHistory('replaceState')
    global.addEventListener('popstate', function () {
        enqueue(baseEvent('pageview'))
        if (cfg.scroll) { reached = {}; }
    })

    // -------------------------------------------------------------------------
    // MutationObserver — detect dynamically added interactive elements
    // -------------------------------------------------------------------------
    var observer = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
            var added = mutations[i].addedNodes
            for (var j = 0; j < added.length; j++) {
                var node = added[j]
                if (node.nodeType !== 1) continue
                // Report when significant interactive islands appear
                if (node.querySelectorAll) {
                    var interactive = node.querySelectorAll('form, [role="dialog"], [role="modal"], nav, [data-track]')
                    if (interactive.length || node.matches && node.matches('form,[role="dialog"],nav,[data-track]')) {
                        enqueue(baseEvent('dom_insert', {
                            target_tag: node.tagName ? node.tagName.toLowerCase() : null,
                            target_id: node.id || null,
                            target_cls: typeof node.className === 'string'
                                ? node.className.trim().slice(0, 100) || null
                                : null,
                        }))
                    }
                }
            }
        }
    })
    observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
    })

    // -------------------------------------------------------------------------
    // Unload — flush remaining events
    // -------------------------------------------------------------------------
    global.addEventListener('pagehide', forceFlush)
    global.addEventListener('beforeunload', forceFlush)

    // -------------------------------------------------------------------------
    // Expose minimal public API
    // -------------------------------------------------------------------------
    global.uclick = {
        track: function (type, extra) {
            enqueue(baseEvent(type, extra || {}))
        },
        flush: forceFlush,
        sessionId: SESSION_ID,
    }

}(window))
