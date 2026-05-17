/**
 * share.module.js — Document Sharing UI Controller
 * GovDoc Vault | Government Document Portal
 *
 * RESPONSIBILITIES:
 *   - Listen for govdoc:openShare custom event from documents.module.js
 *   - Open the share modal, populate "Currently Shared With" list
 *   - Handle phone input → ShareService.shareByPhone()
 *   - Render each shared member with a Revoke button
 *   - Handle revoke → ShareService.revokeAccess()
 *   - Refresh the document grid on any mutation via the refresh callback
 *   - Log all user-facing share/revoke actions
 *
 * INVOCATION:
 *   Initialised from documents.module.js:
 *     ShareModule.init(uid, refreshFn);
 *
 * SECURITY:
 *   - ownerUid always sourced from authenticated session (never from DOM)
 *   - Phone validated and resolved server-side in ShareService
 *   - All writes gated by DbService ownership assertion + Firestore rules
 *
 * DEPENDENCIES:
 *   ShareService  — js/services/share.service.js
 *   Logger        — js/services/logger.service.js
 *   UI            — js/utils/dom.utils.js
 */

'use strict';

import { ShareService } from '../services/share.service.js';
import { Logger }       from '../services/logger.service.js';
import { UI }           from '../utils/dom.utils.js';

const log = new Logger('ShareModule');

// ── Module state ──────────────────────────────────────────────
let _uid        = null;
let _refreshFn  = null;

/** @type {Object|null} — document currently open in share modal */
let _activeDoc  = null;

// ── DOM refs ──────────────────────────────────────────────────
let DOM = {};

function _resolveDOM() {
  DOM = {
    modalShare         : document.getElementById('modal-share'),
    modalShareClose    : document.getElementById('modal-share-close'),
    shareDocName       : document.getElementById('share-doc-name'),
    sharePhone         : document.getElementById('share-phone'),
    sharePhoneError    : document.getElementById('share-phone-error'),
    btnShareSubmit     : document.getElementById('btn-share-submit'),
    btnShareCancel     : document.getElementById('btn-share-cancel'),
    sharedMembersContainer: document.getElementById('shared-members-container'),
  };
}

// ── Init ──────────────────────────────────────────────────────

/**
 * @param {string}   uid       - Authenticated user UID (owner)
 * @param {function} refreshFn - DocumentsModule.refresh callback
 */
function init(uid, refreshFn) {
  if (!uid || typeof refreshFn !== 'function') {
    log.error('SHARE_MODULE_INIT_INVALID', new Error('uid and refreshFn required'));
    return;
  }

  _uid       = uid;
  _refreshFn = refreshFn;

  _resolveDOM();
  _bindModal();
  _bindCustomEvents();

  log.debug('SHARE_MODULE_READY', { uid });
}

// ── Custom event listener ─────────────────────────────────────

function _bindCustomEvents() {
  document.addEventListener('govdoc:openShare', async (e) => {
    const doc = e.detail?.doc;
    if (!doc) return;
    await _openShareModal(doc);
  });
}

// ── Modal lifecycle ───────────────────────────────────────────

/**
 * Opens the share modal for a document.
 * Fetches current shared members from Firestore on every open
 * to ensure the list is never stale.
 *
 * @param {Object} docData
 */
async function _openShareModal(docData) {
  _activeDoc = docData;

  // Populate doc name in modal header
  if (DOM.shareDocName) {
    DOM.shareDocName.textContent = docData.title;
  }

  // Clear prior state
  _clearShareError();
  if (DOM.sharePhone) DOM.sharePhone.value = '';

  // Render members from the embedded sharedWith[] first (instant)
  _renderMemberList(docData.sharedWith ?? []);

  UI.show(DOM.modalShare);
  DOM.sharePhone?.focus();

  log.debug('SHARE_MODAL_OPEN', { docId: docData.id });

  // Then refresh from Firestore for accuracy (covers edge cases where
  // sharedWith[] in the cached card is slightly stale)
  await _refreshMemberList(docData.id);
}

function _closeShareModal() {
  UI.hide(DOM.modalShare);
  _clearShareError();
  _setShareLoading(false);
  _activeDoc = null;
  log.debug('SHARE_MODAL_CLOSE', {});
}

