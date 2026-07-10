(function () {
  "use strict";

  var SU = window.SubmissionUtils;
  if (!SU) return;

  var db = null;
  var currentUser = null;
  var userProfiles = {};

  var gateNotice = document.getElementById("gateNotice");
  var pendingBody = document.getElementById("pendingBody");
  var pendingMeta = document.getElementById("pendingMeta");
  var flaggedSection = document.getElementById("flaggedSection");
  var flaggedBody = document.getElementById("flaggedBody");
  var copySection = document.getElementById("copySection");
  var copyBox = document.getElementById("copyBox");

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setTbodyHtml(el, html) {
    if (!el) return;
    var doc = new DOMParser().parseFromString("<table><tbody>" + String(html || "") + "</tbody></table>", "text/html");
    var nodes = Array.from(doc.querySelector("tbody").childNodes).map(function (n) {
      return document.importNode(n, true);
    });
    el.replaceChildren.apply(el, nodes);
  }

  function showGate(msg) {
    if (gateNotice) {
      gateNotice.hidden = false;
      gateNotice.textContent = msg;
    }
  }

  function contributorMd(sub) {
    return SU.contributorMdFromFields(sub.submitterLabel, sub.submitterGithub || "");
  }

  async function ensureAdmin(user) {
    if (!SU.isSignedInNonAnonymous(user)) {
      showGate("Sign in to access submission review.");
      return false;
    }
    if (!SU.isSubmissionAdminUser(user)) {
      showGate("Your account is not configured as a submission admin.");
      return false;
    }
    if (gateNotice) {
      gateNotice.hidden = true;
      gateNotice.className = "notice";
    }
    return true;
  }

  async function verifyFirestoreAdmin() {
    try {
      await db.collection("linkSubmissions").where("status", "==", "pending").limit(1).get();
      return true;
    } catch (err) {
      if (gateNotice) {
        gateNotice.hidden = false;
        gateNotice.className = "notice err";
        gateNotice.innerHTML =
          "Signed in as admin, but Firestore denied access. Add your Firebase UID to " +
          '<code>config/submissions.adminUids</code> in the Firebase console: <code>' +
          esc(currentUser.uid) +
          "</code>";
      }
      return false;
    }
  }

  async function banUser(uid, reason, label) {
    await db.collection("contributorBans").doc(uid).set({
      uid: uid,
      reason: reason || "Spam or policy violation",
      submitterLabel: label || "",
      bannedAt: firebase.firestore.FieldValue.serverTimestamp(),
      bannedByUid: currentUser.uid,
    });
    await db.collection("contributorStats").doc(uid).set(
      { submitBlocked: true, updated: firebase.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  }

  async function clearPendingSubmissionKey(sub) {
    if (!sub || !sub.urlKeyHash) return;
    try {
      await db.collection("pendingSubmissionKeys").doc(sub.urlKeyHash).delete();
    } catch (_) {}
  }

  async function updateSubmission(docId, status, reviewNote) {
    var subSnap = await db.collection("linkSubmissions").doc(docId).get();
    var sub = subSnap.data() || {};
    await db.collection("linkSubmissions").doc(docId).update({
      status: status,
      reviewNote: reviewNote || "",
      reviewedBy: currentUser.uid,
      updated: firebase.firestore.FieldValue.serverTimestamp(),
    });
    if (status !== "pending") await clearPendingSubmissionKey(sub);
  }

  async function onApprove(docId, sub) {
    await updateSubmission(docId, "approved", "");
    var row = SU.formatListMdRow(sub.url, contributorMd(sub));
    if (copyBox) copyBox.value = row;
    if (copySection) copySection.hidden = false;
    await loadPending();
  }

  async function onReject(docId, reason) {
    await updateSubmission(docId, "rejected", reason || "");
    var subSnap = await db.collection("linkSubmissions").doc(docId).get();
    var sub = subSnap.data() || {};
    if (sub.submitterUid) {
      var statsSnap = await db.collection("contributorStats").doc(sub.submitterUid).get();
      var stats = statsSnap.exists ? statsSnap.data() : {};
      await db.collection("contributorStats").doc(sub.submitterUid).set(
        {
          uid: sub.submitterUid,
          rejectedTotal: (Number(stats.rejectedTotal) || 0) + 1,
          updated: firebase.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    await loadPending();
  }

  async function onRejectBan(docId, sub) {
    await onReject(docId, "Rejected and banned");
    await banUser(sub.submitterUid, "Spam, malicious, or repeated bad submissions", sub.submitterLabel);
    await loadFlagged();
    await loadPending();
  }

  function bindPendingActions() {
    document.querySelectorAll("[data-action]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var action = btn.getAttribute("data-action");
        var id = btn.getAttribute("data-id");
        if (!id) return;
        btn.disabled = true;
        try {
          var snap = await db.collection("linkSubmissions").doc(id).get();
          var sub = snap.data() || {};
          if (action === "approve") await onApprove(id, sub);
          else if (action === "reject") await onReject(id, "Rejected during review");
          else if (action === "ban") await onRejectBan(id, sub);
        } catch (err) {
          alert((err && err.message) || "Action failed");
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  async function loadPending() {
    if (!pendingBody) return;
    var snap = await db.collection("linkSubmissions").where("status", "==", "pending").limit(200).get();
    var rows = [];
    snap.forEach(function (doc) {
      rows.push({ id: doc.id, data: doc.data() });
    });
    rows.sort(function (a, b) {
      var am = a.data.created && a.data.created.toMillis ? a.data.created.toMillis() : 0;
      var bm = b.data.created && b.data.created.toMillis ? b.data.created.toMillis() : 0;
      return bm - am;
    });
    if (pendingMeta) pendingMeta.textContent = rows.length + " pending";
    if (!rows.length) {
      setTbodyHtml(pendingBody, '<tr><td class="muted" colspan="5">No pending submissions.</td></tr>');
      return;
    }
    setTbodyHtml(
      pendingBody,
      rows
        .map(function (row) {
          var s = row.data;
          var provider = esc(s.provider || "") + (s.isNewProvider ? ' <span class="muted">(new)</span>' : "");
          return (
            "<tr>" +
            '<td><a href="' +
            esc(s.url) +
            '" rel="noopener noreferrer" target="_blank">' +
            esc(s.url) +
            "</a></td>" +
            "<td>" +
            provider +
            "</td>" +
            "<td>" +
            esc(s.submitterLabel || s.submitterUid || "") +
            "</td>" +
            "<td>" +
            esc(s.optionalNote || "—") +
            "</td>" +
            '<td><div class="actions">' +
            '<button class="btn btn-ok" type="button" data-action="approve" data-id="' +
            esc(row.id) +
            '">Approve</button>' +
            '<button class="btn" type="button" data-action="reject" data-id="' +
            esc(row.id) +
            '">Reject</button>' +
            '<button class="btn btn-danger" type="button" data-action="ban" data-id="' +
            esc(row.id) +
            '">Reject &amp; ban</button>' +
            "</div></td>" +
            "</tr>"
          );
        })
        .join("")
    );
    bindPendingActions();
  }

  async function loadFlagged() {
    if (!flaggedBody || !flaggedSection) return;
    var snap = await db.collection("contributorStats").where("duplicatesAttempted", ">=", 5).limit(50).get();
    var rows = [];
    snap.forEach(function (doc) {
      rows.push({ id: doc.id, data: doc.data() });
    });
    if (!rows.length) {
      flaggedSection.hidden = true;
      return;
    }
    flaggedSection.hidden = false;
    setTbodyHtml(
      flaggedBody,
      rows
        .map(function (row) {
          var s = row.data;
          return (
            "<tr>" +
            "<td>" +
            esc(s.uid) +
            "</td>" +
            "<td><code>" +
            esc(row.id) +
            "</code></td>" +
            "<td>" +
            esc(String(s.duplicatesAttempted || 0)) +
            "</td>" +
            "<td>" +
            esc(String(s.submissionsTotal || 0)) +
            "</td>" +
            "<td>" +
            (s.submitBlocked ? "yes" : "no") +
            "</td>" +
            '<td><button class="btn btn-danger" type="button" data-ban-uid="' +
            esc(row.id) +
            '">Ban</button></td>' +
            "</tr>"
          );
        })
        .join("")
    );
    document.querySelectorAll("[data-ban-uid]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var uid = btn.getAttribute("data-ban-uid");
        if (!uid || !confirm("Ban this user from submitting?")) return;
        btn.disabled = true;
        try {
          await banUser(uid, "Repeated duplicate or spam submissions", "");
          await loadFlagged();
        } catch (err) {
          alert((err && err.message) || "Ban failed");
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  async function refreshAll() {
    if (!(await ensureAdmin(currentUser))) return;
    if (!(await verifyFirestoreAdmin())) return;
    await Promise.all([loadPending(), loadFlagged()]);
  }

  function init() {
    var cfg = window.__FIREBASE_CONFIG__;
    if (!cfg || !cfg.apiKey || typeof firebase === "undefined") {
      showGate("Firebase is not configured.");
      return;
    }
    if (!firebase.apps.length) firebase.initializeApp(cfg);
    db = firebase.firestore();

    document.getElementById("refreshBtn").addEventListener("click", refreshAll);
    document.getElementById("copyBtn").addEventListener("click", function () {
      if (!copyBox) return;
      copyBox.select();
      navigator.clipboard.writeText(copyBox.value).catch(function () {
        document.execCommand("copy");
      });
    });

    firebase.auth().onAuthStateChanged(async function (user) {
      currentUser = user;
      if (!(await ensureAdmin(user))) return;
      await refreshAll();
    });
  }

  init();
})();
