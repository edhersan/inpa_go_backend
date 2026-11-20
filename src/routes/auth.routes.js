const express = require('express');
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const { uploadFotoPerfil } = require('../middlewares/upload.middleware');
const { authenticateJWT } = require('../middlewares/auth.middleware');
const { uploadPrivateBlob } = require('../services/blobStorage.service');
const {
  hashPassword,
  verifyPassword,
  sha256String,
  sha256Buffer,
  generateRefreshToken,
  generateUuid,
} = require('../utils/crypto.util');
const { sendSuccess, sendError } = require('../utils/response.util');

const router = express.Router();

const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function signAccessToken(user) {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) {
    throw new Error('JWT_ACCESS_SECRET no configurado.');
  }
  return jwt.sign(
    {
      usuario_id: user.usuario_id,
      rol_id: user.rol_id,
      rol_codigo: user.rol_codigo,
      correo_institucional: user.correo_institucional,
    },
    secret,
    { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '30m' }
  );
}

// 1. POST /api/v1/auth/registro (RF01, RF02, RF14)
router.post('/registro', uploadFotoPerfil, async (req, res) => {
  try {
    const {
      documento,
      codigo_institucional = null,
      nombre_completo,
      correo_institucional,
      password,
      rol_codigo = 'ESTUDIANTE',
    } = req.body || {};

    if (!req.file) {
      return sendError(
        res,
        400,
        'La fotografía de registro (foto_perfil) es obligatoria.'
      );
    }

    if (!documento || !nombre_completo || !correo_institucional || !password) {
      return sendError(
        res,
        400,
        'Los campos documento, nombre_completo, correo_institucional y password son obligatorios.'
      );
    }

    const normalizedRol = String(rol_codigo).trim().toUpperCase();
    const rolesRows = await query(
      'SELECT rol_id, codigo FROM roles WHERE codigo = ? LIMIT 1',
      [normalizedRol]
    );
    if (rolesRows.length === 0) {
      return sendError(res, 400, `Rol institucional no válido: ${normalizedRol}.`);
    }

    const rol = rolesRows[0];
    const cleanDoc = String(documento).trim();
    const cleanEmail = String(correo_institucional).trim().toLowerCase();
    const cleanCode = codigo_institucional ? String(codigo_institucional).trim() : null;

    const existing = await query(
      `SELECT usuario_id FROM usuarios
       WHERE documento = ? OR correo_institucional = ? OR (? IS NOT NULL AND codigo_institucional = ?)
       LIMIT 1`,
      [cleanDoc, cleanEmail, cleanCode, cleanCode]
    );

    if (existing.length > 0) {
      return sendError(
        res,
        409,
        'Ya existe un usuario registrado con el mismo documento, correo o código institucional.'
      );
    }

    const passwordHash = await hashPassword(password);
    const fotoHash = sha256Buffer(req.file.buffer);
    const ext = MIME_TO_EXT[req.file.mimetype] || 'jpg';
    const blobPathname = `fotos/${Date.now()}-${generateUuid()}.${ext}`;

    const storedPathname = await uploadPrivateBlob(
      blobPathname,
      req.file.buffer,
      req.file.mimetype
    );

    const insertResult = await query(
      `INSERT INTO usuarios (
         rol_id, documento, codigo_institucional, nombre_completo,
         correo_institucional, password_hash, foto_ruta, foto_mime_type, foto_hash_sha256
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rol.rol_id,
        cleanDoc,
        cleanCode,
        String(nombre_completo).trim(),
        cleanEmail,
        passwordHash,
        storedPathname,
        req.file.mimetype,
        fotoHash,
      ]
    );

    return sendSuccess(res, 201, 'Usuario registrado exitosamente.', {
      usuario_id: insertResult.insertId,
      rol_codigo: rol.codigo,
      documento: cleanDoc,
      nombre_completo: String(nombre_completo).trim(),
      correo_institucional: cleanEmail,
      foto_hash_sha256: fotoHash,
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return sendError(
        res,
        409,
        'Ya existe un usuario registrado con esos datos únicos.',
        err.message
      );
    }
    return sendError(res, 500, 'Error al registrar usuario.', err.message);
  }
});

// 2. POST /api/v1/auth/login (RF01, RF02, RF13)
router.post('/login', async (req, res) => {
  try {
    const { correo_institucional, password, device_id = null } = req.body || {};

    if (!correo_institucional || !password) {
      return sendError(
        res,
        400,
        'Los campos correo_institucional y password son obligatorios.'
      );
    }

    const cleanEmail = String(correo_institucional).trim().toLowerCase();
    const rows = await query(
      `SELECT u.usuario_id, u.rol_id, r.codigo AS rol_codigo, r.nombre AS rol_nombre,
              u.documento, u.codigo_institucional, u.nombre_completo, u.correo_institucional,
              u.password_hash, u.perfil_voz_ruta, u.biometria_habilitada, u.activo
       FROM usuarios u
       INNER JOIN roles r ON u.rol_id = r.rol_id
       WHERE u.correo_institucional = ?
       LIMIT 1`,
      [cleanEmail]
    );

    if (rows.length === 0) {
      return sendError(res, 401, 'Credenciales institucionales inválidas.');
    }

    const user = rows[0];
    const validPassword = await verifyPassword(password, user.password_hash);
    if (!validPassword) {
      return sendError(res, 401, 'Credenciales institucionales inválidas.');
    }

    if (Number(user.activo) !== 1) {
      return sendError(res, 403, 'La cuenta institucional se encuentra desactivada.');
    }

    const accessToken = signAccessToken(user);
    const refreshToken = generateRefreshToken();
    const refreshTokenHash = sha256String(refreshToken);
    const refreshDays = Number(process.env.JWT_REFRESH_EXPIRES_DAYS) || 15;
    const ipOrigen =
      (req.headers['x-forwarded-for'] &&
        String(req.headers['x-forwarded-for']).split(',')[0].trim()) ||
      req.ip ||
      null;

    await query(
      `INSERT INTO sesiones_auth (usuario_id, refresh_token_hash, device_id, ip_origen, expira_en)
       VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))`,
      [user.usuario_id, refreshTokenHash, device_id, ipOrigen, refreshDays]
    );

    return sendSuccess(res, 200, 'Inicio de sesión exitoso.', {
      access_token: accessToken,
      refresh_token: refreshToken,
      usuario: {
        usuario_id: user.usuario_id,
        rol_id: user.rol_id,
        rol_codigo: user.rol_codigo,
        rol_nombre: user.rol_nombre,
        documento: user.documento,
        codigo_institucional: user.codigo_institucional,
        nombre_completo: user.nombre_completo,
        correo_institucional: user.correo_institucional,
        tiene_perfil_voz: Boolean(user.perfil_voz_ruta),
        biometria_habilitada: Boolean(user.biometria_habilitada),
      },
    });
  } catch (err) {
    return sendError(res, 500, 'Error al iniciar sesión.', err.message);
  }
});

// 3. POST /api/v1/auth/refresh (RF01, RF13)
router.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body || {};
    if (!refresh_token) {
      return sendError(res, 400, 'El campo refresh_token es obligatorio.');
    }

    const tokenHash = sha256String(refresh_token);
    const rows = await query(
      `SELECT sa.sesion_auth_id, u.usuario_id, u.rol_id, r.codigo AS rol_codigo,
              u.correo_institucional, u.activo
       FROM sesiones_auth sa
       INNER JOIN usuarios u ON sa.usuario_id = u.usuario_id
       INNER JOIN roles r ON u.rol_id = r.rol_id
       WHERE sa.refresh_token_hash = ?
         AND sa.revocada = 0
         AND sa.expira_en > NOW()
       LIMIT 1`,
      [tokenHash]
    );

    if (rows.length === 0) {
      return sendError(res, 401, 'Sesión expirada o revocada.');
    }

    const sessionUser = rows[0];
    if (Number(sessionUser.activo) !== 1) {
      return sendError(res, 403, 'La cuenta institucional se encuentra desactivada.');
    }

    const accessToken = signAccessToken(sessionUser);
    return sendSuccess(res, 200, 'Token de acceso renovado exitosamente.', {
      access_token: accessToken,
    });
  } catch (err) {
    return sendError(res, 500, 'Error al renovar el token de acceso.', err.message);
  }
});

// 4. POST /api/v1/auth/logout (RF13)
router.post('/logout', authenticateJWT, async (req, res) => {
  try {
    const { refresh_token } = req.body || {};
    let result;

    if (refresh_token) {
      const tokenHash = sha256String(refresh_token);
      result = await query(
        `UPDATE sesiones_auth
         SET revocada = 1, revocada_en = NOW()
         WHERE usuario_id = ? AND refresh_token_hash = ? AND revocada = 0`,
        [req.user.usuario_id, tokenHash]
      );
    } else {
      result = await query(
        `UPDATE sesiones_auth
         SET revocada = 1, revocada_en = NOW()
         WHERE usuario_id = ? AND revocada = 0`,
        [req.user.usuario_id]
      );
    }

    return sendSuccess(res, 200, 'Sesión cerrada exitosamente.', {
      sesiones_revocadas: result.affectedRows || 0,
    });
  } catch (err) {
    return sendError(res, 500, 'Error al cerrar sesión.', err.message);
  }
});

module.exports = router;
