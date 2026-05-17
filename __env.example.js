/**
 * __env.js — Runtime Environment Injection (LOCAL DEV TEMPLATE)
 * GovDoc Vault | Government Document Portal
 *
 * ⚠️  THIS FILE IS FOR LOCAL DEVELOPMENT ONLY.
 *
 * SETUP:
 *   1. Copy this file → rename to `__env.js` in the project root
 *   2. Fill in your Firebase DEV project credentials
 *   3. Load it in index.html / dashboard.html BEFORE firebase.config.js:
 *        <script src="/__env.js"></script>
 *   4. NEVER commit `__env.js` — add it to .gitignore immediately
 *
 * PRODUCTION:
 *   In CI/CD (GitHub Actions, Firebase CLI, etc.), generate this file
 *   from repository secrets at build/deploy time. Example (bash):
 *
 *     echo "window.__GOV_ENV = {
 *       FIREBASE_API_KEY: '${FIREBASE_API_KEY}',
 *       ...
 *     };" > public/__env.js
 *
 * SECURITY:
 *   Firebase web API keys are designed to be public (they identify your
 *   project, not authenticate you). Real security is enforced by:
 *     - Firebase Security Rules  (rules/firestore.rules, rules/storage.rules)
 *     - Authorised domain restrictions in Firebase Console → Auth Settings
 *   See: https://firebase.google.com/docs/projects/api-keys
 */

window.__GOV_ENV = {
  FIREBASE_API_KEY:            'YOUR_DEV_API_KEY',
  FIREBASE_AUTH_DOMAIN:        'your-dev-project.firebaseapp.com',
  FIREBASE_PROJECT_ID:         'your-dev-project-id',
  FIREBASE_STORAGE_BUCKET:     'your-dev-project.appspot.com',
  FIREBASE_MESSAGING_SENDER_ID:'YOUR_SENDER_ID',
  FIREBASE_APP_ID:             'YOUR_APP_ID',
};