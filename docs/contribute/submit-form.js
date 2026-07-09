(function () {
  "use strict";

  var SU = window.SubmissionUtils;
  if (!SU) return;

  var firebaseDb = null;
  var urlKeySet = new Set();
  var blockedPatterns = ["b-cdn.net", "blooket.com"];
  var providers = [];
  var currentUser = null;
  var userProfile = null;
  var pendingUrlKeys = new Set();

  var formEl = document.getElementById("linkSubmitForm");
  var signInPrompt = document.getElementById("submitSignInPrompt");
  var loadingNotice = document.getElementById("submitLoadingNotice");
  var bannedNotice = document.getElementById("submitBannedNotice");
  var statusEl = document.getElementById("submitStatus");
  var historyWrap = document.getElementById("submitHistoryWrap");
  var historyBody = document.getElementById("submitHistoryBody");
  var adminLink = document.getElementById("submitAdminLink");
  var providerSelect = document.getElementById("submitProviderSelect");
  var existingWrap = document.getElementById("existingProviderWrap");
  var newWrap = document.getElementById("newProviderWrap");
  var newProviderInput = document.getElementById("submitNewProvider");

  function showNotice(el, msg, kind) {
    if (!el) return;
    el.hidden = false;
    el.className = "submit-status" + (kind ? " " + kind : "");
    el.textContent = msg;
  }

  function hideNotice(el) {
    if (!el) return;
    el.hidden = true;
    el.textContent = "";
  }

  function showStatus(msg, kind) {
    showNotice(statusEl, msg, kind);
  }

  function clearStatus() {
    hideNotice(statusEl);
  }

  function setProviderMode(mode) {
    var isNew = mode === "new";
    if (existingWrap) existingWrap.hidden = isNew;
    if (newWrap) newWrap.hidden = !isNew;
  }

  function populateProviders(list) {
    providers = list || [];
    if (!providerSelect) return;
    providerSelect.replaceChildren();
    var placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a provider…";
    providerSelect.appendChild(placeholder);
    providers.forEach(function (name) {
      var opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      providerSelect.appendChild(opt);
    });
  }

  async function loadSubmissionIndex() {
    try {
      var res = await fetch("../submission_url_keys.json");
      if (!res.ok) throw new Error("Could not load submission index");
      var payload = await res.json();
      urlKeySet = SU.buildUrlKeySet(payload);
      blockedPatterns = payload.blocked_domain_patterns || blockedPatterns;
      populateProviders(payload.providers || []);
    } catch (err) {
      showStatus((err && err.message) || "Could not load duplicate index.", "err");
    }
  }

  async function loadPendingUrlKeys() {
    if (!firebaseDb) return;
    pendingUrlKeys = new Set();
    try {
      var snap = await firebaseDb.collection("linkSubmissions").where("status", "==", "pending").limit(250).get();
      snap.forEach(function (doc) {
        var key = doc.data() && doc.data().urlKey;
        if (key) pendingUrlKeys.add(key);
      });
    } catch (_) {}
  }

  function isDuplicateKey(key) {
    return urlKeySet.has(key) || pendingUrlKeys.has(key);
  }

  async function getContributorStats(uid) {
    var snap = await firebaseDb.collection("contributorStats").doc(uid).get();
    return snap.exists ? snap.data() || {} : {};
  }

  async function isUserBanned(uid) {
    var snap = await firebaseDb.collection("contributorBans").doc(uid).get();
    return snap.exists;
  }

  function buildStatsPayload(uid, stats, opts) {
    var hourAgo = Date.now() - 60 * 60 * 1000;
    var lastMs = 0;
    if (stats.lastSubmissionAt) {
      lastMs =
        typeof stats.lastSubmissionAt.toMillis === "function"
          ? stats.lastSubmissionAt.toMillis()
          : stats.lastSubmissionAt.seconds
            ? stats.lastSubmissionAt.seconds * 1000
            : 0;
    }
    var recent = Number(stats.recentHourCount) || 0;
    if (!lastMs || lastMs < hourAgo) recent = 0;
    if (opts.countSubmission) recent += 1;

    var dup = Number(stats.duplicatesAttempted) || 0;
    if (opts.countDuplicate) dup += 1;

    var total = Number(stats.submissionsTotal) || 0;
    if (opts.countSubmission) total += 1;

    var submitBlocked = !!stats.submitBlocked;
    if (dup >= SU.DUPLICATE_BLOCK_THRESHOLD) submitBlocked = true;

    return {
      uid: uid,
      submissionsTotal: total,
      duplicatesAttempted: dup,
      rejectedTotal: Number(stats.rejectedTotal) || 0,
      submitBlocked: submitBlocked,
      recentHourCount: recent,
      lastSubmissionAt: opts.touchTime ? firebase.firestore.FieldValue.serverTimestamp() : stats.lastSubmissionAt || null,
      updated: firebase.firestore.FieldValue.serverTimestamp(),
    };
  }

  async function recordDuplicateAttempt(uid) {
    var stats = await getContributorStats(uid);
    var payload = buildStatsPayload(uid, stats, { countDuplicate: true, touchTime: true });
    await firebaseDb.collection("contributorStats").doc(uid).set(payload, { merge: true });
    if (payload.submitBlocked) {
      throw new Error(
        "Too many duplicate submissions. Your ability to contribute has been paused. Contact the list maintainer if you think this is a mistake."
      );
    }
    throw new Error("This URL is already on the list or pending review. Duplicate attempts are tracked.");
  }

  async function handleSubmit(event) {
    event.preventDefault();
    clearStatus();
    if (!currentUser || !firebaseDb) {
      showStatus("Sign in to submit links.", "warn");
      return;
    }

    var rawUrl = document.getElementById("submitUrl").value;
    var note = (document.getElementById("submitNote").value || "").trim();
    var mode = (document.querySelector('input[name="providerMode"]:checked') || {}).value || "existing";
    var isNewProvider = mode === "new";
    var provider = isNewProvider ? (newProviderInput.value || "").trim() : (providerSelect.value || "").trim();

    if (!SU.isValidHttpUrl(rawUrl)) {
      showStatus("Enter a valid http(s) URL.", "err");
      return;
    }
    if (SU.isBlockedDomain(rawUrl, blockedPatterns)) {
      showStatus("This domain is blocked from the list.", "err");
      return;
    }
    if (!provider) {
      showStatus(isNewProvider ? "Enter a name for the new provider." : "Choose a provider.", "err");
      return;
    }
    if (note.length > SU.MAX_NOTE_LEN) {
      showStatus("Note is too long.", "err");
      return;
    }

    var url = SU.normalizeSubmissionUrl(rawUrl);
    var urlKey = SU.submissionUrlKey(url);

    try {
      if (await isUserBanned(currentUser.uid)) {
        showStatus("You are banned from submitting links.", "err");
        return;
      }

      var stats = await getContributorStats(currentUser.uid);
      if (stats.submitBlocked) {
        showStatus("Submissions paused due to repeated duplicates or policy violations.", "err");
        return;
      }
      if (!SU.rateLimitOk(stats)) {
        showStatus("Rate limit reached. Try again later.", "warn");
        return;
      }

      if (isDuplicateKey(urlKey)) {
        try {
          await recordDuplicateAttempt(currentUser.uid);
        } catch (err) {
          showStatus(err.message || "Duplicate URL.", "err");
        }
        return;
      }
    } catch (err) {
      showStatus(
        (err && err.message) ||
          "Could not verify your account (Firestore may need updated rules). Try again or use the Google Form.",
        "err"
      );
      return;
    }

    var submitBtn = document.getElementById("submitBtn");
    if (submitBtn) submitBtn.disabled = true;

    try {
      var label = SU.submitterLabelFromUser(currentUser, userProfile);
      var payload = {
        url: url,
        urlKey: urlKey,
        provider: provider,
        isNewProvider: isNewProvider,
        submitterUid: currentUser.uid,
        submitterLabel: label,
        submitterGithub: SU.githubLoginFromUser(currentUser) || "",
        status: "pending",
        optionalNote: note || "",
        created: firebase.firestore.FieldValue.serverTimestamp(),
        updated: firebase.firestore.FieldValue.serverTimestamp(),
      };

      await firebaseDb.collection("linkSubmissions").add(payload);
      pendingUrlKeys.add(urlKey);

      var stats = await getContributorStats(currentUser.uid);
      var nextStats = buildStatsPayload(currentUser.uid, stats, { countSubmission: true, touchTime: true });
      await firebaseDb.collection("contributorStats").doc(currentUser.uid).set(nextStats, { merge: true });

      formEl.reset();
      setProviderMode("existing");
      showStatus("Submitted for review. Thank you!", "ok");
      await loadSubmitHistory(currentUser.uid);
    } catch (err) {
      var msg = (err && err.message) || "Submission failed.";
      if (/permission|insufficient/i.test(msg)) {
        msg =
          "Submission storage is not available yet (deploy the updated Firestore rules from docs/firestore.rules).";
      }
      showStatus(msg, "err");
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  function statusPill(status) {
    var s = String(status || "pending");
    return '<span class="status-pill ' + s.replace(/[^a-z]/gi, "") + '">' + s + "</span>";
  }

  function localEscapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setHistoryHtml(el, html) {
    if (!el || !window.DOMPurify) return;
    var clean = DOMPurify.sanitize(String(html || ""));
    if (!clean) {
      el.replaceChildren();
      return;
    }
    var doc = new DOMParser().parseFromString("<table><tbody>" + clean + "</tbody></table>", "text/html");
    var section = doc.querySelector("tbody");
    var nodes = section ? Array.from(section.childNodes).map(function (n) { return document.importNode(n, true); }) : [];
    el.replaceChildren.apply(el, nodes);
  }

  async function loadSubmitHistory(uid) {
    if (!firebaseDb || !historyBody || !historyWrap) return;
    try {
      var snap = await firebaseDb
        .collection("linkSubmissions")
        .where("submitterUid", "==", uid)
        .limit(20)
        .get();
      var rows = [];
      snap.forEach(function (doc) {
        rows.push(doc.data());
      });
      rows.sort(function (a, b) {
        var am = a.created && a.created.toMillis ? a.created.toMillis() : 0;
        var bm = b.created && b.created.toMillis ? b.created.toMillis() : 0;
        return bm - am;
      });
      if (!rows.length) {
        historyWrap.hidden = true;
        return;
      }
      historyWrap.hidden = false;
      setHistoryHtml(
        historyBody,
        rows
          .map(function (r) {
            return (
              "<tr><td>" +
              localEscapeHtml(r.url || "") +
              "</td><td>" +
              localEscapeHtml(r.provider || "") +
              "</td><td>" +
              statusPill(r.status) +
              "</td></tr>"
            );
          })
          .join("")
      );
    } catch (_) {
      historyWrap.hidden = true;
    }
  }

  function showSignedOutUi() {
    if (formEl) formEl.hidden = true;
    if (signInPrompt) signInPrompt.hidden = false;
    if (historyWrap) historyWrap.hidden = true;
    if (adminLink) adminLink.hidden = true;
    hideNotice(loadingNotice);
    hideNotice(bannedNotice);
    clearStatus();
  }

  async function refreshAuthUi(user) {
    currentUser = user;
    var signedIn = SU.isSignedInNonAnonymous(user);

    if (!signedIn) {
      showSignedOutUi();
      return;
    }

    if (signInPrompt) signInPrompt.hidden = true;
    showNotice(loadingNotice, "Checking your account…", "");

    if (!firebaseDb) {
      hideNotice(loadingNotice);
      showNotice(
        bannedNotice,
        "Submission service could not start. Refresh the page or try again later.",
        "err"
      );
      if (formEl) formEl.hidden = true;
      return;
    }

    try {
      try {
        var profSnap = await firebaseDb.collection("users").doc(user.uid).get();
        userProfile = profSnap.exists ? profSnap.data() : null;
      } catch (_) {
        userProfile = null;
      }

      var banned = false;
      try {
        banned = await isUserBanned(user.uid);
      } catch (_) {
        banned = false;
      }

      if (banned) {
        var banSnap = await firebaseDb.collection("contributorBans").doc(user.uid).get();
        var reason = (banSnap.data() && banSnap.data().reason) || "Policy violation";
        hideNotice(loadingNotice);
        showNotice(bannedNotice, "You are banned from submitting links: " + reason, "err");
        if (formEl) formEl.hidden = true;
        return;
      }

      hideNotice(bannedNotice);

      var stats = {};
      try {
        stats = await getContributorStats(user.uid);
      } catch (_) {
        stats = {};
      }

      if (stats.submitBlocked) {
        hideNotice(loadingNotice);
        showNotice(
          bannedNotice,
          "Submissions paused after repeated duplicate URLs. Contact the list maintainer if you need this lifted.",
          "warn"
        );
        if (formEl) formEl.hidden = true;
        return;
      }

      hideNotice(loadingNotice);
      if (formEl) formEl.hidden = false;
      if (adminLink) adminLink.hidden = !SU.isSubmissionAdminUser(user);
      await loadSubmitHistory(user.uid);
      await loadPendingUrlKeys();
    } catch (err) {
      hideNotice(loadingNotice);
      if (formEl) formEl.hidden = false;
      showNotice(
        bannedNotice,
        "Could not fully verify your account, but you can try submitting. If it fails, the site maintainer may still be deploying submission support.",
        "warn"
      );
      if (adminLink) adminLink.hidden = !SU.isSubmissionAdminUser(user);
    }
  }

  function initFirebase() {
    var cfg = window.__FIREBASE_CONFIG__;
    if (!cfg || !cfg.apiKey || typeof firebase === "undefined") {
      if (signInPrompt) {
        signInPrompt.hidden = false;
        signInPrompt.innerHTML =
          'Firebase is not configured for submissions on this host. Use <a href="https://forms.gle/SMx9EUkBeiFuLwBa8" rel="noopener noreferrer" target="_blank">Google Form</a> or GitHub instead.';
      }
      return;
    }
    try {
      if (!firebase.apps.length) firebase.initializeApp(cfg);
      firebaseDb = firebase.firestore();
      var auth = firebase.auth();
      var ready =
        typeof auth.authStateReady === "function"
          ? auth.authStateReady()
          : Promise.resolve();
      ready.then(function () {
        auth.onAuthStateChanged(function (user) {
          refreshAuthUi(user);
        });
      });
    } catch (err) {
      if (signInPrompt) {
        signInPrompt.hidden = false;
        signInPrompt.textContent = "Could not initialize submission service.";
      }
    }
  }

  document.querySelectorAll('input[name="providerMode"]').forEach(function (radio) {
    radio.addEventListener("change", function () {
      setProviderMode(radio.value);
    });
  });

  if (formEl) formEl.addEventListener("submit", handleSubmit);

  loadSubmissionIndex();
  initFirebase();
})();
