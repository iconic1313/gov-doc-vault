/**
 * file.validator.js — File Upload Validator
 * GovDoc Vault | Government Document Portal
 *
 * RESPONSIBILITIES:
 *   - Validate file MIME type against an allowlist (not just extension)
 *   - Validate file size against a configurable ceiling
 *   - Sanitise file name for safe Storage path usage
 *   - Return structured validation results — never throw
 *
 * USAGE:
 *   import { FileValidator } from '../validators/file.validator.js';
 *
 *   const result = FileValidator.validate(file);
 *   if (!result.valid) { showError(result.message); return; }
 */

'use strict';

// ── Policy constants ──────────────────────────────────────────

const FILE_POLICY = Object.freeze({
  MAX_SIZE_BYTES: 5 * 1024 * 1024,          // 5 MB hard limit

  ALLOWED_MIME_TYPES: Object.freeze([
    'application/pdf',
    'image/jpeg',
    'image/jpg',
    'image/png',
  ]),

  ALLOWED_EXTENSIONS: Object.freeze([
    '.pdf', '.jpg', '.jpeg', '.png',
  ]),

  // Human-readable label for error messages
  ALLOWED_LABEL: 'PDF, JPG, PNG',

  // Regex: keeps only alphanumeric, dash, underscore, dot
  SAFE_NAME_REGEX: /[^a-zA-Z0-9.\-_]/g,

  MAX_NAME_LENGTH: 200,
});

// ── Validator ─────────────────────────────────────────────────

/**
 * @typedef {{ valid: true,  file: File, sanitisedName: string, message: string }} ValidResult
 * @typedef {{ valid: false, file: null, sanitisedName: null,   message: string }} InvalidResult
 * @typedef {ValidResult|InvalidResult} ValidationResult
 */

/**
 * validate
 * --------
 * Runs all checks against the provided File object.
 * Checks are ordered cheapest → most specific.
 *
 * @param   {File} file
 * @returns {ValidationResult}
 */
function validate(file) {
  // 1. Presence
  if (!(file instanceof File)) {
    return _fail('No file selected. Please choose a file to upload.');
  }

  // 2. Size (check before MIME — avoids reading a huge file)
  if (file.size === 0) {
    return _fail('The selected file is empty. Please choose a valid file.');
  }

  if (file.size > FILE_POLICY.MAX_SIZE_BYTES) {
    const maxMB  = (FILE_POLICY.MAX_SIZE_BYTES / 1_048_576).toFixed(0);
    const fileMB = (file.size / 1_048_576).toFixed(2);
    return _fail(
      `File size (${fileMB} MB) exceeds the maximum allowed size of ${maxMB} MB.`
    );
  }

  // 3. MIME type (primary check — browser-reported)
  if (!FILE_POLICY.ALLOWED_MIME_TYPES.includes(file.type)) {
    return _fail(
      `File type "${file.type || 'unknown'}" is not allowed. ` +
      `Accepted formats: ${FILE_POLICY.ALLOWED_LABEL}.`
    );
  }

  // 4. Extension cross-check (secondary — defence against MIME spoofing)
  const ext = _extractExtension(file.name).toLowerCase();
  if (!FILE_POLICY.ALLOWED_EXTENSIONS.includes(ext)) {
    return _fail(
      `File extension "${ext || 'unknown'}" does not match an accepted format. ` +
      `Accepted: ${FILE_POLICY.ALLOWED_LABEL}.`
    );
  }

  // 5. MIME ↔ Extension consistency (prevent e.g. image/jpeg with .pdf extension)
  if (!_mimeMatchesExtension(file.type, ext)) {
    return _fail(
      'File type and extension do not match. ' +
      'Please ensure your file is a genuine PDF, JPG, or PNG.'
    );
  }

  // 6. Name sanitisation (safe for Firebase Storage paths)
  const sanitisedName = _sanitiseName(file.name);

  return {
    valid        : true,
    file,
    sanitisedName,
    message      : 'File is valid.',
  };
}

// ── Helpers ───────────────────────────────────────────────────

/** @returns {InvalidResult} */
function _fail(message) {
  return { valid: false, file: null, sanitisedName: null, message };
}

/**
 * Extracts the lowercase extension including the dot.
 * 'document.scan.PDF' → '.pdf'
 *
 * @param {string} filename
 * @returns {string}
 */
function _extractExtension(filename) {
  if (!filename || !filename.includes('.')) return '';
  return '.' + filename.split('.').pop().toLowerCase();
}

/**
 * Verifies that the MIME type and file extension are consistent.
 *
 * @param {string} mime
 * @param {string} ext  — with leading dot, e.g. '.jpg'
 * @returns {boolean}
 */
function _mimeMatchesExtension(mime, ext) {
  const MAP = {
    'application/pdf': ['.pdf'],
    'image/jpeg'     : ['.jpg', '.jpeg'],
    'image/jpg'      : ['.jpg', '.jpeg'],
    'image/png'      : ['.png'],
  };
  return (MAP[mime] ?? []).includes(ext);
}

/**
 * Returns a filesystem-safe version of the filename.
 * Replaces unsafe characters, collapses spaces, trims length.
 *
 * @param {string} name
 * @returns {string}
 */
function _sanitiseName(name) {
  if (!name) return 'upload';

  // Separate base name and extension
  const lastDot = name.lastIndexOf('.');
  const base    = lastDot > 0 ? name.slice(0, lastDot) : name;
  const ext     = lastDot > 0 ? name.slice(lastDot).toLowerCase() : '';

  const safeBase = base
    .replace(/\s+/g, '_')                        // spaces → underscores
    .replace(FILE_POLICY.SAFE_NAME_REGEX, '')    // strip unsafe chars
    .slice(0, FILE_POLICY.MAX_NAME_LENGTH - 10)  // respect max length
    || 'upload';

  return `${safeBase}${ext}`;
}

/**
 * Returns a human-readable file size string.
 * Re-exported here for convenience so upload module has one import.
 *
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  if (bytes < 1_024)         return `${bytes} B`;
  if (bytes < 1_048_576)     return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(2)} MB`;
}

// ── Public API ────────────────────────────────────────────────
const FileValidator = Object.freeze({
  validate,
  formatBytes,
  POLICY: FILE_POLICY,
});

export { FileValidator };