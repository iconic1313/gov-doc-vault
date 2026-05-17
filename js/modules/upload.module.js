/**
 * upload.module.js — Document Upload Controller
 * GovDoc Vault | Government Document Portal
 *
 * RESPONSIBILITIES:
 *   - Own the upload modal form interaction on dashboard.html
 *   - Validate form fields (FormValidator) and file (FileValidator)
 *   - Orchestrate the two-phase commit:
 *       Phase 1: Upload file to Storage (StorageService.uploadFile)
 *       Phase 2: Write metadata to Firestore (DbService.createDocument)
 *   - Render upload progress bar in the modal
 *   - Show file preview (name + size) on file selection
 *   - Roll back the Storage file if the Firestore write fails
 *   - Trigger DocumentsModule.refresh() on success
 *   - Log every stage of the operation
 *
 * INVOCATION:
 *   Imported by documents.module.js — no separate <script> tag needed.
 *   Call UploadModule.init() after DOM is ready.
 *
 * DEPENDENCIES:
 *   StorageService  — js/services/storage.service.js
 *   DbService       — js/services/db.service.js
 *   FileValidator   — js/validators/file.validator.js
 *   FormValidator   — js/validators/form.validator.js
 *   Logger          — js/services/logger.service.js
 *   UI              — js/utils/dom.utils.js
 */

'use strict';

import { StorageService } from '../services/storage.service.js';
import { DbService }      from '../services/db.service.js';
import { FileValidator }  from '../validators/file.validator.js';
import { FormValidator }  from '../validators/form.validator.js';
import { Logger }         from '../services/logger.service.js';
import { UI }             from '../utils/dom.utils.js';

const log = new Logger('UploadModule');

// ── Module state ──────────────────────────────────────────────
/** @type {string|null} */
let _uid = null;

/** @type {File|null} */
let _selectedFile = null;

// ── DOM refs ──────────────────────────────────────────────────
let DOM = {};

function _resolveDOM() {
  DOM = {
    formUpload      : document.getElementById('form-upload'),
    inputTitle      : document.getElementById('upload-title'),
    inputType       : document.getElementById('upload-type'),
    inputFile       : document.getElementById('upload-file'),
    fileDropZone    : document.getElementById('file-drop-zone'),
    filePreview     : document.getElementById('file-preview'),
    btnSubmit       : document.getElementById('btn-upload-submit'),
    btnCancel       : document.getElementById('btn-upload-cancel'),
    modalUpload     : document.getElementById('modal-upload'),
    titleError      : document.getElementById('upload-title-error'),
    typeError       : document.getElementById('upload-type-error'),
    fileError       : document.getElementById('upload-file-error'),
  };
}

// ── Init ──────────────────────────────────────────────────────

/**
 * @param {string} uid - Authenticated user's UID
 * @param {function} onUploadSuccess - Callback after successful upload (e.g. DocumentsModule.refresh)
 */
function init(uid, onUploadSuccess) {
  if (!uid) {
    log.error('UPLOAD_INIT_NO_UID', new Error('UID required to initialise UploadModule'));
    return;
  }

  _uid = uid;
  _resolveDOM();

  _bindFileInput(onUploadSuccess);
  _bindFormSubmit(onUploadSuccess);
  _bindModalReset();

  log.debug('UPLOAD_MODULE_READY', { uid });
}

// ── File input binding ────────────────────────────────────────

function _bindFileInput() {
  // File input change (browse or drop)
  DOM.inputFile?.addEventListener('change', (e) => {
    const file = e.target.files?.[0] ?? null;
    _onFileSelected(file);
  });
}

/**
 * Validates the selected file immediately on selection.
 * Shows a file preview or an error — no submit needed for file feedback.
 *
 * @param {File|null} file
 */
function _onFileSelected(file) {
  _clearFileError();
  _clearFilePreview();
  _selectedFile = null;

  if (!file) return;

  const validation = FileValidator.validate(file);

  if (!validation.valid) {
    _showFileError(validation.message);
    DOM.inputFile.value = '';           // reset input so user can re-select
    log.warn('FILE_VALIDATION_FAILED', { message: validation.message });
    return;
  }

  _selectedFile = validation.file;
  _showFilePreview(validation.file, validation.sanitisedName);
  log.debug('FILE_SELECTED', {
    name: validation.sanitisedName,
    size: validation.file.size,
    mime: validation.file.type,
  });
}

// ── Form submit ───────────────────────────────────────────────

function _bindFormSubmit(onUploadSuccess) {
  DOM.formUpload?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await _handleUpload(onUploadSuccess);
  });
}

