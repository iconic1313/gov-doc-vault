/**
 * share.service.js — Document Sharing Service
 * GovDoc Vault | Government Document Portal
 *
 * RESPONSIBILITIES:
 *   - Resolve a target citizen by phone number (lookup users/ collection)
 *   - Validate sharing preconditions (self-share, duplicate, ownership)
 *   - Delegate write operations to DbService (single Firestore layer)
 *   - Create / update familyLinks records for invitation lifecycle tracking
 *   - Provide revoke + list helpers consumed by share.module.js
 *   - Log every share / revoke operation with masked PII
 *
 * SECURITY MODEL:
 *   - Target must be a registered citizen (uid must exist in users/)
 *   - Owner identity is never trusted from the client — always read from
 *     auth.currentUser and re-verified by DbService._assertOwner()
 *   - Sharing metadata written to documents/{docId}.sharedWith[]
 *     using Firestore arrayUnion (atomic, no duplicates)
 *   - familyLinks/ collection tracks invite lifecycle independently of
 *     the document record, enabling future email/SMS notification
 *
 * USAGE:
 *   import { ShareService } from '../services/share.service.js';
 *
 *   await ShareService.shareByPhone(docId, ownerUid, '+919876543210');
 *   await ShareService.revokeAccess(docId, ownerUid, targetUid);
 *   await ShareService.getSharedMembers(docId, ownerUid);
 */

'use strict';

import { db, firebaseReady }  from '../config/firebase.config.js';
import { DbService }          from './db.service.js';
import { Logger }             from './logger.service.js';

