const express = require('express');
const PDFDocument = require('pdfkit');
const { query } = require('../config/db');
const { authenticateJWT, authorizeRoles } = require('../middlewares/auth.middleware');
const { sendSuccess, sendError } = require('../utils/response.util');

const router = express.Router();

// 26. GET /api/v1/asistencias/historial (RF11 - ESTUDIANTE o DOCENTE)
router.get(
  '/asistencias/historial',
  authenticateJWT,
  authorizeRoles('ESTUDIANTE', 'DOCENTE'),
  async (req, res) => {
    try {
      const { asignatura_id, grupo_id, fecha_desde, fecha_hasta } = req.query;
      const { rol_codigo: rolCodigo, usuario_id: usuarioId } = req.user;

      const conditions = [];
      const params = [];

      if (rolCodigo === 'ESTUDIANTE') {
        conditions.push('ra.estudiante_id = ?');
        params.push(usuarioId);
      } else {
        conditions.push('sa.docente_id = ?');
        params.push(usuarioId);
      }

      if (asignatura_id) {
        conditions.push('a.asignatura_id = ?');
        params.push(Number(asignatura_id));
      }
      if (grupo_id) {
        conditions.push('g.grupo_id = ?');
        params.push(Number(grupo_id));
      }
      if (fecha_desde) {
        conditions.push('sa.fecha >= ?');
        params.push(String(fecha_desde).trim());
      }
      if (fecha_hasta) {
        conditions.push('sa.fecha <= ?');
        params.push(String(fecha_hasta).trim());
      }

      const rows = await query(
        `SELECT ra.asistencia_id, ra.sesion_id, sa.fecha, sa.hora_inicio, sa.hora_fin, sa.estado AS estado_sesion,
                a.asignatura_id, a.codigo AS asignatura_codigo, a.nombre AS asignatura_nombre,
                g.grupo_id, g.codigo_grupo, g.periodo_academico,
                est.usuario_id AS estudiante_id, est.documento AS estudiante_documento,
                est.nombre_completo AS estudiante_nombre,
                doc.nombre_completo AS docente_nombre,
                ra.estado AS estado_asistencia, ra.metodo_confirmacion, ra.observacion, ra.confirmado_en,
                ev.distancia_metros, ev.ubicacion_valida, ev.similitud_espectro, ev.voz_valida
         FROM registros_asistencia ra
         INNER JOIN sesiones_academicas sa ON ra.sesion_id = sa.sesion_id
         INNER JOIN grupos g ON sa.grupo_id = g.grupo_id
         INNER JOIN asignaturas a ON g.asignatura_id = a.asignatura_id
         INNER JOIN usuarios est ON ra.estudiante_id = est.usuario_id
         INNER JOIN usuarios doc ON sa.docente_id = doc.usuario_id
         LEFT JOIN evidencias_asistencia ev ON ra.evidencia_id = ev.evidencia_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY sa.fecha DESC, sa.hora_inicio DESC, est.nombre_completo ASC`,
        params
      );

      return sendSuccess(res, 200, 'Historial de asistencias consultado exitosamente.', {
        total: rows.length,
        registros: rows,
      });
    } catch (err) {
      return sendError(res, 500, 'Error al consultar el historial de asistencias.', err.message);
    }
  }
);

