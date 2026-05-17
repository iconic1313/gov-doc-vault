/**
 * family.module.js — Family Access Page Controller
 * GovDoc Vault | Government Document Portal
 *
 * Shows:
 *   1. Documents the current user has shared with others (with revoke)
 *   2. Documents shared with the current user by others (read-only view)
 */
'use strict';

import { requireAuth }  from '../utils/session.utils.js';
import { DbService }    from '../services/db.service.js';
import { ShareService } from '../services/share.service.js';
import { Logger }       from '../services/logger.service.js';
import { UI }           from '../utils/dom.utils.js';

const log = new Logger('FamilyModule');

let _uid       = null;
let _revokeTarget = null; // { docId, docTitle, memberUid, memberPhone }

// ── Boot ──────────────────────────────────────────────────────
function init() {
  requireAuth(async (user) => {
    _uid = user.uid;
    log.info('FAMILY_PAGE_BOOT', { uid: user.uid });

    _bootstrapSidebar(user);
    _bindRevokeModal();
    _bindSignout();

    await _loadAll();
  });
}

// ── Sidebar ───────────────────────────────────────────────────
async function _bootstrapSidebar(user) {
  const profileResult = await DbService.getUser(user.uid);
  const name  = profileResult.success && profileResult.data.name
    ? profileResult.data.name
    : user.phoneNumber ?? '';
  const phone = user.phoneNumber ?? '';

  _setText('sidebar-user-name',   name || _fmtPhone(phone));
  _setText('sidebar-user-phone',  _fmtPhone(phone));
  _setText('user-avatar-initials', _initials(name || phone.slice(-4)));
}

// ── Load all data ─────────────────────────────────────────────
async function _loadAll() {
  _el('family-loading').style.display = 'flex';
  _el('family-content').hidden = true;

  // Fetch all user documents (to find shared ones)
  const docsResult = await DbService.getUserDocuments(_uid);

  // Fetch documents shared with me
  const sharedWithMeResult = await DbService.getSharedWithMe(_uid);

  _el('family-loading').style.display = 'none';
  _el('family-content').hidden = false;

  const myDocs = docsResult.success ? docsResult.data : [];
  const sharedWithMe = sharedWithMeResult.success ? sharedWithMeResult.data : [];

  // Documents I have shared (any doc where sharedWith has at least 1 member)
  const sharedByMe = myDocs.filter(d => d.sharedWith && d.sharedWith.length > 0);

  // Stats
  const uniqueMembers = new Set(
    sharedByMe.flatMap(d => d.sharedWith.map(m => m.uid))
  );
  const totalLinks = sharedByMe.reduce((sum, d) => sum + d.sharedWith.length, 0);

  _setText('stat-total-shared',   sharedByMe.length);
  _setText('stat-unique-members', uniqueMembers.size);
  _setText('stat-active-links',   totalLinks);

  _renderSharedByMe(sharedByMe);
  _renderSharedWithMe(sharedWithMe);

  log.info('FAMILY_DATA_LOADED', {
    sharedByMe: sharedByMe.length,
    sharedWithMe: sharedWithMe.length,
  });
}

// ── Render: documents I shared ────────────────────────────────
function _renderSharedByMe(docs) {
  const container = _el('shared-by-me-list');
  const emptyEl   = _el('shared-by-me-empty');

  container.innerHTML = '';

  if (docs.length === 0) {
    emptyEl.hidden = false;
    return;
  }

  emptyEl.hidden = true;

  docs.forEach(doc => {
    const card = document.createElement('div');
    card.className = 'family-doc-card';
    card.innerHTML = `
      <div class="family-doc-card__header">
        <div class="family-doc-card__info">
          <span class="doc-type-badge" data-type="${_esc(doc.type)}">${_esc(_typeLabel(doc.type))}</span>
          <h3 class="family-doc-card__title">${_esc(doc.title)}</h3>
          <p class="family-doc-card__meta">${_fmtBytes(doc.sizeBytes)} · Uploaded ${_fmtDate(doc.uploadedAt)}</p>
        </div>
        <a href="${_esc(doc.fileURL)}" target="_blank" rel="noopener noreferrer"
           class="btn btn--ghost btn--sm">View File</a>
      </div>
      <div class="family-members-list" id="members-${_esc(doc.id)}"></div>
    `;
    container.appendChild(card);
    _renderMemberRows(doc, doc.sharedWith);
  });
}

