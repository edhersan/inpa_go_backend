const path = require('node:path');
const express = require('express');
const { query, getConnection } = require('../config/db');
const { authenticateJWT, authorizeRoles } = require('../middlewares/auth.middleware');
const { uploadAudioVoz } = require('../middlewares/upload.middleware');
const {
  uploadPrivateBlob,
  getPrivateBlobBuffer,
} = require('../services/blobStorage.service');
const { sha256Buffer, generateUuid } = require('../utils/crypto.util');
const { validarGeocerca } = require('../utils/haversine.util');
const {
  extractVoiceSignature,
  compareVoiceBuffers,
} = require('../utils/voiceSpectrum.util');
const { sendSuccess, sendError } = require('../utils/response.util');

const router = express.Router();

const ESTADOS_ASISTENCIA_VALIDOS = new Set(['PRESENTE', 'AUSENTE', 'TARDE', 'EXCUSA']);
const METODOS_CONFIRMACION_VALIDOS = new Set(['VOZ_GPS_FOTO', 'MANUAL_DOCENTE']);

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

// 17. POST /api/v1/sesiones (RF07 - DOCENTE)
router.post('/', authenticateJWT, authorizeRoles('DOCENTE'), async (req, res) => {
  try {
    const { grupo_id, geocerca_id, fecha, hora_inicio } = req.body || {};

    if (!grupo_id || !geocerca_id || !fecha || !hora_inicio) {
      return sendError(
        res,
        400,
        'Los campos grupo_id, geocerca_id, fecha y hora_inicio son obligatorios.'
      );
    }

    const groupRows = await query(
      'SELECT grupo_id FROM grupos WHERE grupo_id = ? AND docente_id = ? AND activo = 1 LIMIT 1',
      [Number(grupo_id), req.user.usuario_id]
    );
    if (groupRows.length === 0) {
      return sendError(
        res,
        403,
        'No eres el docente titular del grupo especificado o el grupo no está activo.'
      );
    }

    const geoRows = await query(
      'SELECT geocerca_id FROM geocercas_institucionales WHERE geocerca_id = ? AND activa = 1 LIMIT 1',
      [Number(geocerca_id)]
    );
    if (geoRows.length === 0) {
      return sendError(res, 404, 'La geocerca institucional seleccionada no existe o está inactiva.');
    }

    const insertResult = await query(
      `INSERT INTO sesiones_academicas (grupo_id, docente_id, geocerca_id, fecha, hora_inicio, estado)
       VALUES (?, ?, ?, ?, ?, 'ABIERTA')`,
      [Number(grupo_id), req.user.usuario_id, Number(geocerca_id), fecha, hora_inicio]
    );

    return sendSuccess(res, 201, 'Sesión académica abierta exitosamente.', {
      sesion_id: insertResult.insertId,
      grupo_id: Number(grupo_id),
      docente_id: req.user.usuario_id,
      geocerca_id: Number(geocerca_id),
      fecha,
      hora_inicio,
      estado: 'ABIERTA',
    });
  } catch (err) {
    return sendError(res, 500, 'Error al abrir la sesión académica.', err.message);
  }
});

