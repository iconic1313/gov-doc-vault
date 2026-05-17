/**
 * auth.service.js — Firebase Phone Authentication Service
 * GovDoc Vault | Government Document Portal
 *
 * RESPONSIBILITIES:
 *   - Send OTP via Firebase Phone Auth (RecaptchaVerifier)
 *   - Verify OTP and return authenticated Firebase User
 *   - Sign out and clean up session state
 *   - Expose auth state observer for session guarding
 *   - Normalise all Firebase auth error codes into user-safe messages
 *   - Log every auth event via logger.service
 *
 * USAGE:
 *   import { AuthService } from '../services/auth.service.js';
 *
 *   // Initialise once (attach reCAPTCHA to a container element)
 *   AuthService.initRecaptcha('recaptcha-container');
 *
 *   // Send OTP
 *   await AuthService.sendOTP('+919876543210');
 *
 *   // Verify OTP
 *   const user = await AuthService.verifyOTP('123456');
 *
 *   // Sign out
 *   await AuthService.logout();
 *
 *   // Guard pages
 *   AuthService.onAuthStateChanged(user => { ... });
 *
 * DEPENDENCIES:
 *   - js/config/firebase.config.js  (auth singleton + firebaseReady)
 *   - js/services/logger.service.js (Logger)
 */

'use strict';

import { auth, firebaseReady }        from '../config/firebase.config.js';
import { Logger, clearSessionLog }    from './logger.service.js';

import {
  RecaptchaVerifier,
  signInWithPhoneNumber,
  signOut,
  onAuthStateChanged as _fbAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

// ── Module logger ────────────────────────────────────────────
const log = new Logger('AuthService');

// ── Module-level state ────────────────────────────────────────
/** @type {import('firebase/auth').ConfirmationResult|null} */
let _confirmationResult = null;

/** @type {RecaptchaVerifier|null} */
let _recaptchaVerifier = null;

/** @type {string|null} — E.164 phone number from last sendOTP call */
let _pendingPhone = null;

// ── Error code → user-safe message map ───────────────────────

const AUTH_ERROR_MESSAGES = Object.freeze({
  'auth/invalid-phone-number':         'The phone number entered is invalid. Please enter a valid 10-digit number.',
  'auth/too-many-requests':            'Too many attempts. Please wait a few minutes and try again.',
  'auth/invalid-verification-code':    'The OTP entered is incorrect. Please check and try again.',
  'auth/code-expired':                 'The OTP has expired. Please request a new one.',
  'auth/session-expired':              'Your session has expired. Please restart the login process.',
  'auth/quota-exceeded':               'SMS quota exceeded for this project. Please contact support.',
  'auth/captcha-check-failed':         'reCAPTCHA verification failed. Please refresh and try again.',
  'auth/missing-phone-number':         'Phone number is required.',
  'auth/user-disabled':                'This account has been disabled. Please contact support.',
  'auth/network-request-failed':       'A network error occurred. Please check your connection.',
  'auth/internal-error':               'An internal error occurred. Please try again.',
  'auth/operation-not-allowed':        'Phone sign-in is not enabled. Please contact support.',
  'auth/missing-verification-code':    'Please enter the OTP before verifying.',
  'auth/provider-already-linked':      'This phone number is already linked to another account.',
});

/**
 * Maps a Firebase Auth error to a safe, human-readable message.
 *
 * @param {Error} err - Firebase Auth error (has .code property)
 * @returns {string}
 */
function _resolveErrorMessage(err) {
  return AUTH_ERROR_MESSAGES[err?.code] ||
    'An unexpected error occurred. Please try again.';
}

// ── Phone number validation ───────────────────────────────────

const INDIA_PHONE_REGEX = /^[6-9]\d{9}$/;

/**
 * Normalises a raw phone input to E.164 format (+91XXXXXXXXXX).
 * Strips spaces, dashes, and an optional leading +91 or 0.
 *
 * @param  {string} raw
 * @returns {{ e164: string, digits: string }}
 * @throws {Error} if the number fails validation
 */
function _normalisePhone(raw) {
  if (typeof raw !== 'string') throw new Error('Phone number must be a string.');

  let digits = raw.replace(/[\s\-().]/g, '');

  // Strip country prefix if supplied by the caller
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.startsWith('91') && digits.length === 12) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = digits.slice(1);

  if (!INDIA_PHONE_REGEX.test(digits)) {
    throw new Error(
      'Invalid phone number. Must be a 10-digit Indian mobile number starting with 6–9.'
    );
  }

  return { e164: `+91${digits}`, digits };
}

