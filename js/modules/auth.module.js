/**
 * auth.module.js — Authentication UI Controller
 * GovDoc Vault | Government Document Portal
 *
 * RESPONSIBILITIES:
 *   - Wire index.html OTP flow to AuthService (sendOTP / verifyOTP)
 *   - Manage UI state: idle → loading → success → error
 *   - Drive step transitions: phone input → OTP input
 *   - Run OTP countdown timer + resend flow
 *   - Redirect authenticated user to dashboard after login
 *   - Redirect already-logged-in users away from login page on load
 *   - Log every meaningful auth event via Logger
 *
 * INVOCATION:
 *   Add to index.html (after __env.js):
 *     <script type="module" src="js/modules/auth.module.js"></script>
 *
 * DEPENDENCIES:
 *   AuthService    — js/services/auth.service.js
 *   session.utils  — js/utils/session.utils.js
 *   Logger         — js/services/logger.service.js
 *   dom.utils      — js/utils/dom.utils.js
 */

'use strict';

import { AuthService }              from '../services/auth.service.js';
import { redirectIfAuthenticated }  from '../utils/session.utils.js';
import { Logger }                   from '../services/logger.service.js';
import { UI }                       from '../utils/dom.utils.js';

const log = new Logger('AuthModule');

// ── Constants ────────────────────────────────────────────────
const OTP_COUNTDOWN_SECONDS = 30;
const DASHBOARD_URL         = '/dashboard.html';

// ── DOM references ────────────────────────────────────────────
// Resolved once on DOMContentLoaded — never queried repeatedly.
let DOM = {};

function _resolveDOM() {
  DOM = {
    // Steps
    stepPhone : document.getElementById('step-phone'),
    stepOtp   : document.getElementById('step-otp'),

    // Phone step
    formPhone : document.getElementById('form-phone'),
    inputPhone: document.getElementById('input-phone'),
    phoneError: document.getElementById('phone-error'),
    btnSendOtp: document.getElementById('btn-send-otp'),

    // OTP step
    formOtp       : document.getElementById('form-otp'),
    inputOtp      : document.getElementById('input-otp'),       // hidden aggregator
    otpPhoneDisplay: document.getElementById('otp-phone-display'),
    otpError      : document.getElementById('otp-error'),
    btnVerifyOtp  : document.getElementById('btn-verify-otp'),
    btnResend     : document.getElementById('btn-resend'),
    btnChangeNum  : document.getElementById('btn-change-number'),
    countdownEl   : document.getElementById('countdown'),
    otpTimer      : document.getElementById('otp-timer'),

    // reCAPTCHA
    recaptchaContainer: document.getElementById('recaptcha-container'),
  };
}

// ── Timer state ───────────────────────────────────────────────
let _countdownTimer = null;

// ── Boot ──────────────────────────────────────────────────────

/**
 * Entry point. Called after DOM is ready.
 */
async function init() {
  _resolveDOM();

  // If user is already signed in, bounce to dashboard immediately
  redirectIfAuthenticated();

  // Initialise invisible reCAPTCHA (must happen after DOM is ready)
  try {
    AuthService.initRecaptcha('recaptcha-container');
    log.debug('RECAPTCHA_BOUND', { container: 'recaptcha-container' });
  } catch (err) {
    log.error('RECAPTCHA_INIT_FAILED', err);
    _showPhoneError('Failed to initialise security check. Please refresh the page.');
    return;
  }

  _bindPhoneStep();
  _bindOtpStep();

  log.info('AUTH_MODULE_READY', { page: 'index.html' });
}

// ── Phone Step ────────────────────────────────────────────────

function _bindPhoneStep() {
  DOM.formPhone.addEventListener('submit', async (e) => {
    e.preventDefault();
    await _handleSendOtp();
  });
}