// 18. GET /api/v1/sesiones/abiertas (RF07 - ESTUDIANTE o DOCENTE)
router.get(
  '/abiertas',
  authenticateJWT,
  authorizeRoles('ESTUDIANTE', 'DOCENTE'),
  async (req, res) => {
    try {
      const { rol_codigo: rolCodigo, usuario_id: usuarioId } = req.user;
      let rows;

      if (rolCodigo === 'DOCENTE') {
        rows = await query(
          `SELECT s.sesion_id, s.grupo_id, g.codigo_grupo, g.periodo_academico,
                  a.asignatura_id, a.codigo AS asignatura_codigo, a.nombre AS asignatura_nombre,
                  s.fecha, s.hora_inicio, s.estado,
                  geo.geocerca_id, geo.sede, geo.latitud, geo.longitud, geo.radio_metros
           FROM sesiones_academicas s
           INNER JOIN grupos g ON s.grupo_id = g.grupo_id
           INNER JOIN asignaturas a ON g.asignatura_id = a.asignatura_id
           INNER JOIN geocercas_institucionales geo ON s.geocerca_id = geo.geocerca_id
           WHERE s.docente_id = ? AND s.estado IN ('ABIERTA', 'PAUSADA')
           ORDER BY s.fecha DESC, s.hora_inicio DESC`,
          [usuarioId]
        );
      } else {
        rows = await query(
          `SELECT s.sesion_id, s.grupo_id, g.codigo_grupo, g.periodo_academico,
                  a.asignatura_id, a.codigo AS asignatura_codigo, a.nombre AS asignatura_nombre,
                  d.nombre_completo AS docente_nombre,
                  s.fecha, s.hora_inicio, s.estado,
                  geo.geocerca_id, geo.sede, geo.latitud, geo.longitud, geo.radio_metros,
                  ev.evidencia_id, (ev.evidencia_id IS NOT NULL) AS evidencia_enviada,
                  ev.ubicacion_valida, ev.voz_valida, ev.similitud_espectro, ev.enviado_en
           FROM sesiones_academicas s
           INNER JOIN grupos g ON s.grupo_id = g.grupo_id
           INNER JOIN asignaturas a ON g.asignatura_id = a.asignatura_id
           INNER JOIN usuarios d ON s.docente_id = d.usuario_id
           INNER JOIN geocercas_institucionales geo ON s.geocerca_id = geo.geocerca_id
           INNER JOIN inscripciones_grupo ig
             ON ig.grupo_id = s.grupo_id AND ig.estudiante_id = ? AND ig.estado = 'ACTIVO'
           LEFT JOIN evidencias_asistencia ev
             ON ev.sesion_id = s.sesion_id AND ev.estudiante_id = ?
           WHERE s.estado IN ('ABIERTA', 'PAUSADA')
           ORDER BY s.fecha DESC, s.hora_inicio DESC`,
          [usuarioId, usuarioId]
        );
      }

      return sendSuccess(res, 200, 'Sesiones activas consultadas exitosamente.', {
        total: rows.length,
        sesiones: rows,
      });
    } catch (err) {
      return sendError(res, 500, 'Error al consultar sesiones abiertas.', err.message);
    }
  }
);

// 19. PATCH /api/v1/sesiones/:sesionId/pausar (RF07 - DOCENTE)
router.patch(
  '/:sesionId/pausar',
  authenticateJWT,
  authorizeRoles('DOCENTE'),
  async (req, res) => {
    try {
      const sesionId = Number(req.params.sesionId);
      if (!Number.isInteger(sesionId) || sesionId <= 0) {
        return sendError(res, 400, 'Identificador de sesión inválido.');
      }

      const rows = await query(
        'SELECT sesion_id, docente_id, estado FROM sesiones_academicas WHERE sesion_id = ? LIMIT 1',
        [sesionId]
      );
      if (rows.length === 0) {
        return sendError(res, 404, 'Sesión académica no encontrada.');
      }

      const sesion = rows[0];
      if (sesion.docente_id !== req.user.usuario_id) {
        return sendError(res, 403, 'No eres el docente titular de esta sesión.');
      }
      if (sesion.estado !== 'ABIERTA') {
        return sendError(
          res,
          409,
          `Solo se puede pausar una sesión en estado ABIERTA (estado actual: ${sesion.estado}).`
        );
      }

      await query("UPDATE sesiones_academicas SET estado = 'PAUSADA' WHERE sesion_id = ?", [
        sesionId,
      ]);

      return sendSuccess(res, 200, 'Sesión académica pausada exitosamente.', {
        sesion_id: sesionId,
        estado: 'PAUSADA',
      });
    } catch (err) {
      return sendError(res, 500, 'Error al pausar la sesión.', err.message);
    }
  }
);