// ── reCAPTCHA ─────────────────────────────────────────────────

/**
 * Initialises an invisible reCAPTCHA verifier and binds it to a DOM element.
 * Must be called once before sendOTP — typically in the auth module controller.
 *
 * Calling this more than once resets the previous verifier safely.
 *
 * @param {string} containerId - ID of the DOM element to bind reCAPTCHA to
 * @returns {void}
 */
function initRecaptcha(containerId) {
  if (!containerId || typeof containerId !== 'string') {
    throw new TypeError('[AuthService] initRecaptcha: containerId must be a non-empty string.');
  }

  // Clean up any existing verifier before re-initialising
  _destroyRecaptcha();

  _recaptchaVerifier = new RecaptchaVerifier(auth, containerId, {
    size: 'invisible',
    callback: () => {
      log.debug('RECAPTCHA_SOLVED', { containerId });
    },
    'expired-callback': () => {
      log.warn('RECAPTCHA_EXPIRED', { containerId });
      _destroyRecaptcha();
    },
  });

  log.debug('RECAPTCHA_INIT', { containerId });
}

/**
 * Destroys the current reCAPTCHA verifier instance and clears the reference.
 * Called internally on logout and re-init.
 */
function _destroyRecaptcha() {
  if (_recaptchaVerifier) {
    try {
      _recaptchaVerifier.clear();
    } catch (_) {
      // Verifier may already be cleared — safe to ignore
    }
    _recaptchaVerifier = null;
  }
}

// ── Core Auth Functions ───────────────────────────────────────

/**
 * sendOTP
 * -------
 * Validates the phone number, then triggers Firebase Phone Auth to
 * dispatch an OTP SMS to the provided number.
 *
 * @param   {string} rawPhone - Raw phone input (10-digit or +91 prefixed)
 * @returns {Promise<{ success: boolean, phone: string, message: string }>}
 */
async function sendOTP(rawPhone) {
  await firebaseReady;

  // 1. Validate + normalise phone
  let normalised;
  try {
    normalised = _normalisePhone(rawPhone);
  } catch (validationErr) {
    log.warn('OTP_SEND_VALIDATION_FAILED', { raw: rawPhone });
    return { success: false, phone: null, message: validationErr.message };
  }

  // 2. Recaptcha must be initialised before sending OTP
  if (!_recaptchaVerifier) {
    const msg = 'reCAPTCHA not initialised. Call AuthService.initRecaptcha() first.';
    log.error('OTP_SEND_FAILED', new Error(msg), { phone: normalised.e164 });
    return { success: false, phone: null, message: msg };
  }

  // 3. Send OTP via Firebase
  try {
    _confirmationResult = await signInWithPhoneNumber(
      auth,
      normalised.e164,
      _recaptchaVerifier
    );

    _pendingPhone = normalised.e164;

    log.info('OTP_SENT', { phone: _maskPhone(normalised.e164) });

    return {
      success: true,
      phone:   normalised.e164,
      message: `OTP sent to ${normalised.e164}.`,
    };

  } catch (err) {
    log.error('OTP_SEND_FAILED', err, { phone: _maskPhone(normalised.e164) });

    // Reset reCAPTCHA so the user can retry
    _destroyRecaptcha();

    return {
      success: false,
      phone:   null,
      message: _resolveErrorMessage(err),
    };
  }
}

/**
 * verifyOTP
 * ---------
 * Confirms the OTP entered by the user against the pending confirmation result.
 * Returns the Firebase User object on success.
 *
 * @param   {string} otp - 6-digit OTP string
 * @returns {Promise<{ success: boolean, user: import('firebase/auth').User|null, message: string }>}
 */
