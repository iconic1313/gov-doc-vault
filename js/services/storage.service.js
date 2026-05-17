/**
 * storage.service.js — Firebase Storage Service
 * GovDoc Vault | Government Document Portal
 *
 * RESPONSIBILITIES:
 *   - Upload validated files to Storage under a user-scoped path
 *   - Report upload progress via an optional callback
 *   - Delete files from Storage by their reference path
 *   - Return the public download URL after upload
 *   - Log all storage operations
 *
 * PATH STRUCTURE:
 *   documents/{uid}/{docId}/original.{ext}
 *
 *   - uid-scoped:   no cross-user path collisions
 *   - docId-scoped: each Firestore document owns exactly one file slot
 *   - 'original':   static leaf name simplifies delete (no URL parsing)
 *
 * USAGE:
 *   import { StorageService } from '../services/storage.service.js';
 *
 *   const result = await StorageService.uploadFile(uid, docId, file, sanitisedName, onProgress);
 *   await StorageService.deleteFile(fileRef);
 */

'use strict';

import { storage, firebaseReady } from '../config/firebase.config.js';
import { Logger }                 from './logger.service.js';

import {
  ref,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';

const log = new Logger('StorageService');

// ── Path builder ──────────────────────────────────────────────

/**
 * Builds the canonical Storage path for a document file.
 *
 * @param {string} uid
 * @param {string} docId
 * @param {string} ext    — with leading dot, e.g. '.pdf'
 * @returns {string}      e.g. 'documents/uid123/docABC/original.pdf'
 */
function _buildPath(uid, docId, ext) {
  return `documents/${uid}/${docId}/original${ext}`;
}

/**
 * Extracts the lowercase extension from a filename.
 *
 * @param {string} filename
 * @returns {string}
 */
function _ext(filename) {
  const parts = filename.split('.');
  return parts.length > 1 ? `.${parts.pop().toLowerCase()}` : '';
}

// ── Upload ────────────────────────────────────────────────────

/**
 * uploadFile
 * ----------
 * Uploads a validated File to Firebase Storage.
 * Uses `uploadBytesResumable` to support progress reporting.
 *
 * @param {string}   uid           - Owner's Firebase UID
 * @param {string}   docId         - Firestore document ID (pre-generated or temp)
 * @param {File}     file          - The validated File object
 * @param {string}   sanitisedName - Safe filename from FileValidator
 * @param {function} [onProgress]  - Optional: (percent: number) => void
 *
 * @returns {Promise<{
 *   success:  boolean,
 *   fileRef:  string|null,
 *   fileURL:  string|null,
 *   mimeType: string|null,
 *   message:  string,
 * }>}
 */
async function uploadFile(uid, docId, file, sanitisedName, onProgress) {
  await firebaseReady;

  if (!uid || !docId || !(file instanceof File)) {
    return _err('Invalid upload parameters.');
  }

  const extension = _ext(sanitisedName || file.name);
  const filePath  = _buildPath(uid, docId, extension);
  const storageRef = ref(storage, filePath);

  const metadata = {
    contentType : file.type,
    customMetadata: {
      ownerId      : uid,
      originalName : sanitisedName,
      uploadedAt   : new Date().toISOString(),
    },
  };

  log.info('UPLOAD_START', {
    uid,
    docId,
    path : filePath,
    mime : file.type,
    size : file.size,
  });

  return new Promise((resolve) => {
    const uploadTask = uploadBytesResumable(storageRef, file, metadata);

    // Progress reporting
    uploadTask.on(
      'state_changed',

      // ── Snapshot handler ─────────────────────────────────
      (snapshot) => {
        const percent = Math.round(
          (snapshot.bytesTransferred / snapshot.totalBytes) * 100
        );

        log.debug('UPLOAD_PROGRESS', { docId, percent });

        if (typeof onProgress === 'function') {
          onProgress(percent);
        }
      },

      // ── Error handler ────────────────────────────────────
      (err) => {
        log.error('UPLOAD_FAILED', err, { uid, docId, path: filePath });
        resolve(_err(_resolveStorageError(err)));
      },

      // ── Completion handler ───────────────────────────────
      async () => {
        try {
          const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);

          log.info('UPLOAD_SUCCESS', {
            uid,
            docId,
            path: filePath,
            url : downloadURL.slice(0, 60) + '…',   // truncate for log safety
          });

          resolve({
            success : true,
            fileRef : filePath,
            fileURL : downloadURL,
            mimeType: file.type,
            message : 'File uploaded successfully.',
          });

        } catch (urlErr) {
          log.error('UPLOAD_URL_FETCH_FAILED', urlErr, { docId });
          resolve(_err('Upload succeeded but download URL could not be retrieved.'));
        }
      }
    );
  });
}

// ── Delete ────────────────────────────────────────────────────

/**
 * deleteFile
 * ----------
 * Permanently removes a file from Firebase Storage by its path reference.
 *
 * @param   {string} fileRef - Storage path, e.g. 'documents/uid/docId/original.pdf'
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function deleteFile(fileRef) {
  await firebaseReady;

  if (!fileRef || typeof fileRef !== 'string') {
    return _err('Invalid file reference provided for deletion.');
  }

  try {
    const storageRef = ref(storage, fileRef);
    await deleteObject(storageRef);

    log.info('FILE_DELETED', { fileRef });
    return { success: true, message: 'File deleted from storage.' };

  } catch (err) {
    // 'object-not-found' is treated as a soft failure —
    // the Firestore record can still be cleaned up safely.
    if (err?.code === 'storage/object-not-found') {
      log.warn('FILE_NOT_FOUND_ON_DELETE', { fileRef });
      return { success: true, message: 'File already removed from storage.' };
    }

    log.error('FILE_DELETE_FAILED', err, { fileRef });
    return _err(_resolveStorageError(err));
  }
}

// ── Error normalisation ───────────────────────────────────────

const STORAGE_ERROR_MESSAGES = Object.freeze({
  'storage/unauthorized'     : 'You do not have permission to perform this upload.',
  'storage/canceled'         : 'Upload was cancelled.',
  'storage/quota-exceeded'   : 'Storage quota exceeded. Please contact support.',
  'storage/invalid-checksum' : 'File integrity check failed. Please try uploading again.',
  'storage/retry-limit-exceeded': 'Upload failed after multiple retries. Check your connection.',
  'storage/object-not-found' : 'The file could not be found in storage.',
  'storage/unauthenticated'  : 'You must be signed in to upload files.',
});

/**
 * @param {Error} err
 * @returns {string}
 */
function _resolveStorageError(err) {
  return STORAGE_ERROR_MESSAGES[err?.code] ||
    'A storage error occurred. Please try again.';
}

/** @returns {{ success: false, fileRef: null, fileURL: null, mimeType: null, message: string }} */
function _err(message) {
  return { success: false, fileRef: null, fileURL: null, mimeType: null, message };
}

// ── Public API ────────────────────────────────────────────────
const StorageService = Object.freeze({
  uploadFile,
  deleteFile,
});

export { StorageService };