// 20. PATCH /api/v1/sesiones/:sesionId/reanudar (RF07 - DOCENTE)
router.patch(
  '/:sesionId/reanudar',
  authenticateJWT,
  authorizeRoles('DOCENTE'),
  async (req, res) => {
    try {
      const sesionId = Number(req.params.sesionId);
      if (!Number.isInteger(sesionId) || sesionId <= 0) {
        return sendError(res, 400, 'Identificador de sesión inválido.');
      }

      const rows = await query(
        'SELECT sesion_id, docente_id, estado FROM sesiones_academicas WHERE sesion_id = ? LIMIT 1',
        [sesionId]
      );
      if (rows.length === 0) {
        return sendError(res, 404, 'Sesión académica no encontrada.');
      }

      const sesion = rows[0];
      if (sesion.docente_id !== req.user.usuario_id) {
        return sendError(res, 403, 'No eres el docente titular de esta sesión.');
      }
      if (sesion.estado !== 'PAUSADA') {
        return sendError(
          res,
          409,
          `Solo se puede reanudar una sesión en estado PAUSADA (estado actual: ${sesion.estado}).`
        );
      }

      await query("UPDATE sesiones_academicas SET estado = 'ABIERTA' WHERE sesion_id = ?", [
        sesionId,
      ]);

      return sendSuccess(res, 200, 'Sesión académica reanudada exitosamente.', {
        sesion_id: sesionId,
        estado: 'ABIERTA',
      });
    } catch (err) {
      return sendError(res, 500, 'Error al reanudar la sesión.', err.message);
    }
  }
);