async function _handleUpload(onUploadSuccess) {
  _clearAllErrors();

  // 1. Validate form fields
  const formResult = FormValidator.validateUploadForm({
    title: DOM.inputTitle?.value ?? '',
    type : DOM.inputType?.value  ?? '',
  });

  if (!formResult.valid) {
    if (formResult.errors.title) _showFieldError(DOM.titleError, formResult.errors.title);
    if (formResult.errors.type)  _showFieldError(DOM.typeError,  formResult.errors.type);
    log.warn('UPLOAD_FORM_INVALID', { errors: formResult.errors });
    return;
  }

  // 2. File must be selected and valid
  if (!_selectedFile) {
    _showFileError('Please select a file to upload.');
    log.warn('UPLOAD_NO_FILE', {});
    return;
  }

  const { title, type } = formResult.data;

  _setSubmitLoading(true);
  _showProgressBar(0);

  log.info('UPLOAD_INITIATED', { uid: _uid, title, type });

  // ── Phase 1: Upload to Storage ─────────────────────────────
  //
  // We need a docId before uploading so the Storage path is
  // deterministic. We derive a temporary client-side ID here;
  // Firestore's addDoc will replace it with its own ID.
  // We use a timestamp + random suffix as the folder name.
  const tempDocId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const uploadResult = await StorageService.uploadFile(
    _uid,
    tempDocId,
    _selectedFile,
    FileValidator.validate(_selectedFile).sanitisedName,
    (percent) => _updateProgressBar(percent)
  );

  if (!uploadResult.success) {
    _setSubmitLoading(false);
    _hideProgressBar();
    _showFileError(uploadResult.message);
    log.error('UPLOAD_STORAGE_FAILED', new Error(uploadResult.message), { uid: _uid });
    return;
  }

  log.info('UPLOAD_STORAGE_SUCCESS', { uid: _uid, fileRef: uploadResult.fileRef });

  // ── Phase 2: Write metadata to Firestore ───────────────────
  const dbResult = await DbService.createDocument(_uid, {
    title    : title,
    type     : type,
    fileRef  : uploadResult.fileRef,
    fileURL  : uploadResult.fileURL,
    mimeType : uploadResult.mimeType,
    sizeBytes: _selectedFile.size,
  });

  _setSubmitLoading(false);
  _hideProgressBar();

  if (!dbResult.success) {
    // ── Rollback: delete the orphaned Storage file ───────────
    log.warn('UPLOAD_DB_FAILED_ROLLING_BACK', { fileRef: uploadResult.fileRef });
    await StorageService.deleteFile(uploadResult.fileRef);
    log.info('UPLOAD_STORAGE_ROLLBACK_DONE', { fileRef: uploadResult.fileRef });

    UI.toast(dbResult.message, 'error');
    log.error('UPLOAD_FIRESTORE_FAILED', new Error(dbResult.message), { uid: _uid });
    return;
  }

  // ── Success ────────────────────────────────────────────────
  log.info('UPLOAD_COMPLETE', {
    uid  : _uid,
    docId: dbResult.data.id,
    title,
    type,
  });

  UI.toast(`"${title}" uploaded successfully.`, 'success');
  _resetForm();
  UI.hide(DOM.modalUpload);

  if (typeof onUploadSuccess === 'function') {
    onUploadSuccess();
  }
}

// ── Modal reset ───────────────────────────────────────────────

function _bindModalReset() {
  // Reset form when modal is closed via cancel or close button
  DOM.btnCancel?.addEventListener('click', _resetForm);
}

function _resetForm() {
  DOM.formUpload?.reset();
  _selectedFile = null;
  _clearAllErrors();
  _clearFilePreview();
  _hideProgressBar();
  _setSubmitLoading(false);
  log.debug('UPLOAD_FORM_RESET', {});
}

// ── Progress bar ──────────────────────────────────────────────

let _progressEl = null;

function _showProgressBar(percent) {
  if (_progressEl) return;

  _progressEl = document.createElement('div');
  _progressEl.className = 'upload-progress';
  _progressEl.innerHTML = `
    <div class="upload-progress__track">
      <div class="upload-progress__fill" style="width:${percent}%"></div>
    </div>
    <span class="upload-progress__label">${percent}%</span>
  `;

  DOM.formUpload?.appendChild(_progressEl);
}

function _updateProgressBar(percent) {
  if (!_progressEl) return;
  const fill  = _progressEl.querySelector('.upload-progress__fill');
  const label = _progressEl.querySelector('.upload-progress__label');
  if (fill)  fill.style.width   = `${percent}%`;
  if (label) label.textContent  = `${percent}%`;
}

function _hideProgressBar() {
  _progressEl?.remove();
  _progressEl = null;
}

// ── File preview ──────────────────────────────────────────────

function _showFilePreview(file, sanitisedName) {
  if (!DOM.filePreview) return;

  DOM.filePreview.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 2h6l4 4v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z"
            stroke="currentColor" stroke-width="1.3" fill="none"/>
      <path d="M10 2v4h4" stroke="currentColor" stroke-width="1.3" fill="none"/>
    </svg>
    <span class="file-preview__name">${_escapeHtml(sanitisedName)}</span>
    <span class="file-preview__size">${FileValidator.formatBytes(file.size)}</span>
  `;
  UI.show(DOM.filePreview);
}

function _clearFilePreview() {
  if (!DOM.filePreview) return;
  DOM.filePreview.innerHTML = '';
  UI.hide(DOM.filePreview);
}

// ── UI state helpers ──────────────────────────────────────────

function _setSubmitLoading(isLoading) {
  if (!DOM.btnSubmit) return;
  const textEl   = DOM.btnSubmit.querySelector('.btn__text');
  const loaderEl = DOM.btnSubmit.querySelector('.btn__loader');
  DOM.btnSubmit.disabled = isLoading;
  if (textEl)   textEl.style.visibility = isLoading ? 'hidden' : '';
  if (loaderEl) loaderEl.hidden         = !isLoading;
}

function _showFieldError(el, message) {
  if (!el) return;
  el.textContent = message;
  el.hidden      = false;
}

function _showFileError(message) {
  _showFieldError(DOM.fileError, message);
}

function _clearFileError() {
  if (DOM.fileError) { DOM.fileError.textContent = ''; DOM.fileError.hidden = true; }
}

function _clearAllErrors() {
  [DOM.titleError, DOM.typeError, DOM.fileError].forEach((el) => {
    if (el) { el.textContent = ''; el.hidden = true; }
  });

  [DOM.inputTitle].forEach((el) => {
    el?.classList.remove('form-input--error');
    el?.removeAttribute('aria-invalid');
  });
}

function _escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Public API ────────────────────────────────────────────────
const UploadModule = Object.freeze({ init });

export { UploadModule };