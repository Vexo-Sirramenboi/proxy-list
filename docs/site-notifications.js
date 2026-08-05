/**
 * Right-side toast notifications for GitHub + site feedback events.
 * Loaded by docs/index.html; uses window helpers when available.
 */
(function (global) {
  "use strict";

  function iconBase() {
    try {
      var scripts = document.getElementsByTagName("script");
      for (var i = scripts.length - 1; i >= 0; i--) {
        var src = scripts[i].getAttribute("src") || scripts[i].src || "";
        if (src.indexOf("site-notifications.js") !== -1) {
          return src.replace(/site-notifications\.js(\?.*)?$/i, "icons/");
        }
      }
    } catch (_) {}
    return "./icons/";
  }

  function iconUrl(file) {
    return iconBase() + file;
  }

  var ICON = {
    issueClosed: iconUrl("issue-closed-24.svg"),
    issueReopened: iconUrl("issue-reopened-24.svg"),
    pr: iconUrl("git-pull-request-24.svg"),
    prClosed: iconUrl("git-pull-request-closed-24.svg"),
    code: iconUrl("code-24.svg"),
    suspended: iconUrl("account-suspended.png"),
  };

  var stackEl = null;
  var reasonModal = null;
  var dismissed = Object.create(null);
  var countdownTimer = null;
  var DISMISS_KEY = "proxyList_site_toasts_dismissed_v1";

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function loadDismissed() {
    try {
      var raw = localStorage.getItem(DISMISS_KEY);
      var parsed = raw ? JSON.parse(raw) : {};
      dismissed = parsed && typeof parsed === "object" ? parsed : Object.create(null);
    } catch (_) {
      dismissed = Object.create(null);
    }
  }

  function saveDismissed() {
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify(dismissed));
    } catch (_) {}
  }

  function ensureStack() {
    if (stackEl && document.body.contains(stackEl)) return stackEl;
    stackEl = $("siteToastStack");
    if (!stackEl) {
      stackEl = document.createElement("div");
      stackEl.id = "siteToastStack";
      stackEl.className = "site-toast-stack";
      stackEl.setAttribute("aria-live", "polite");
      document.body.appendChild(stackEl);
    }
    return stackEl;
  }

  function ensureReasonModal() {
    if (reasonModal && document.body.contains(reasonModal)) return reasonModal;
    reasonModal = document.createElement("div");
    reasonModal.id = "siteToastReasonModal";
    reasonModal.className = "summary-backdrop";
    reasonModal.setAttribute("aria-hidden", "true");
    reasonModal.innerHTML =
      '<section class="summary-modal" role="dialog" aria-modal="true" aria-labelledby="toastReasonTitle" style="max-width:min(28rem,100%)">' +
      '<div class="summary-head"><h2 class="summary-title" id="toastReasonTitle">Why</h2>' +
      '<button class="btn" type="button" id="toastReasonCloseBtn">Close</button></div>' +
      '<div class="summary-body"><p class="summary-muted" id="toastReasonBody" style="white-space:pre-wrap"></p></div>' +
      "</section>";
    document.body.appendChild(reasonModal);
    reasonModal.addEventListener("click", function (ev) {
      if (ev.target === reasonModal) hideReason();
    });
    var btn = reasonModal.querySelector("#toastReasonCloseBtn");
    if (btn) btn.addEventListener("click", hideReason);
    return reasonModal;
  }

  function showReason(text) {
    ensureReasonModal();
    var body = $("toastReasonBody");
    if (body) body.textContent = text || "No reason was provided.";
    reasonModal.classList.add("open");
    reasonModal.setAttribute("aria-hidden", "false");
  }

  function hideReason() {
    if (!reasonModal) return;
    reasonModal.classList.remove("open");
    reasonModal.setAttribute("aria-hidden", "true");
  }

  function formatYymd(d) {
    var dt = d instanceof Date ? d : new Date(d);
    if (isNaN(dt.getTime())) return "—";
    var yy = String(dt.getFullYear()).slice(-2);
    var mm = String(dt.getMonth() + 1).padStart(2, "0");
    var dd = String(dt.getDate()).padStart(2, "0");
    return yy + "/" + mm + "/" + dd;
  }

  function formatUntil(until) {
    if (!until) return "Permanent";
    var end = until.toDate ? until.toDate() : until instanceof Date ? until : new Date(until);
    if (isNaN(end.getTime())) return "Permanent";
    var ms = end.getTime() - Date.now();
    if (ms <= 0) return "Expired";
    var totalSec = Math.floor(ms / 1000);
    var dd = Math.floor(totalSec / 86400);
    var hh = Math.floor((totalSec % 86400) / 3600);
    var mm = Math.floor((totalSec % 3600) / 60);
    var ss = totalSec % 60;
    return (
      String(dd).padStart(2, "0") +
      ":" +
      String(hh).padStart(2, "0") +
      ":" +
      String(mm).padStart(2, "0") +
      ":" +
      String(ss).padStart(2, "0")
    );
  }

  function iconFor(kind) {
    switch (kind) {
      case "issue_closed":
      case "issue_completed":
      case "links_approved":
        return ICON.issueClosed;
      case "issue_reopened":
        return ICON.issueReopened;
      case "pr_merged":
        return ICON.pr;
      case "pr_closed":
        return ICON.prClosed;
      case "contribution":
        return ICON.code;
      case "account_suspended":
      case "form_suspended":
      case "suspended_both":
      case "warning":
        return ICON.suspended;
      default:
        return ICON.code;
    }
  }

  function messageFor(n) {
    var kind = n.kind;
    switch (kind) {
      case "issue_closed":
        return "Your issue #" + n.number + " was closed";
      case "issue_reopened":
        return "Your issue #" + n.number + " was reopened";
      case "issue_completed":
        return "Your issue #" + n.number + " was marked as completed";
      case "pr_merged":
        return "Your pull request #" + n.number + " was merged";
      case "pr_closed":
        return "Your pull request #" + n.number + " was closed";
      case "contribution":
        return "Thank you for contributing to the Proxy List! Your help is appreciated <3";
      case "links_approved":
        return (
          n.count +
          " links were approved and added from your request on " +
          formatYymd(n.date)
        );
      case "feature_approved":
        return (
          "Your feature/QOL request was approved and added from your request on " +
          formatYymd(n.date)
        );
      case "bug_approved":
        return (
          "Your bugfix request was approved and fixed from your request on " +
          formatYymd(n.date)
        );
      case "appeal_lifted":
        return "Your appeal was reviewed and your account is no longer suspended. We apologize for any problems this caused.";
      case "appeal_denied":
        return "Your suspension appeal was denied.";
      case "wait_lifted":
        return "Your account is no longer suspended. If you are suspended again, it will likely be permanent.";
      case "links_denied":
        return n.count + " links were denied from your request on " + formatYymd(n.date);
      case "feature_denied":
        return "Your feature/QOL request was denied from your request on " + formatYymd(n.date);
      case "bug_denied":
        return "Your bugfix request was denied from your request on " + formatYymd(n.date);
      case "account_suspended":
        return "Your account is suspended from accessing community features until: " + formatUntil(n.until);
      case "form_suspended":
        return "Your account is suspended from making link/feature/bugfix requests until: " + formatUntil(n.until);
      case "suspended_both":
        return (
          "Your account is suspended from community features and from making link/feature/bugfix requests until: " +
          formatUntil(n.until)
        );
      case "warning":
        return "You received a warning from the list maintainer.";
      default:
        return n.message || "Notification";
    }
  }

  function actionsFor(kind) {
    if (
      kind === "issue_closed" ||
      kind === "issue_reopened" ||
      kind === "issue_completed" ||
      kind === "pr_merged" ||
      kind === "pr_closed"
    ) {
      return ["open", "close"];
    }
    if (
      kind === "links_denied" ||
      kind === "feature_denied" ||
      kind === "bug_denied" ||
      kind === "appeal_denied" ||
      kind === "account_suspended" ||
      kind === "form_suspended" ||
      kind === "suspended_both" ||
      kind === "warning"
    ) {
      return ["why", "close"];
    }
    return ["close"];
  }

  function dismissToast(card, n) {
    if (!n || !n.id) return;
    dismissed[n.id] = Date.now();
    saveDismissed();
    if (card && card.parentNode) card.parentNode.removeChild(card);
    if (n.firestoreId && typeof global.SiteNotificationsMarkRead === "function") {
      try {
        global.SiteNotificationsMarkRead(n.firestoreId);
      } catch (_) {}
    }
  }

  function refreshCountdowns() {
    if (!stackEl) return;
    var cards = stackEl.querySelectorAll(
      ".site-toast[data-kind='account_suspended'], .site-toast[data-kind='form_suspended'], .site-toast[data-kind='suspended_both']"
    );
    cards.forEach(function (card) {
      var msg = card.querySelector(".site-toast-msg");
      if (!msg) return;
      var untilMs = Number(card.getAttribute("data-until-ms") || 0);
      var kind = card.getAttribute("data-kind");
      var until = untilMs > 0 ? new Date(untilMs) : null;
      msg.textContent = messageFor({ kind: kind, until: until });
    });
  }

  function ensureCountdownTimer() {
    if (countdownTimer) return;
    countdownTimer = setInterval(refreshCountdowns, 1000);
  }

  function renderToast(n) {
    if (!n || !n.id || dismissed[n.id]) return;
    ensureStack();
    if (stackEl.querySelector('[data-toast-id="' + String(n.id).replace(/"/g, "") + '"]')) return;

    var kind = n.kind || "contribution";
    var card = document.createElement("article");
    card.className = "site-toast";
    card.setAttribute("role", "status");
    card.setAttribute("data-toast-id", n.id);
    card.setAttribute("data-kind", kind);
    if (n.until) {
      var end = n.until.toDate ? n.until.toDate() : n.until instanceof Date ? n.until : new Date(n.until);
      if (!isNaN(end.getTime())) card.setAttribute("data-until-ms", String(end.getTime()));
    }

    var iconWrap = document.createElement("div");
    iconWrap.className = "site-toast-icon";
    var img = document.createElement("img");
    img.src = iconFor(kind);
    img.alt = "";
    img.width = 24;
    img.height = 24;
    iconWrap.appendChild(img);

    var body = document.createElement("div");
    body.className = "site-toast-body";
    var msg = document.createElement("p");
    msg.className = "site-toast-msg";
    msg.textContent = messageFor(n);
    body.appendChild(msg);
    if (kind === "account_suspended" || kind === "form_suspended" || kind === "suspended_both") {
      ensureCountdownTimer();
    }

    var actions = document.createElement("div");
    actions.className = "site-toast-actions";
    actionsFor(kind).forEach(function (act) {
      if (act === "open" && n.url) {
        var a = document.createElement("a");
        a.className = "btn";
        a.href = n.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = "Open in GitHub";
        actions.appendChild(a);
      } else if (act === "why") {
        var why = document.createElement("button");
        why.type = "button";
        why.className = "btn";
        why.textContent = "See why";
        why.addEventListener("click", function () {
          showReason(n.reason || "No reason was provided.");
        });
        actions.appendChild(why);
      } else if (act === "close") {
        var close = document.createElement("button");
        close.type = "button";
        close.className = "btn";
        close.textContent = "Close";
        close.addEventListener("click", function () {
          dismissToast(card, n);
        });
        actions.appendChild(close);
      }
    });
    body.appendChild(actions);

    card.appendChild(iconWrap);
    card.appendChild(body);
    stackEl.appendChild(card);
  }

  function showMany(items) {
    loadDismissed();
    (items || []).forEach(renderToast);
  }

  function clearAll() {
    ensureStack();
    stackEl.replaceChildren();
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function apiToHtmlUrl(apiUrl) {
    if (!apiUrl) return "";
    return String(apiUrl)
      .replace("api.github.com/repos/", "github.com/")
      .replace(/\/pulls\//, "/pull/")
      .replace(/\/issues\//, "/issues/");
  }

  async function classifyGithubNote(note, token) {
    var subject = note.subject || {};
    var type = String(subject.type || "").toLowerCase();
    var apiUrl = subject.url || "";
    var id = String(note.id || "");
    if (!id) return null;

    if (type !== "pullrequest" && type !== "issue" && type !== "commit") {
      return {
        id: "gh-" + id,
        kind: "contribution",
        url: apiToHtmlUrl(apiUrl) || (note.repository && note.repository.html_url) || "",
      };
    }

    if (type === "commit") {
      return {
        id: "gh-" + id,
        kind: "contribution",
        url: apiToHtmlUrl(apiUrl) || (note.repository && note.repository.html_url) || "",
      };
    }

    if (!apiUrl || !token) {
      return {
        id: "gh-" + id,
        kind: "contribution",
        url: apiToHtmlUrl(apiUrl),
      };
    }

    try {
      var res = await fetch(apiUrl, {
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/vnd.github+json",
        },
      });
      if (!res.ok) throw new Error("status " + res.status);
      var data = await res.json();
      var number = data.number;
      var htmlUrl = data.html_url || apiToHtmlUrl(apiUrl);

      if (type === "pullrequest") {
        if (data.merged) {
          return { id: "gh-" + id, kind: "pr_merged", number: number, url: htmlUrl };
        }
        if (data.state === "closed") {
          return { id: "gh-" + id, kind: "pr_closed", number: number, url: htmlUrl };
        }
        return null;
      }

      // issue
      if (data.state === "open" && note.reason === "state_change") {
        return { id: "gh-" + id, kind: "issue_reopened", number: number, url: htmlUrl };
      }
      if (data.state === "closed") {
        if (String(data.state_reason || "") === "completed") {
          return { id: "gh-" + id, kind: "issue_completed", number: number, url: htmlUrl };
        }
        return { id: "gh-" + id, kind: "issue_closed", number: number, url: htmlUrl };
      }
    } catch (_) {
      return {
        id: "gh-" + id,
        kind: "contribution",
        url: apiToHtmlUrl(apiUrl),
      };
    }
    return null;
  }

  loadDismissed();

  global.SiteNotifications = {
    show: renderToast,
    showMany: showMany,
    clearAll: clearAll,
    classifyGithubNote: classifyGithubNote,
    formatYymd: formatYymd,
    formatUntil: formatUntil,
    showReason: showReason,
    ICON: ICON,
  };
})(window);