// 21. POST /api/v1/sesiones/:sesionId/evidencia-estudiante (RF08, RF09 - ESTUDIANTE)
router.post(
  '/:sesionId/evidencia-estudiante',
  authenticateJWT,
  authorizeRoles('ESTUDIANTE'),
  uploadAudioVoz,
  async (req, res) => {
    try {
      const sesionId = Number(req.params.sesionId);
      if (!Number.isInteger(sesionId) || sesionId <= 0) {
        return sendError(res, 400, 'Identificador de sesión inválido.');
      }

      if (!req.file) {
        return sendError(res, 400, 'El archivo de audio (audio_voz) es obligatorio.');
      }

      const {
        latitud_reportada,
        longitud_reportada,
        precision_metros = null,
        transcripcion_voz = null,
      } = req.body || {};

      if (latitud_reportada === undefined || longitud_reportada === undefined) {
        return sendError(
          res,
          400,
          'Las coordenadas latitud_reportada y longitud_reportada son obligatorias.'
        );
      }

      const latRep = Number(latitud_reportada);
      const lonRep = Number(longitud_reportada);
      const precVal =
        precision_metros !== null && precision_metros !== ''
          ? Number(precision_metros)
          : null;

      if (!Number.isFinite(latRep) || !Number.isFinite(lonRep)) {
        return sendError(res, 400, 'Las coordenadas GPS enviadas no son numéricas válidas.');
      }

      const sesionRows = await query(
        `SELECT s.sesion_id, s.grupo_id, s.estado,
                geo.latitud AS sede_latitud, geo.longitud AS sede_longitud, geo.radio_metros
         FROM sesiones_academicas s
         INNER JOIN geocercas_institucionales geo ON s.geocerca_id = geo.geocerca_id
         WHERE s.sesion_id = ?
         LIMIT 1`,
        [sesionId]
      );
      if (sesionRows.length === 0) {
        return sendError(res, 404, 'Sesión académica no encontrada.');
      }

      const sesion = sesionRows[0];

      // Validar inscripción activa del estudiante en el grupo
      const inscRows = await query(
        `SELECT inscripcion_id FROM inscripciones_grupo
         WHERE grupo_id = ? AND estudiante_id = ? AND estado = 'ACTIVO'
         LIMIT 1`,
        [sesion.grupo_id, req.user.usuario_id]
      );
      if (inscRows.length === 0) {
        return sendError(
          res,
          403,
          'No estás inscrito activamente en el grupo de esta sesión académica.'
        );
      }

      // Máquina de estados: solo ABIERTA admite evidencias
      if (sesion.estado !== 'ABIERTA') {
        return sendError(
          res,
          409,
          `No es posible enviar evidencia porque la sesión está en estado ${sesion.estado}.`
        );
      }

      // Validación geográfica Haversine en servidor (RF09)
      const { distancia_metros, ubicacion_valida } = validarGeocerca(
        latRep,
        lonRep,
        sesion.sede_latitud,
        sesion.sede_longitud,
        sesion.radio_metros
      );

      // Análisis espectral de voz FFT en memoria (RF08)
      const sampleSig = extractVoiceSignature(req.file.buffer);
      if (sampleSig.activeFrames === 0) {
        return sendError(
          res,
          400,
          'El audio de evidencia no contiene voz audible (silencio detectado).'
        );
      }

      const audioHash = sha256Buffer(req.file.buffer);
      const ext = resolveAudioExt(req.file);
      const mimeType = req.file.mimetype || 'audio/wav';
      const evidenceBlobPath = `audios/sesion-${sesionId}-${req.user.usuario_id}-${generateUuid()}.${ext}`;

      const storedEvidencePath = await uploadPrivateBlob(
        evidenceBlobPath,
        req.file.buffer,
        mimeType
      );

      // Consultar perfil base de voz del estudiante
      const userRows = await query(
        'SELECT perfil_voz_ruta FROM usuarios WHERE usuario_id = ? LIMIT 1',
        [req.user.usuario_id]
      );
      const baselinePath = userRows[0]?.perfil_voz_ruta || null;

      let similitudEspectro = 100;
      let vozValida = 1;
      let enrolamientoInicial = false;

      if (baselinePath) {
        const baselineBuffer = await getPrivateBlobBuffer(baselinePath);
        if (baselineBuffer) {
          const comparison = compareVoiceBuffers(req.file.buffer, baselineBuffer);
          similitudEspectro = comparison.similitud_espectro;
          vozValida = comparison.voz_valida;
        } else {
          // Si el blob de referencia no existiera, enrolar esta muestra válida
          const newBaselinePath = `audios/baseline-${req.user.usuario_id}-${generateUuid()}.${ext}`;
          const storedBaselinePath = await uploadPrivateBlob(
            newBaselinePath,
            req.file.buffer,
            mimeType
          );
          await query(
            'UPDATE usuarios SET perfil_voz_ruta = ?, perfil_voz_hash_sha256 = ? WHERE usuario_id = ?',
            [storedBaselinePath, audioHash, req.user.usuario_id]
          );
          enrolamientoInicial = true;
        }
      } else {
        const newBaselinePath = `audios/baseline-${req.user.usuario_id}-${generateUuid()}.${ext}`;
        const storedBaselinePath = await uploadPrivateBlob(
          newBaselinePath,
          req.file.buffer,
          mimeType
        );
        await query(
          'UPDATE usuarios SET perfil_voz_ruta = ?, perfil_voz_hash_sha256 = ? WHERE usuario_id = ?',
          [storedBaselinePath, audioHash, req.user.usuario_id]
        );
        enrolamientoInicial = true;
      }

      // Persistencia idempotente (RNF03)
      await query(
        `INSERT INTO evidencias_asistencia (
           sesion_id, estudiante_id, latitud_reportada, longitud_reportada,
           precision_metros, distancia_metros, ubicacion_valida,
           audio_voz_ruta, audio_voz_hash_sha256, transcripcion_voz,
           similitud_espectro, voz_valida
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           latitud_reportada = VALUES(latitud_reportada),
           longitud_reportada = VALUES(longitud_reportada),
           precision_metros = VALUES(precision_metros),
           distancia_metros = VALUES(distancia_metros),
           ubicacion_valida = VALUES(ubicacion_valida),
           audio_voz_ruta = VALUES(audio_voz_ruta),
           audio_voz_hash_sha256 = VALUES(audio_voz_hash_sha256),
           transcripcion_voz = VALUES(transcripcion_voz),
           similitud_espectro = VALUES(similitud_espectro),
           voz_valida = VALUES(voz_valida),
           enviado_en = CURRENT_TIMESTAMP`,
        [
          sesionId,
          req.user.usuario_id,
          latRep,
          lonRep,
          precVal,
          distancia_metros,
          ubicacion_valida,
          storedEvidencePath,
          audioHash,
          transcripcion_voz ? String(transcripcion_voz).slice(0, 255) : null,
          similitudEspectro,
          vozValida,
        ]
      );

      const savedRows = await query(
        'SELECT evidencia_id FROM evidencias_asistencia WHERE sesion_id = ? AND estudiante_id = ? LIMIT 1',
        [sesionId, req.user.usuario_id]
      );

      return sendSuccess(res, 201, 'Evidencia biométrica y GPS registrada exitosamente.', {
        evidencia_id: savedRows[0]?.evidencia_id || null,
        sesion_id: sesionId,
        estudiante_id: req.user.usuario_id,
        distancia_metros,
        ubicacion_valida,
        similitud_espectro: similitudEspectro,
        voz_valida: vozValida,
        enrolamiento_inicial: enrolamientoInicial,
        audio_voz_hash_sha256: audioHash,
      });
    } catch (err) {
      return sendError(res, 500, 'Error al registrar evidencia del estudiante.', err.message);
    }
  }
);

