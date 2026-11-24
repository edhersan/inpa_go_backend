const path = require('node:path');
const express = require('express');
const { query } = require('../config/db');
const { authenticateJWT, authorizeRoles } = require('../middlewares/auth.middleware');
const { uploadAudioVoz } = require('../middlewares/upload.middleware');
const {
  uploadPrivateBlob,
  getPrivateBlobStream,
  deletePrivateBlob,
} = require('../services/blobStorage.service');
const {
  hashPassword,
  sha256Buffer,
  generateUuid,
} = require('../utils/crypto.util');
const { extractVoiceSignature } = require('../utils/voiceSpectrum.util');
const { sendSuccess, sendError } = require('../utils/response.util');

const router = express.Router();

function resolveAudioExt(file) {
  const extFromName = path.extname(file.originalname || '').replace('.', '').toLowerCase();
  if (['wav', 'm4a', 'mp4', 'mp3', 'webm'].includes(extFromName)) {
    return extFromName;
  }
  const mimeMap = {
    'audio/wav': 'wav',
    'audio/wave': 'wav',
    'audio/x-wav': 'wav',
    'audio/m4a': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/webm': 'webm',
  };
  return mimeMap[file.mimetype] || 'wav';
}

// 5. POST /api/v1/usuarios/me/perfil-voz (RF08)
router.post('/me/perfil-voz', authenticateJWT, uploadAudioVoz, async (req, res) => {
  try {
    if (!req.file) {
      return sendError(res, 400, 'El archivo de audio (audio_voz) es obligatorio.');
    }

    const signature = extractVoiceSignature(req.file.buffer);
    if (signature.activeFrames === 0) {
      return sendError(
        res,
        400,
        'El audio enviado no contiene voz audible (silencio detectado).'
      );
    }

    const userRows = await query(
      'SELECT perfil_voz_ruta FROM usuarios WHERE usuario_id = ? LIMIT 1',
      [req.user.usuario_id]
    );
    if (userRows.length === 0) {
      return sendError(res, 404, 'Usuario no encontrado.');
    }

    const previousPath = userRows[0].perfil_voz_ruta;
    const ext = resolveAudioExt(req.file);
    const audioHash = sha256Buffer(req.file.buffer);
    const blobPathname = `audios/baseline-${req.user.usuario_id}-${generateUuid()}.${ext}`;

    const storedPathname = await uploadPrivateBlob(
      blobPathname,
      req.file.buffer,
      req.file.mimetype || 'audio/wav'
    );

    await query(
      `UPDATE usuarios
       SET perfil_voz_ruta = ?, perfil_voz_hash_sha256 = ?
       WHERE usuario_id = ?`,
      [storedPathname, audioHash, req.user.usuario_id]
    );

    if (previousPath && previousPath !== storedPathname) {
      try {
        await deletePrivateBlob(previousPath);
      } catch (_cleanupErr) {
        // No bloquear la respuesta si el blob anterior ya había sido eliminado
      }
    }

    return sendSuccess(res, 200, 'Perfil de voz registrado exitosamente.', {
      usuario_id: req.user.usuario_id,
      perfil_voz_hash_sha256: audioHash,
      active_frames: signature.activeFrames,
    });
  } catch (err) {
    return sendError(res, 500, 'Error al registrar el perfil de voz.', err.message);
  }
});

