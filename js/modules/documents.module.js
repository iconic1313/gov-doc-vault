/**
 * documents.module.js — Dashboard Data Layer Controller
 * GovDoc Vault | Government Document Portal
 *
 * RESPONSIBILITIES:
 *   - Guard the dashboard page with requireAuth()
 *   - Bootstrap user session data into the sidebar
 *   - Fetch and render the authenticated user's documents
 *   - Compute and render stats strip (total, shared, storage)
 *   - Drive client-side search and filter on the rendered list
 *   - Wire delete confirmation modal → DbService.deleteDocument()
 *   - Expose a refresh function for use by upload/share modules
 *
 * INVOCATION:
 *   Add to dashboard.html (after __env.js):
 *     <script type="module" src="js/modules/documents.module.js"></script>
 *
 * DEPENDENCIES:
 *   requireAuth  — js/utils/session.utils.js
 *   DbService    — js/services/db.service.js
 *   Logger       — js/services/logger.service.js
 *   UI           — js/utils/dom.utils.js
 */

'use strict';

import { requireAuth }   from '../utils/session.utils.js';
import { DbService }     from '../services/db.service.js';
import { Logger }        from '../services/logger.service.js';
import { UI }            from '../utils/dom.utils.js';
import { UploadModule }          from './upload.module.js';
import { DocManagementModule }  from './doc-management.module.js';
import { ShareModule }          from './share.module.js';

const log = new Logger('DocumentsModule');

// ── Module state ──────────────────────────────────────────────
/** @type {import('../services/auth.service.js').User|null} */
let _currentUser = null;

/** @type {Object[]} — full document list for the session */
let _allDocs = [];

/** @type {string|null} — docId pending delete confirmation */
let _pendingDeleteId = null; // retained for legacy reference safety

// ── DOM refs ──────────────────────────────────────────────────
let DOM = {};

function _resolveDOM() {
  DOM = {
    // Sidebar user info
    sidebarName   : document.getElementById('sidebar-user-name'),
    sidebarPhone  : document.getElementById('sidebar-user-phone'),
    userAvatar    : document.getElementById('user-avatar-initials'),

    // Stats
    statTotal     : document.getElementById('stat-total'),
    statShared    : document.getElementById('stat-shared'),
    statMembers   : document.getElementById('stat-members'),
    statStorage   : document.getElementById('stat-storage'),

    // Controls
    searchInput   : document.getElementById('doc-search'),
    filterType    : document.getElementById('filter-type'),
    filterSort    : document.getElementById('filter-sort'),

    // Grid + states
    docGrid       : document.getElementById('doc-grid'),
    emptyState    : document.getElementById('empty-state'),
    loadingState  : document.getElementById('loading-state'),

    // Delete modal
    modalDelete   : document.getElementById('modal-delete'),
    deleteDocName : document.getElementById('delete-doc-name'),
    btnDeleteConf : document.getElementById('btn-delete-confirm'),

    // Sign-out
    btnSignout    : document.getElementById('btn-signout'),
  };
}

// ── Boot ──────────────────────────────────────────────────────

/**
 * Entry point — guards page, then loads all data.
 */
function init() {
  _resolveDOM();

  requireAuth(async (user) => {
    _currentUser = user;
    log.info('DASHBOARD_BOOT', { uid: user.uid });

    _bootstrapUserInfo(user);
    _bindControls();
    _bindSignout();

    // Initialise upload module — passes uid + refresh callback
    UploadModule.init(user.uid, _loadDocuments);

    // Initialise document management (edit + delete) module
    DocManagementModule.init(user.uid, _loadDocuments);

    // Initialise sharing module
    ShareModule.init(user.uid, _loadDocuments);

    await _loadDocuments();
  });
}

// ── User info bootstrap ───────────────────────────────────────

/**
 * Populates sidebar with user name / phone / avatar initials.
 * Falls back to phone number if no profile name is set yet.
 *
 * @param {import('firebase/auth').User} user
 */
async function _bootstrapUserInfo(user) {
  const phone = user.phoneNumber ?? '';

  // Attempt to load profile name from Firestore
  const profileResult = await DbService.getUser(user.uid);

  const displayName = profileResult.success && profileResult.data.name
    ? profileResult.data.name
    : phone;

  UI.setText(DOM.sidebarName,  displayName);
  UI.setText(DOM.sidebarPhone, _formatPhone(phone));
  UI.setText(DOM.userAvatar,   _getInitials(displayName));

  log.debug('USER_INFO_RENDERED', { uid: user.uid });
}

// ── Document loading ──────────────────────────────────────────

/**
 * Fetches documents for the current user and renders the grid.
 * Called on boot and after any upload/delete.
 */
async function _loadDocuments() {
  _setGridState('loading');
  log.debug('DOCS_LOAD_START', { uid: _currentUser.uid });

  const result = await DbService.getUserDocuments(_currentUser.uid);

  if (!result.success) {
    log.error('DOCS_LOAD_FAILED', new Error(result.message), { uid: _currentUser.uid });
    UI.toast(result.message, 'error');
    _setGridState('empty');
    return;
  }

  _allDocs = result.data;
  log.info('DOCS_LOADED', { uid: _currentUser.uid, count: _allDocs.length });

  _renderStats(_allDocs);
  _renderGrid(_allDocs);
}