// 22. GET /api/v1/sesiones/:sesionId/lista-asistencia (RF10, RF14 - DOCENTE)
router.get(
  '/:sesionId/lista-asistencia',
  authenticateJWT,
  authorizeRoles('DOCENTE'),
  async (req, res) => {
    try {
      const sesionId = Number(req.params.sesionId);
      if (!Number.isInteger(sesionId) || sesionId <= 0) {
        return sendError(res, 400, 'Identificador de sesión inválido.');
      }

      const sesionRows = await query(
        `SELECT s.sesion_id, s.grupo_id, s.docente_id, s.fecha, s.hora_inicio, s.hora_fin, s.estado,
                g.codigo_grupo, g.periodo_academico,
                a.asignatura_id, a.codigo AS asignatura_codigo, a.nombre AS asignatura_nombre,
                geo.geocerca_id, geo.sede, geo.latitud, geo.longitud, geo.radio_metros
         FROM sesiones_academicas s
         INNER JOIN grupos g ON s.grupo_id = g.grupo_id
         INNER JOIN asignaturas a ON g.asignatura_id = a.asignatura_id
         INNER JOIN geocercas_institucionales geo ON s.geocerca_id = geo.geocerca_id
         WHERE s.sesion_id = ?
         LIMIT 1`,
        [sesionId]
      );

      if (sesionRows.length === 0) {
        return sendError(res, 404, 'Sesión académica no encontrada.');
      }

      const sesion = sesionRows[0];
      if (sesion.docente_id !== req.user.usuario_id) {
        return sendError(res, 403, 'No eres el docente titular de esta sesión.');
      }

      const studentRows = await query(
        `SELECT u.usuario_id AS estudiante_id, u.documento, u.codigo_institucional,
                u.nombre_completo, u.correo_institucional,
                ev.evidencia_id, ev.distancia_metros, ev.ubicacion_valida,
                ev.similitud_espectro, ev.voz_valida, ev.transcripcion_voz, ev.enviado_en,
                ra.asistencia_id, ra.estado AS estado_asistencia,
                ra.metodo_confirmacion, ra.observacion, ra.confirmado_en
         FROM inscripciones_grupo ig
         INNER JOIN usuarios u ON ig.estudiante_id = u.usuario_id
         LEFT JOIN evidencias_asistencia ev
           ON ev.sesion_id = ? AND ev.estudiante_id = u.usuario_id
         LEFT JOIN registros_asistencia ra
           ON ra.sesion_id = ? AND ra.estudiante_id = u.usuario_id
         WHERE ig.grupo_id = ? AND ig.estado = 'ACTIVO'
         ORDER BY u.nombre_completo ASC`,
        [sesionId, sesionId, sesion.grupo_id]
      );

      const estudiantes = studentRows.map((row) => ({
        ...row,
        foto_url: `/api/v1/usuarios/${row.estudiante_id}/foto`,
      }));

      return sendSuccess(res, 200, 'Lista de asistencia consultada exitosamente.', {
        sesion,
        total_estudiantes: estudiantes.length,
        estudiantes,
      });
    } catch (err) {
      return sendError(res, 500, 'Error al consultar la lista de asistencia.', err.message);
    }
  }
);

