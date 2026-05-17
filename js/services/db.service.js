/**
 * db.service.js — Firestore Database Service
 * GovDoc Vault | Government Document Portal
 *
 * RESPONSIBILITIES:
 *   - Abstract all Firestore operations behind typed methods
 *   - Enforce owner-scoped queries (ownerId === currentUser.uid)
 *   - Never expose raw Firestore references outside this service
 *   - Return plain JS objects (never Firestore DocumentSnapshot)
 *   - Log all read/write/delete operations
 *
 * COLLECTIONS:
 *   users/       {uid}        → citizen profile
 *   documents/   {docId}      → document metadata + sharedWith[]
 *   familyLinks/ {linkId}     → share invitations lifecycle
 *
 * USAGE:
 *   import { DbService } from '../services/db.service.js';
 *
 *   const docs = await DbService.getUserDocuments(uid);
 *   const doc  = await DbService.getDocument(docId, uid);
 *   await DbService.createDocument(uid, payload);
 *   await DbService.updateDocument(docId, uid, patch);
 *   await DbService.deleteDocument(docId, uid);
 */

'use strict';

import { db, firebaseReady }  from '../config/firebase.config.js';
import { Logger }             from './logger.service.js';

import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  setDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const log = new Logger('DbService');

// ── Collection name constants ─────────────────────────────────
const COLLECTIONS = Object.freeze({
  USERS        : 'users',
  DOCUMENTS    : 'documents',
  FAMILY_LINKS : 'familyLinks',
});

// ── Firestore error normalisation ─────────────────────────────
const FIRESTORE_ERROR_MESSAGES = Object.freeze({
  'permission-denied'  : 'Access denied. You do not have permission to perform this action.',
  'not-found'          : 'The requested record was not found.',
  'unavailable'        : 'Service temporarily unavailable. Please try again.',
  'deadline-exceeded'  : 'The request timed out. Please check your connection.',
  'already-exists'     : 'A record with this identifier already exists.',
  'resource-exhausted' : 'Too many requests. Please slow down and try again.',
  'unauthenticated'    : 'You must be signed in to perform this action.',
});

/**
 * @param {Error} err - Firestore error (has .code property)
 * @returns {string}
 */
function _resolveError(err) {
  const code = err?.code?.replace('firestore/', '') ?? '';
  return FIRESTORE_ERROR_MESSAGES[code] ||
    'A database error occurred. Please try again.';
}

// ── Result envelope ───────────────────────────────────────────
/**
 * All DbService methods return a consistent result object.
 * Callers check `result.success` before reading `result.data`.
 *
 * @typedef {{ success: true,  data: any,  message: string }} OkResult
 * @typedef {{ success: false, data: null, message: string }} ErrResult
 * @typedef {OkResult|ErrResult} DbResult
 */

/** @returns {OkResult} */
function _ok(data, message = 'OK') {
  return { success: true, data, message };
}

/** @returns {ErrResult} */
function _err(message) {
  return { success: false, data: null, message };
}

// ── Serialisers ───────────────────────────────────────────────
/**
 * Converts a Firestore DocumentSnapshot into a plain JS object.
 * Converts Timestamp fields to ISO strings for uniform handling.
 *
 * @param {import('firebase/firestore').DocumentSnapshot} snap
 * @returns {Object|null}
 */
function _snapToPlain(snap) {
  if (!snap.exists()) return null;

  const raw = snap.data();

  // Convert all Timestamp values to ISO strings
  const plain = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [
      k,
      v instanceof Timestamp ? v.toDate().toISOString() : v,
    ])
  );

  return { id: snap.id, ...plain };
}

/**
 * Converts an array of DocumentSnapshots to plain objects,
 * filtering out any that no longer exist.
 *
 * @param {import('firebase/firestore').QuerySnapshot} querySnap
 * @returns {Object[]}
 */
function _queryToPlain(querySnap) {
  return querySnap.docs
    .map(_snapToPlain)
    .filter(Boolean);
}

