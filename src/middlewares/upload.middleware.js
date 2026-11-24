const path = require('node:path');
const multer = require('multer');
const { sendError } = require('../utils/response.util');

const storage = multer.memoryStorage();

const PHOTO_MAX_BYTES = 3 * 1024 * 1024; // 3 MB
const AUDIO_MAX_BYTES = 4 * 1024 * 1024; // 4 MB
const EXCEL_MAX_BYTES = 4 * 1024 * 1024; // 4 MB

const PHOTO_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const AUDIO_MIME_TYPES = new Set([
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/m4a',
  'audio/x-m4a',
  'audio/mp4',
  'audio/mpeg',
  'audio/mp3',
  'audio/webm',
]);
const AUDIO_EXTENSIONS = new Set(['.wav', '.m4a', '.mp4', '.mp3', '.webm']);
const EXCEL_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);
const EXCEL_EXTENSIONS = new Set(['.xlsx', '.xls']);

function detectImageMagicBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  // WebP: RIFF....WEBP
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function detectAudioMagicBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }
  // WAV: RIFF....WAVE
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WAVE'
  ) {
    return 'audio/wav';
  }
  // MP4 / M4A (ISO Base Media File Format): ....ftyp
  if (buffer.toString('ascii', 4, 8) === 'ftyp') {
    return 'audio/mp4';
  }
  // MP3: ID3 tag o frame sync MPEG (FF E0..FF)
  if (
    buffer.toString('ascii', 0, 3) === 'ID3' ||
    (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
  ) {
    return 'audio/mpeg';
  }
  // WebM / Matroska (EBML header): 1A 45 DF A3
  if (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return 'audio/webm';
  }
  return null;
}

function detectExcelMagicBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    return null;
  }
  // XLSX (ZIP): PK\x03\x04, PK\x05\x06 o PK\x07\x08
  if (
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    ((buffer[2] === 0x03 && buffer[3] === 0x04) ||
      (buffer[2] === 0x05 && buffer[3] === 0x06) ||
      (buffer[2] === 0x07 && buffer[3] === 0x08))
  ) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  // XLS (OLE2 Compound Document): D0 CF 11 E0 A1 B1 1A E1
  if (
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0 &&
    buffer[4] === 0xa1 &&
    buffer[5] === 0xb1 &&
    buffer[6] === 0x1a &&
    buffer[7] === 0xe1
  ) {
    return 'application/vnd.ms-excel';
  }
  return null;
}

function createUploadMiddleware({
  fieldName,
  maxBytes,
  maxMbLabel,
  fileFilter,
  validateMagicBytes,
  magicBytesErrorMessage,
}) {
  const uploader = multer({
    storage,
    limits: {
      fileSize: maxBytes,
      files: 1,
    },
    fileFilter,
  }).single(fieldName);

  return (req, res, next) => {
    uploader(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return sendError(
              res,
              400,
              `El archivo excede el tamaño máximo permitido de ${maxMbLabel}.`,
              err.code
            );
          }
          return sendError(res, 400, 'Error al procesar el archivo adjunto.', err.message);
        }
        return sendError(res, 400, err.message || 'Archivo adjunto inválido.');
      }

      if (req.file && typeof validateMagicBytes === 'function') {
        const detectedMime = validateMagicBytes(req.file.buffer);
        if (!detectedMime) {
          req.file = undefined;
          return sendError(
            res,
            400,
            magicBytesErrorMessage || 'La firma binaria del archivo no corresponde al formato permitido.'
          );
        }
        req.file.detectedMimeType = detectedMime;
      }

      return next();
    });
  };
}

const uploadFotoPerfil = createUploadMiddleware({
  fieldName: 'foto_perfil',
  maxBytes: PHOTO_MAX_BYTES,
  maxMbLabel: '3 MB',
  fileFilter: (_req, file, cb) => {
    if (!PHOTO_MIME_TYPES.has(file.mimetype)) {
      return cb(
        new Error('Formato de fotografía no permitido. Use image/jpeg, image/png o image/webp.')
      );
    }
    return cb(null, true);
  },
  validateMagicBytes: detectImageMagicBytes,
  magicBytesErrorMessage:
    'El contenido binario del archivo no coincide con una imagen válida (JPEG, PNG o WebP).',
});

const uploadAudioVoz = createUploadMiddleware({
  fieldName: 'audio_voz',
  maxBytes: AUDIO_MAX_BYTES,
  maxMbLabel: '4 MB',
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!AUDIO_MIME_TYPES.has(file.mimetype) && !AUDIO_EXTENSIONS.has(ext)) {
      return cb(
        new Error('Formato de audio no permitido. Use WAV, M4A, MP4, MP3 o WebM.')
      );
    }
    return cb(null, true);
  },
  validateMagicBytes: detectAudioMagicBytes,
  magicBytesErrorMessage:
    'El contenido binario del archivo no coincide con un formato de audio válido (WAV, M4A/MP4, MP3 o WebM).',
});

const uploadArchivoExcel = createUploadMiddleware({
  fieldName: 'archivo_excel',
  maxBytes: EXCEL_MAX_BYTES,
  maxMbLabel: '4 MB',
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!EXCEL_MIME_TYPES.has(file.mimetype) && !EXCEL_EXTENSIONS.has(ext)) {
      return cb(new Error('Formato de archivo no permitido. Use un libro Excel (.xlsx o .xls).'));
    }
    return cb(null, true);
  },
  validateMagicBytes: detectExcelMagicBytes,
  magicBytesErrorMessage:
    'El contenido binario del archivo no coincide con una firma ZIP/XLSX o XLS válida.',
});

module.exports = {
  PHOTO_MAX_BYTES,
  AUDIO_MAX_BYTES,
  EXCEL_MAX_BYTES,
  detectImageMagicBytes,
  detectAudioMagicBytes,
  detectExcelMagicBytes,
  uploadFotoPerfil,
  uploadAudioVoz,
  uploadArchivoExcel,
};