function _renderMemberRows(doc, members) {
  const container = _el(`members-${doc.id}`);
  if (!container) return;

  container.innerHTML = `
    <p class="family-members-label">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <circle cx="4" cy="4" r="2" stroke="currentColor" stroke-width="1.2"/>
        <circle cx="9" cy="4" r="2" stroke="currentColor" stroke-width="1.2"/>
        <path d="M0 10c0-2 1.8-3.5 4-3.5s4 1.5 4 3.5" stroke="currentColor" stroke-width="1.2" fill="none"/>
      </svg>
      Shared with ${members.length} member${members.length !== 1 ? 's' : ''}
    </p>
  `;

  members.forEach(member => {
    const row = document.createElement('div');
    row.className = 'family-member-row';
    row.innerHTML = `
      <div class="family-member-row__info">
        <span class="family-member-avatar">${_initials(_maskPhone(member.phone))}</span>
        <div>
          <p class="family-member-phone">${_maskPhone(member.phone)}</p>
          <p class="family-member-since">Access since ${_fmtDate(member.sharedAt)}</p>
        </div>
      </div>
      <div class="family-member-row__actions">
        <span class="access-badge access-badge--view">${member.accessLevel ?? 'view'}</span>
        <button class="btn btn--danger-ghost btn--sm btn-revoke-member"
                data-doc-id="${_esc(doc.id)}"
                data-doc-title="${_esc(doc.title)}"
                data-member-uid="${_esc(member.uid)}"
                data-member-phone="${_esc(member.phone)}"
                type="button">Revoke</button>
      </div>
    `;
    container.appendChild(row);
  });

  // Bind revoke buttons
  container.querySelectorAll('.btn-revoke-member').forEach(btn => {
    btn.addEventListener('click', () => {
      _openRevokeModal({
        docId       : btn.dataset.docId,
        docTitle    : btn.dataset.docTitle,
        memberUid   : btn.dataset.memberUid,
        memberPhone : btn.dataset.memberPhone,
      });
    });
  });
}

// ── Render: documents shared with me ─────────────────────────
function _renderSharedWithMe(docs) {
  const container = _el('shared-with-me-list');
  const emptyEl   = _el('shared-with-me-empty');

  container.innerHTML = '';

  if (docs.length === 0) {
    emptyEl.hidden = false;
    return;
  }

  emptyEl.hidden = true;

  docs.forEach(doc => {
    const card = document.createElement('div');
    card.className = 'family-doc-card family-doc-card--received';
    card.innerHTML = `
      <div class="family-doc-card__header">
        <div class="family-doc-card__info">
          <span class="doc-type-badge" data-type="${_esc(doc.type)}">${_esc(_typeLabel(doc.type))}</span>
          <h3 class="family-doc-card__title">${_esc(doc.title)}</h3>
          <p class="family-doc-card__meta">${_fmtBytes(doc.sizeBytes)} · Shared ${_fmtDate(doc.uploadedAt)}</p>
        </div>
        <a href="${_esc(doc.fileURL)}" target="_blank" rel="noopener noreferrer"
           class="btn btn--primary btn--sm">View Document</a>
      </div>
    `;
    container.appendChild(card);
  });
}