function _bindModal() {
  DOM.btnShareSubmit?.addEventListener('click', async () => {
    await _handleShare();
  });

  DOM.btnShareCancel?.addEventListener('click',  _closeShareModal);
  DOM.modalShareClose?.addEventListener('click', _closeShareModal);

  // Close on overlay click
  DOM.modalShare?.addEventListener('click', (e) => {
    if (e.target === DOM.modalShare) _closeShareModal();
  });

  // Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !DOM.modalShare?.hidden) _closeShareModal();
  });

  // Allow Enter key on phone input to trigger share
  DOM.sharePhone?.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      await _handleShare();
    }
  });
}

// ── Share handler ─────────────────────────────────────────────

async function _handleShare() {
  if (!_activeDoc) return;

  const rawPhone = DOM.sharePhone?.value?.trim() ?? '';

  _clearShareError();

  if (!rawPhone) {
    _showShareError('Please enter a mobile number.');
    return;
  }

  _setShareLoading(true);

  log.info('SHARE_SUBMIT', { docId: _activeDoc.id, uid: _uid });

  const result = await ShareService.shareByPhone(_activeDoc.id, _uid, rawPhone);

  _setShareLoading(false);

  if (!result.success) {
    _showShareError(result.message);
    log.warn('SHARE_UI_FAILED', { docId: _activeDoc.id, message: result.message });
    return;
  }

  log.info('SHARE_UI_SUCCESS', {
    docId     : _activeDoc.id,
    targetUid : result.data.targetUid,
  });

  // Clear phone input after success
  if (DOM.sharePhone) DOM.sharePhone.value = '';

  UI.toast(result.message, 'success');

  // Refresh the member list in the modal
  await _refreshMemberList(_activeDoc.id);

  // Update sharedWith on the cached activeDoc so the UI stays coherent
  _activeDoc = {
    ..._activeDoc,
    sharedWith: [
      ...(_activeDoc.sharedWith ?? []),
      {
        uid        : result.data.targetUid,
        phone      : result.data.targetPhone,
        accessLevel: 'view',
        sharedAt   : new Date().toISOString(),
      },
    ],
  };

  // Refresh the document grid in the background (updates share indicator)
  _refreshFn().catch(() => {});
}

// ── Revoke handler ────────────────────────────────────────────

/**
 * @param {string} targetUid
 * @param {string} targetPhone
 */
async function _handleRevoke(targetUid, targetPhone) {
  if (!_activeDoc) return;

  const docId = _activeDoc.id;

  log.info('REVOKE_SUBMIT', { docId, ownerUid: _uid, targetUid });

  // Optimistic UI: disable the revoke button immediately
  const btn = DOM.sharedMembersContainer?.querySelector(
    `[data-revoke-uid="${CSS.escape(targetUid)}"]`
  );
  if (btn) { btn.disabled = true; btn.textContent = 'Revoking…'; }

  const result = await ShareService.revokeAccess(docId, _uid, targetUid);

  if (!result.success) {
    // Restore button on failure
    if (btn) { btn.disabled = false; btn.textContent = 'Revoke'; }

    UI.toast(result.message, 'error');
    log.warn('REVOKE_UI_FAILED', { docId, targetUid, message: result.message });
    return;
  }

  log.info('REVOKE_UI_SUCCESS', { docId, targetUid });

  UI.toast(
    `Access revoked for ${_maskPhone(targetPhone)}.`,
    'success'
  );

  // Remove member from cached activeDoc
  _activeDoc = {
    ..._activeDoc,
    sharedWith: (_activeDoc.sharedWith ?? []).filter((m) => m.uid !== targetUid),
  };

  // Re-render member list from updated cache
  _renderMemberList(_activeDoc.sharedWith);

  // Refresh grid in background
  _refreshFn().catch(() => {});
}

// ── Member list rendering ─────────────────────────────────────

/**
 * Fetches fresh sharedWith[] from Firestore and re-renders the list.
 * @param {string} docId
 */