// 27. GET /api/v1/reportes/asistencia/pdf (RF12 - DOCENTE)
router.get(
  '/reportes/asistencia/pdf',
  authenticateJWT,
  authorizeRoles('DOCENTE'),
  async (req, res) => {
    try {
      const { asignatura_id, grupo_id, sesion_id } = req.query;
      const conditions = ['sa.docente_id = ?'];
      const params = [req.user.usuario_id];

      if (asignatura_id) {
        conditions.push('a.asignatura_id = ?');
        params.push(Number(asignatura_id));
      }
      if (grupo_id) {
        conditions.push('g.grupo_id = ?');
        params.push(Number(grupo_id));
      }
      if (sesion_id) {
        conditions.push('sa.sesion_id = ?');
        params.push(Number(sesion_id));
      }

      const rows = await query(
        `SELECT sa.sesion_id, sa.fecha, sa.hora_inicio, sa.hora_fin,
                a.codigo AS asignatura_codigo, a.nombre AS asignatura_nombre,
                g.codigo_grupo, g.periodo_academico,
                doc.nombre_completo AS docente_nombre,
                est.documento AS estudiante_documento, est.nombre_completo AS estudiante_nombre,
                ra.estado AS estado_asistencia, ra.metodo_confirmacion, ra.observacion
         FROM registros_asistencia ra
         INNER JOIN sesiones_academicas sa ON ra.sesion_id = sa.sesion_id
         INNER JOIN grupos g ON sa.grupo_id = g.grupo_id
         INNER JOIN asignaturas a ON g.asignatura_id = a.asignatura_id
         INNER JOIN usuarios doc ON sa.docente_id = doc.usuario_id
         INNER JOIN usuarios est ON ra.estudiante_id = est.usuario_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY sa.fecha DESC, est.nombre_completo ASC`,
        params
      );

      const first = rows[0] || {};
      const codigoGrupoRaw = first.codigo_grupo || (grupo_id ? `G${grupo_id}` : 'GENERAL');
      const codigoGrupoSafe = String(codigoGrupoRaw).replace(/[^a-zA-Z0-9_-]/g, '_');

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="Reporte_Asistencia_InpaGo_${codigoGrupoSafe}.pdf"`
      );

      const doc = new PDFDocument({ margin: 45, size: 'LETTER' });
      doc.pipe(res);

      // Encabezado Institucional UNINPAHU
      doc
        .fontSize(15)
        .font('Helvetica-Bold')
        .text('FUNDACIÓN UNIVERSITARIA UNINPAHU', { align: 'center' });
      doc
        .fontSize(11)
        .font('Helvetica')
        .text('Inpa_Go — Reporte Oficial de Asistencia Académica', { align: 'center' });
      doc.moveDown(1);

      // Metadatos del reporte
      doc.fontSize(10).font('Helvetica-Bold').text('Información Académica');
      doc.font('Helvetica');
      doc.text(
        `Asignatura: ${first.asignatura_codigo ? `${first.asignatura_codigo} - ${first.asignatura_nombre}` : 'Todas / Filtrada'}`
      );
      doc.text(
        `Grupo: ${first.codigo_grupo || 'Todos'}  |  Período: ${first.periodo_academico || 'N/A'}`
      );
      doc.text(`Docente: ${first.docente_nombre || req.user.correo_institucional}`);
      doc.text(
        `Fecha de Sesión: ${first.fecha ? String(first.fecha).slice(0, 10) : new Date().toISOString().slice(0, 10)}`
      );
      doc.text(`Generado: ${new Date().toISOString()}`);
      doc.moveDown(1);

      // Encabezado de tabla
      const startX = 45;
      let y = doc.y;

      doc.font('Helvetica-Bold').fontSize(9);
      doc.text('Documento', startX, y, { width: 85 });
      doc.text('Estudiante', startX + 90, y, { width: 175 });
      doc.text('Estado', startX + 270, y, { width: 70 });
      doc.text('Método', startX + 345, y, { width: 95 });
      doc.text('Observación', startX + 445, y, { width: 120 });

      y += 16;
      doc.moveTo(startX, y).lineTo(565, y).stroke();
      y += 8;

      doc.font('Helvetica').fontSize(8.5);
      if (rows.length === 0) {
        doc.text('No se encontraron registros de asistencia para los filtros seleccionados.', startX, y);
      } else {
        for (const row of rows) {
          if (y > 700) {
            doc.addPage();
            y = 50;
          }
          doc.text(String(row.estudiante_documento || ''), startX, y, { width: 85 });
          doc.text(String(row.estudiante_nombre || ''), startX + 90, y, { width: 175 });
          doc.text(String(row.estado_asistencia || ''), startX + 270, y, { width: 70 });
          doc.text(String(row.metodo_confirmacion || ''), startX + 345, y, { width: 95 });
          doc.text(String(row.observacion || '-'), startX + 445, y, { width: 120 });
          y += 18;
        }
      }

      doc.end();
      return undefined;
    } catch (err) {
      if (!res.headersSent) {
        return sendError(res, 500, 'Error al generar el reporte PDF de asistencia.', err.message);
      }
      return undefined;
    }
  }
);

module.exports = router;
