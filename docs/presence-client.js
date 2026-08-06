/**
 * Shared presence ping for User Statistics aggregates (Worker → Firestore).
 * Safe no-op when the Worker API is unavailable (e.g. plain GitHub Pages).
 */
(function (global) {
  "use strict";

  var lastPingAt = 0;
  var MIN_PING_GAP_MS = 45 * 1000;
  var inFlight = false;

  function resolveApiUrl() {
    try {
      var path = String((global.location && global.location.pathname) || "");
      if (/\/stats(\/|$)/i.test(path) || /\/contribute(\/|$)/i.test(path) || /\/community(\/|$)/i.test(path) || /\/about(\/|$)/i.test(path) || /\/account(\/|$)/i.test(path) || /\/login(\/|$)/i.test(path) || /\/admin(\/|$)/i.test(path)) {
        return "../api/presence-ping";
      }
    } catch (_) {}
    return "./api/presence-ping";
  }

  function ping(opts) {
    opts = opts || {};
    var sessionId = String(opts.sessionId || "").trim();
    if (!sessionId || sessionId.length < 8) return Promise.resolve({ ok: false, error: "no_session" });
    var now = Date.now();
    if (!opts.force && (inFlight || now - lastPingAt < MIN_PING_GAP_MS)) {
      return Promise.resolve({ ok: true, skipped: true });
    }
    inFlight = true;
    lastPingAt = now;

    var body = {
      sessionId: sessionId.slice(0, 128),
      uid: opts.uid ? String(opts.uid).slice(0, 128) : "",
      anonymous: !!opts.anonymous,
      displayName: opts.displayName ? String(opts.displayName).slice(0, 32) : "",
    };

    return fetch(resolveApiUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    })
      .then(function (res) {
        return res.json().catch(function () {
          return { ok: res.ok };
        });
      })
      .catch(function () {
        return { ok: false, error: "network" };
      })
      .finally(function () {
        inFlight = false;
      });
  }

  global.ProxyListPresence = { ping: ping };
})(typeof window !== "undefined" ? window : globalThis);
