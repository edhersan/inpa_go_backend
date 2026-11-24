const express = require('express');
const XLSX = require('xlsx');
const { query, getConnection } = require('../config/db');
const { authenticateJWT, authorizeRoles } = require('../middlewares/auth.middleware');
const {
  uploadArchivoExcel,
  detectExcelMagicBytes,
} = require('../middlewares/upload.middleware');
const { hashPassword } = require('../utils/crypto.util');
const { sendSuccess, sendError } = require('../utils/response.util');

const router = express.Router();

const REQUIRED_EXCEL_COLUMNS = ['documento', 'nombre_completo', 'correo_institucional'];
const MAX_EXCEL_ROWS = 1000;

function sanitizeExcelCell(value) {
  if (typeof value !== 'string') {
    return value;
  }
  // Eliminar caracteres de control y prefijos peligrosos de CSV/Formula Injection (=, +, -, @, \t, \r)
  const withoutControl = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
  return withoutControl.replace(/^[=+\-@\t\r]+/, '').trim();
}

function normalizeRowKeys(row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    const cleanKey = String(key).trim().toLowerCase();
    normalized[cleanKey] = typeof value === 'string' ? sanitizeExcelCell(value) : value;
  }
  return normalized;
}

// 9. POST /api/v1/importaciones/excel (RF04, RF06 - ADMIN_BIENESTAR)
router.post(
  '/importaciones/excel',
  authenticateJWT,
  authorizeRoles('ADMIN_BIENESTAR'),
  uploadArchivoExcel,
  async (req, res) => {
    try {
      if (!req.file) {
        return sendError(res, 400, 'El archivo Excel (archivo_excel) es obligatorio.');
      }

      // Defensa en profundidad: verificar firma binaria ZIP/XLSX o OLE2/XLS antes de parsear
      if (!detectExcelMagicBytes(req.file.buffer)) {
        return sendError(
          res,
          400,
          'El archivo cargado no posee una firma binaria ZIP/XLSX o XLS válida.'
        );
      }

      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) {
        return sendError(
          res,
          422,
          'El libro de Excel no contiene hojas de cálculo válidas.'
        );
      }

      const sheet = workbook.Sheets[firstSheetName];
      const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      if (!Array.isArray(rawRows) || rawRows.length === 0) {
        return sendError(
          res,
          422,
          'La primera hoja del archivo Excel está vacía.'
        );
      }

      if (rawRows.length > MAX_EXCEL_ROWS) {
        return sendError(
          res,
          422,
          `El archivo excede el límite máximo permitido de ${MAX_EXCEL_ROWS} filas por importación.`,
          { max_filas: MAX_EXCEL_ROWS, filas_recibidas: rawRows.length }
        );
      }

      const firstNormalized = normalizeRowKeys(rawRows[0]);
      const availableColumns = new Set(Object.keys(firstNormalized));
      const missingColumns = REQUIRED_EXCEL_COLUMNS.filter(
        (col) => !availableColumns.has(col)
      );

      if (missingColumns.length > 0) {
        return sendError(
          res,
          422,
          'El archivo Excel no contiene todas las columnas obligatorias.',
          { columnas_faltantes: missingColumns }
        );
      }

      const rolesRows = await query('SELECT rol_id, codigo FROM roles');
      const rolesMap = new Map(rolesRows.map((r) => [r.codigo, r.rol_id]));

      let filasExitosas = 0;
      const errores = [];
      const conn = await getConnection();

      try {
        for (let idx = 0; idx < rawRows.length; idx += 1) {
          const excelRowNumber = idx + 2;
          const row = normalizeRowKeys(rawRows[idx]);

          try {
            await conn.beginTransaction();

            const documento = String(row.documento || '').trim();
            const nombreCompleto = String(row.nombre_completo || '').trim();
            const correo = String(row.correo_institucional || '').trim().toLowerCase();
            const codigoInstitucional = row.codigo_institucional
              ? String(row.codigo_institucional).trim()
              : null;
            const rolCodigo = String(row.rol_codigo || 'ESTUDIANTE')
              .trim()
              .toUpperCase();

            if (!documento || !nombreCompleto || !correo) {
              throw new Error(
                'Faltan valores obligatorios (documento, nombre_completo o correo_institucional).'
              );
            }

            const rolId = rolesMap.get(rolCodigo);
            if (!rolId) {
              throw new Error(`Rol no reconocido: ${rolCodigo}.`);
            }

            // 1. Upsert usuario
            const [existingUsers] = await conn.execute(
              'SELECT usuario_id FROM usuarios WHERE documento = ? OR correo_institucional = ? LIMIT 1',
              [documento, correo]
            );

            let usuarioId;
            if (existingUsers.length > 0) {
              usuarioId = existingUsers[0].usuario_id;
              await conn.execute(
                `UPDATE usuarios
                 SET nombre_completo = ?, codigo_institucional = COALESCE(?, codigo_institucional), activo = 1
                 WHERE usuario_id = ?`,
                [nombreCompleto, codigoInstitucional, usuarioId]
              );
            } else {
              const defaultPass = String(row.password || documento);
              const passwordHash = await hashPassword(defaultPass);
              const [insertedUser] = await conn.execute(
                `INSERT INTO usuarios (
                   rol_id, documento, codigo_institucional, nombre_completo,
                   correo_institucional, password_hash
                 ) VALUES (?, ?, ?, ?, ?, ?)`,
                [rolId, documento, codigoInstitucional, nombreCompleto, correo, passwordHash]
              );
              usuarioId = insertedUser.insertId;
            }

            // 2. Opcional: Asignatura, Grupo e Inscripción si vienen en el Excel
            const codigoAsignatura = String(row.codigo_asignatura || '').trim();
            const nombreAsignatura = String(row.nombre_asignatura || '').trim();
            const codigoGrupo = String(row.codigo_grupo || '').trim();
            const periodoAcademico = String(row.periodo_academico || '').trim();

            if (codigoAsignatura) {
              const creditos = row.creditos ? Number(row.creditos) : null;
              await conn.execute(
                `INSERT INTO asignaturas (codigo, nombre, creditos, activa)
                 VALUES (?, ?, ?, 1)
                 ON DUPLICATE KEY UPDATE
                   nombre = VALUES(nombre),
                   creditos = COALESCE(VALUES(creditos), creditos),
                   activa = 1`,
                [codigoAsignatura, nombreAsignatura || codigoAsignatura, creditos]
              );

              const [asigRows] = await conn.execute(
                'SELECT asignatura_id FROM asignaturas WHERE codigo = ? LIMIT 1',
                [codigoAsignatura]
              );
              const asignaturaId = asigRows[0].asignatura_id;

              if (codigoGrupo && periodoAcademico) {
                let docenteId = req.user.usuario_id;
                const docenteCorreo = String(row.correo_docente || '').trim().toLowerCase();
                const docenteDoc = String(row.documento_docente || '').trim();

                if (docenteCorreo || docenteDoc) {
                  const [docRows] = await conn.execute(
                    'SELECT usuario_id FROM usuarios WHERE correo_institucional = ? OR documento = ? LIMIT 1',
                    [docenteCorreo || '', docenteDoc || '']
                  );
                  if (docRows.length > 0) {
                    docenteId = docRows[0].usuario_id;
                  }
                }

                await conn.execute(
                  `INSERT INTO grupos (asignatura_id, docente_id, codigo_grupo, periodo_academico, activo)
                   VALUES (?, ?, ?, ?, 1)
                   ON DUPLICATE KEY UPDATE
                     docente_id = VALUES(docente_id),
                     activo = 1`,
                  [asignaturaId, docenteId, codigoGrupo, periodoAcademico]
                );

                const [grpRows] = await conn.execute(
                  `SELECT grupo_id FROM grupos
                   WHERE asignatura_id = ? AND codigo_grupo = ? AND periodo_academico = ?
                   LIMIT 1`,
                  [asignaturaId, codigoGrupo, periodoAcademico]
                );
                const grupoId = grpRows[0].grupo_id;

                if (rolCodigo === 'ESTUDIANTE') {
                  await conn.execute(
                    `INSERT INTO inscripciones_grupo (grupo_id, estudiante_id, estado)
                     VALUES (?, ?, 'ACTIVO')
                     ON DUPLICATE KEY UPDATE estado = 'ACTIVO'`,
                    [grupoId, usuarioId]
                  );
                }
              }
            }

            await conn.commit();
            filasExitosas += 1;
          } catch (rowErr) {
            await conn.rollback();
            errores.push({
              fila: excelRowNumber,
              motivo: rowErr.message,
            });
          }
        }
      } finally {
        conn.release();
      }

      const nombreArchivo = String(req.file.originalname || 'importacion.xlsx').slice(0, 200);
      const totalFilas = rawRows.length;
      const filasConError = errores.length;

      const auditResult = await query(
        `INSERT INTO importaciones_excel (
           administrador_id, nombre_archivo, total_filas,
           filas_exitosas, filas_con_error, detalle_errores_json
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          req.user.usuario_id,
          nombreArchivo,
          totalFilas,
          filasExitosas,
          filasConError,
          JSON.stringify(errores),
        ]
      );

      return sendSuccess(res, 200, 'Importación masiva procesada exitosamente.', {
        importacion_id: auditResult.insertId,
        nombre_archivo: nombreArchivo,
        total_filas: totalFilas,
        filas_exitosas: filasExitosas,
        filas_con_error: filasConError,
        errores,
      });
    } catch (err) {
      return sendError(res, 500, 'Error al procesar el archivo Excel.', err.message);
    }
  }
);

// 10. GET /api/v1/asignaturas (RF05, RF06 - Todos los roles)
router.get('/asignaturas', authenticateJWT, async (req, res) => {
  try {
    const { periodo_academico } = req.query;
    const { rol_codigo: rolCodigo, usuario_id: usuarioId } = req.user;
    const params = [];
    let sql = '';

    if (rolCodigo === 'ADMIN_BIENESTAR') {
      sql = `
        SELECT a.asignatura_id, a.codigo AS asignatura_codigo, a.nombre AS asignatura_nombre,
               a.creditos, a.activa,
               g.grupo_id, g.codigo_grupo, g.periodo_academico, g.activo AS grupo_activo,
               g.docente_id, d.nombre_completo AS docente_nombre
        FROM asignaturas a
        LEFT JOIN grupos g ON a.asignatura_id = g.asignatura_id AND g.activo = 1
        LEFT JOIN usuarios d ON g.docente_id = d.usuario_id
        WHERE a.activa = 1
      `;
      if (periodo_academico) {
        sql += ' AND g.periodo_academico = ?';
        params.push(String(periodo_academico).trim());
      }
      sql += ' ORDER BY a.nombre ASC, g.codigo_grupo ASC';
    } else if (rolCodigo === 'DOCENTE') {
      sql = `
        SELECT a.asignatura_id, a.codigo AS asignatura_codigo, a.nombre AS asignatura_nombre,
               a.creditos, g.grupo_id, g.codigo_grupo, g.periodo_academico,
               g.docente_id, d.nombre_completo AS docente_nombre
        FROM grupos g
        INNER JOIN asignaturas a ON g.asignatura_id = a.asignatura_id
        INNER JOIN usuarios d ON g.docente_id = d.usuario_id
        WHERE g.docente_id = ? AND g.activo = 1 AND a.activa = 1
      `;
      params.push(usuarioId);
      if (periodo_academico) {
        sql += ' AND g.periodo_academico = ?';
        params.push(String(periodo_academico).trim());
      }
      sql += ' ORDER BY a.nombre ASC, g.codigo_grupo ASC';
    } else {
      sql = `
        SELECT a.asignatura_id, a.codigo AS asignatura_codigo, a.nombre AS asignatura_nombre,
               a.creditos, g.grupo_id, g.codigo_grupo, g.periodo_academico,
               g.docente_id, d.nombre_completo AS docente_nombre, ig.estado AS estado_inscripcion
        FROM inscripciones_grupo ig
        INNER JOIN grupos g ON ig.grupo_id = g.grupo_id
        INNER JOIN asignaturas a ON g.asignatura_id = a.asignatura_id
        INNER JOIN usuarios d ON g.docente_id = d.usuario_id
        WHERE ig.estudiante_id = ? AND ig.estado = 'ACTIVO' AND g.activo = 1 AND a.activa = 1
      `;
      params.push(usuarioId);
      if (periodo_academico) {
        sql += ' AND g.periodo_academico = ?';
        params.push(String(periodo_academico).trim());
      }
      sql += ' ORDER BY a.nombre ASC, g.codigo_grupo ASC';
    }

    const rows = await query(sql, params);
    return sendSuccess(res, 200, 'Asignaturas y grupos consultados exitosamente.', {
      total: rows.length,
      asignaturas: rows,
    });
  } catch (err) {
    return sendError(res, 500, 'Error al consultar asignaturas.', err.message);
  }
});

// 11. POST /api/v1/asignaturas (RF05 - ADMIN_BIENESTAR)
router.post(
  '/asignaturas',
  authenticateJWT,
  authorizeRoles('ADMIN_BIENESTAR'),
  async (req, res) => {
    try {
      const { codigo, nombre, creditos = null } = req.body || {};
      if (!codigo || !nombre) {
        return sendError(res, 400, 'Los campos codigo y nombre son obligatorios.');
      }

      const result = await query(
        'INSERT INTO asignaturas (codigo, nombre, creditos) VALUES (?, ?, ?)',
        [String(codigo).trim(), String(nombre).trim(), creditos !== null ? Number(creditos) : null]
      );

      return sendSuccess(res, 201, 'Asignatura creada exitosamente.', {
        asignatura_id: result.insertId,
        codigo: String(codigo).trim(),
        nombre: String(nombre).trim(),
        creditos: creditos !== null ? Number(creditos) : null,
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return sendError(res, 409, 'Ya existe una asignatura con ese código.', err.message);
      }
      return sendError(res, 500, 'Error al crear asignatura.', err.message);
    }
  }
);

// 12. PATCH /api/v1/asignaturas/:asignaturaId (RF05 - ADMIN_BIENESTAR)
router.patch(
  '/asignaturas/:asignaturaId',
  authenticateJWT,
  authorizeRoles('ADMIN_BIENESTAR'),
  async (req, res) => {
    try {
      const asignaturaId = Number(req.params.asignaturaId);
      if (!Number.isInteger(asignaturaId) || asignaturaId <= 0) {
        return sendError(res, 400, 'Identificador de asignatura inválido.');
      }

      const { codigo, nombre, creditos, activa } = req.body || {};
      const updates = [];
      const params = [];

      if (codigo !== undefined) {
        updates.push('codigo = ?');
        params.push(String(codigo).trim());
      }
      if (nombre !== undefined) {
        updates.push('nombre = ?');
        params.push(String(nombre).trim());
      }
      if (creditos !== undefined) {
        updates.push('creditos = ?');
        params.push(creditos !== null ? Number(creditos) : null);
      }
      if (activa !== undefined) {
        updates.push('activa = ?');
        params.push(Number(activa) === 1 ? 1 : 0);
      }

      if (updates.length === 0) {
        return sendError(res, 400, 'Debe enviar al menos un campo para actualizar.');
      }

      params.push(asignaturaId);
      const result = await query(
        `UPDATE asignaturas SET ${updates.join(', ')} WHERE asignatura_id = ?`,
        params
      );

      if (result.affectedRows === 0) {
        return sendError(res, 404, 'Asignatura no encontrada.');
      }

      return sendSuccess(res, 200, 'Asignatura actualizada exitosamente.', {
        asignatura_id: asignaturaId,
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return sendError(res, 409, 'Ya existe otra asignatura con ese código.', err.message);
      }
      return sendError(res, 500, 'Error al actualizar asignatura.', err.message);
    }
  }
);

// 13. POST /api/v1/grupos (RF05, RF06 - ADMIN_BIENESTAR)
router.post(
  '/grupos',
  authenticateJWT,
  authorizeRoles('ADMIN_BIENESTAR'),
  async (req, res) => {
    try {
      const { asignatura_id, docente_id, codigo_grupo, periodo_academico } = req.body || {};
      if (!asignatura_id || !docente_id || !codigo_grupo || !periodo_academico) {
        return sendError(
          res,
          400,
          'Los campos asignatura_id, docente_id, codigo_grupo y periodo_academico son obligatorios.'
        );
      }

      const result = await query(
        `INSERT INTO grupos (asignatura_id, docente_id, codigo_grupo, periodo_academico)
         VALUES (?, ?, ?, ?)`,
        [
          Number(asignatura_id),
          Number(docente_id),
          String(codigo_grupo).trim(),
          String(periodo_academico).trim(),
        ]
      );

      return sendSuccess(res, 201, 'Grupo creado exitosamente.', {
        grupo_id: result.insertId,
        asignatura_id: Number(asignatura_id),
        docente_id: Number(docente_id),
        codigo_grupo: String(codigo_grupo).trim(),
        periodo_academico: String(periodo_academico).trim(),
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return sendError(
          res,
          409,
          'Ya existe un grupo con ese código para la asignatura y período indicados.',
          err.message
        );
      }
      if (err.code === 'ER_NO_REFERENCED_ROW_2') {
        return sendError(res, 400, 'La asignatura o el docente especificado no existe.');
      }
      return sendError(res, 500, 'Error al crear grupo.', err.message);
    }
  }
);

// 14. PATCH /api/v1/grupos/:grupoId (RF05, RF06 - ADMIN_BIENESTAR)
router.patch(
  '/grupos/:grupoId',
  authenticateJWT,
  authorizeRoles('ADMIN_BIENESTAR'),
  async (req, res) => {
    try {
      const grupoId = Number(req.params.grupoId);
      if (!Number.isInteger(grupoId) || grupoId <= 0) {
        return sendError(res, 400, 'Identificador de grupo inválido.');
      }

      const { docente_id, codigo_grupo, periodo_academico, activo } = req.body || {};
      const updates = [];
      const params = [];

      if (docente_id !== undefined) {
        const docenteId = Number(docente_id);
        if (!Number.isInteger(docenteId) || docenteId <= 0) {
          return sendError(res, 400, 'El campo docente_id debe ser un entero positivo.');
        }

        const docenteRows = await query(
          `SELECT u.usuario_id
           FROM usuarios u
           INNER JOIN roles r ON u.rol_id = r.rol_id
           WHERE u.usuario_id = ? AND u.activo = 1 AND r.codigo = 'DOCENTE'
           LIMIT 1`,
          [docenteId]
        );
        if (docenteRows.length === 0) {
          return sendError(
            res,
            400,
            'El docente_id especificado no existe, está inactivo o no tiene el rol DOCENTE.'
          );
        }

        updates.push('docente_id = ?');
        params.push(docenteId);
      }
      if (codigo_grupo !== undefined) {
        const cleanCodigo = String(codigo_grupo).trim();
        if (!cleanCodigo) {
          return sendError(res, 400, 'El campo codigo_grupo no puede estar vacío.');
        }
        updates.push('codigo_grupo = ?');
        params.push(cleanCodigo);
      }
      if (periodo_academico !== undefined) {
        const cleanPeriodo = String(periodo_academico).trim();
        if (!cleanPeriodo) {
          return sendError(res, 400, 'El campo periodo_academico no puede estar vacío.');
        }
        updates.push('periodo_academico = ?');
        params.push(cleanPeriodo);
      }
      if (activo !== undefined) {
        let activoVal;
        if (typeof activo === 'boolean') {
          activoVal = activo ? 1 : 0;
        } else if (Number(activo) === 0 || Number(activo) === 1) {
          activoVal = Number(activo);
        } else {
          return sendError(res, 400, 'El campo activo debe ser booleano, 1 o 0.');
        }
        updates.push('activo = ?');
        params.push(activoVal);
      }

      if (updates.length === 0) {
        return sendError(res, 400, 'Debe enviar al menos un campo para actualizar.');
      }

      params.push(grupoId);
      const result = await query(
        `UPDATE grupos SET ${updates.join(', ')} WHERE grupo_id = ?`,
        params
      );

      if (result.affectedRows === 0) {
        return sendError(res, 404, 'Grupo no encontrado.');
      }

      const updatedRows = await query(
        `SELECT g.grupo_id, g.asignatura_id, g.docente_id, d.nombre_completo AS docente_nombre,
                g.codigo_grupo, g.periodo_academico, g.activo
         FROM grupos g
         INNER JOIN usuarios d ON g.docente_id = d.usuario_id
         WHERE g.grupo_id = ?
         LIMIT 1`,
        [grupoId]
      );

      return sendSuccess(
        res,
        200,
        'Grupo actualizado exitosamente.',
        updatedRows[0] || { grupo_id: grupoId }
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return sendError(
          res,
          409,
          'Ya existe un grupo con ese código en el mismo período.',
          err.message
        );
      }
      return sendError(res, 500, 'Error al actualizar grupo.', err.message);
    }
  }
);

// Helper reutilizable RBAC + Ownership para gestión de estudiantes en grupos
async function canManageGrupo(user, grupoId) {
  const rows = await query(
    'SELECT grupo_id, docente_id, activo FROM grupos WHERE grupo_id = ? LIMIT 1',
    [grupoId]
  );
  if (rows.length === 0) {
    return { allowed: false, status: 404, message: 'Grupo académico no encontrado.' };
  }
  const grupo = rows[0];
  if (user.rol_codigo === 'ADMIN_BIENESTAR') {
    return { allowed: true, grupo };
  }
  if (user.rol_codigo === 'DOCENTE' && Number(grupo.docente_id) === Number(user.usuario_id)) {
    return { allowed: true, grupo };
  }
  return {
    allowed: false,
    status: 403,
    message: 'No tienes permisos para gestionar estudiantes en este grupo.',
  };
}

// 14b. GET /api/v1/grupos/:grupoId/estudiantes (RF06 - ADMIN_BIENESTAR o DOCENTE dueño)
router.get(
  '/grupos/:grupoId/estudiantes',
  authenticateJWT,
  authorizeRoles('ADMIN_BIENESTAR', 'DOCENTE'),
  async (req, res) => {
    try {
      const grupoId = Number(req.params.grupoId);
      if (!Number.isInteger(grupoId) || grupoId <= 0) {
        return sendError(res, 400, 'Identificador de grupo inválido.');
      }

      const authz = await canManageGrupo(req.user, grupoId);
      if (!authz.allowed) {
        return sendError(res, authz.status, authz.message);
      }

      const rows = await query(
        `SELECT u.usuario_id, u.documento, u.codigo_institucional,
                u.nombre_completo, u.correo_institucional
         FROM inscripciones_grupo ig
         INNER JOIN usuarios u ON ig.estudiante_id = u.usuario_id
         WHERE ig.grupo_id = ? AND ig.estado = 'ACTIVO'
         ORDER BY u.nombre_completo ASC`,
        [grupoId]
      );

      const estudiantes = rows.map((row) => ({
        ...row,
        foto_url: `/api/v1/usuarios/${row.usuario_id}/foto`,
      }));

      return sendSuccess(res, 200, 'Estudiantes del grupo consultados exitosamente.', {
        grupo_id: grupoId,
        total: estudiantes.length,
        estudiantes,
      });
    } catch (err) {
      return sendError(res, 500, 'Error al consultar los estudiantes del grupo.', err.message);
    }
  }
);

// 14c. POST /api/v1/grupos/:grupoId/estudiantes (RF06, RNF03 - ADMIN_BIENESTAR o DOCENTE dueño)
router.post(
  '/grupos/:grupoId/estudiantes',
  authenticateJWT,
  authorizeRoles('ADMIN_BIENESTAR', 'DOCENTE'),
  async (req, res) => {
    try {
      const grupoId = Number(req.params.grupoId);
      if (!Number.isInteger(grupoId) || grupoId <= 0) {
        return sendError(res, 400, 'Identificador de grupo inválido.');
      }

      const authz = await canManageGrupo(req.user, grupoId);
      if (!authz.allowed) {
        return sendError(res, authz.status, authz.message);
      }

      const { estudiante_id, estudiante_ids } = req.body || {};
      const rawIds = [];
      if (estudiante_id !== undefined && estudiante_id !== null) {
        rawIds.push(estudiante_id);
      }
      if (Array.isArray(estudiante_ids)) {
        rawIds.push(...estudiante_ids);
      }

      if (rawIds.length === 0) {
        return sendError(
          res,
          400,
          'Debe proporcionar estudiante_id o un arreglo no vacío en estudiante_ids.'
        );
      }

      const parsedIds = [];
      for (const rawId of rawIds) {
        const id = Number(rawId);
        if (!Number.isInteger(id) || id <= 0) {
          return sendError(
            res,
            400,
            'Todos los identificadores de estudiante deben ser enteros positivos.'
          );
        }
        parsedIds.push(id);
      }

      const uniqueIds = [...new Set(parsedIds)];
      if (uniqueIds.length > 500) {
        return sendError(
          res,
          400,
          'No se pueden inscribir más de 500 estudiantes en una sola petición.'
        );
      }

      const placeholders = uniqueIds.map(() => '?').join(', ');
      const validRows = await query(
        `SELECT u.usuario_id
         FROM usuarios u
         INNER JOIN roles r ON u.rol_id = r.rol_id
         WHERE u.usuario_id IN (${placeholders})
           AND u.activo = 1
           AND r.codigo = 'ESTUDIANTE'`,
        uniqueIds
      );

      const validSet = new Set(validRows.map((r) => Number(r.usuario_id)));
      const invalidIds = uniqueIds.filter((id) => !validSet.has(id));
      if (invalidIds.length > 0) {
        return sendError(
          res,
          400,
          'Uno o más estudiantes no existen, están inactivos o no tienen el rol ESTUDIANTE.',
          { estudiantes_invalidos: invalidIds }
        );
      }

      const conn = await getConnection();
      try {
        await conn.beginTransaction();
        for (const estId of uniqueIds) {
          await conn.execute(
            `INSERT INTO inscripciones_grupo (grupo_id, estudiante_id, estado)
             VALUES (?, ?, 'ACTIVO')
             ON DUPLICATE KEY UPDATE estado = 'ACTIVO'`,
            [grupoId, estId]
          );
        }
        await conn.commit();
      } catch (txErr) {
        await conn.rollback();
        throw txErr;
      } finally {
        conn.release();
      }

      return sendSuccess(res, 201, 'Estudiantes inscritos en el grupo exitosamente.', {
        grupo_id: grupoId,
        inscritos_procesados: uniqueIds.length,
        estudiante_ids: uniqueIds,
      });
    } catch (err) {
      return sendError(res, 500, 'Error al inscribir estudiantes en el grupo.', err.message);
    }
  }
);

// 14d. DELETE /api/v1/grupos/:grupoId/estudiantes/:estudianteId (RF06 - ADMIN_BIENESTAR o DOCENTE dueño)
router.delete(
  '/grupos/:grupoId/estudiantes/:estudianteId',
  authenticateJWT,
  authorizeRoles('ADMIN_BIENESTAR', 'DOCENTE'),
  async (req, res) => {
    try {
      const grupoId = Number(req.params.grupoId);
      const estudianteId = Number(req.params.estudianteId);
      if (!Number.isInteger(grupoId) || grupoId <= 0 || !Number.isInteger(estudianteId) || estudianteId <= 0) {
        return sendError(res, 400, 'Identificadores de grupo o estudiante inválidos.');
      }

      const authz = await canManageGrupo(req.user, grupoId);
      if (!authz.allowed) {
        return sendError(res, authz.status, authz.message);
      }

      const result = await query(
        `UPDATE inscripciones_grupo
         SET estado = 'RETIRADO'
         WHERE grupo_id = ? AND estudiante_id = ? AND estado = 'ACTIVO'`,
        [grupoId, estudianteId]
      );

      if (result.affectedRows === 0) {
        return sendError(
          res,
          404,
          'El estudiante no cuenta con una inscripción activa en este grupo.'
        );
      }

      return sendSuccess(res, 200, 'Inscripción del estudiante retirada del grupo exitosamente.', {
        grupo_id: grupoId,
        estudiante_id: estudianteId,
        estado: 'RETIRADO',
      });
    } catch (err) {
      return sendError(res, 500, 'Error al retirar al estudiante del grupo.', err.message);
    }
  }
);

// 15. GET /api/v1/configuracion/geocercas (RF09 - Todos los roles)
router.get('/configuracion/geocercas', authenticateJWT, async (_req, res) => {
  try {
    const rows = await query(
      `SELECT geocerca_id, sede, latitud, longitud, radio_metros
       FROM geocercas_institucionales
       WHERE activa = 1
       ORDER BY geocerca_id ASC`
    );

    return sendSuccess(res, 200, 'Geocercas institucionales consultadas exitosamente.', {
      total: rows.length,
      geocercas: rows,
    });
  } catch (err) {
    return sendError(res, 500, 'Error al consultar geocercas.', err.message);
  }
});

// 16. PUT /api/v1/configuracion/geocerca (RF09 - ADMIN_BIENESTAR)
router.put(
  '/configuracion/geocerca',
  authenticateJWT,
  authorizeRoles('ADMIN_BIENESTAR'),
  async (req, res) => {
    try {
      const {
        geocerca_id,
        sede,
        latitud,
        longitud,
        radio_metros = 300,
        activa = 1,
      } = req.body || {};

      if (!sede || latitud === undefined || longitud === undefined) {
        return sendError(
          res,
          400,
          'Los campos sede, latitud y longitud son obligatorios.'
        );
      }

      const lat = Number(latitud);
      const lon = Number(longitud);
      const radio = Number(radio_metros);
      const activaVal = Number(activa) === 1 ? 1 : 0;

      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(radio) || radio <= 0) {
        return sendError(
          res,
          400,
          'Las coordenadas (latitud, longitud) y radio_metros deben ser valores numéricos válidos.'
        );
      }

      if (geocerca_id) {
        const result = await query(
          `UPDATE geocercas_institucionales
           SET sede = ?, latitud = ?, longitud = ?, radio_metros = ?, activa = ?, actualizado_por = ?
           WHERE geocerca_id = ?`,
          [String(sede).trim(), lat, lon, radio, activaVal, req.user.usuario_id, Number(geocerca_id)]
        );

        if (result.affectedRows === 0) {
          return sendError(res, 404, 'Geocerca institucional no encontrada.');
        }

        return sendSuccess(res, 200, 'Geocerca institucional actualizada exitosamente.', {
          geocerca_id: Number(geocerca_id),
          sede: String(sede).trim(),
          latitud: lat,
          longitud: lon,
          radio_metros: radio,
          activa: activaVal,
        });
      }

      const result = await query(
        `INSERT INTO geocercas_institucionales (sede, latitud, longitud, radio_metros, activa, actualizado_por)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [String(sede).trim(), lat, lon, radio, activaVal, req.user.usuario_id]
      );

      return sendSuccess(res, 201, 'Geocerca institucional creada exitosamente.', {
        geocerca_id: result.insertId,
        sede: String(sede).trim(),
        latitud: lat,
        longitud: lon,
        radio_metros: radio,
        activa: activaVal,
      });
    } catch (err) {
      return sendError(res, 500, 'Error al guardar la geocerca institucional.', err.message);
    }
  }
);

module.exports = router;
