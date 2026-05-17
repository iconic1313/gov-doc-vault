/**
 * doc-management.module.js — Document Edit & Delete Controller
 * GovDoc Vault | Government Document Portal
 */
'use strict';

import { DbService }      from '../services/db.service.js';
import { StorageService } from '../services/storage.service.js';
import { FormValidator }  from '../validators/form.validator.js';
import { Logger }         from '../services/logger.service.js';
import { UI }             from '../utils/dom.utils.js';

const log = new Logger('DocManagementModule');

let _uid         = null;
let _refreshFn   = null;
let _initialised = false;
let _activeDoc   = null;

// ── Init ──────────────────────────────────────────────────────
function init(uid, refreshFn) {
  _uid       = uid;
  _refreshFn = refreshFn;

  if (_initialised) return;
  _initialised = true;

  // Ensure both modals are hidden before binding anything
  const delModal = document.getElementById('modal-delete');
  const editModal = document.getElementById('modal-edit');
  if (delModal)  delModal.hidden  = true;
  if (editModal) editModal.hidden = true;

  _injectEditModal();
  _bindEditListeners();
  _bindDeleteListeners();
  _bindCustomEvents();

  log.debug('DOC_MGMT_READY', { uid });
}

// ── Inject edit modal ─────────────────────────────────────────
function _injectEditModal() {
  if (document.getElementById('modal-edit')) return;

  const div = document.createElement('div');
  div.id        = 'modal-edit';
  div.className = 'modal-overlay';
  div.setAttribute('role', 'dialog');
  div.setAttribute('aria-modal', 'true');
  div.hidden    = true;

  div.innerHTML = `
    <div class="modal" tabindex="-1">
      <div class="modal__header">
        <h2 class="modal__title" id="modal-edit-title">Edit Document</h2>
        <button class="modal__close" id="modal-edit-close" type="button">&#10005;</button>
      </div>
      <div class="modal__body">
        <form class="auth-form" id="form-edit" novalidate>
          <div class="form-group">
            <label class="form-label" for="edit-doc-title">
              Document Name <span class="required-mark">*</span>
            </label>
            <input class="form-input" type="text" id="edit-doc-title" maxlength="60" />
            <span class="form-error" id="edit-title-error" role="alert" hidden></span>
          </div>
          <div class="form-group">
            <label class="form-label" for="edit-doc-type">
              Document Type <span class="required-mark">*</span>
            </label>
            <select class="form-select" id="edit-doc-type">
              <option value="">Select type</option>
              <option value="aadhaar">Aadhaar Card</option>
              <option value="pan">PAN Card</option>
              <option value="passport">Passport</option>
              <option value="driving">Driving Licence</option>
              <option value="voter">Voter ID</option>
              <option value="other">Other</option>
            </select>
            <span class="form-error" id="edit-type-error" role="alert" hidden></span>
          </div>
          <div class="modal__actions">
            <button class="btn btn--ghost" type="button" id="btn-edit-cancel">Cancel</button>
            <button class="btn btn--primary" type="submit" id="btn-edit-submit">
              <span class="btn__text">Save Changes</span>
              <span class="btn__loader" hidden><span class="spinner"></span></span>
            </button>
          </div>
        </form>
      </div>
    </div>`;

  document.body.appendChild(div);
  log.debug('EDIT_MODAL_INJECTED');
}

// ── Edit listeners ────────────────────────────────────────────
function _bindEditListeners() {
  // Use document-level delegation so injected elements are always found
  document.addEventListener('click', (e) => {
    const id = e.target.closest('[id]')?.id || e.target.id;

    if (id === 'btn-edit-cancel' || id === 'modal-edit-close') {
      _closeEdit();
      return;
    }
    if (id === 'modal-edit' && !e.target.closest('.modal')) {
      _closeEdit();
      return;
    }
  });

  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'form-edit') {
      e.preventDefault();
      await _handleUpdate();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const m = document.getElementById('modal-edit');
      if (m && !m.hidden) _closeEdit();
    }
  });
}

// ── Delete listeners ──────────────────────────────────────────
function _bindDeleteListeners() {
  document.addEventListener('click', (e) => {
    const id = e.target.closest('[id]')?.id || e.target.id;

    if (id === 'btn-delete-confirm') {
      if (_activeDoc) _handleDelete();
      return;
    }
    if (id === 'btn-delete-cancel' || id === 'modal-delete-close') {
      _closeDelete();
      return;
    }
    if (id === 'modal-delete' && !e.target.closest('.modal')) {
      _closeDelete();
      return;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const m = document.getElementById('modal-delete');
      if (m && !m.hidden) _closeDelete();
    }
  });
}

// ── Custom events ─────────────────────────────────────────────
function _bindCustomEvents() {
  document.addEventListener('govdoc:openEdit', (e) => {
    const doc = e.detail?.doc;
    if (!doc || !doc.id) {
      log.warn('EDIT_INVALID_DOC', {});
      return;
    }
    _openEdit(doc);
  });

  document.addEventListener('govdoc:openDelete', (e) => {
    const doc = e.detail?.doc;
    if (!doc || !doc.id) {
      log.warn('DELETE_INVALID_DOC', {});
      return;
    }
    _openDelete(doc);
  });
}