// ── Ownership guard ───────────────────────────────────────────
/**
 * Asserts that a document's ownerId matches the requesting uid.
 * Prevents horizontal privilege escalation at the service layer —
 * a second line of defence behind Firestore Security Rules.
 *
 * @param {Object} docData - Plain document object from Firestore
 * @param {string} uid     - Requesting user's uid
 * @throws {Error}         - If ownership mismatch detected
 */
function _assertOwner(docData, uid) {
  if (docData.ownerId !== uid) {
    throw Object.assign(
      new Error('Ownership mismatch — access denied.'),
      { code: 'permission-denied' }
    );
  }
}

// ══════════════════════════════════════════════════════════════
// USER PROFILE
// ══════════════════════════════════════════════════════════════

/**
 * Fetches the citizen profile for the given uid.
 *
 * @param {string} uid
 * @returns {Promise<DbResult>}
 */
async function getUser(uid) {
  await firebaseReady;

  try {
    const snap  = await getDoc(doc(db, COLLECTIONS.USERS, uid));
    const plain = _snapToPlain(snap);

    if (!plain) {
      log.warn('USER_NOT_FOUND', { uid });
      return _err('User profile not found.');
    }

    log.info('USER_FETCHED', { uid });
    return _ok(plain);

  } catch (err) {
    log.error('USER_FETCH_FAILED', err, { uid });
    return _err(_resolveError(err));
  }
}

/**
 * Creates or overwrites the citizen profile document.
 * Called after first successful OTP login.
 *
 * @param {string} uid
 * @param {{ name: string, phone: string, dob?: string }} payload
 * @returns {Promise<DbResult>}
 */
async function upsertUser(uid, payload) {
  await firebaseReady;

  try {
    const ref   = doc(db, COLLECTIONS.USERS, uid);
    const snap  = await getDoc(ref);
    const isNew = !snap.exists();

    // If phone is missing from payload, try to read it from existing doc
    // This prevents the Firestore rule (phone.size() > 0) from failing
    let phone = String(payload.phone ?? '').trim();
    if (!phone && !isNew) {
      phone = snap.data()?.phone ?? '';
    }

    // Guard: phone is mandatory
    if (!phone) {
      log.error('UPSERT_USER_NO_PHONE', new Error('Phone is required'), { uid });
      return _err('Phone number is required to save your profile.');
    }

    const data = {
      name     : String(payload.name ?? '').trim(),
      phone,
      dob      : payload.dob ? String(payload.dob).trim() : '',
      updatedAt: serverTimestamp(),
      ...(isNew ? { createdAt: serverTimestamp() } : {}),
    };

    await setDoc(ref, data, { merge: true });

    log.info('USER_UPSERTED', { uid, isNew });
    return _ok({ uid, ...data }, 'Profile saved.');

  } catch (err) {
    log.error('USER_UPSERT_FAILED', err, { uid });
    return _err(_resolveError(err));
  }
}

// ══════════════════════════════════════════════════════════════
// DOCUMENTS
// ══════════════════════════════════════════════════════════════

/**
 * Fetches all documents owned by the given uid,
 * ordered by uploadedAt descending (newest first).
 *
 * @param {string} uid
 * @returns {Promise<DbResult>}  data → Document[]
 */
async function getUserDocuments(uid) {
  await firebaseReady;

  if (!uid) {
    log.warn('GET_DOCS_NO_UID', {});
    return _err('User ID is required to fetch documents.');
  }

  try {
    const q    = query(
      collection(db, COLLECTIONS.DOCUMENTS),
      where('ownerId', '==', uid),
      orderBy('uploadedAt', 'desc')
    );
    const snap  = await getDocs(q);
    const docs  = _queryToPlain(snap);

    log.info('DOCS_FETCHED', { uid, count: docs.length });
    return _ok(docs, `${docs.length} document(s) retrieved.`);

  } catch (err) {
    log.error('DOCS_FETCH_FAILED', err, { uid });
    return _err(_resolveError(err));
  }
}