import {
  collection,
  query,
  where,
  getDocs,
  addDoc,
  updateDoc,
  doc,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const log = new Logger('ShareService');

// ── Phone normalisation (mirrors auth.service pattern) ────────

const INDIA_PHONE_REGEX = /^[6-9]\d{9}$/;

/**
 * Normalises raw phone input to E.164 (+91XXXXXXXXXX).
 *
 * @param  {string} raw
 * @returns {{ e164: string, digits: string }}
 * @throws {Error} on invalid number
 */
function _normalisePhone(raw) {
  let digits = String(raw).replace(/[\s\-().]/g, '');
  if (digits.startsWith('+91'))                      digits = digits.slice(3);
  else if (digits.startsWith('91') && digits.length === 12) digits = digits.slice(2);
  else if (digits.startsWith('0'))                   digits = digits.slice(1);

  if (!INDIA_PHONE_REGEX.test(digits)) {
    throw new Error('Invalid phone number. Must be a 10-digit Indian mobile number (6–9 start).');
  }
  return { e164: `+91${digits}`, digits };
}

/** Masks phone for safe logging. '+919876543210' → '+91XXXXXX3210' */
function _maskPhone(phone) {
  if (!phone || phone.length < 4) return '[unknown]';
  return phone.slice(0, -4).replace(/\d/g, 'X') + phone.slice(-4);
}

// ── Result envelope ───────────────────────────────────────────

function _ok(data, message = 'OK')  { return { success: true,  data,  message }; }
function _err(message)               { return { success: false, data: null, message }; }

// ── Target user resolution ────────────────────────────────────

/**
 * Looks up a registered citizen by their E.164 phone number.
 * Queries the `users/` collection — only registered users appear here.
 *
 * Returns the user's { uid, name, phone } or a descriptive error.
 *
 * @param   {string} e164Phone
 * @returns {Promise<{ success: boolean, data: Object|null, message: string }>}
 */
async function _resolveUserByPhone(e164Phone) {
  await firebaseReady;

  try {
    const q    = query(
      collection(db, 'users'),
      where('phone', '==', e164Phone)
    );
    const snap = await getDocs(q);

    if (snap.empty) {
      log.warn('SHARE_TARGET_NOT_FOUND', { phone: _maskPhone(e164Phone) });
      return _err(
        'No registered citizen found with this mobile number. ' +
        'They must register on GovDoc Vault before you can share with them.'
      );
    }

    // Phone numbers are unique per user — take the first result
    const userDoc = snap.docs[0];
    const data    = userDoc.data();

    return _ok({
      uid  : userDoc.id,
      name : data.name  ?? '',
      phone: data.phone ?? e164Phone,
    });

  } catch (err) {
    log.error('SHARE_TARGET_LOOKUP_FAILED', err, { phone: _maskPhone(e164Phone) });
    return _err('Failed to look up user. Please try again.');
  }
}

// ── familyLinks record ────────────────────────────────────────

/**
 * Creates a familyLinks record to track the share invitation lifecycle.
 * This is supplementary to the sharedWith[] entry on the document —
 * it enables future notification, audit, and re-invite flows.
 *
 * @param {string} docId
 * @param {string} requestorId  - Owner UID
 * @param {string} targetUid
 * @param {string} targetPhone
 */
async function _createFamilyLink(docId, requestorId, targetUid, targetPhone) {
  try {
    await addDoc(collection(db, 'familyLinks'), {
      docId      : docId,
      requestorId: requestorId,
      targetPhone: targetPhone,
      targetUid  : targetUid,
      status     : 'accepted',          // direct share — no pending step
      createdAt  : serverTimestamp(),
      updatedAt  : serverTimestamp(),
    });
    log.debug('FAMILY_LINK_CREATED', { docId, requestorId, targetUid });
  } catch (err) {
    // Non-fatal — the document share itself succeeded.
    // Log and continue; the link can be reconstructed from document data.
    log.warn('FAMILY_LINK_CREATE_FAILED', { docId, error: err.message });
  }
}

/**
 * Updates a familyLink to 'revoked' status on access removal.
 *
 * @param {string} docId
 * @param {string} targetUid
 */
async function _revokeFamilyLink(docId, targetUid) {
  try {
    const q    = query(
      collection(db, 'familyLinks'),
      where('docId',     '==', docId),
      where('targetUid', '==', targetUid),
      where('status',    '==', 'accepted')
    );
    const snap = await getDocs(q);

    const updates = snap.docs.map((d) =>
      updateDoc(doc(db, 'familyLinks', d.id), {
        status   : 'revoked',
        updatedAt: serverTimestamp(),
      })
    );
    await Promise.all(updates);

    log.debug('FAMILY_LINK_REVOKED', { docId, targetUid });
  } catch (err) {
    log.warn('FAMILY_LINK_REVOKE_FAILED', { docId, targetUid, error: err.message });
  }
}

// ══════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════

/**
 * shareByPhone
 * ------------
 * Main entry point. Validates, resolves target, checks preconditions,
 * writes to Firestore atomically, and creates a familyLinks record.
 *
 * Precondition checks (all enforced before any write):
 *   ✗ Target phone is invalid
 *   ✗ Target user is not registered
 *   ✗ Owner is sharing with themselves
 *   ✗ Document does not exist or owner mismatch
 *   ✗ Target already has access to this document
 *
 * @param {string} docId
 * @param {string} ownerUid
 * @param {string} rawPhone   - Raw input from the share form
 * @returns {Promise<{ success: boolean, data: Object|null, message: string }>}
 */
async function shareByPhone(docId, ownerUid, rawPhone) {
  await firebaseReady;

  // 1. Normalise and validate phone
  let normalised;
  try {
    normalised = _normalisePhone(rawPhone);
  } catch (validationErr) {
    log.warn('SHARE_PHONE_INVALID', { raw: rawPhone });
    return _err(validationErr.message);
  }

  log.info('SHARE_INITIATED', {
    docId,
    ownerUid,
    targetPhone: _maskPhone(normalised.e164),
  });

  // 2. Resolve target citizen
  const targetResult = await _resolveUserByPhone(normalised.e164);
  if (!targetResult.success) return targetResult;

  const target = targetResult.data;

  // 3. Prevent self-share
  if (target.uid === ownerUid) {
    log.warn('SHARE_SELF_ATTEMPT', { ownerUid });
    return _err('You cannot share a document with yourself.');
  }

  // 4. Fetch document and verify ownership
  const docResult = await DbService.getDocument(docId, ownerUid);
  if (!docResult.success) return docResult;

  const docData = docResult.data;

  // 5. Prevent duplicate share
  const alreadyShared = (docData.sharedWith ?? []).some((m) => m.uid === target.uid);
  if (alreadyShared) {
    log.warn('SHARE_DUPLICATE', { docId, targetUid: target.uid });
    return _err(
      `This document is already shared with ${_maskPhone(normalised.e164)}.`
    );
  }

  // 6. Write share entry (via DbService — single Firestore layer)
  const shareResult = await DbService.shareDocument(docId, ownerUid, {
    uid  : target.uid,
    phone: normalised.e164,
  });

  if (!shareResult.success) return shareResult;

  // 7. Create familyLinks record (non-blocking)
  await _createFamilyLink(docId, ownerUid, target.uid, normalised.e164);

  log.info('SHARE_SUCCESS', {
    docId,
    ownerUid,
    targetUid  : target.uid,
    targetPhone: _maskPhone(normalised.e164),
  });

  return _ok(
    { targetUid: target.uid, targetName: target.name, targetPhone: normalised.e164 },
    `Document shared successfully with ${target.name || _maskPhone(normalised.e164)}.`
  );
}

/**
 * revokeAccess
 * ------------
 * Removes a family member's access from a document.
 * Verifies ownership, finds the exact sharedWith entry, and removes it.
 *
 * @param {string} docId
 * @param {string} ownerUid
 * @param {string} targetUid
 * @returns {Promise<{ success: boolean, data: Object|null, message: string }>}
 */
async function revokeAccess(docId, ownerUid, targetUid) {
  await firebaseReady;

  if (!targetUid) return _err('Target user ID is required to revoke access.');

  log.info('REVOKE_INITIATED', { docId, ownerUid, targetUid });

  const result = await DbService.revokeShare(docId, ownerUid, targetUid);

  if (!result.success) {
    log.error('REVOKE_FAILED', new Error(result.message), { docId, ownerUid, targetUid });
    return result;
  }

  // Update familyLinks record (non-blocking)
  await _revokeFamilyLink(docId, targetUid);

  log.info('REVOKE_SUCCESS', { docId, ownerUid, targetUid });
  return _ok({ docId, targetUid }, 'Access has been revoked.');
}

/**
 * getSharedMembers
 * ----------------
 * Returns the sharedWith[] array for a document, verifying ownership.
 * Used to populate the "Currently Shared With" panel in the share modal.
 *
 * @param {string} docId
 * @param {string} ownerUid
 * @returns {Promise<{ success: boolean, data: Object[]|null, message: string }>}
 */
async function getSharedMembers(docId, ownerUid) {
  const result = await DbService.getDocument(docId, ownerUid);

  if (!result.success) return result;

  const members = result.data.sharedWith ?? [];
  log.debug('SHARED_MEMBERS_FETCHED', { docId, count: members.length });

  return _ok(members);
}

// ── Public API ────────────────────────────────────────────────
const ShareService = Object.freeze({
  shareByPhone,
  revokeAccess,
  getSharedMembers,
});

export { ShareService };