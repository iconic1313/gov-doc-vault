/**
 * dom.utils.js — Shared DOM Utilities
 * GovDoc Vault | Government Document Portal
 *
 * RESPONSIBILITIES:
 *   - Lightweight querySelector wrappers
 *   - Toast notification system (info / success / warn / error)
 *   - Global page loader overlay
 *   - Safe element show/hide
 *
 * USAGE:
 *   import { UI } from '../utils/dom.utils.js';
 *
 *   UI.toast('Document uploaded.', 'success');
 *   UI.toast('Something went wrong.', 'error', 6000);
 *   UI.showLoader();
 *   UI.hideLoader();
 */

'use strict';

// ── Toast ─────────────────────────────────────────────────────

const TOAST_DEFAULTS = Object.freeze({
  duration : 4000,   // ms before auto-dismiss
  maxStack : 4,      // maximum visible toasts at once
});

const TOAST_ICONS = Object.freeze({
  success : '✓',
  error   : '✕',
  warning : '⚠',
  info    : 'ℹ',
});

/**
 * Renders a toast notification in #toast-container.
 * Auto-dismisses after `duration` ms.
 *
 * @param {string} message
 * @param {'success'|'error'|'warning'|'info'} [type='info']
 * @param {number} [duration]
 */
function toast(message, type = 'info', duration = TOAST_DEFAULTS.duration) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  // Enforce max stack — remove oldest if over limit
  const existing = container.querySelectorAll('.toast');
  if (existing.length >= TOAST_DEFAULTS.maxStack) {
    existing[0].remove();
  }

  const el = document.createElement('div');
  el.className    = `toast toast--${type}`;
  el.setAttribute('role', 'alert');
  el.setAttribute('aria-live', 'assertive');
  el.innerHTML = `
    <span class="toast__icon" aria-hidden="true">${TOAST_ICONS[type] ?? 'ℹ'}</span>
    <span class="toast__message">${_escapeHtml(message)}</span>
    <button class="toast__close" aria-label="Dismiss notification" type="button">&#10005;</button>
  `;

  // Dismiss on close button
  el.querySelector('.toast__close').addEventListener('click', () => _dismissToast(el));

  container.appendChild(el);

  // Auto-dismiss
  const timer = setTimeout(() => _dismissToast(el), duration);

  // Cancel auto-dismiss if user interacts (hover / focus)
  el.addEventListener('mouseenter', () => clearTimeout(timer));

  return el;
}

function _dismissToast(el) {
  if (!el || !el.parentNode) return;
  el.style.transition = 'opacity 150ms ease, transform 150ms ease';
  el.style.opacity    = '0';
  el.style.transform  = 'translateX(12px)';
  setTimeout(() => el.remove(), 150);
}

// ── Page Loader ───────────────────────────────────────────────

let _loaderEl = null;

/**
 * Shows a full-page loading overlay.
 * Creates the overlay element on first call.
 *
 * @param {string} [label='Loading…']
 */
function showLoader(label = 'Loading…') {
  if (_loaderEl) return;

  _loaderEl = document.createElement('div');
  _loaderEl.className          = 'page-loader';
  _loaderEl.setAttribute('role', 'status');
  _loaderEl.setAttribute('aria-live', 'polite');
  _loaderEl.innerHTML = `
    <span class="spinner spinner--lg" aria-hidden="true"></span>
    <span class="page-loader__label">${_escapeHtml(label)}</span>
  `;

  document.body.appendChild(_loaderEl);
  document.body.style.overflow = 'hidden';
}

/**
 * Hides and removes the page loader overlay.
 */
function hideLoader() {
  if (!_loaderEl) return;
  _loaderEl.remove();
  _loaderEl = null;
  document.body.style.overflow = '';
}

// ── Safe DOM helpers ──────────────────────────────────────────

/**
 * Typed querySelector — throws in dev if element is not found.
 *
 * @template {HTMLElement} T
 * @param {string} selector
 * @param {Document|HTMLElement} [scope=document]
 * @returns {T}
 */
function qs(selector, scope = document) {
  const el = scope.querySelector(selector);
  if (!el && !_isProduction()) {
    console.warn(`[GovDoc][DOM] Element not found: "${selector}"`);
  }
  return el;
}

/**
 * Typed querySelectorAll returning a plain Array.
 *
 * @param {string} selector
 * @param {Document|HTMLElement} [scope=document]
 * @returns {HTMLElement[]}
 */
function qsa(selector, scope = document) {
  return Array.from(scope.querySelectorAll(selector));
}

/**
 * Show a DOM element (removes `hidden` attribute).
 * @param {HTMLElement} el
 */
function show(el) {
  if (el) el.hidden = false;
}

/**
 * Hide a DOM element (sets `hidden` attribute).
 * @param {HTMLElement} el
 */
function hide(el) {
  if (el) el.hidden = true;
}

/**
 * Toggle element visibility.
 * @param {HTMLElement} el
 * @param {boolean} [force]
 */
function toggle(el, force) {
  if (!el) return;
  el.hidden = force !== undefined ? !force : !el.hidden;
}

/**
 * Set text content safely (no XSS risk).
 * @param {HTMLElement} el
 * @param {string} text
 */
function setText(el, text) {
  if (el) el.textContent = String(text ?? '');
}

/**
 * Safely escape HTML special characters for use in innerHTML.
 * @param {string} str
 * @returns {string}
 */
function _escapeHtml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#x27;');
}

function _isProduction() {
  return window.__GOV_ENV?.APP_ENV === 'production';
}

// ── Public API ────────────────────────────────────────────────

const UI = Object.freeze({
  toast,
  showLoader,
  hideLoader,
  qs,
  qsa,
  show,
  hide,
  toggle,
  setText,
});

export { UI };