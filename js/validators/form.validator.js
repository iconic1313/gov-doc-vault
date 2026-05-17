/**
 * form.validator.js — Upload Form Field Validator
 * GovDoc Vault | Government Document Portal
 *
 * RESPONSIBILITIES:
 *   - Validate and sanitise document title and type fields
 *   - Return field-level error map for granular UI error binding
 *   - Provide a single validateUploadForm() entry point
 *
 * USAGE:
 *   import { FormValidator } from '../validators/form.validator.js';
 *
 *   const result = FormValidator.validateUploadForm({ title, type });
 *   if (!result.valid) {
 *     // result.errors = { title: 'Required.', type: 'Select a type.' }
 *   }
 */

'use strict';

const ALLOWED_DOC_TYPES = Object.freeze([
  'aadhaar', 'pan', 'passport', 'driving', 'voter', 'other',
]);

const TITLE_MAX_LENGTH = 60;
const TITLE_MIN_LENGTH = 2;

// Blocks script injection and control characters
const SAFE_TEXT_REGEX = /[<>"'`]/g;

/**
 * @typedef {{ valid: true,  data: { title: string, type: string }, errors: {} }}  ValidForm
 * @typedef {{ valid: false, data: null, errors: Record<string,string> }}           InvalidForm
 * @typedef {ValidForm|InvalidForm} FormResult
 */

/**
 * validateUploadForm
 * ------------------
 * Validates and sanitises the document upload form fields.
 *
 * @param {{ title: string, type: string }} fields
 * @returns {FormResult}
 */
function validateUploadForm({ title = '', type = '' } = {}) {
  const errors = {};

  // ── Title ──────────────────────────────────────────────────
  const cleanTitle = String(title).trim().replace(SAFE_TEXT_REGEX, '');

  if (!cleanTitle) {
    errors.title = 'Document name is required.';
  } else if (cleanTitle.length < TITLE_MIN_LENGTH) {
    errors.title = `Document name must be at least ${TITLE_MIN_LENGTH} characters.`;
  } else if (cleanTitle.length > TITLE_MAX_LENGTH) {
    errors.title = `Document name must not exceed ${TITLE_MAX_LENGTH} characters.`;
  }

  // ── Type ───────────────────────────────────────────────────
  const cleanType = String(type).trim().toLowerCase();

  if (!cleanType) {
    errors.type = 'Please select a document type.';
  } else if (!ALLOWED_DOC_TYPES.includes(cleanType)) {
    errors.type = 'Invalid document type selected.';
  }

  if (Object.keys(errors).length > 0) {
    return { valid: false, data: null, errors };
  }

  return {
    valid : true,
    data  : { title: cleanTitle, type: cleanType },
    errors: {},
  };
}

const FormValidator = Object.freeze({ validateUploadForm });

export { FormValidator };