async function _handleSendOtp() {
  const rawPhone = DOM.inputPhone.value.trim();

  _clearPhoneError();
  _setButtonLoading(DOM.btnSendOtp, true);

  log.debug('OTP_SEND_ATTEMPT', { raw: rawPhone });

  const result = await AuthService.sendOTP(rawPhone);

  _setButtonLoading(DOM.btnSendOtp, false);

  if (!result.success) {
    _showPhoneError(result.message);
    log.warn('OTP_SEND_UI_ERROR', { message: result.message });

    // Re-init reCAPTCHA after a failed attempt so the user can retry
    try {
      AuthService.initRecaptcha('recaptcha-container');
    } catch (_) { /* non-fatal */ }

    return;
  }

  log.info('OTP_SEND_SUCCESS_UI', { phone: result.phone });
  _transitionToOtpStep(result.phone);
}

// ── OTP Step ──────────────────────────────────────────────────

function _bindOtpStep() {
  DOM.formOtp.addEventListener('submit', async (e) => {
    e.preventDefault();
    await _handleVerifyOtp();
  });

  DOM.btnResend.addEventListener('click', async () => {
    await _handleResend();
  });

  DOM.btnChangeNum.addEventListener('click', () => {
    _transitionToPhoneStep();
  });
}

async function _handleVerifyOtp() {
  const otp = DOM.inputOtp.value.trim();

  _clearOtpError();

  if (otp.length !== 6) {
    _showOtpError('Please enter all 6 digits of the OTP.');
    return;
  }

  _setButtonLoading(DOM.btnVerifyOtp, true);

  log.debug('OTP_VERIFY_ATTEMPT', {});

  const result = await AuthService.verifyOTP(otp);

  _setButtonLoading(DOM.btnVerifyOtp, false);

  if (!result.success) {
    _showOtpError(result.message);
    log.warn('OTP_VERIFY_UI_ERROR', { message: result.message });
    _clearOtpInputs();
    return;
  }

  log.info('LOGIN_SUCCESS_UI', { uid: result.user.uid });

  // Auto-create user profile on first login (non-blocking)
  try {
    const { DbService } = await import('../services/db.service.js');
    await DbService.upsertUser(result.user.uid, {
      name : '',
      phone: result.user.phoneNumber ?? '',
      dob  : '',
    });
    log.info('USER_PROFILE_ENSURED', { uid: result.user.uid });
  } catch (err) {
    log.warn('USER_PROFILE_ENSURE_FAILED', { uid: result.user.uid });
  }

  UI.toast('Login successful. Redirecting…', 'success');

  setTimeout(() => {
    window.location.replace(DASHBOARD_URL);
  }, 800);
}

async function _handleResend() {
  const rawPhone = DOM.inputPhone.value.trim();

  DOM.btnResend.disabled = true;
  _clearOtpError();
  _clearOtpInputs();

  log.info('OTP_RESEND_ATTEMPT', {});

  // Re-init reCAPTCHA before resend
  try {
    AuthService.initRecaptcha('recaptcha-container');
  } catch (err) {
    log.error('RECAPTCHA_REINIT_FAILED', err);
    _showOtpError('Failed to re-initialise security check. Please refresh.');
    return;
  }

  const result = await AuthService.sendOTP(rawPhone);

  if (!result.success) {
    _showOtpError(result.message);
    log.warn('OTP_RESEND_FAILED_UI', { message: result.message });
    return;
  }

  log.info('OTP_RESEND_SUCCESS_UI', {});
  UI.toast('A new OTP has been sent.', 'info');
  _startCountdown();
}

// ── Step Transitions ──────────────────────────────────────────

/**
 * Show the OTP input step, hide the phone step.
 * Displays the masked phone number the OTP was sent to.
 *
 * @param {string} e164Phone - Full E.164 phone number
 */
