(function () {
  "use strict";

  var SU = window.SubmissionUtils;
  if (!SU) return;

  var firebaseDb = null;
  var currentUser = null;
  var activeBan = null;

  var formEl = document.getElementById("appealForm");
  var bodyInput = document.getElementById("appealBody");
  var submitBtn = document.getElementById("appealSubmitBtn");
  var signInPrompt = document.getElementById("appealSignInPrompt");
  var notBannedNotice = document.getElementById("appealNotBannedNotice");
  var loadingNotice = document.getElementById("appealLoadingNotice");
  var statusEl = document.getElementById("appealStatus");
  var pendingNote = document.getElementById("appealPendingNote");

  function showStatus(msg, kind) {
    if (!statusEl) return;
    statusEl.hidden = !msg;
    statusEl.textContent = msg || "";
    statusEl.className = "submit-status" + (kind ? " " + kind : "");
  }

  function hideNotice(el) {
    if (el) el.hidden = true;
  }

  function showNotice(el, msg, kind) {
    if (!el) return;
    el.hidden = false;
    el.textContent = msg || "";
    if (kind) el.className = "submit-status" + (kind ? " " + kind : "");
  }

  async function loadActiveBan(uid) {
    var snap = await firebaseDb.collection("contributorBans").doc(uid).get();
    if (!snap.exists) return null;
    var data = snap.data() || {};
    if (data.until && typeof data.until.toMillis === "function") {
      if (data.until.toMillis() <= Date.now()) return null;
    }
    return data;
  }

  function banStartMs(ban) {
    if (!ban || !ban.bannedAt) return 0;
    if (typeof ban.bannedAt.toMillis === "function") return ban.bannedAt.toMillis();
    return 0;
  }

  async function hasAppealForCurrentBan(uid, ban) {
    if (!ban) return false;
    if (ban.appealSubmitted === true) return true;
    var start = banStartMs(ban);
    var snap = await firebaseDb
      .collection("suspensionAppeals")
      .where("submitterUid", "==", uid)
      .limit(40)
      .get();
    return snap.docs.some(function (doc) {
      var d = doc.data() || {};
      if (d.banBannedAtMs && start && Number(d.banBannedAtMs) >= start - 2000) return true;
      var createdMs = d.created && typeof d.created.toMillis === "function" ? d.created.toMillis() : 0;
      return !!(start && createdMs && createdMs >= start);
    });
  }

  async function handleSubmit(ev) {
    ev.preventDefault();
    showStatus("", "");
    if (!currentUser || !firebaseDb) {
      showStatus("Sign in to submit an appeal.", "err");
      return;
    }
    activeBan = await loadActiveBan(currentUser.uid);
    if (!activeBan) {
      showStatus("You are not currently suspended.", "warn");
      if (formEl) formEl.hidden = true;
      return;
    }
    if (await hasAppealForCurrentBan(currentUser.uid, activeBan)) {
      showStatus("You already submitted an appeal for this suspension (one appeal per ban).", "warn");
      if (formEl) formEl.hidden = true;
      if (pendingNote) {
        pendingNote.hidden = false;
        pendingNote.textContent =
          "You already used your one appeal for this suspension. Wait for a review, or for the suspension to end.";
      }
      return;
    }
    var body = String((bodyInput && bodyInput.value) || "").trim();
    if (!body || body.length > 2000) {
      showStatus("Enter an explanation (1–2000 characters).", "warn");
      return;
    }
    if (submitBtn) submitBtn.disabled = true;
    try {
      var label =
        (currentUser.displayName && String(currentUser.displayName).trim()) ||
        SU.githubLoginFromUser(currentUser) ||
        "Signed-in user";
      var banMs = banStartMs(activeBan) || Date.now();
      await firebaseDb.collection("suspensionAppeals").add({
        body: body,
        status: "pending",
        submitterUid: currentUser.uid,
        submitterLabel: String(label).slice(0, 120),
        submitterGithub: SU.githubLoginFromUser(currentUser) || "",
        submitterEmail: currentUser.email ? String(currentUser.email).slice(0, 320) : "",
        banBannedAtMs: banMs,
        created: firebase.firestore.FieldValue.serverTimestamp(),
        updated: firebase.firestore.FieldValue.serverTimestamp(),
      });
      try {
        await firebaseDb.collection("contributorBans").doc(currentUser.uid).set(
          {
            appealSubmitted: true,
            appealSubmittedAt: firebase.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      } catch (_) {}
      if (bodyInput) bodyInput.value = "";
      if (formEl) formEl.hidden = true;
      if (pendingNote) {
        pendingNote.hidden = false;
        pendingNote.textContent =
          "Appeal submitted. You can only send one appeal per suspension. The maintainer will review it.";
      }
      showStatus("Appeal submitted. The maintainer will review it.", "ok");
    } catch (err) {
      console.warn("[proxy-list] appeal submit failed", err);
      var msg = (err && err.message) || "Appeal failed.";
      if (/permission|insufficient/i.test(msg)) {
        msg = "Could not submit appeal (permission denied). Refresh and try again.";
      }
      showStatus(msg, "err");
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  async function refreshAuthUi(user) {
    currentUser = user && !user.isAnonymous ? user : null;
    activeBan = null;
    hideNotice(loadingNotice);
    hideNotice(notBannedNotice);
    showStatus("", "");
    if (pendingNote) pendingNote.hidden = true;

    if (!currentUser) {
      if (formEl) formEl.hidden = true;
      if (signInPrompt) signInPrompt.hidden = false;
      return;
    }
    if (signInPrompt) signInPrompt.hidden = true;
    if (!firebaseDb) {
      showStatus("Firebase is not available.", "err");
      return;
    }

    showNotice(loadingNotice, "Checking your account…", "");
    try {
      activeBan = await loadActiveBan(currentUser.uid);
      hideNotice(loadingNotice);
      if (!activeBan) {
        if (formEl) formEl.hidden = true;
        showNotice(notBannedNotice, "You are not currently suspended.", "");
        return;
      }
      var already = await hasAppealForCurrentBan(currentUser.uid, activeBan);
      if (already) {
        if (formEl) formEl.hidden = true;
        if (pendingNote) {
          pendingNote.hidden = false;
          pendingNote.textContent =
            "You already submitted an appeal for this suspension (one appeal per ban).";
        }
      } else if (formEl) {
        formEl.hidden = false;
      }
    } catch (_) {
      hideNotice(loadingNotice);
      if (formEl) formEl.hidden = false;
    }
  }

  function initFirebase() {
    try {
      if (!firebase.apps.length) {
        var cfg = window.__FIREBASE_CONFIG__;
        if (!cfg || !cfg.apiKey) return;
        firebase.initializeApp(cfg);
      }
      firebaseDb = firebase.firestore();
      firebase.auth().onAuthStateChanged(function (user) {
        void refreshAuthUi(user);
      });
    } catch (_) {
      firebaseDb = null;
    }
  }

  if (formEl) formEl.addEventListener("submit", handleSubmit);
  initFirebase();
})();
