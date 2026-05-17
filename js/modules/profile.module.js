/**
 * profile.module.js — User Profile Controller
 * GovDoc Vault | Government Document Portal
 */
'use strict';

import { requireAuth }  from '../utils/session.utils.js';
import { DbService }    from '../services/db.service.js';
import { Logger }       from '../services/logger.service.js';
import { UI }           from '../utils/dom.utils.js';

const log = new Logger('ProfileModule');

let _currentUser     = null;
let _originalProfile = null;

// ── Boot ──────────────────────────────────────────────────────
function init() {
  requireAuth(async (user) => {
    _currentUser = user;
    log.info('PROFILE_PAGE_BOOT', { uid: user.uid });
    await _loadProfile(user);
    _bindForm();
    _bindSignout();
  });
}

// ── Load ──────────────────────────────────────────────────────
async function _loadProfile(user) {
  // Show spinner, hide content
  _el('profile-loading').hidden = false;
  _el('profile-content').hidden = true;

  const [profileResult, docsResult] = await Promise.all([
    DbService.getUser(user.uid),
    DbService.getUserDocuments(user.uid),
  ]);

  if (!profileResult.success) {
    log.warn('PROFILE_NOT_FOUND_AUTO_CREATING', { uid: user.uid });
    await DbService.upsertUser(user.uid, {
      name : '',
      phone: user.phoneNumber ?? '',
      dob  : '',
    });
    _originalProfile = {
      name     : '',
      phone    : user.phoneNumber ?? '',
      dob      : '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  } else {
    log.info('PROFILE_LOADED', { uid: user.uid });
    _originalProfile = profileResult.data;
  }

  // Hide spinner, show content — always reaches here
  _el('profile-loading').hidden = true;
  _el('profile-content').hidden = false;

  _renderProfile(_originalProfile, user);

  // Stats
  if (docsResult.success) {
    const docs   = docsResult.data;
    const shared = docs.filter(d => d.sharedWith?.length > 0).length;
    _setText('ph-stat-docs',   docs.length);
    _setText('ph-stat-shared', shared);
    _setText('ph-stat-since',  _fmtShort(_originalProfile.createdAt));
    log.debug('PROFILE_STATS_RENDERED', { docs: docs.length, shared });
  }
}

// ── Render ────────────────────────────────────────────────────
function _renderProfile(profile, user) {
  const phone = (profile.phone ?? '').replace(/^\+91/, '');
  const name  = profile.name ?? '';

  _setText('profile-avatar',      _initials(name || phone));
  _setText('profile-display-name', name || _fmtPhone(profile.phone ?? ''));
  _setText('profile-uid',         `UID: ${user?.uid ?? '—'}`);
  _setText('sidebar-user-name',   name || _fmtPhone(profile.phone ?? ''));
  _setText('sidebar-user-phone',  _fmtPhone(profile.phone ?? ''));
  _setText('user-avatar-initials', _initials(name || phone));

  const nameInput    = _el('profile-name');
  const dobInput     = _el('profile-dob');
  const phoneInput   = _el('profile-phone');
  const createdInput = _el('profile-created');
  const updatedInput = _el('profile-updated');

  if (nameInput)    nameInput.value    = name;
  if (dobInput)     dobInput.value     = profile.dob ?? '';
  if (phoneInput)   phoneInput.value   = phone;
  if (createdInput) createdInput.value = _fmtLong(profile.createdAt);
  if (updatedInput) updatedInput.value = _fmtLong(profile.updatedAt);
}

// ── Form ──────────────────────────────────────────────────────
function _bindForm() {
  _el('btn-profile-reset')?.addEventListener('click', _handleReset);
  _el('form-profile')?.addEventListener('submit', (e) => {
    e.preventDefault();
    _handleSave();
  });
  _el('btn-profile-save')?.addEventListener('click', (e) => {
    e.preventDefault();
    _handleSave();
  });
  _el('profile-name')?.addEventListener('input', _clearNameError);
}

async function _handleSave() {
  _clearNameError();
  const name = (_el('profile-name')?.value ?? '').trim();
  const dob  = (_el('profile-dob')?.value  ?? '').trim();

  if (!name || name.length < 2) {
    _showNameError(name ? 'Name must be at least 2 characters.' : 'Full name is required.');
    return;
  }
  if (name.length > 80) { _showNameError('Name must not exceed 80 characters.'); return; }
  if (/[<>"'`]/.test(name)) { _showNameError('Name contains invalid characters.'); return; }
  if (dob && new Date(dob) > new Date()) { UI.toast('Date of birth cannot be in the future.', 'warning'); return; }
  if (name === _originalProfile?.name && dob === (_originalProfile?.dob ?? '')) {
    UI.toast('No changes to save.', 'info'); return;
  }

  _setSaveLoading(true);
  log.info('PROFILE_SAVE_START', { uid: _currentUser.uid });

  const result = await DbService.upsertUser(_currentUser.uid, {
    name,
    phone: _currentUser.phoneNumber ?? '',
    dob,
  });

  _setSaveLoading(false);

  if (!result.success) {
    UI.toast(result.message, 'error');
    log.error('PROFILE_SAVE_FAILED', new Error(result.message), { uid: _currentUser.uid });
    return;
  }

  _originalProfile = { ..._originalProfile, name, dob, updatedAt: new Date().toISOString() };

  _setText('profile-display-name', name);
  _setText('profile-avatar',       _initials(name));
  _setText('sidebar-user-name',    name);
  _setText('user-avatar-initials', _initials(name));
  const updatedInput = _el('profile-updated');
  if (updatedInput) updatedInput.value = _fmtLong(new Date().toISOString());

  log.info('PROFILE_SAVE_SUCCESS', { uid: _currentUser.uid });
  UI.toast('Profile updated successfully.', 'success');
}

function _handleReset() {
  if (!_originalProfile) return;
  const n = _el('profile-name'); if (n) n.value = _originalProfile.name ?? '';
  const d = _el('profile-dob');  if (d) d.value = _originalProfile.dob  ?? '';
  _clearNameError();
  UI.toast('Changes discarded.', 'info');
}

// ── Signout ───────────────────────────────────────────────────
function _bindSignout() {
  const handler = async () => {
    const { AuthService } = await import('../services/auth.service.js');
    UI.showLoader('Signing out…');
    await AuthService.logout();
    UI.hideLoader();
    window.location.replace('/index.html');
  };
  _el('btn-signout')?.addEventListener('click', handler);
  _el('btn-profile-signout')?.addEventListener('click', handler);
}

// ── Helpers ───────────────────────────────────────────────────
function _el(id)          { return document.getElementById(id); }
function _setText(id, val){ const e = _el(id); if (e) e.textContent = String(val ?? ''); }

function _setSaveLoading(on) {
  const btn = _el('btn-profile-save'); if (!btn) return;
  btn.disabled = on;
  const t = btn.querySelector('.btn__text');
  const l = btn.querySelector('.btn__loader');
  if (t) t.style.visibility = on ? 'hidden' : '';
  if (l) l.hidden = !on;
  const rst = _el('btn-profile-reset'); if (rst) rst.disabled = on;
}

function _showNameError(msg) {
  const e = _el('profile-name-error'); if (!e) return;
  e.textContent = msg; e.hidden = false;
  _el('profile-name')?.classList.add('form-input--error');
}
function _clearNameError() {
  const e = _el('profile-name-error'); if (!e) return;
  e.textContent = ''; e.hidden = true;
  _el('profile-name')?.classList.remove('form-input--error');
}

function _initials(str) {
  if (!str) return '?';
  const p = str.trim().split(/\s+/);
  return p.length === 1 ? p[0][0].toUpperCase() : (p[0][0] + p[p.length-1][0]).toUpperCase();
}
function _fmtPhone(e164) {
  if (!e164) return '';
  const d = e164.replace('+91','');
  return `+91 ${d.slice(0,5)} ${d.slice(5)}`;
}
function _fmtLong(iso) {
  if (!iso) return '—';
  try { return new Intl.DateTimeFormat('en-IN',{day:'2-digit',month:'short',year:'numeric'}).format(new Date(iso)); }
  catch { return iso; }
}
function _fmtShort(iso) {
  if (!iso) return '—';
  try { return new Intl.DateTimeFormat('en-IN',{month:'short',year:'numeric'}).format(new Date(iso)); }
  catch { return iso; }
}

document.addEventListener('DOMContentLoaded', init);