async function _refreshMemberList(docId) {
  const result = await ShareService.getSharedMembers(docId, _uid);

  if (!result.success) {
    log.warn('MEMBER_LIST_REFRESH_FAILED', { docId, message: result.message });
    return;
  }

  _renderMemberList(result.data);
}

/**
 * Renders the "Currently Shared With" member rows.
 * Each row has a masked phone, access badge, and Revoke button.
 *
 * @param {Object[]} members - sharedWith[] array entries
 */
function _renderMemberList(members) {
  if (!DOM.sharedMembersContainer) return;

  if (!members || members.length === 0) {
    DOM.sharedMembersContainer.innerHTML =
      '<p class="text-muted text-sm">Not shared with anyone yet.</p>';
    return;
  }

  const fragment = document.createDocumentFragment();

  members.forEach((member) => {
    const row = _buildMemberRow(member);
    fragment.appendChild(row);
  });

  DOM.sharedMembersContainer.innerHTML = '';
  DOM.sharedMembersContainer.appendChild(fragment);

  log.debug('MEMBER_LIST_RENDERED', { count: members.length });
}

/**
 * Builds a single member row element.
 * @param {{ uid: string, phone: string, accessLevel: string, sharedAt: string }} member
 * @returns {HTMLElement}
 */
function _buildMemberRow(member) {
  const row = document.createElement('div');
  row.className = 'shared-member-row';

  const maskedPhone = _maskPhone(member.phone);
  const sharedDate  = _formatDate(member.sharedAt);
  const level       = member.accessLevel ?? 'view';

  row.innerHTML = `
    <div class="shared-member-info">
      <span class="shared-member-phone">${_escapeHtml(maskedPhone)}</span>
      <span class="shared-member-meta">
        <span class="access-badge access-badge--${_escapeHtml(level)}">${_escapeHtml(level)}</span>
        <span class="shared-member-date">Since ${_escapeHtml(sharedDate)}</span>
      </span>
    </div>
    <button
      class="btn btn--danger-ghost btn--sm btn--revoke"
      type="button"
      data-revoke-uid="${_escapeHtml(member.uid)}"
      aria-label="Revoke access for ${_escapeHtml(maskedPhone)}"
    >Revoke</button>
  `;

  // Bind revoke button
  const revokeBtn = row.querySelector('.btn--revoke');
  revokeBtn?.addEventListener('click', () => {
    _handleRevoke(member.uid, member.phone);
  });

  return row;
}

// ── UI state helpers ──────────────────────────────────────────

function _setShareLoading(isLoading) {
  if (!DOM.btnShareSubmit) return;
  const textEl   = DOM.btnShareSubmit.querySelector('.btn__text');
  const loaderEl = DOM.btnShareSubmit.querySelector('.btn__loader');
  DOM.btnShareSubmit.disabled = isLoading;
  if (textEl)   textEl.style.visibility = isLoading ? 'hidden' : '';
  if (loaderEl) loaderEl.hidden         = !isLoading;
}

function _showShareError(message) {
  if (!DOM.sharePhoneError) return;
  DOM.sharePhoneError.textContent = message;
  DOM.sharePhoneError.hidden      = false;
  DOM.sharePhone?.classList.add('form-input--error');
  DOM.sharePhone?.setAttribute('aria-invalid', 'true');
}

function _clearShareError() {
  if (DOM.sharePhoneError) {
    DOM.sharePhoneError.textContent = '';
    DOM.sharePhoneError.hidden      = true;
  }
  DOM.sharePhone?.classList.remove('form-input--error');
  DOM.sharePhone?.removeAttribute('aria-invalid');
}

// ── Formatters ────────────────────────────────────────────────

function _maskPhone(phone) {
  if (!phone || phone.length < 4) return '[unknown]';
  return phone.slice(0, -4).replace(/\d/g, 'X') + phone.slice(-4);
}

function _formatDate(isoString) {
  if (!isoString) return '—';
  try {
    return new Intl.DateTimeFormat('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
    }).format(new Date(isoString));
  } catch {
    return isoString;
  }
}

function _escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#x27;');
}

// ── Public API ────────────────────────────────────────────────
const ShareModule = Object.freeze({ init });

export { ShareModule };