// 24. PUT /api/v1/sesiones/:sesionId/asistencias (RF10, RNF03 - DOCENTE)
router.put(
  '/:sesionId/asistencias',
  authenticateJWT,
  authorizeRoles('DOCENTE'),
  async (req, res) => {
    try {
      const sesionId = Number(req.params.sesionId);
      if (!Number.isInteger(sesionId) || sesionId <= 0) {
        return sendError(res, 400, 'Identificador de sesión inválido.');
      }

      const { registros } = req.body || {};
      if (!Array.isArray(registros) || registros.length === 0) {
        return sendError(
          res,
          400,
          'Debe enviar un arreglo no vacío en el campo registros.'
        );
      }
      if (registros.length > 500) {
        return sendError(
          res,
          400,
          'El lote excede el máximo permitido de 500 registros por petición.'
        );
      }

      const sesionRows = await query(
        'SELECT sesion_id, grupo_id, docente_id, estado FROM sesiones_academicas WHERE sesion_id = ? LIMIT 1',
        [sesionId]
      );
      if (sesionRows.length === 0) {
        return sendError(res, 404, 'Sesión académica no encontrada.');
      }

      const sesion = sesionRows[0];
      if (sesion.docente_id !== req.user.usuario_id) {
        return sendError(res, 403, 'No eres el docente titular de esta sesión.');
      }

      if (sesion.estado === 'CERRADA') {
        return sendError(
          res,
          409,
          'No es posible modificar asistencias de una sesión CERRADA.'
        );
      }

      for (const item of registros) {
        const estudianteId = Number(item.estudiante_id);
        if (
          !Number.isInteger(estudianteId) ||
          estudianteId <= 0 ||
          !ESTADOS_ASISTENCIA_VALIDOS.has(item.estado)
        ) {
          return sendError(
            res,
            400,
            'Cada registro debe incluir estudiante_id válido y un estado permitido (PRESENTE, AUSENTE, TARDE o EXCUSA).'
          );
        }
        const metodo = item.metodo_confirmacion || 'VOZ_GPS_FOTO';
        if (!METODOS_CONFIRMACION_VALIDOS.has(metodo)) {
          return sendError(
            res,
            400,
            `Método de confirmación no válido: ${metodo}.`
          );
        }
        if (item.evidencia_id !== undefined && item.evidencia_id !== null) {
          const evId = Number(item.evidencia_id);
          if (!Number.isInteger(evId) || evId <= 0) {
            return sendError(res, 400, 'Identificador de evidencia inválido.');
          }
        }
      }

      // Validación IDOR: verificar que todos los estudiantes pertenezcan activamente al grupo de la sesión
      const enrolledRows = await query(
        "SELECT estudiante_id FROM inscripciones_grupo WHERE grupo_id = ? AND estado = 'ACTIVO'",
        [sesion.grupo_id]
      );
      const enrolledSet = new Set(enrolledRows.map((r) => Number(r.estudiante_id)));

      for (const item of registros) {
        const estId = Number(item.estudiante_id);
        if (!enrolledSet.has(estId)) {
          return sendError(
            res,
            403,
            `El estudiante ${estId} no se encuentra inscrito activamente en el grupo de esta sesión.`
          );
        }
      }

      // Validación IDOR: si se envía evidencia_id, comprobar que corresponde a (sesionId, estudiante_id)
      const itemsWithEvidence = registros.filter(
        (item) => item.evidencia_id !== undefined && item.evidencia_id !== null
      );
      if (itemsWithEvidence.length > 0) {
        const evidenceRows = await query(
          'SELECT evidencia_id, estudiante_id FROM evidencias_asistencia WHERE sesion_id = ?',
          [sesionId]
        );
        const evidenceOwnerMap = new Map(
          evidenceRows.map((r) => [Number(r.evidencia_id), Number(r.estudiante_id)])
        );
        for (const item of itemsWithEvidence) {
          const evId = Number(item.evidencia_id);
          const estId = Number(item.estudiante_id);
          if (evidenceOwnerMap.get(evId) !== estId) {
            return sendError(
              res,
              400,
              `La evidencia ${evId} no pertenece al estudiante ${estId} en esta sesión.`
            );
          }
        }
      }

      const conn = await getConnection();
      try {
        await conn.beginTransaction();

        for (const item of registros) {
          const metodo = item.metodo_confirmacion || 'VOZ_GPS_FOTO';
          const evidenciaId = item.evidencia_id ? Number(item.evidencia_id) : null;
          const observacion = item.observacion
            ? String(item.observacion).slice(0, 255)
            : null;

          await conn.execute(
            `INSERT INTO registros_asistencia (
               sesion_id, estudiante_id, evidencia_id, estado,
               metodo_confirmacion, observacion, confirmado_por
             ) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               evidencia_id = VALUES(evidencia_id),
               estado = VALUES(estado),
               metodo_confirmacion = VALUES(metodo_confirmacion),
               observacion = VALUES(observacion),
               confirmado_por = VALUES(confirmado_por),
               confirmado_en = CURRENT_TIMESTAMP`,
            [
              sesionId,
              Number(item.estudiante_id),
              evidenciaId,
              item.estado,
              metodo,
              observacion,
              req.user.usuario_id,
            ]
          );
        }

        await conn.commit();
      } catch (txErr) {
        await conn.rollback();
        throw txErr;
      } finally {
        conn.release();
      }

      return sendSuccess(res, 200, 'Asistencias confirmadas exitosamente.', {
        sesion_id: sesionId,
        registros_procesados: registros.length,
      });
    } catch (err) {
      return sendError(res, 500, 'Error al guardar las asistencias.', err.message);
    }
  }
);

