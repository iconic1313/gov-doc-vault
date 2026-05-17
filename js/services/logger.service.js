/**
 * logger.service.js — Centralised Logging Utility
 * GovDoc Vault | Government Document Portal
 *
 * RESPONSIBILITIES:
 *   - Provide structured, consistent log output across all modules
 *   - Attach timestamp, log level, action type, and context to every entry
 *   - Maintain an in-memory audit trail for the current session
 *   - Conditionally suppress debug-level logs in production
 *   - Expose a session log dump for diagnostics / future remote log shipping
 *
 * USAGE:
 *   import { Logger } from '../services/logger.service.js';
 *
 *   const log = new Logger('AuthModule');
 *   log.info ('OTP_SENT',    { phone: '+91XXXXXX' });
 *   log.warn ('OTP_EXPIRED', { attempts: 3 });
 *   log.error('LOGIN_FAILED', err, { uid: null });
 *
 * AUDIT TRAIL:
 *   import { getSessionLog, clearSessionLog } from '../services/logger.service.js';
 *   const entries = getSessionLog();   // array of all log entries this session
 */

'use strict';

// ── Constants ────────────────────────────────────────────────

const LEVELS = Object.freeze({
  INFO:  'INFO',
  WARN:  'WARN',
  ERROR: 'ERROR',
  DEBUG: 'DEBUG',
});

/**
 * Detect production environment.
 * Set window.__GOV_ENV.APP_ENV = 'production' in your __env.js to
 * suppress DEBUG logs and console output in prod.
 */
const IS_PRODUCTION = (
  typeof window !== 'undefined' &&
  window.__GOV_ENV?.APP_ENV === 'production'
);

// ── In-memory session audit log ──────────────────────────────
/** @type {LogEntry[]} */
const _sessionLog = [];

// ── Types (JSDoc) ────────────────────────────────────────────

/**
 * @typedef {Object} LogEntry
 * @property {string} timestamp   - ISO 8601 UTC timestamp
 * @property {string} level       - INFO | WARN | ERROR | DEBUG
 * @property {string} module      - Originating module name
 * @property {string} action      - Semantic action identifier (e.g. 'LOGIN_SUCCESS')
 * @property {string} message     - Human-readable description
 * @property {Object} [context]   - Arbitrary structured metadata
 * @property {string} [error]     - Serialised error message (ERROR level only)
 * @property {string} [stack]     - Error stack trace (ERROR level only, non-prod)
 */

// ── Core formatter ───────────────────────────────────────────

/**
 * Builds a structured LogEntry object.
 *
 * @param {string}  level
 * @param {string}  module
 * @param {string}  action
 * @param {string}  message
 * @param {Error|null} [err]
 * @param {Object}  [context]
 * @returns {LogEntry}
 */
function _buildEntry(level, module, action, message, err = null, context = {}) {
  /** @type {LogEntry} */
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    module:  module  || 'Unknown',
    action:  action  || 'UNSPECIFIED',
    message: message || '',
    context: _sanitiseContext(context),
  };

  if (err instanceof Error) {
    entry.error = err.message;
    // Omit stack traces in production to avoid leaking internals
    if (!IS_PRODUCTION) {
      entry.stack = err.stack;
    }
  }

  return entry;
}

/**
 * Strips sensitive fields from context before logging.
 * Extend this list as the data model grows.
 *
 * @param {Object} ctx
 * @returns {Object}
 */
function _sanitiseContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return {};

  const SENSITIVE_KEYS = ['password', 'otp', 'token', 'secret', 'apiKey', 'key'];
  const safe = { ...ctx };

  SENSITIVE_KEYS.forEach((k) => {
    if (k in safe) safe[k] = '[REDACTED]';
  });

  return safe;
}

// ── Console output ───────────────────────────────────────────

const _CONSOLE_STYLES = {
  [LEVELS.INFO]:  'color:#1A3A5C; font-weight:600;',
  [LEVELS.WARN]:  'color:#F57F17; font-weight:600;',
  [LEVELS.ERROR]: 'color:#C62828; font-weight:600;',
  [LEVELS.DEBUG]: 'color:#8A96A3; font-weight:400;',
};

/**
 * Emits a formatted console line.
 * Suppressed entirely in production for ERROR guards — use remote
 * log shipping (future) instead.
 *
 * @param {LogEntry} entry
 */
