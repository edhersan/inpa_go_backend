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

function createUploadMiddleware({ fieldName, maxBytes, maxMbLabel, fileFilter }) {
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
      if (!err) {
        return next();
      }
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
});

module.exports = {
  PHOTO_MAX_BYTES,
  AUDIO_MAX_BYTES,
  EXCEL_MAX_BYTES,
  uploadFotoPerfil,
  uploadAudioVoz,
  uploadArchivoExcel,
};