/**
 * Fetches a single document by ID and validates ownership.
 *
 * @param {string} docId
 * @param {string} uid   - Must match ownerId
 * @returns {Promise<DbResult>}  data → Document
 */
async function getDocument(docId, uid) {
  await firebaseReady;

  try {
    const snap  = await getDoc(doc(db, COLLECTIONS.DOCUMENTS, docId));
    const plain = _snapToPlain(snap);

    if (!plain) {
      log.warn('DOC_NOT_FOUND', { docId });
      return _err('Document not found.');
    }

    _assertOwner(plain, uid);

    log.info('DOC_FETCHED', { docId, uid });
    return _ok(plain);

  } catch (err) {
    log.error('DOC_FETCH_FAILED', err, { docId, uid });
    return _err(_resolveError(err));
  }
}

/**
 * Creates a new document metadata record in Firestore.
 * The file must already be uploaded to Storage before calling this.
 *
 * @param {string} uid
 * @param {{
 *   title:      string,
 *   type:       string,
 *   fileRef:    string,
 *   fileURL:    string,
 *   mimeType:   string,
 *   sizeBytes:  number,
 * }} payload
 * @returns {Promise<DbResult>}  data → { id, ...payload }
 */
async function createDocument(uid, payload) {
  await firebaseReady;

  const data = {
    ownerId    : uid,
    title      : String(payload.title     ?? '').trim(),
    type       : String(payload.type      ?? 'other').trim(),
    fileRef    : String(payload.fileRef   ?? ''),
    fileURL    : String(payload.fileURL   ?? ''),
    mimeType   : String(payload.mimeType  ?? ''),
    sizeBytes  : Number(payload.sizeBytes ?? 0),
    sharedWith : [],
    uploadedAt : serverTimestamp(),
    updatedAt  : serverTimestamp(),
  };

  try {
    const ref = await addDoc(collection(db, COLLECTIONS.DOCUMENTS), data);

    log.info('DOC_CREATED', { docId: ref.id, uid, type: data.type });
    return _ok({ id: ref.id, ...data }, 'Document record created.');

  } catch (err) {
    log.error('DOC_CREATE_FAILED', err, { uid });
    return _err(_resolveError(err));
  }
}

/**
 * Partially updates a document's metadata (title, type).
 * Ownership is verified before writing.
 *
 * @param {string} docId
 * @param {string} uid
 * @param {{ title?: string, type?: string }} patch
 * @returns {Promise<DbResult>}
 */
async function updateDocument(docId, uid, patch) {
  await firebaseReady;

  try {
    // Verify ownership before writing
    const existing = await getDocument(docId, uid);
    if (!existing.success) return existing;

    const allowed = {};
    if (patch.title !== undefined) allowed.title = String(patch.title).trim();
    if (patch.type  !== undefined) allowed.type  = String(patch.type).trim();
    allowed.updatedAt = serverTimestamp();

    await updateDoc(doc(db, COLLECTIONS.DOCUMENTS, docId), allowed);

    log.info('DOC_UPDATED', { docId, uid, fields: Object.keys(patch) });
    return _ok({ id: docId, ...allowed }, 'Document updated.');

  } catch (err) {
    log.error('DOC_UPDATE_FAILED', err, { docId, uid });
    return _err(_resolveError(err));
  }
}

/**
 * Permanently deletes a document metadata record.
 * Caller is responsible for deleting the Storage file separately.
 *
 * @param {string} docId
 * @param {string} uid
 * @returns {Promise<DbResult>}
 */
async function deleteDocument(docId, uid) {
  await firebaseReady;

  try {
    // Verify ownership before deleting
    const existing = await getDocument(docId, uid);
    if (!existing.success) return existing;

    await deleteDoc(doc(db, COLLECTIONS.DOCUMENTS, docId));

    log.info('DOC_DELETED', { docId, uid });
    return _ok({ id: docId }, 'Document deleted.');

  } catch (err) {
    log.error('DOC_DELETE_FAILED', err, { docId, uid });
    return _err(_resolveError(err));
  }
}

