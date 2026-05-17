/**
 * session.utils.js — Auth Guard & Session Utilities
 * GovDoc Vault | Government Document Portal
 *
 * RESPONSIBILITIES:
 *   - Protect pages that require authentication
 *   - Redirect unauthenticated users to login
 *   - Redirect already-authenticated users away from login page
 *   - Provide a clean way to get current session user data
 *
 * USAGE (on every protected page — top of the page module):
 *   import { requireAuth } from '../utils/session.utils.js';
 *   requireAuth();   // redirects to /index.html if not signed in
 *
 * USAGE (on login page — prevent signed-in users re-visiting auth):
 *   import { redirectIfAuthenticated } from '../utils/session.utils.js';
 *   redirectIfAuthenticated();   // redirects to /dashboard.html if signed in
 */

'use strict';

import { AuthService } from '../services/auth.service.js';
import { Logger }      from '../services/logger.service.js';

const log = new Logger('SessionUtils');

// ── Route constants ───────────────────────────────────────────
const ROUTES = Object.freeze({
  LOGIN:     '/index.html',
  DASHBOARD: '/dashboard.html',
});

/**
 * requireAuth
 * -----------
 * Guards a page that requires authentication.
 * Subscribes to the Firebase auth state observer — if the resolved user
 * is null, redirects immediately to the login page.
 *
 * Call at the top of every protected page script (dashboard, profile, etc.)
 *
 * @param {function(import('firebase/auth').User): void} [onUser]
 *   Optional callback invoked with the authenticated User when confirmed.
 *   Use this to bootstrap page data (e.g. load documents for the user).
 *
 * @returns {function} Firebase unsubscribe — call on page teardown if needed
 */
function requireAuth(onUser) {
  const unsubscribe = AuthService.onAuthStateChanged((user) => {
    if (!user) {
      log.warn('AUTH_GUARD_REDIRECT', {
        from: window.location.pathname,
        to:   ROUTES.LOGIN,
      });
      window.location.replace(ROUTES.LOGIN);
      return;
    }

    log.debug('AUTH_GUARD_PASS', { uid: user.uid });

    if (typeof onUser === 'function') {
      onUser(user);
    }
  });

  return unsubscribe;
}

/**
 * redirectIfAuthenticated
 * -----------------------
 * Anti-guard for the login page.
 * If a user is already signed in and navigates to /index.html,
 * redirect them straight to the dashboard.
 *
 * @returns {function} Firebase unsubscribe
 */
function redirectIfAuthenticated() {
  const unsubscribe = AuthService.onAuthStateChanged((user) => {
    if (user) {
      log.info('ALREADY_AUTHENTICATED_REDIRECT', {
        uid: user.uid,
        to:  ROUTES.DASHBOARD,
      });
      window.location.replace(ROUTES.DASHBOARD);
    }
  });

  return unsubscribe;
}

/**
 * getSessionUser
 * --------------
 * Returns the currently resolved Firebase User synchronously.
 * Safe to call after requireAuth() has confirmed the session.
 *
 * @returns {import('firebase/auth').User|null}
 */
function getSessionUser() {
  return AuthService.getCurrentUser();
}

export { requireAuth, redirectIfAuthenticated, getSessionUser, ROUTES };