// ── Stats ─────────────────────────────────────────────────────

/**
 * Computes and renders all stats strip values from the document list.
 *
 * @param {Object[]} docs
 */
function _renderStats(docs) {
  const totalDocs    = docs.length;
  const sharedDocs   = docs.filter((d) => d.sharedWith?.length > 0).length;
  const totalBytes   = docs.reduce((sum, d) => sum + (d.sizeBytes ?? 0), 0);

  // Unique family member UIDs across all shared docs
  const memberUids = new Set(
    docs.flatMap((d) => (d.sharedWith ?? []).map((m) => m.uid))
  );

  UI.setText(DOM.statTotal,   totalDocs);
  UI.setText(DOM.statShared,  sharedDocs);
  UI.setText(DOM.statMembers, memberUids.size);
  UI.setText(DOM.statStorage, _formatBytes(totalBytes));

  log.debug('STATS_RENDERED', {
    total: totalDocs,
    shared: sharedDocs,
    members: memberUids.size,
    storageMB: (totalBytes / 1_048_576).toFixed(2),
  });
}

// ── Grid rendering ────────────────────────────────────────────

/**
 * Clones the <template> for each document and appends to #doc-grid.
 * Applies client-side search and filter before rendering.
 *
 * @param {Object[]} docs - Full or filtered document list
 */
function _renderGrid(docs) {
  const filtered = _applyFilters(docs);

  DOM.docGrid.innerHTML = '';

  if (filtered.length === 0) {
    _setGridState(_allDocs.length === 0 ? 'empty' : 'no-results');
    return;
  }

  _setGridState('grid');

  const template = document.getElementById('doc-card-template');
  if (!template) {
    log.error('TEMPLATE_MISSING', new Error('#doc-card-template not found'));
    return;
  }

  const fragment = document.createDocumentFragment();

  filtered.forEach((docData) => {
    const card = _buildDocCard(template, docData);
    fragment.appendChild(card);
  });

  DOM.docGrid.appendChild(fragment);

  log.debug('GRID_RENDERED', { count: filtered.length });
}

/**
 * Clones the card template and binds data to [data-bind] slots.
 *
 * @param {HTMLTemplateElement} template
 * @param {Object} docData
 * @returns {HTMLElement}
 */
function _buildDocCard(template, docData) {
  const clone = template.content.cloneNode(true);
  const card  = clone.querySelector('.doc-card');

  card.dataset.docId = docData.id;

  // Type badge
  const badge = clone.querySelector('[data-bind="type-badge"]');
  if (badge) {
    badge.textContent       = _docTypeLabel(docData.type);
    badge.dataset.type      = docData.type;
    badge.classList.add('doc-type-badge');
  }

  // Title
  const title = clone.querySelector('[data-bind="title"]');
  if (title) title.textContent = docData.title;

  // Type label
  const typeLabel = clone.querySelector('[data-bind="type-label"]');
  if (typeLabel) typeLabel.textContent = _docTypeLabel(docData.type);

  // File size
  const size = clone.querySelector('[data-bind="size"]');
  if (size) size.textContent = _formatBytes(docData.sizeBytes ?? 0);

  // Upload date
  const dateEl = clone.querySelector('[data-bind="date"]');
  if (dateEl) {
    const dateStr = _formatDate(docData.uploadedAt);
    dateEl.textContent    = dateStr;
    dateEl.setAttribute('datetime', docData.uploadedAt ?? '');
  }

  // Share indicator
  const shareInd = clone.querySelector('[data-bind="share-indicator"]');
  if (shareInd && docData.sharedWith?.length > 0) {
    shareInd.hidden = false;
  }

  // Dropdown action wiring
  _bindCardActions(clone, docData);

  return clone;
}

/**
 * Wires the three dropdown actions (view, share, delete) on a card.
 *
 * @param {DocumentFragment} clone
 * @param {Object} docData
 */
function _bindCardActions(clone, docData) {
  const viewBtn   = clone.querySelector('[data-action="view"]');
  const shareBtn  = clone.querySelector('[data-action="share"]');
  const editBtn   = clone.querySelector('[data-action="edit"]');
  const deleteBtn = clone.querySelector('[data-action="delete"]');

  if (viewBtn) {
    viewBtn.addEventListener('click', () => {
      log.info('DOC_VIEW_TRIGGERED', { docId: docData.id });
      window.open(docData.fileURL, '_blank', 'noopener,noreferrer');
    });
  }

  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      log.info('DOC_SHARE_TRIGGERED', { docId: docData.id });
      document.dispatchEvent(
        new CustomEvent('govdoc:openShare', { detail: { doc: docData } })
      );
    });
  }

  if (editBtn) {
    editBtn.addEventListener('click', () => {
      log.info('DOC_EDIT_TRIGGERED', { docId: docData.id });
      document.dispatchEvent(
        new CustomEvent('govdoc:openEdit', { detail: { doc: docData } })
      );
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      log.info('DOC_DELETE_TRIGGERED', { docId: docData.id });
      document.dispatchEvent(
        new CustomEvent('govdoc:openDelete', { detail: { doc: docData } })
      );
    });
  }
}