// ══════════════════════════════════════════════════════════════
// SHARING
// ══════════════════════════════════════════════════════════════

/**
 * Adds a family member to a document's sharedWith array.
 * Uses arrayUnion to prevent duplicate entries atomically.
 *
 * @param {string} docId
 * @param {string} ownerUid
 * @param {{ uid: string, phone: string }} member
 * @returns {Promise<DbResult>}
 */
async function shareDocument(docId, ownerUid, member) {
  await firebaseReady;

  const { arrayUnion } = await import(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
  );

  try {
    const existing = await getDocument(docId, ownerUid);
    if (!existing.success) return existing;

    // Prevent sharing with self
    if (member.uid === ownerUid) {
      return _err('You cannot share a document with yourself.');
    }

    const entry = {
      uid        : member.uid,
      phone      : member.phone,
      accessLevel: 'view',
      sharedAt   : new Date().toISOString(),
    };

    await updateDoc(doc(db, COLLECTIONS.DOCUMENTS, docId), {
      sharedWith: arrayUnion(entry),
      updatedAt : serverTimestamp(),
    });

    log.info('DOC_SHARED', {
      docId,
      ownerUid,
      targetUid: member.uid,
    });
    return _ok(entry, 'Document shared successfully.');

  } catch (err) {
    log.error('DOC_SHARE_FAILED', err, { docId, ownerUid });
    return _err(_resolveError(err));
  }
}

/**
 * Removes a family member from a document's sharedWith array.
 * Uses arrayRemove for atomic removal.
 *
 * @param {string} docId
 * @param {string} ownerUid
 * @param {string} targetUid - UID of the member to revoke
 * @returns {Promise<DbResult>}
 */
async function revokeShare(docId, ownerUid, targetUid) {
  await firebaseReady;

  const { arrayRemove } = await import(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
  );

  try {
    const existing = await getDocument(docId, ownerUid);
    if (!existing.success) return existing;

    // Find the exact entry to remove
    const entry = (existing.data.sharedWith ?? [])
      .find((m) => m.uid === targetUid);

    if (!entry) {
      log.warn('REVOKE_MEMBER_NOT_FOUND', { docId, targetUid });
      return _err('This member does not have access to the document.');
    }

    await updateDoc(doc(db, COLLECTIONS.DOCUMENTS, docId), {
      sharedWith: arrayRemove(entry),
      updatedAt : serverTimestamp(),
    });

    log.info('DOC_SHARE_REVOKED', { docId, ownerUid, targetUid });
    return _ok({ docId, targetUid }, 'Access revoked.');

  } catch (err) {
    log.error('DOC_REVOKE_FAILED', err, { docId, ownerUid, targetUid });
    return _err(_resolveError(err));
  }
}

/**
 * Fetches all documents shared WITH the given uid
 * (i.e. documents owned by others where sharedWith contains this uid).
 *
 * @param {string} uid
 * @returns {Promise<DbResult>}
 */
async function getSharedWithMe(uid) {
  await firebaseReady;

  try {
    const q    = query(
      collection(db, COLLECTIONS.DOCUMENTS),
      where('sharedWith', 'array-contains', { uid, accessLevel: 'view' })
    );
    const snap = await getDocs(q);
    const docs = _queryToPlain(snap);

    log.info('SHARED_WITH_ME_FETCHED', { uid, count: docs.length });
    return _ok(docs);

  } catch (err) {
    log.error('SHARED_WITH_ME_FAILED', err, { uid });
    return _err(_resolveError(err));
  }
}

// ── Public API ────────────────────────────────────────────────
const DbService = Object.freeze({
  // User
  getUser,
  upsertUser,

  // Documents
  getUserDocuments,
  getDocument,
  createDocument,
  updateDocument,
  deleteDocument,

  // Sharing
  shareDocument,
  revokeShare,
  getSharedWithMe,

  // Expose constants for use in modules
  COLLECTIONS,
});

export { DbService };