// ── Edit open / close ─────────────────────────────────────────
function _openEdit(docData) {
  _activeDoc = docData;

  const titleInput = document.getElementById('edit-doc-title');
  const typeSelect = document.getElementById('edit-doc-type');

  if (titleInput) titleInput.value = docData.title ?? '';
  if (typeSelect) typeSelect.value = docData.type  ?? '';

  _clearEditErrors();

  const modal = document.getElementById('modal-edit');
  if (modal) modal.hidden = false;

  if (titleInput) titleInput.focus();

  log.debug('EDIT_OPEN', { docId: docData.id, title: docData.title });
}

function _closeEdit() {
  const modal = document.getElementById('modal-edit');
  if (modal) modal.hidden = true;
  _clearEditErrors();
  _setLoading('btn-edit-submit', false);
  _activeDoc = null;
  log.debug('EDIT_CLOSE');
}

// ── Update handler ────────────────────────────────────────────
async function _handleUpdate() {
  if (!_activeDoc || !_activeDoc.id) {
    log.error('UPDATE_NO_ACTIVE_DOC', new Error('_activeDoc is null'), {});
    return;
  }

  const title = document.getElementById('edit-doc-title')?.value ?? '';
  const type  = document.getElementById('edit-doc-type')?.value  ?? '';

  _clearEditErrors();

  const validation = FormValidator.validateUploadForm({ title, type });

  if (!validation.valid) {
    if (validation.errors.title)
      _showErr('edit-title-error', validation.errors.title);
    if (validation.errors.type)
      _showErr('edit-type-error', validation.errors.type);
    log.warn('DOC_UPDATE_VALIDATION_FAILED', { docId: _activeDoc.id });
    return;
  }

  const { title: cleanTitle, type: cleanType } = validation.data;

  if (cleanTitle === _activeDoc.title && cleanType === _activeDoc.type) {
    _closeEdit();
    return;
  }

  _setLoading('btn-edit-submit', true);
  log.info('DOC_UPDATE_START', { docId: _activeDoc.id, uid: _uid });

  const result = await DbService.updateDocument(
    _activeDoc.id, _uid, { title: cleanTitle, type: cleanType }
  );

  _setLoading('btn-edit-submit', false);

  if (!result.success) {
    _showErr('edit-title-error', result.message);
    log.error('DOC_UPDATE_FAILED', new Error(result.message), { docId: _activeDoc.id });
    return;
  }

  log.info('DOC_UPDATE_SUCCESS', { docId: _activeDoc.id });
  UI.toast(`"${cleanTitle}" updated successfully.`, 'success');
  _closeEdit();
  await _refreshFn();
}

// ── Delete open / close ───────────────────────────────────────
function _openDelete(docData) {
  _activeDoc = docData;
  const nameEl = document.getElementById('delete-doc-name');
  if (nameEl) nameEl.textContent = docData.title;
  const modal = document.getElementById('modal-delete');
  if (modal) modal.hidden = false;
  log.debug('DELETE_OPEN', { docId: docData.id });
}

function _closeDelete() {
  const modal = document.getElementById('modal-delete');
  if (modal) modal.hidden = true;
  _setLoading('btn-delete-confirm', false);
  _activeDoc = null;
  log.debug('DELETE_CLOSE');
}

// ── Delete handler ────────────────────────────────────────────
async function _handleDelete() {
  if (!_activeDoc || !_activeDoc.id) {
    log.error('DELETE_NO_ACTIVE_DOC', new Error('_activeDoc is null'), {});
    return;
  }

  const { id: docId, title, fileRef } = _activeDoc;

  _setLoading('btn-delete-confirm', true);
  log.info('DOC_DELETE_START', { docId, uid: _uid });

  const storageResult = await StorageService.deleteFile(fileRef);
  if (!storageResult.success) {
    _setLoading('btn-delete-confirm', false);
    UI.toast(storageResult.message, 'error');
    log.error('DOC_DELETE_STORAGE_FAILED', new Error(storageResult.message), { docId });
    return;
  }

  const dbResult = await DbService.deleteDocument(docId, _uid);
  _setLoading('btn-delete-confirm', false);

  if (!dbResult.success) {
    UI.toast('Record could not be deleted. Please try again.', 'error');
    log.error('DOC_DELETE_DB_FAILED', new Error(dbResult.message), { docId });
    _closeDelete();
    return;
  }

  log.info('DOC_DELETE_SUCCESS', { docId, uid: _uid });
  UI.toast(`"${title}" permanently deleted.`, 'success');
  _closeDelete();
  await _refreshFn();
}

// ── Helpers ───────────────────────────────────────────────────
function _setLoading(btnId, on) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = on;
  const t = btn.querySelector('.btn__text');
  const l = btn.querySelector('.btn__loader');
  if (t) t.style.visibility = on ? 'hidden' : '';
  if (l) l.hidden = !on;
}

function _showErr(id, msg) {
  const e = document.getElementById(id);
  if (e) { e.textContent = msg; e.hidden = false; }
}

function _clearEditErrors() {
  ['edit-title-error', 'edit-type-error'].forEach(id => {
    const e = document.getElementById(id);
    if (e) { e.textContent = ''; e.hidden = true; }
  });
}

const DocManagementModule = Object.freeze({ init });
export { DocManagementModule };