// ── Revoke modal ──────────────────────────────────────────────
function _bindRevokeModal() {
  document.addEventListener('click', e => {
    const id = e.target.id;
    if (id === 'btn-revoke-confirm') { _handleRevoke(); return; }
    if (id === 'btn-revoke-cancel' || id === 'modal-revoke-close') { _closeRevokeModal(); return; }
    if (id === 'modal-revoke') { _closeRevokeModal(); return; }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const m = _el('modal-revoke');
      if (m && !m.hidden) _closeRevokeModal();
    }
  });
}

function _openRevokeModal({ docId, docTitle, memberUid, memberPhone }) {
  _revokeTarget = { docId, docTitle, memberUid, memberPhone };
  _setText('revoke-doc-name',     docTitle);
  _setText('revoke-member-phone', _maskPhone(memberPhone));
  _el('modal-revoke').hidden = false;
}

function _closeRevokeModal() {
  _el('modal-revoke').hidden = true;
  _setLoading('btn-revoke-confirm', false);
  _revokeTarget = null;
}

async function _handleRevoke() {
  if (!_revokeTarget) return;

  const { docId, docTitle, memberUid, memberPhone } = _revokeTarget;

  _setLoading('btn-revoke-confirm', true);
  log.info('REVOKE_START', { docId, memberUid, uid: _uid });

  const result = await ShareService.revokeAccess(docId, _uid, memberUid);

  _setLoading('btn-revoke-confirm', false);

  if (!result.success) {
    UI.toast(result.message, 'error');
    log.error('REVOKE_FAILED', new Error(result.message), { docId, memberUid });
    _closeRevokeModal();
    return;
  }

  log.info('REVOKE_SUCCESS', { docId, memberUid });
  UI.toast(`Access revoked for ${_maskPhone(memberPhone)}.`, 'success');
  _closeRevokeModal();
  await _loadAll();
}

// ── Signout ───────────────────────────────────────────────────
function _bindSignout() {
  _el('btn-signout')?.addEventListener('click', async () => {
    const { AuthService } = await import('../services/auth.service.js');
    UI.showLoader('Signing out…');
    await AuthService.logout();
    UI.hideLoader();
    window.location.replace('/index.html');
  });
}

// ── Helpers ───────────────────────────────────────────────────
function _el(id)           { return document.getElementById(id); }
function _setText(id, val) { const e = _el(id); if (e) e.textContent = String(val ?? ''); }
function _esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _setLoading(btnId, on) {
  const btn = _el(btnId); if (!btn) return;
  btn.disabled = on;
  const t = btn.querySelector('.btn__text');
  const l = btn.querySelector('.btn__loader');
  if (t) t.style.visibility = on ? 'hidden' : '';
  if (l) l.hidden = !on;
}

function _maskPhone(phone) {
  if (!phone || phone.length < 4) return '[unknown]';
  return phone.slice(0, -4).replace(/\d/g, 'X') + phone.slice(-4);
}

function _fmtPhone(e164) {
  if (!e164) return '';
  const d = e164.replace('+91', '');
  return `+91 ${d.slice(0,5)} ${d.slice(5)}`;
}

function _initials(str) {
  if (!str) return '?';
  const p = str.trim().split(/\s+/);
  return p.length === 1 ? p[0][0]?.toUpperCase() ?? '?' : (p[0][0] + p[p.length-1][0]).toUpperCase();
}

function _fmtDate(iso) {
  if (!iso) return '—';
  try { return new Intl.DateTimeFormat('en-IN',{day:'2-digit',month:'short',year:'numeric'}).format(new Date(iso)); }
  catch { return iso; }
}

function _fmtBytes(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024)     return `${bytes} B`;
  if (bytes < 1048576)  return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/1048576).toFixed(2)} MB`;
}

const TYPE_LABELS = { aadhaar:'Aadhaar Card', pan:'PAN Card', passport:'Passport', driving:'Driving Licence', voter:'Voter ID', other:'Other' };
function _typeLabel(type) { return TYPE_LABELS[type] ?? 'Other'; }

document.addEventListener('DOMContentLoaded', init);