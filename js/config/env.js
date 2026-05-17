/**
 * env.js — Runtime Environment Configuration
 * GovDoc Vault | Government Document Portal
 *
 * PURPOSE:
 *   Provides a single source of truth for all environment-based config.
 *   In a no-build-tool vanilla JS stack, Firebase config is injected at
 *   deploy time via CI/CD (Firebase Hosting environment targets) or
 *   supplied through a generated `__env.js` file (see DEPLOYMENT NOTE).
 *
 * DEPLOYMENT NOTE:
 *   For Firebase Hosting, use `.env` files with the Firebase CLI and
 *   hosting targets. During your CI pipeline, generate a `__env.js` from
 *   your secrets and load it BEFORE this module in your HTML:
 *
 *     <script src="/__env.js"></script>   ← generated at build/deploy
 *     <script type="module" src="js/config/env.js"></script>
 *
 *   The generated `__env.js` must assign:
 *     window.__GOV_ENV = { FIREBASE_API_KEY: "...", ... }
 *
 *   NEVER hardcode real values here. NEVER commit real values.
 *
 * LOCAL DEVELOPMENT:
 *   Create `public/__env.js` locally (gitignored) with your dev project
 *   credentials. Use a separate Firebase project for dev vs production.
 */

'use strict';

/**
 * Reads Firebase config from the runtime-injected window.__GOV_ENV object.
 * Throws early with a clear message if any required key is missing —
 * prevents silent failures in production.
 *
 * @returns {Object} Validated Firebase configuration object
 * @throws  {Error}  If any required environment variable is absent
 */
function loadEnv() {
  const source = window.__GOV_ENV;

  if (!source || typeof source !== 'object') {
    throw new Error(
      '[GovDoc][Config] Environment not initialised. ' +
      'Ensure __env.js is loaded before firebase.config.js. ' +
      'See .env.example for required keys.'
    );
  }

  const REQUIRED_KEYS = [
    'FIREBASE_API_KEY',
    'FIREBASE_AUTH_DOMAIN',
    'FIREBASE_PROJECT_ID',
    'FIREBASE_STORAGE_BUCKET',
    'FIREBASE_MESSAGING_SENDER_ID',
    'FIREBASE_APP_ID',
  ];

  const missing = REQUIRED_KEYS.filter(
    (key) => !source[key] || source[key].trim() === ''
  );

  if (missing.length > 0) {
    throw new Error(
      `[GovDoc][Config] Missing required environment keys: ${missing.join(', ')}. ` +
      'Check your __env.js or CI/CD secret injection.'
    );
  }

  return {
    apiKey:            source.FIREBASE_API_KEY,
    authDomain:        source.FIREBASE_AUTH_DOMAIN,
    projectId:         source.FIREBASE_PROJECT_ID,
    storageBucket:     source.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: source.FIREBASE_MESSAGING_SENDER_ID,
    appId:             source.FIREBASE_APP_ID,
  };
}

export { loadEnv };