// 6. GET /api/v1/usuarios (RF03, RF06 - ADMIN_BIENESTAR o directorio de estudiantes activos para DOCENTE)
router.get(
  '/',
  authenticateJWT,
  authorizeRoles('ADMIN_BIENESTAR', 'DOCENTE'),
  async (req, res) => {
    try {
      const { rol_codigo, activo } = req.query;
      const requesterRol = req.user.rol_codigo;

      // Para DOCENTE: restringir exclusivamente a estudiantes activos y campos públicos de directorio
      if (requesterRol === 'DOCENTE') {
        const requestedRol = rol_codigo ? String(rol_codigo).trim().toUpperCase() : '';
        const requestedActivo = activo !== undefined && activo !== '' ? Number(activo) : null;

        if (requestedRol !== 'ESTUDIANTE' || requestedActivo !== 1) {
          return sendError(
            res,
            403,
            'El rol DOCENTE únicamente puede consultar el directorio de estudiantes activos (rol_codigo=ESTUDIANTE&activo=1).'
          );
        }

        const rows = await query(
          `SELECT u.usuario_id, u.documento, u.codigo_institucional,
                  u.nombre_completo, u.correo_institucional
           FROM usuarios u
           INNER JOIN roles r ON u.rol_id = r.rol_id
           WHERE r.codigo = 'ESTUDIANTE' AND u.activo = 1
           ORDER BY u.nombre_completo ASC`
        );

        return sendSuccess(res, 200, 'Directorio de estudiantes activos consultado exitosamente.', {
          total: rows.length,
          usuarios: rows,
        });
      }

      const conditions = [];
      const params = [];

      if (rol_codigo) {
        conditions.push('r.codigo = ?');
        params.push(String(rol_codigo).trim().toUpperCase());
      }

      if (activo !== undefined && activo !== '') {
        conditions.push('u.activo = ?');
        params.push(Number(activo) === 1 ? 1 : 0);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = await query(
        `SELECT u.usuario_id, u.rol_id, r.codigo AS rol_codigo, r.nombre AS rol_nombre,
                u.documento, u.codigo_institucional, u.nombre_completo, u.correo_institucional,
                u.foto_hash_sha256, (u.perfil_voz_ruta IS NOT NULL) AS tiene_perfil_voz,
                u.biometria_habilitada, u.activo, u.creado_en, u.actualizado_en
         FROM usuarios u
         INNER JOIN roles r ON u.rol_id = r.rol_id
         ${whereClause}
         ORDER BY u.usuario_id DESC`,
        params
      );

      return sendSuccess(res, 200, 'Usuarios consultados exitosamente.', {
        total: rows.length,
        usuarios: rows,
      });
    } catch (err) {
      return sendError(res, 500, 'Error al consultar usuarios.', err.message);
    }
  }
);

// 7. POST /api/v1/usuarios/docentes (RF03 - ADMIN_BIENESTAR)
router.post(
  '/docentes',
  authenticateJWT,
  authorizeRoles('ADMIN_BIENESTAR'),
  async (req, res) => {
    try {
      const {
        documento,
        codigo_institucional = null,
        nombre_completo,
        correo_institucional,
        password_temporal,
      } = req.body || {};

      if (!documento || !nombre_completo || !correo_institucional || !password_temporal) {
        return sendError(
          res,
          400,
          'Los campos documento, nombre_completo, correo_institucional y password_temporal son obligatorios.'
        );
      }

      const roleRows = await query(
        "SELECT rol_id, codigo FROM roles WHERE codigo = 'DOCENTE' LIMIT 1"
      );
      if (roleRows.length === 0) {
        return sendError(res, 500, 'No se encontró el rol DOCENTE en el catálogo.');
      }

      const passwordHash = await hashPassword(password_temporal);
      const cleanDoc = String(documento).trim();
      const cleanEmail = String(correo_institucional).trim().toLowerCase();
      const cleanCode = codigo_institucional ? String(codigo_institucional).trim() : null;

      const result = await query(
        `INSERT INTO usuarios (
           rol_id, documento, codigo_institucional, nombre_completo,
           correo_institucional, password_hash
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          roleRows[0].rol_id,
          cleanDoc,
          cleanCode,
          String(nombre_completo).trim(),
          cleanEmail,
          passwordHash,
        ]
      );

      return sendSuccess(res, 201, 'Docente creado exitosamente.', {
        usuario_id: result.insertId,
        rol_codigo: 'DOCENTE',
        documento: cleanDoc,
        codigo_institucional: cleanCode,
        nombre_completo: String(nombre_completo).trim(),
        correo_institucional: cleanEmail,
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return sendError(
          res,
          409,
          'Ya existe un usuario con el mismo documento, correo o código institucional.',
          err.message
        );
      }
      return sendError(res, 500, 'Error al crear la cuenta docente.', err.message);
    }
  }
);

// 8. PATCH /api/v1/usuarios/:usuarioId (RF03 - ADMIN_BIENESTAR)
router.patch(
  '/:usuarioId',
  authenticateJWT,
  authorizeRoles('ADMIN_BIENESTAR'),
  async (req, res) => {
    try {
      const usuarioId = Number(req.params.usuarioId);
      if (!Number.isInteger(usuarioId) || usuarioId <= 0) {
        return sendError(res, 400, 'Identificador de usuario inválido.');
      }

      const { nombre_completo, codigo_institucional, activo } = req.body || {};
      const updates = [];
      const params = [];

      if (nombre_completo !== undefined) {
        updates.push('nombre_completo = ?');
        params.push(String(nombre_completo).trim());
      }
      if (codigo_institucional !== undefined) {
        updates.push('codigo_institucional = ?');
        params.push(codigo_institucional ? String(codigo_institucional).trim() : null);
      }
      if (activo !== undefined) {
        const activoVal = Number(activo);
        if (activoVal !== 0 && activoVal !== 1) {
          return sendError(res, 400, 'El campo activo debe ser 1 o 0.');
        }
        updates.push('activo = ?');
        params.push(activoVal);
      }

      if (updates.length === 0) {
        return sendError(
          res,
          400,
          'Debe proporcionar al menos un campo para actualizar (nombre_completo, codigo_institucional o activo).'
        );
      }

      params.push(usuarioId);
      const result = await query(
        `UPDATE usuarios SET ${updates.join(', ')} WHERE usuario_id = ?`,
        params
      );

      if (result.affectedRows === 0) {
        return sendError(res, 404, 'Usuario no encontrado.');
      }

      return sendSuccess(res, 200, 'Usuario actualizado exitosamente.', {
        usuario_id: usuarioId,
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return sendError(
          res,
          409,
          'El código institucional ya pertenece a otro usuario.',
          err.message
        );
      }
      return sendError(res, 500, 'Error al actualizar el usuario.', err.message);
    }
  }
);

// 23. GET /api/v1/usuarios/:usuarioId/foto (RF14, RNF06 - Stream privado desde Vercel Blob)
router.get('/:usuarioId/foto', authenticateJWT, async (req, res) => {
  try {
    const targetUserId = Number(req.params.usuarioId);
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return sendError(res, 400, 'Identificador de usuario inválido.');
    }

    const { usuario_id: requesterId, rol_codigo: requesterRol } = req.user;

    if (requesterRol === 'ESTUDIANTE') {
      if (requesterId !== targetUserId) {
        return sendError(
          res,
          403,
          'Un estudiante únicamente puede consultar su propia fotografía.'
        );
      }
    } else if (requesterRol === 'DOCENTE') {
      if (requesterId !== targetUserId) {
        const enrolledRows = await query(
          `SELECT 1
           FROM inscripciones_grupo ig
           INNER JOIN grupos g ON ig.grupo_id = g.grupo_id
           WHERE ig.estudiante_id = ? AND g.docente_id = ? AND ig.estado = 'ACTIVO'
           LIMIT 1`,
          [targetUserId, requesterId]
        );
        if (enrolledRows.length === 0) {
          return sendError(
            res,
            403,
            'No tienes autorización para ver la fotografía de un estudiante fuera de tus grupos.'
          );
        }
      }
    } else if (requesterRol !== 'ADMIN_BIENESTAR') {
      return sendError(res, 403, 'Rol no autorizado para consultar fotografías.');
    }

    const userRows = await query(
      'SELECT foto_ruta, foto_mime_type FROM usuarios WHERE usuario_id = ? LIMIT 1',
      [targetUserId]
    );
    if (userRows.length === 0 || !userRows[0].foto_ruta) {
      return sendError(res, 404, 'Fotografía no encontrada para el usuario especificado.');
    }

    const blob = await getPrivateBlobStream(userRows[0].foto_ruta);
    if (!blob) {
      return sendError(
        res,
        404,
        'El archivo de fotografía no se encuentra disponible en inpa-go-store.'
      );
    }

    res.setHeader(
      'Content-Type',
      userRows[0].foto_mime_type || blob.contentType || 'image/jpeg'
    );
    res.setHeader('Cache-Control', 'private, max-age=300');

    blob.stream.on('error', () => {
      if (!res.headersSent) {
        sendError(res, 500, 'Error al transmitir la fotografía privada.');
      }
    });

    return blob.stream.pipe(res);
  } catch (err) {
    return sendError(res, 500, 'Error al obtener la fotografía del usuario.', err.message);
  }
});

module.exports = router;