async function verifyOTP(otp) {
  await firebaseReady;

  // 1. Guard: OTP must have been sent first
  if (!_confirmationResult) {
    const msg = 'No OTP request in progress. Please send an OTP first.';
    log.warn('OTP_VERIFY_NO_SESSION', {});
    return { success: false, user: null, message: msg };
  }

  // 2. Basic OTP format validation
  const otpStr = String(otp).trim();
  if (!/^\d{6}$/.test(otpStr)) {
    log.warn('OTP_VERIFY_INVALID_FORMAT', { length: otpStr.length });
    return {
      success: false,
      user:    null,
      message: 'OTP must be exactly 6 digits.',
    };
  }

  // 3. Confirm with Firebase
  try {
    const credential = await _confirmationResult.confirm(otpStr);
    const user       = credential.user;

    log.info('LOGIN_SUCCESS', {
      uid:   user.uid,
      phone: _maskPhone(user.phoneNumber),
      isNew: credential.additionalUserInfo?.isNewUser ?? false,
    });

    // Clean up the pending confirmation state
    _confirmationResult = null;
    _pendingPhone       = null;

    return { success: true, user, message: 'Login successful.' };

  } catch (err) {
    log.error('LOGIN_FAILED', err, {
      phone: _maskPhone(_pendingPhone),
    });

    return {
      success: false,
      user:    null,
      message: _resolveErrorMessage(err),
    };
  }
}

/**
 * logout
 * ------
 * Signs the current user out of Firebase, destroys the reCAPTCHA verifier,
 * and clears the in-memory session audit log.
 *
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function logout() {
  await firebaseReady;

  const currentUser = auth.currentUser;

  try {
    await signOut(auth);

    _destroyRecaptcha();
    _confirmationResult = null;
    _pendingPhone       = null;

    // Clear PII from in-memory log on sign-out
    clearSessionLog();

    log.info('LOGOUT_SUCCESS', { uid: currentUser?.uid ?? 'unknown' });

    return { success: true, message: 'You have been signed out.' };

  } catch (err) {
    log.error('LOGOUT_FAILED', err, { uid: currentUser?.uid ?? 'unknown' });
    return { success: false, message: _resolveErrorMessage(err) };
  }
}

/**
 * onAuthStateChanged
 * ------------------
 * Subscribes to Firebase auth state changes.
 * Use this on every protected page to guard against unauthenticated access.
 *
 * Returns the Firebase unsubscribe function — always call it on page teardown
 * to prevent memory leaks.
 *
 * @param   {function(import('firebase/auth').User|null): void} callback
 * @returns {function} unsubscribe
 *
 * @example
 *   const unsub = AuthService.onAuthStateChanged((user) => {
 *     if (!user) window.location.replace('/index.html');
 *   });
 */
function onAuthStateChanged(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('[AuthService] onAuthStateChanged: callback must be a function.');
  }

  return _fbAuthStateChanged(auth, (user) => {
    log.debug(
      user ? 'AUTH_STATE_SIGNED_IN' : 'AUTH_STATE_SIGNED_OUT',
      { uid: user?.uid ?? null }
    );
    callback(user);
  });
}

/**
 * getCurrentUser
 * --------------
 * Synchronously returns the currently signed-in Firebase User, or null.
 * Note: may be null during the initial auth state resolution tick.
 * Prefer `onAuthStateChanged` for reliable auth gating.
 *
 * @returns {import('firebase/auth').User|null}
 */
function getCurrentUser() {
  return auth.currentUser;
}

// ── Helpers ───────────────────────────────────────────────────

/**
 * Masks a phone number for safe logging — shows only last 4 digits.
 * Input: '+919876543210'  →  Output: '+91XXXXXX3210'
 *
 * @param {string|null} phone
 * @returns {string}
 */
function _maskPhone(phone) {
  if (!phone || phone.length < 4) return '[unknown]';
  return phone.slice(0, -4).replace(/\d/g, 'X') + phone.slice(-4);
}

// ── Public API ────────────────────────────────────────────────

const AuthService = Object.freeze({
  initRecaptcha,
  sendOTP,
  verifyOTP,
  logout,
  onAuthStateChanged,
  getCurrentUser,
});

export { AuthService };