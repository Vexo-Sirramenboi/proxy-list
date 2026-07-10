/* Shipped with the site (e.g. GitHub Pages). index.html loads this first, then
   firebase-config.local.js (committed stub on Pages; you may edit locally for overrides).

   For local-only experiments, edit firebase-config.local.js in your clone (do not commit
   private keys). Production deploy uses the stub plus this example file.

   Leave apiKey empty for browser-only click counts (localStorage).

   Google Cloud → APIs & Services → Credentials → your browser API key →
   HTTP referrers must include ALL of: your GitHub Pages origin (e.g.
   https://USER.github.io/*), localhost (e.g. http://localhost:8080/*), AND
   https://<projectId>.firebaseapp.com/* — Auth runs helper iframes from
   authDomain; without this, Identity Toolkit returns API_KEY_HTTP_REFERRER_BLOCKED.

   For "Most opened", deploy docs/firestore.rules. link_clicks writes require a signed-in
   (non-anonymous) account and increment by at most +1 per write.

   On-site link submissions (docs/contribute/, docs/admin/submissions.html):
   - Deploy docs/firestore.rules (includes linkSubmissions, pendingSubmissionKeys,
     contributorBans, contributorStats with strict client counter rules).
   - In Firestore, create document config/submissions with field adminUids (array of Firebase Auth UIDs
     for accounts that may approve/reject/ban). Example: { "adminUids": ["abc123uid"] }.
   - Set window.__SUBMISSION_ADMIN_GITHUB__ in this file for GitHub admins (UI access).
   - Both the GitHub username AND adminUids entry are required for full admin actions.

   Enable Authentication → Sign-in method → Anonymous, GitHub (OAuth app in Firebase Console),
   Google, and Email/Password.

   Active user count uses Realtime Database (not Firestore): each tab writes
   presence/{sessionId} with uid + ts; only sessions updated in the last ~5 minutes
   count as active (stale nodes from crashed tabs are ignored). In Firebase Console:
   Build → Realtime Database → Create database. If the SDK cannot connect, add
   databaseURL from that screen to the config object below, e.g.:
   databaseURL: "https://<projectId>-default-rtdb.firebaseio.com"

   Example Realtime Database rules for path "presence/{sessionId}":

   {
     "rules": {
       "presence": {
         ".read": "auth != null",
         "$key": {
           ".write": "auth != null && ((!data.exists() && newData.child('uid').val() === auth.uid) || (data.exists() && !newData.exists() && data.child('uid').val() === auth.uid))",
           ".validate": "!newData.exists() || newData.hasChildren(['uid', 'ts'])"
         }
       }
     }
   } */
window.__FIREBASE_CONFIG__ = {
  apiKey: "AIzaSyBPXPOxZeezDBn2YtgzTsj-Dxje62lYYOQ",
  authDomain: "proxy-list-c06ea.firebaseapp.com",
  databaseURL: "https://proxy-list-c06ea-default-rtdb.firebaseio.com",
  projectId: "proxy-list-c06ea",
  storageBucket: "proxy-list-c06ea.firebasestorage.app",
  messagingSenderId: "31862303655",
  appId: "1:31862303655:web:d3e93df7a86ce31cf1e482",
  measurementId: "G-P51BKTLW18",
};

/** GitHub usernames allowed to open docs/admin/submissions.html (UI gate). */
window.__SUBMISSION_ADMIN_GITHUB__ = ["yourworstnightmare1"];

/** Firebase Auth UIDs with Firestore write access for submissions (must match config/submissions.adminUids). */
window.__SUBMISSION_ADMIN_UIDS__ = [];