function _emit(entry) {
  if (IS_PRODUCTION && entry.level === LEVELS.DEBUG) return;

  const prefix = `%c[GovDoc][${entry.level}]`;
  const label  = `[${entry.module}] ${entry.action}`;
  const style  = _CONSOLE_STYLES[entry.level] || '';
  const ts     = entry.timestamp;

  const consoleFn =
    entry.level === LEVELS.ERROR ? console.error  :
    entry.level === LEVELS.WARN  ? console.warn   :
    entry.level === LEVELS.DEBUG ? console.debug  :
    console.log;

  if (Object.keys(entry.context).length > 0 || entry.error) {
    consoleFn(
      `${prefix} ${ts} — ${label}: ${entry.message}`,
      style,
      { context: entry.context, ...(entry.error ? { error: entry.error } : {}) }
    );
  } else {
    consoleFn(`${prefix} ${ts} — ${label}: ${entry.message}`, style);
  }
}

// ── Session log management ───────────────────────────────────

/**
 * Appends entry to the in-memory session log.
 * Caps at 500 entries to prevent unbounded memory growth.
 *
 * @param {LogEntry} entry
 */
function _record(entry) {
  if (_sessionLog.length >= 500) _sessionLog.shift();
  _sessionLog.push(entry);
}

// ── Logger class ─────────────────────────────────────────────

class Logger {
  /**
   * @param {string} moduleName - Identifies the calling module in every log entry
   */
  constructor(moduleName) {
    if (!moduleName || typeof moduleName !== 'string') {
      throw new TypeError('[GovDoc][Logger] moduleName must be a non-empty string.');
    }
    this._module = moduleName;
  }

  /**
   * Log an informational event.
   * Use for successful operations: login, upload, share, etc.
   *
   * @param {string} action   - Semantic action key  e.g. 'LOGIN_SUCCESS'
   * @param {Object} [context] - Structured metadata  e.g. { uid, phone }
   */
  info(action, context = {}) {
    const entry = _buildEntry(
      LEVELS.INFO,
      this._module,
      action,
      _actionToMessage(action),
      null,
      context
    );
    _record(entry);
    _emit(entry);
  }

  /**
   * Log a warning — non-fatal but noteworthy.
   * Use for: OTP expiry, retry attempts, validation failures.
   *
   * @param {string} action
   * @param {Object} [context]
   */
  warn(action, context = {}) {
    const entry = _buildEntry(
      LEVELS.WARN,
      this._module,
      action,
      _actionToMessage(action),
      null,
      context
    );
    _record(entry);
    _emit(entry);
  }

  /**
   * Log an error — includes the Error object for stack capture.
   * Use for: auth failures, upload errors, Firestore write failures.
   *
   * @param {string} action
   * @param {Error}  err
   * @param {Object} [context]
   */
  error(action, err, context = {}) {
    if (!(err instanceof Error)) {
      // Coerce non-Error throws into Error for consistent structure
      err = new Error(String(err));
    }
    const entry = _buildEntry(
      LEVELS.ERROR,
      this._module,
      action,
      err.message,
      err,
      context
    );
    _record(entry);
    _emit(entry);
  }

  /**
   * Log a debug entry — suppressed in production.
   * Use for: internal state, intermediate values during development.
   *
   * @param {string} action
   * @param {Object} [context]
   */
  debug(action, context = {}) {
    if (IS_PRODUCTION) return;
    const entry = _buildEntry(
      LEVELS.DEBUG,
      this._module,
      action,
      _actionToMessage(action),
      null,
      context
    );
    _record(entry);
    _emit(entry);
  }
}

// ── Action → readable message ─────────────────────────────────

/**
 * Converts a SCREAMING_SNAKE_CASE action key into a human sentence.
 * Keeps log messages readable without requiring callers to write prose.
 *
 * @param {string} action
 * @returns {string}
 */
function _actionToMessage(action) {
  return action
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

// ── Module-level exports ──────────────────────────────────────

/**
 * Returns a shallow copy of the full session audit log.
 * Useful for diagnostics or future remote log shipping.
 *
 * @returns {LogEntry[]}
 */
function getSessionLog() {
  return [..._sessionLog];
}

/**
 * Clears the in-memory session log.
 * Call on sign-out to remove any PII from memory.
 */
function clearSessionLog() {
  _sessionLog.length = 0;
}

/**
 * Returns all ERROR-level entries from the session log.
 * Convenience helper for error reporting screens.
 *
 * @returns {LogEntry[]}
 */
function getErrorLog() {
  return _sessionLog.filter((e) => e.level === LEVELS.ERROR);
}

export { Logger, getSessionLog, clearSessionLog, getErrorLog, LEVELS };