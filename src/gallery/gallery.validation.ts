/**
 * Gallery upload validation rules — replyagent parity (UploadFiles.vue 33-55).
 *
 * Per-type size caps + extension whitelist + compressed-file blocklist. Both
 * the frontend and backend reference these limits so a malicious / broken
 * client can't bypass UI-only checks.
 */

export type MediaKind = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'FILE';

/** MB caps mirrored from replyagent's `UploadFiles.vue` (allowed_image=10,
 *  allowed_video=15, allowed_audio=10, allowed_document=10). FILE (catch-all)
 *  falls through to DOCUMENT's cap so unknown-but-allowed extensions are
 *  still bounded. */
export const SIZE_CAPS_MB: Record<MediaKind, number> = {
  IMAGE: 10,
  VIDEO: 15,
  AUDIO: 10,
  DOCUMENT: 10,
  FILE: 10,
};

/** Max files per multipart upload (replyagent UploadFiles.vue `variable.limit`). */
export const MAX_FILES_PER_UPLOAD = 10;

/** Compressed file extensions — replyagent explicitly blocks these. Listed
 *  here separately so the message can be specific in the error. */
export const COMPRESSED_EXTENSIONS = new Set([
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'bz2',
  'xz',
  'tgz',
  'tbz2',
]);

/**
 * Extension → media kind. Mirrors replyagent's `getMediaTypeByExtension`
 * (GalleryHelper.php 562-599) + the accept list in UploadFiles.vue.
 *
 * Anything not in this map is REJECTED (no quiet "FILE" fallback) — that's
 * what makes the upload safe against malware extensions.
 */
const EXT_KIND: Record<string, MediaKind> = {
  // Images
  jpg: 'IMAGE',
  jpeg: 'IMAGE',
  png: 'IMAGE',
  gif: 'IMAGE',
  bmp: 'IMAGE',
  tif: 'IMAGE',
  tiff: 'IMAGE',
  webp: 'IMAGE',

  // Videos
  m4v: 'VIDEO',
  avi: 'VIDEO',
  mpeg: 'VIDEO',
  mp4: 'VIDEO',
  mkv: 'VIDEO',
  webm: 'VIDEO',
  flv: 'VIDEO',
  wmv: 'VIDEO',
  mov: 'VIDEO',

  // Audios
  mp3: 'AUDIO',
  wav: 'AUDIO',
  aac: 'AUDIO',
  ogg: 'AUDIO',
  oga: 'AUDIO',
  m4a: 'AUDIO',

  // Documents
  doc: 'DOCUMENT',
  docx: 'DOCUMENT',
  pdf: 'DOCUMENT',
  xls: 'DOCUMENT',
  xlsx: 'DOCUMENT',
  ppt: 'DOCUMENT',
  pptx: 'DOCUMENT',
  csv: 'DOCUMENT',
  txt: 'DOCUMENT',
  odt: 'DOCUMENT',
  html: 'DOCUMENT',
  htm: 'DOCUMENT',
};

/** Lowercase extension without leading dot. Empty string if no extension. */
export function extOf(filename: string): string {
  if (!filename) return '';
  const i = filename.lastIndexOf('.');
  return i < 0 || i === filename.length - 1
    ? ''
    : filename.slice(i + 1).toLowerCase();
}

export function isCompressedExt(ext: string): boolean {
  return COMPRESSED_EXTENSIONS.has(ext.toLowerCase());
}

/** Resolve media kind from extension. Returns null when the extension is
 *  not in the whitelist (caller should reject the upload). */
export function kindForExt(ext: string): MediaKind | null {
  return EXT_KIND[ext.toLowerCase()] ?? null;
}

/** Resolve media kind from a MIME type — used as a sanity cross-check
 *  alongside the extension. */
export function kindForMime(mime: string): MediaKind | null {
  if (!mime) return null;
  const m = mime.toLowerCase();
  if (m.startsWith('image/')) return 'IMAGE';
  if (m.startsWith('video/')) return 'VIDEO';
  if (m.startsWith('audio/')) return 'AUDIO';
  if (
    m === 'application/pdf' ||
    m.includes('msword') ||
    m.includes('wordprocessing') ||
    m.includes('spreadsheet') ||
    m.includes('excel') ||
    m.includes('presentation') ||
    m.includes('powerpoint') ||
    m === 'text/csv' ||
    m === 'text/plain' ||
    m === 'text/html' ||
    m === 'application/vnd.oasis.opendocument.text'
  ) {
    return 'DOCUMENT';
  }
  return null;
}

export interface ValidatedFile {
  kind: MediaKind;
  extension: string;
}

export class GalleryValidationError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'INVALID_FILE_TYPE'
      | 'COMPRESSED_BLOCKED'
      | 'SIZE_EXCEEDED'
      | 'BATCH_LIMIT'
      | 'EMPTY_BATCH',
  ) {
    super(message);
  }
}

/**
 * Validate a single uploaded file against extension whitelist + size cap.
 * Throws GalleryValidationError with a specific code so the controller can
 * map to a clean 422 response.
 */
export function validateOneFile(file: {
  originalname: string;
  size: number;
  mimetype: string;
}): ValidatedFile {
  const ext = extOf(file.originalname);
  if (!ext) {
    throw new GalleryValidationError(
      `"${file.originalname}" has no file extension`,
      'INVALID_FILE_TYPE',
    );
  }
  if (isCompressedExt(ext)) {
    throw new GalleryValidationError(
      `Compressed files (.zip, .rar, .7z, etc.) are not allowed`,
      'COMPRESSED_BLOCKED',
    );
  }
  const kind = kindForExt(ext);
  if (!kind) {
    throw new GalleryValidationError(
      `"${file.originalname}" — file type .${ext} is not supported`,
      'INVALID_FILE_TYPE',
    );
  }
  const capMb = SIZE_CAPS_MB[kind];
  const sizeMb = file.size / (1024 * 1024);
  if (sizeMb > capMb) {
    throw new GalleryValidationError(
      `"${file.originalname}" exceeds the ${capMb} MB limit for ${kind.toLowerCase()} files`,
      'SIZE_EXCEEDED',
    );
  }
  return { kind, extension: ext };
}

/** Validate the entire batch — runs per-file checks + enforces the batch cap. */
export function validateBatch(
  files: Array<{ originalname: string; size: number; mimetype: string }>,
): ValidatedFile[] {
  if (!files || files.length === 0) {
    throw new GalleryValidationError('Please select any file', 'EMPTY_BATCH');
  }
  if (files.length > MAX_FILES_PER_UPLOAD) {
    throw new GalleryValidationError(
      `Maximum ${MAX_FILES_PER_UPLOAD} files per upload`,
      'BATCH_LIMIT',
    );
  }
  return files.map(validateOneFile);
}
