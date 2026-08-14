/**
 * Site-wide debug overlays: UA/host HUD, console toasts, performance graph.
 * Reads proxyList_app_settings_v1 from localStorage (and IndexedDB when present).
 * On the main list page, call ProxyListDebug.applySettings(appSettings) after settings load/change.
 */
(function (global) {
  "use strict";

  if (global.ProxyListDebug && global.ProxyListDebug.__booted) return;

  var LS_KEY = "proxyList_app_settings_v1";
  var LS_DEBUG_KEY = "proxyList_debug_overlays_v1";
  var IDB_NAME = "proxyListSettings";
  var IDB_STORE = "appSettings";
  var STYLE_ID = "proxyListDebugOverlayStyles";

  var settings = {
    debugMode: false,
    debugShowUserAgent: true,
    debugPerfGraph: false,
  };

  var consoleLogBuffer = [];
  var chunkLogBuffer = [];
  var consoleHooksInstalled = false;
  var perfTimer = null;
  var perfSamples = [];
  var lastFrameTs = 0;
  var cpuEma = 0;
  var bootPromise = null;
  var lastScriptRankTs = 0;
  var longTaskMsByScript = Object.create(null);
  var longTaskObserverStarted = false;

  function $(id) {
    return document.getElementById(id);
  }

  function normalizeDebugSettings(raw) {
    var out = {
      debugMode: false,
      debugShowUserAgent: true,
      debugPerfGraph: false,
    };
    if (!raw || typeof raw !== "object") return out;
    if (typeof raw.debugMode === "boolean") out.debugMode = raw.debugMode;
    else if (raw.debugMode === "enabled") out.debugMode = true;
    else if (raw.debugMode === "disabled") out.debugMode = false;
    if (typeof raw.debugShowUserAgent === "boolean") out.debugShowUserAgent = raw.debugShowUserAgent;
    if (typeof raw.debugPerfGraph === "boolean") out.debugPerfGraph = raw.debugPerfGraph;
    return out;
  }

  function isDebugMode() {
    return settings.debugMode === true;
  }

  function readLocalStorageSettings() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function readDebugMirror() {
    try {
      var raw = localStorage.getItem(LS_DEBUG_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function writeDebugMirror(raw) {
    try {
      var n = normalizeDebugSettings(raw);
      localStorage.setItem(
        LS_DEBUG_KEY,
        JSON.stringify({
          debugMode: n.debugMode === true,
          debugShowUserAgent: n.debugShowUserAgent !== false,
          debugPerfGraph: n.debugPerfGraph === true,
        })
      );
    } catch (_) {}
  }

  function readIdbSettings() {
    return new Promise(function (resolve) {
      try {
        if (!global.indexedDB) {
          resolve(null);
          return;
        }
        var req = indexedDB.open(IDB_NAME, 1);
        req.onerror = function () {
          resolve(null);
        };
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        };
        req.onsuccess = function () {
          var db = req.result;
          try {
            var tx = db.transaction(IDB_STORE, "readonly");
            var getReq = tx.objectStore(IDB_STORE).get("default");
            getReq.onsuccess = function () {
              resolve(getReq.result || null);
            };
            getReq.onerror = function () {
              resolve(null);
            };
          } catch (_) {
            resolve(null);
          }
        };
      } catch (_) {
        resolve(null);
      }
    });
  }

  function injectStyles() {
    var css =
      "#debugPerfGraph{position:fixed;right:0.75rem;bottom:0.75rem;z-index:94;width:min(20rem,calc(100vw - 1.5rem));max-height:min(72vh,32rem);overflow:auto;padding:0.55rem 0.65rem 0.65rem;border-radius:10px;border:1px solid #6b4a12;background:rgba(22,16,6,0.96);color:#f5e6c8;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.68rem;line-height:1.35;box-shadow:0 8px 22px rgba(0,0,0,0.4);pointer-events:auto}" +
      "#debugPerfGraph[hidden]{display:none!important}" +
      "#debugPerfGraph .debug-perf-title{color:#ffd27a;font-weight:700;margin-bottom:0.35rem}" +
      "#debugPerfGraph .debug-perf-chart{margin-top:0.45rem}" +
      "#debugPerfGraph .debug-perf-chart-label{display:flex;justify-content:space-between;gap:0.5rem;color:#d8c9a8;margin-bottom:0.15rem}" +
      "#debugPerfGraph .debug-perf-chart-label strong{color:#f5e6c8;font-weight:600}" +
      "#debugPerfGraph canvas{display:block;width:100%;height:48px;border-radius:4px;background:rgba(0,0,0,0.25)}" +
      "#debugPerfGraph .debug-perf-scripts{margin-top:0.55rem;border-top:1px solid #6b4a12;padding-top:0.45rem}" +
      "#debugPerfGraph .debug-perf-scripts-title{color:#ffd27a;font-weight:700;margin-bottom:0.3rem}" +
      "#debugPerfGraph .debug-perf-scripts-hint{color:#a89878;margin:0 0 0.35rem;font-size:0.62rem}" +
      "#debugPerfGraph .debug-perf-script-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:0.3rem}" +
      "#debugPerfGraph .debug-perf-script-list li{display:grid;grid-template-columns:1fr auto;gap:0.15rem 0.45rem;align-items:baseline}" +
      "#debugPerfGraph .debug-perf-script-name{color:#f5e6c8;overflow-wrap:anywhere;word-break:break-word}" +
      "#debugPerfGraph .debug-perf-script-meta{color:#9be7ff;white-space:nowrap;font-variant-numeric:tabular-nums}" +
      "#debugPerfGraph .debug-perf-script-sub{grid-column:1 / -1;color:#a89878;font-size:0.62rem}" +
      "#debugPerfGraph .debug-perf-scripts-empty{color:#a89878;margin:0}" +
      "#debugHudBar{position:fixed;top:0;left:0;right:0;z-index:95;padding:0.35rem 0.65rem;background:rgba(18,14,6,0.96);border-bottom:1px solid #6b4a12;color:#f5e6c8;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.68rem;line-height:1.35;pointer-events:none}" +
      "#debugHudBar[hidden]{display:none!important}" +
      "#debugHudBar .debug-hud-row{display:block;overflow-wrap:anywhere;word-break:break-word}" +
      "#debugHudBar .debug-hud-label{color:#ffd27a;font-weight:600}" +
      "html.debug-mode-on{scroll-padding-top:3.5rem}" +
      "html.debug-mode-on body{padding-top:3.25rem}" +
      ".debug-toast-stack{position:fixed;left:0.75rem;bottom:0.75rem;z-index:96;display:flex;flex-direction:column-reverse;gap:0.45rem;width:min(24rem,calc(100vw - 1.5rem));max-height:min(50vh,22rem);overflow:hidden;pointer-events:none}" +
      ".debug-toast{pointer-events:none;padding:0.55rem 0.65rem;border-radius:10px;border:1px solid #6b4a12;background:rgba(22,16,6,0.96);box-shadow:0 8px 22px rgba(0,0,0,0.4);color:#f5e6c8;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.72rem;line-height:1.35;overflow-wrap:anywhere;word-break:break-word;opacity:0;transform:translateY(8px);transition:opacity 0.18s ease,transform 0.18s ease}" +
      ".debug-toast.visible{opacity:1;transform:translateY(0)}" +
      ".debug-toast.debug-toast-error{border-color:#a83d3d;background:rgba(42,16,16,0.96);color:#ffb4b4}" +
      ".debug-toast.debug-toast-chunk{border-color:#2d6aa8;background:rgba(12,24,36,0.96);color:#9be7ff}" +
      ".debug-toast.debug-toast-info{border-color:#6b4a12;color:#f5e6c8}" +
      ".debug-toast-kind{display:block;font-weight:700;margin-bottom:0.15rem;text-transform:uppercase;letter-spacing:0.03em;font-size:0.66rem;opacity:0.9}" +
      'html[data-animations="disabled"] .debug-toast{transition:none!important}';
    var style = $(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = css;
  }

  function ensureDom() {
    if (!document.body) return false;
    if (!$("debugHudBar")) {
      var hud = document.createElement("div");
      hud.id = "debugHudBar";
      hud.hidden = true;
      hud.setAttribute("aria-live", "polite");
      hud.innerHTML =
        '<span class="debug-hud-row"><span class="debug-hud-label">UA:</span> <span id="debugHudUa"></span></span>' +
        '<span class="debug-hud-row"><span class="debug-hud-label">Host:</span> <span id="debugHudHost"></span></span>';
      document.body.appendChild(hud);
    }
    if (!$("debugToastStack")) {
      var stack = document.createElement("div");
      stack.id = "debugToastStack";
      stack.className = "debug-toast-stack";
      stack.setAttribute("aria-live", "polite");
      stack.setAttribute("aria-relevant", "additions");
      document.body.appendChild(stack);
    }
    if (!$("debugPerfGraph")) {
      var panel = document.createElement("aside");
      panel.id = "debugPerfGraph";
      panel.hidden = true;
      panel.setAttribute("aria-label", "Performance graph");
      panel.innerHTML =
        '<div class="debug-perf-title">Performance</div>' +
        '<div class="debug-perf-chart"><div class="debug-perf-chart-label"><span>CPU pressure</span><strong id="debugPerfCpuValue">—</strong></div>' +
        '<canvas id="debugPerfCpuCanvas" width="300" height="48" aria-hidden="true"></canvas></div>' +
        '<div class="debug-perf-chart"><div class="debug-perf-chart-label"><span>JS heap</span><strong id="debugPerfRamValue">—</strong></div>' +
        '<canvas id="debugPerfRamCanvas" width="300" height="48" aria-hidden="true"></canvas></div>' +
        '<div class="debug-perf-scripts">' +
        '<div class="debug-perf-scripts-title">Top scripts</div>' +
        '<p class="debug-perf-scripts-hint">Ranked by transfer size, load time, and long-task time when available.</p>' +
        '<ul class="debug-perf-script-list" id="debugPerfScriptList"></ul>' +
        '<p class="debug-perf-scripts-empty" id="debugPerfScriptsEmpty">Collecting…</p>' +
        "</div>";
      document.body.appendChild(panel);
    } else if (!$("debugPerfScriptList")) {
      var existing = $("debugPerfGraph");
      var scriptsWrap = document.createElement("div");
      scriptsWrap.className = "debug-perf-scripts";
      scriptsWrap.innerHTML =
        '<div class="debug-perf-scripts-title">Top scripts</div>' +
        '<p class="debug-perf-scripts-hint">Ranked by transfer size, load time, and long-task time when available.</p>' +
        '<ul class="debug-perf-script-list" id="debugPerfScriptList"></ul>' +
        '<p class="debug-perf-scripts-empty" id="debugPerfScriptsEmpty">Collecting…</p>';
      existing.appendChild(scriptsWrap);
    }
    return true;
  }

  function describePageHostContext() {
    try {
      var loc = global.location;
      var protocol = String(loc.protocol || "").toLowerCase();
      var host = String(loc.hostname || "").toLowerCase();
      if (protocol === "file:") return "Local page (file://)";
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "[::1]" ||
        host.endsWith(".localhost") ||
        host.endsWith(".local")
      ) {
        return "Local page (" + (loc.host || host || "localhost") + ")";
      }
      if (!host) return "Unknown host";
      return "Hosted externally (" + (loc.host || host) + ")";
    } catch (_) {
      return "Unknown host";
    }
  }

  function pushLogBuffer(kind, message) {
    var entry = {
      at: new Date().toISOString(),
      kind: kind,
      message: String(message || ""),
    };
    if (kind === "chunk") {
      chunkLogBuffer.push(entry);
      if (chunkLogBuffer.length > 500) chunkLogBuffer.shift();
    } else {
      consoleLogBuffer.push(entry);
      if (consoleLogBuffer.length > 500) consoleLogBuffer.shift();
    }
  }

  function formatDebugArg(arg) {
    if (arg == null) return String(arg);
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return arg.stack || arg.message || String(arg);
    try {
      return JSON.stringify(arg);
    } catch (_) {
      return String(arg);
    }
  }

  function showToast(kind, message) {
    if (!isDebugMode()) return;
    pushLogBuffer(
      kind === "chunk" ? "chunk" : kind === "error" ? "error" : kind === "warn" ? "warn" : "info",
      message
    );
    ensureDom();
    var stack = $("debugToastStack");
    if (!stack) return;
    var toast = document.createElement("div");
    var k = kind === "error" ? "error" : kind === "chunk" ? "chunk" : "info";
    toast.className = "debug-toast debug-toast-" + k;
    toast.setAttribute("role", k === "error" ? "alert" : "status");
    var label = document.createElement("span");
    label.className = "debug-toast-kind";
    label.textContent =
      kind === "error" ? "Error" : kind === "chunk" ? "Load time" : kind === "info" ? "Info" : "Warn";
    var body = document.createElement("div");
    var ts = new Date().toISOString().slice(11, 23);
    body.textContent = "[" + ts + "] " + String(message || "");
    toast.appendChild(label);
    toast.appendChild(body);
    stack.appendChild(toast);
    while (stack.childNodes.length > 8) stack.removeChild(stack.firstChild);
    requestAnimationFrame(function () {
      toast.classList.add("visible");
    });
    var holdMs = k === "error" ? 9000 : k === "chunk" ? 5500 : 7000;
    setTimeout(function () {
      toast.classList.remove("visible");
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 220);
    }, holdMs);
  }

  function syncHudBar() {
    ensureDom();
    var bar = $("debugHudBar");
    if (!bar) return;
    var on = isDebugMode() && settings.debugShowUserAgent !== false;
    bar.hidden = !on;
    document.documentElement.classList.toggle("debug-mode-on", on);
    if (!on) return;
    var uaEl = $("debugHudUa");
    var hostEl = $("debugHudHost");
    if (uaEl) uaEl.textContent = navigator.userAgent || "(unavailable)";
    if (hostEl) hostEl.textContent = describePageHostContext();
  }

  function drawPerfSeries(canvas, samples, key, maxValue, color) {
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext("2d");
    var w = canvas.width;
    var h = canvas.height;
    var maxV = Math.max(1, Number(maxValue) || 1);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(245, 230, 200, 0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(1, h - 2);
    ctx.lineTo(w - 1, h - 2);
    ctx.stroke();
    if (!samples.length) return;
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    samples.forEach(function (s, i) {
      var val = Math.max(0, Number(s[key]) || 0);
      var x = (i / Math.max(1, samples.length - 1)) * (w - 2) + 1;
      var y = h - 2 - (Math.min(maxV, val) / maxV) * (h - 4);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function shortScriptLabel(url) {
    var raw = String(url || "");
    if (!raw) return "(unknown)";
    try {
      var u = new URL(raw, global.location.href);
      var parts = u.pathname.split("/").filter(Boolean);
      var file = parts.length ? parts[parts.length - 1] : u.hostname || raw;
      if (!file) file = u.hostname || raw;
      if (file.length > 42) file = file.slice(0, 20) + "…" + file.slice(-18);
      return file;
    } catch (_) {
      return raw.length > 42 ? raw.slice(0, 20) + "…" + raw.slice(-18) : raw;
    }
  }

  function formatBytes(n) {
    var v = Number(n) || 0;
    if (v <= 0) return "—";
    if (v < 1024) return v + " B";
    if (v < 1048576) return (v / 1024).toFixed(1) + " KB";
    return (v / 1048576).toFixed(2) + " MB";
  }

  function formatMs(n) {
    var v = Number(n) || 0;
    if (v <= 0) return "—";
    if (v < 10) return v.toFixed(1) + " ms";
    return Math.round(v) + " ms";
  }

  function normalizeScriptKey(url) {
    var raw = String(url || "");
    if (!raw) return "";
    try {
      var u = new URL(raw, global.location.href);
      u.hash = "";
      return u.href;
    } catch (_) {
      return raw.split("#")[0];
    }
  }

  function isScriptResourceEntry(entry) {
    if (!entry) return false;
    var type = String(entry.initiatorType || "").toLowerCase();
    if (type === "script") return true;
    var name = String(entry.name || "").toLowerCase();
    return /\.m?js(\?|$)/.test(name) || /\/[^/?]+\.m?js(\?|$)/.test(name);
  }

  function ensureLongTaskObserver() {
    if (longTaskObserverStarted) return;
    longTaskObserverStarted = true;
    if (typeof PerformanceObserver === "undefined") return;
    try {
      var obs = new PerformanceObserver(function (list) {
        var entries = list.getEntries ? list.getEntries() : [];
        for (var i = 0; i < entries.length; i++) {
          var entry = entries[i];
          var dur = Number(entry.duration) || 0;
          var attrs = entry.attribution || [];
          if (!attrs.length) {
            var key = "(unattributed)";
            longTaskMsByScript[key] = (longTaskMsByScript[key] || 0) + dur;
            continue;
          }
          for (var j = 0; j < attrs.length; j++) {
            var a = attrs[j] || {};
            var src =
              normalizeScriptKey(a.containerSrc || a.scriptUrl || a.name || "") ||
              String(a.containerType || "script");
            longTaskMsByScript[src] = (longTaskMsByScript[src] || 0) + dur;
          }
        }
      });
      obs.observe({ type: "longtask", buffered: true });
    } catch (_) {}
  }

  function collectTopScripts(limit) {
    var byKey = Object.create(null);
    try {
      var resources =
        performance && typeof performance.getEntriesByType === "function"
          ? performance.getEntriesByType("resource")
          : [];
      for (var i = 0; i < resources.length; i++) {
        var entry = resources[i];
        if (!isScriptResourceEntry(entry)) continue;
        var key = normalizeScriptKey(entry.name);
        if (!key) continue;
        var size = Number(entry.decodedBodySize) || Number(entry.transferSize) || 0;
        var duration = Number(entry.duration) || 0;
        if (!byKey[key]) {
          byKey[key] = { key: key, size: 0, duration: 0, longTaskMs: 0, hits: 0 };
        }
        byKey[key].size = Math.max(byKey[key].size, size);
        byKey[key].duration += duration;
        byKey[key].hits += 1;
      }
    } catch (_) {}

    Object.keys(longTaskMsByScript).forEach(function (ltKey) {
      var ltMs = Number(longTaskMsByScript[ltKey]) || 0;
      if (!ltMs) return;
      if (byKey[ltKey]) {
        byKey[ltKey].longTaskMs += ltMs;
        return;
      }
      var matched = false;
      Object.keys(byKey).forEach(function (resKey) {
        if (matched) return;
        if (resKey.indexOf(ltKey) !== -1 || (ltKey.length > 8 && ltKey.indexOf(resKey) !== -1)) {
          byKey[resKey].longTaskMs += ltMs;
          matched = true;
        }
      });
      if (!matched) {
        byKey[ltKey] = { key: ltKey, size: 0, duration: 0, longTaskMs: ltMs, hits: 0 };
      }
    });

    var rows = Object.keys(byKey).map(function (k) {
      return byKey[k];
    });
    rows.forEach(function (row) {
      // Weight: 1 point per KB + 2 points per load ms + 8 points per long-task ms.
      row.score = row.size / 1024 + row.duration * 2 + row.longTaskMs * 8;
    });
    rows.sort(function (a, b) {
      return b.score - a.score;
    });
    return rows.slice(0, Math.max(1, limit || 6));
  }

  function renderTopScripts() {
    ensureDom();
    var list = $("debugPerfScriptList");
    var empty = $("debugPerfScriptsEmpty");
    if (!list) return;
    var rows = collectTopScripts(6);
    list.replaceChildren();
    if (!rows.length || rows.every(function (r) { return r.score <= 0; })) {
      if (empty) {
        empty.hidden = false;
        empty.textContent = "No script timings yet.";
      }
      return;
    }
    if (empty) empty.hidden = true;
    rows.forEach(function (row, idx) {
      var li = document.createElement("li");
      var name = document.createElement("span");
      name.className = "debug-perf-script-name";
      name.textContent = idx + 1 + ". " + shortScriptLabel(row.key);
      name.title = row.key;
      var meta = document.createElement("span");
      meta.className = "debug-perf-script-meta";
      meta.textContent = formatBytes(row.size);
      var sub = document.createElement("span");
      sub.className = "debug-perf-script-sub";
      var bits = ["load " + formatMs(row.duration)];
      if (row.longTaskMs > 0) bits.push("long " + formatMs(row.longTaskMs));
      if (row.hits > 1) bits.push("×" + row.hits);
      sub.textContent = bits.join(" · ");
      li.appendChild(name);
      li.appendChild(meta);
      li.appendChild(sub);
      list.appendChild(li);
    });
  }

  function syncPerfGraph() {
    ensureDom();
    var panel = $("debugPerfGraph");
    if (!panel) return;
    var on = isDebugMode() && settings.debugPerfGraph === true;
    panel.hidden = !on;
    if (!on) {
      if (perfTimer) {
        cancelAnimationFrame(perfTimer);
        perfTimer = null;
      }
      return;
    }
    ensureLongTaskObserver();
    if (perfTimer) return;
    lastFrameTs = performance.now();
    var tick = function (now) {
      perfTimer = null;
      if (!(isDebugMode() && settings.debugPerfGraph === true)) return;
      var dt = Math.max(1, now - lastFrameTs);
      lastFrameTs = now;
      var frameCost = Math.min(100, Math.max(0, ((dt - 16.7) / 16.7) * 100));
      cpuEma = cpuEma * 0.85 + frameCost * 0.15;
      var heapUsedMb = null;
      try {
        var mem = performance.memory;
        if (mem && mem.usedJSHeapSize) heapUsedMb = mem.usedJSHeapSize / 1048576;
      } catch (_) {}
      var cpuEl = $("debugPerfCpuValue");
      if (cpuEl) cpuEl.textContent = "~" + cpuEma.toFixed(0) + "%";
      var ramEl = $("debugPerfRamValue");
      if (ramEl) ramEl.textContent = heapUsedMb == null ? "n/a" : heapUsedMb.toFixed(1) + " MB";
      perfSamples.push({ cpu: cpuEma, heapMb: heapUsedMb == null ? 0 : heapUsedMb });
      if (perfSamples.length > 60) perfSamples.shift();
      var ramScale = Math.max((heapUsedMb || 0) * 1.25, 100);
      drawPerfSeries($("debugPerfCpuCanvas"), perfSamples, "cpu", 100, "#9be7ff");
      drawPerfSeries($("debugPerfRamCanvas"), perfSamples, "heapMb", ramScale, "#ffd27a");
      if (!lastScriptRankTs || now - lastScriptRankTs > 1000) {
        lastScriptRankTs = now;
        renderTopScripts();
      }
      perfTimer = requestAnimationFrame(tick);
    };
    perfTimer = requestAnimationFrame(tick);
  }

  function captureConsoleMessage(level, args) {
    if (!isDebugMode()) return;
    var text = Array.prototype.map.call(args || [], formatDebugArg).join(" ");
    if (!text) return;
    showToast(level === "error" ? "error" : "warn", text);
  }

  function installConsoleHooks() {
    if (consoleHooksInstalled) return;
    consoleHooksInstalled = true;
    var origError = console.error.bind(console);
    var origWarn = console.warn.bind(console);
    console.error = function () {
      try {
        captureConsoleMessage("error", arguments);
      } catch (_) {}
      return origError.apply(console, arguments);
    };
    console.warn = function () {
      try {
        captureConsoleMessage("warn", arguments);
      } catch (_) {}
      return origWarn.apply(console, arguments);
    };
    global.addEventListener("error", function (ev) {
      if (!isDebugMode()) return;
      var msg =
        (ev && ev.message ? ev.message : "window error") +
        (ev && ev.filename ? " @ " + ev.filename + ":" + (ev.lineno || "?") : "");
      showToast("error", msg);
    });
    global.addEventListener("unhandledrejection", function (ev) {
      if (!isDebugMode()) return;
      showToast("error", "unhandledrejection: " + formatDebugArg(ev && ev.reason));
    });
  }

  function sync() {
    injectStyles();
    ensureDom();
    installConsoleHooks();
    syncHudBar();
    var stack = $("debugToastStack");
    if (stack && !isDebugMode()) stack.replaceChildren();
    syncPerfGraph();
  }

  function applySettings(raw) {
    settings = normalizeDebugSettings(raw);
    writeDebugMirror(settings);
    sync();
  }

  function mergeSettingsSources(fromLs, fromIdb, fromMirror) {
    var merged = {};
    if (fromLs && typeof fromLs === "object") merged = Object.assign(merged, fromLs);
    if (fromIdb && typeof fromIdb === "object") merged = Object.assign(merged, fromIdb);
    if (fromMirror && typeof fromMirror === "object") merged = Object.assign(merged, fromMirror);
    // Prefer whichever source explicitly enables debug mode / perf graph.
    if (fromLs && fromLs.debugMode === true) merged.debugMode = true;
    if (fromIdb && fromIdb.debugMode === true) merged.debugMode = true;
    if (fromMirror && fromMirror.debugMode === true) merged.debugMode = true;
    if (fromLs && fromLs.debugPerfGraph === true) merged.debugPerfGraph = true;
    if (fromIdb && fromIdb.debugPerfGraph === true) merged.debugPerfGraph = true;
    if (fromMirror && fromMirror.debugPerfGraph === true) merged.debugPerfGraph = true;
    return merged;
  }

  function loadAndSync() {
    if (bootPromise) return bootPromise;
    bootPromise = Promise.resolve()
      .then(function () {
        var fromLs = readLocalStorageSettings();
        var fromMirror = readDebugMirror();
        // Always try IndexedDB as well — settings may live there even when the
        // "save locally" toggle is off, or when localStorage was cleared.
        return readIdbSettings().then(function (fromIdb) {
          return mergeSettingsSources(fromLs, fromIdb, fromMirror);
        });
      })
      .then(function (merged) {
        applySettings(merged);
        if (isDebugMode()) {
          showToast("info", "Debug overlays active on this page.");
        }
        return settings;
      })
      .catch(function () {
        applySettings(null);
        return settings;
      });
    return bootPromise;
  }

  function bootWhenReady() {
    injectStyles();
    function go() {
      ensureDom();
      loadAndSync().then(function () {
        // Re-assert DOM after late layout scripts (e.g. stats charts).
        setTimeout(function () {
          ensureDom();
          sync();
        }, 500);
      });
    }
    if (document.body) go();
    else document.addEventListener("DOMContentLoaded", go);

    try {
      global.addEventListener("storage", function (ev) {
        if (!ev || (ev.key !== LS_KEY && ev.key !== LS_DEBUG_KEY)) return;
        bootPromise = null;
        loadAndSync();
      });
    } catch (_) {}
  }

  var api = {
    __booted: true,
    applySettings: applySettings,
    sync: sync,
    showToast: showToast,
    isDebugMode: isDebugMode,
    describeHost: describePageHostContext,
    getConsoleLogs: function () {
      return consoleLogBuffer.slice();
    },
    getChunkLogs: function () {
      return chunkLogBuffer.slice();
    },
    getSettings: function () {
      return Object.assign({}, settings);
    },
  };

  global.ProxyListDebug = api;
  bootWhenReady();
})(typeof window !== "undefined" ? window : this);