// ── Search + Filter ───────────────────────────────────────────

function _bindControls() {
  DOM.searchInput?.addEventListener('input', _onFilterChange);
  DOM.filterType?.addEventListener('change', _onFilterChange);
  DOM.filterSort?.addEventListener('change', _onFilterChange);
}

function _onFilterChange() {
  _renderGrid(_allDocs);
}

/**
 * Applies search query, type filter, and sort order to the document list.
 *
 * @param {Object[]} docs
 * @returns {Object[]}
 */
function _applyFilters(docs) {
  const query    = (DOM.searchInput?.value ?? '').toLowerCase().trim();
  const typeVal  = DOM.filterType?.value  ?? '';
  const sortVal  = DOM.filterSort?.value  ?? 'newest';

  let result = [...docs];

  // Search: match on title or type label
  if (query) {
    result = result.filter((d) =>
      d.title.toLowerCase().includes(query) ||
      _docTypeLabel(d.type).toLowerCase().includes(query)
    );
  }

  // Type filter
  if (typeVal) {
    result = result.filter((d) => d.type === typeVal);
  }

  // Sort
  result.sort((a, b) => {
    if (sortVal === 'newest') return _dateMs(b.uploadedAt) - _dateMs(a.uploadedAt);
    if (sortVal === 'oldest') return _dateMs(a.uploadedAt) - _dateMs(b.uploadedAt);
    if (sortVal === 'name')   return a.title.localeCompare(b.title);
    return 0;
  });

  return result;
}

// ── Grid state transitions ────────────────────────────────────

/**
 * Controls which state is visible in the document section.
 *
 * @param {'loading'|'empty'|'no-results'|'grid'} state
 */
function _setGridState(state) {
  const loading   = document.getElementById('loading-state');
  const empty     = document.getElementById('empty-state');

  UI.hide(loading);
  UI.hide(empty);
  UI.hide(DOM.docGrid);

  if (state === 'loading') {
    UI.show(loading);
  } else if (state === 'empty') {
    UI.show(empty);
  } else if (state === 'no-results') {
    // Show the grid container with a no-results message
    DOM.docGrid.innerHTML =
      `<p class="text-muted text-sm" style="padding:var(--space-6) 0">
         No documents match your search or filter.
       </p>`;
    UI.show(DOM.docGrid);
  } else {
    UI.show(DOM.docGrid);
  }
}

// ── Sign-out ──────────────────────────────────────────────────

function _bindSignout() {
  DOM.btnSignout?.addEventListener('click', async () => {
    const { AuthService } = await import('../services/auth.service.js');

    log.info('SIGNOUT_TRIGGERED', { uid: _currentUser?.uid });
    UI.showLoader('Signing out…');

    const result = await AuthService.logout();
    UI.hideLoader();

    if (result.success) {
      window.location.replace('/index.html');
    } else {
      UI.toast(result.message, 'error');
    }
  });
}

// ── Button loading ────────────────────────────────────────────

function _setButtonLoading(btn, isLoading) {
  if (!btn) return;
  const textEl   = btn.querySelector('.btn__text');
  const loaderEl = btn.querySelector('.btn__loader');
  btn.disabled = isLoading;
  if (textEl)   textEl.style.visibility = isLoading ? 'hidden' : '';
  if (loaderEl) loaderEl.hidden         = !isLoading;
}

// ── Formatters ────────────────────────────────────────────────

const DOC_TYPE_LABELS = Object.freeze({
  aadhaar : 'Aadhaar Card',
  pan     : 'PAN Card',
  passport: 'Passport',
  driving : 'Driving Licence',
  voter   : 'Voter ID',
  other   : 'Other',
});

/** @param {string} type @returns {string} */
function _docTypeLabel(type) {
  return DOC_TYPE_LABELS[type] ?? 'Other';
}

/** @param {number} bytes @returns {string} */
function _formatBytes(bytes) {
  if (bytes === 0) return '0 KB';
  if (bytes < 1_024)          return `${bytes} B`;
  if (bytes < 1_048_576)      return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(2)} MB`;
}

/** @param {string} isoString @returns {string} */
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

/** @param {string} isoString @returns {number} */
function _dateMs(isoString) {
  return isoString ? new Date(isoString).getTime() : 0;
}

/** @param {string} e164 @returns {string} */
function _formatPhone(e164) {
  if (!e164) return '';
  const digits = e164.replace('+91', '');
  return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
}

/** @param {string} name @returns {string} */
function _getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ── Public API (for use by upload/share modules) ──────────────
const DocumentsModule = Object.freeze({
  /** Re-fetches and re-renders the full document list. */
  refresh: _loadDocuments,
});

export { DocumentsModule };

// ── Boot ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);