function _transitionToOtpStep(e164Phone) {
  DOM.otpPhoneDisplay.textContent = _formatPhoneDisplay(e164Phone);

  DOM.stepPhone.classList.add('auth-step--hidden');
  DOM.stepPhone.setAttribute('aria-hidden', 'true');

  DOM.stepOtp.classList.remove('auth-step--hidden');
  DOM.stepOtp.setAttribute('aria-hidden', 'false');

  _startCountdown();

  // Focus the first OTP digit box
  document.querySelector('.otp-input')?.focus();

  log.debug('TRANSITION_TO_OTP_STEP', {});
}

/**
 * Return to the phone entry step and reset all OTP state.
 */
function _transitionToPhoneStep() {
  _stopCountdown();
  _clearOtpInputs();
  _clearOtpError();

  DOM.stepOtp.classList.add('auth-step--hidden');
  DOM.stepOtp.setAttribute('aria-hidden', 'true');

  DOM.stepPhone.classList.remove('auth-step--hidden');
  DOM.stepPhone.setAttribute('aria-hidden', 'false');

  DOM.inputPhone.focus();

  log.debug('TRANSITION_TO_PHONE_STEP', {});
}

// ── Countdown Timer ───────────────────────────────────────────

function _startCountdown() {
  _stopCountdown();

  let remaining = OTP_COUNTDOWN_SECONDS;

  DOM.countdownEl.textContent = remaining;
  DOM.otpTimer.hidden         = false;
  DOM.btnResend.disabled      = true;

  _countdownTimer = setInterval(() => {
    remaining -= 1;
    DOM.countdownEl.textContent = remaining;

    if (remaining <= 0) {
      _stopCountdown();
      DOM.otpTimer.hidden    = true;
      DOM.btnResend.disabled = false;
    }
  }, 1000);
}

function _stopCountdown() {
  if (_countdownTimer) {
    clearInterval(_countdownTimer);
    _countdownTimer = null;
  }
}

// ── UI State Helpers ──────────────────────────────────────────

/**
 * Toggle loading state on a submit button.
 * Shows spinner, hides text label, disables the button.
 *
 * @param {HTMLButtonElement} btn
 * @param {boolean}           isLoading
 */
function _setButtonLoading(btn, isLoading) {
  const textEl   = btn.querySelector('.btn__text');
  const loaderEl = btn.querySelector('.btn__loader');

  btn.disabled = isLoading;

  if (textEl)   textEl.style.visibility  = isLoading ? 'hidden' : '';
  if (loaderEl) loaderEl.hidden          = !isLoading;
}

function _showPhoneError(message) {
  DOM.phoneError.textContent = message;
  DOM.phoneError.hidden      = false;
  DOM.inputPhone.classList.add('form-input--error');
  DOM.inputPhone.setAttribute('aria-invalid', 'true');
}

function _clearPhoneError() {
  DOM.phoneError.textContent = '';
  DOM.phoneError.hidden      = true;
  DOM.inputPhone.classList.remove('form-input--error');
  DOM.inputPhone.removeAttribute('aria-invalid');
}

function _showOtpError(message) {
  DOM.otpError.textContent = message;
  DOM.otpError.hidden      = false;
}

function _clearOtpError() {
  DOM.otpError.textContent = '';
  DOM.otpError.hidden      = true;
}

function _clearOtpInputs() {
  document.querySelectorAll('.otp-input').forEach((i) => { i.value = ''; });
  DOM.inputOtp.value = '';
  document.querySelector('.otp-input')?.focus();
}

// ── Formatting ────────────────────────────────────────────────

/**
 * Formats an E.164 number for display in the OTP step label.
 * '+919876543210' → '+91 98765 43210'
 *
 * @param {string} e164
 * @returns {string}
 */
function _formatPhoneDisplay(e164) {
  if (!e164 || e164.length < 10) return e164;
  const digits = e164.replace('+91', '');
  return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
}

// ── Boot on DOMContentLoaded ──────────────────────────────────
document.addEventListener('DOMContentLoaded', init);