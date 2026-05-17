/**
 * firebase.config.js — Firebase Initialisation & Service Exports
 * GovDoc Vault | Government Document Portal
 *
 * RESPONSIBILITIES:
 *   - Load validated environment config via env.js
 *   - Initialise the Firebase App exactly once (singleton guard)
 *   - Initialise and export: Auth, Firestore, Storage
 *   - Apply session-only auth persistence (security requirement)
 *   - Expose a readiness promise for modules that boot asynchronously
 *
 * USAGE (in any service/module):
 *   import { auth, db, storage } from '../config/firebase.config.js';
 *
 * IMPORTS:
 *   Firebase is loaded via CDN ESM shims (no npm build required).
 *   Pin the version string to avoid silent breaking changes.
 */

'use strict';

import { loadEnv }            from './env.js';

// ── Firebase SDK (CDN ESM — version-pinned) ──────────────────
import { initializeApp, getApps }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';

import {
  getAuth,
  setPersistence,
  browserSessionPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

import { getStorage }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';

// ── Module-level service references ─────────────────────────
let _app;
let _auth;
let _db;
let _storage;

/**
 * Initialises Firebase services once.
 * Called internally; downstream modules import the named exports below.
 *
 * @returns {Promise<void>}
 */
async function _initialise() {
  // 1. Load & validate environment config
  const firebaseConfig = loadEnv();

  // 2. Singleton guard — prevent double-init (e.g. HMR or multi-import)
  if (getApps().length > 0) {
    _app     = getApps()[0];
    _auth    = getAuth(_app);
    _db      = getFirestore(_app);
    _storage = getStorage(_app);
    return;
  }

  // 3. Initialise Firebase App
  _app = initializeApp(firebaseConfig);

  // 4. Auth — session persistence only (expires on tab/browser close)
  //    Security requirement: no long-lived tokens in localStorage
  _auth = getAuth(_app);
  await setPersistence(_auth, browserSessionPersistence);

  // 5. Firestore — modern persistent cache (replaces deprecated enableIndexedDbPersistence)
  //    persistentMultipleTabManager allows offline cache across multiple tabs
  try {
    _db = initializeFirestore(_app, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });
  } catch (err) {
    // Fallback to in-memory Firestore if persistence is unsupported
    console.warn('[GovDoc][Firestore] Persistent cache unavailable, using memory cache:', err.message);
    _db = getFirestore(_app);
  }

  // 6. Storage
  _storage = getStorage(_app);
}

// ── Boot: initialise immediately on module load ──────────────
//    All consumers can await `firebaseReady` before using services
const firebaseReady = _initialise().catch((err) => {
  // Surface config/init errors loudly — these are fatal
  console.error('[GovDoc][Firebase] Initialisation failed:', err.message);
  // Re-throw so consumers can gate on failure
  throw err;
});

// ── Named service exports ────────────────────────────────────
//    Accessed as singletons; always initialised before first use
//    because modules naturally await `firebaseReady` at startup.

/** Firebase Auth instance */
export { _auth as auth };

/** Firestore database instance */
export { _db as db };

/** Firebase Storage instance */
export { _storage as storage };

/** Promise that resolves when all services are ready */
export { firebaseReady };