// 25. PATCH /api/v1/sesiones/:sesionId/finalizar (RF07 - DOCENTE)
router.patch(
  '/:sesionId/finalizar',
  authenticateJWT,
  authorizeRoles('DOCENTE'),
  async (req, res) => {
    try {
      const sesionId = Number(req.params.sesionId);
      if (!Number.isInteger(sesionId) || sesionId <= 0) {
        return sendError(res, 400, 'Identificador de sesión inválido.');
      }

      const sesionRows = await query(
        'SELECT sesion_id, docente_id, estado FROM sesiones_academicas WHERE sesion_id = ? LIMIT 1',
        [sesionId]
      );
      if (sesionRows.length === 0) {
        return sendError(res, 404, 'Sesión académica no encontrada.');
      }

      const sesion = sesionRows[0];
      if (sesion.docente_id !== req.user.usuario_id) {
        return sendError(res, 403, 'No eres el docente titular de esta sesión.');
      }
      if (sesion.estado === 'CERRADA') {
        return sendError(res, 409, 'La sesión académica ya se encuentra CERRADA.');
      }

      const horaFin = req.body?.hora_fin || null;
      await query(
        `UPDATE sesiones_academicas
         SET estado = 'CERRADA', hora_fin = COALESCE(?, CURTIME()), cerrada_en = NOW()
         WHERE sesion_id = ?`,
        [horaFin, sesionId]
      );

      return sendSuccess(res, 200, 'Sesión académica finalizada definitivamente.', {
        sesion_id: sesionId,
        estado: 'CERRADA',
      });
    } catch (err) {
      return sendError(res, 500, 'Error al finalizar la sesión académica.', err.message);
    }
  }
);

module.exports = router;
