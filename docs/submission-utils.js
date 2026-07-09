/**
 * Shared helpers for on-site link submissions (duplicate checks, validation, admin).
 * URL keys match scripts/submission_url_key.py / import_link_request_csv.normalize_key.
 */
(function (global) {
  "use strict";

  var DUPLICATE_BLOCK_THRESHOLD = 10;
  var RATE_LIMIT_PER_HOUR = 8;
  var MAX_NOTE_LEN = 500;

  function submissionUrlKey(url) {
    var u = String(url || "").trim();
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    u = u.replace("?/", "/");
    while (true) {
      var u2 = u.replace(/(https?:\/\/[^/]+)\/+/g, "$1/");
      if (u2 === u) break;
      u = u2;
    }
    var parts = u.split("://", 1 + 1);
    if (parts.length === 2) {
      var scheme = parts[0];
      var rest = parts[1];
      var slash = rest.indexOf("/");
      var netloc = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
      var pathPart = slash === -1 ? "" : rest.slice(slash);
      u = scheme + "://" + netloc + pathPart;
    }
    if (u.endsWith("/") && (u.match(/\//g) || []).length > 3) u = u.replace(/\/+$/, "");
    return u;
  }

  function normalizeSubmissionUrl(url) {
    return submissionUrlKey(url);
  }

  function isBlockedDomain(url, patterns) {
    var list = patterns || ["b-cdn.net", "blooket.com"];
    var lower = String(url || "").toLowerCase();
    for (var i = 0; i < list.length; i++) {
      if (lower.indexOf(String(list[i]).toLowerCase()) !== -1) return true;
    }
    return false;
  }

  function isValidHttpUrl(url) {
    try {
      var u = new URL(submissionUrlKey(url));
      return u.protocol === "http:" || u.protocol === "https:";
    } catch (_) {
      return false;
    }
  }

  function buildUrlKeySet(indexPayload) {
    var keys = indexPayload && indexPayload.keys;
    return new Set(Array.isArray(keys) ? keys : []);
  }

  function githubLoginFromUser(user) {
    if (!user) return "";
    var gh = (user.providerData || []).find(function (p) {
      return p.providerId === "github.com";
    });
    if (!gh) return "";
    if (gh.displayName) return String(gh.displayName).trim();
    var email = gh.email ? String(gh.email).split("@")[0] : "";
    return email;
  }

  function isSignedInNonAnonymous(user) {
    return !!(user && !user.isAnonymous);
  }

  function submissionAdminGithubLogins() {
    var cfg = global.__SUBMISSION_ADMIN_GITHUB__ || global.__SUBMISSION_ADMIN_GITHUB_LOGINS__;
    return Array.isArray(cfg) ? cfg.map(function (s) {
      return String(s).trim().toLowerCase();
    }).filter(Boolean) : ["yourworstnightmare1"];
  }

  function submissionAdminUids() {
    var cfg = global.__SUBMISSION_ADMIN_UIDS__;
    return Array.isArray(cfg) ? cfg.map(String).filter(Boolean) : [];
  }

  function isSubmissionAdminUser(user) {
    if (!isSignedInNonAnonymous(user)) return false;
    var uids = submissionAdminUids();
    if (uids.indexOf(user.uid) !== -1) return true;
    var gh = githubLoginFromUser(user).toLowerCase();
    if (!gh) return false;
    return submissionAdminGithubLogins().indexOf(gh) !== -1;
  }

  function submitterLabelFromUser(user, profileDoc) {
    if (profileDoc && profileDoc.siteUsername) return String(profileDoc.siteUsername).trim();
    var gh = githubLoginFromUser(user);
    if (gh) return gh;
    if (user.displayName) return String(user.displayName).trim();
    if (user.email) return String(user.email).split("@")[0];
    return "Contributor";
  }

  function contributorMdFromUser(user, profileDoc) {
    var gh = githubLoginFromUser(user);
    var label = submitterLabelFromUser(user, profileDoc);
    if (gh) return "[" + label + "](https://github.com/" + gh + ")";
    return label;
  }

  function formatListMdRow(url, contributorMd) {
    return "| | " + url + " | N/A | N/A | N/A | " + contributorMd;
  }

  function rateLimitOk(stats) {
    if (!stats || !stats.lastSubmissionAt) return true;
    var ts = stats.lastSubmissionAt;
    var ms = typeof ts.toMillis === "function" ? ts.toMillis() : typeof ts.seconds === "number" ? ts.seconds * 1000 : 0;
    if (!ms) return true;
    var hourAgo = Date.now() - 60 * 60 * 1000;
    var recent = Number(stats.recentHourCount) || 0;
    if (ms < hourAgo) return true;
    return recent < RATE_LIMIT_PER_HOUR;
  }

  global.SubmissionUtils = {
    DUPLICATE_BLOCK_THRESHOLD: DUPLICATE_BLOCK_THRESHOLD,
    RATE_LIMIT_PER_HOUR: RATE_LIMIT_PER_HOUR,
    MAX_NOTE_LEN: MAX_NOTE_LEN,
    submissionUrlKey: submissionUrlKey,
    normalizeSubmissionUrl: normalizeSubmissionUrl,
    isBlockedDomain: isBlockedDomain,
    isValidHttpUrl: isValidHttpUrl,
    buildUrlKeySet: buildUrlKeySet,
    githubLoginFromUser: githubLoginFromUser,
    isSignedInNonAnonymous: isSignedInNonAnonymous,
    isSubmissionAdminUser: isSubmissionAdminUser,
    submitterLabelFromUser: submitterLabelFromUser,
    contributorMdFromUser: contributorMdFromUser,
    formatListMdRow: formatListMdRow,
    rateLimitOk: rateLimitOk,
  };
})(typeof window !== "undefined" ? window : globalThis);
