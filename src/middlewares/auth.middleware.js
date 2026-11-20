const jwt = require('jsonwebtoken');
const { sendError } = require('../utils/response.util');

function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return sendError(res, 401, 'Token de acceso no proporcionado o formato inválido.');
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return sendError(res, 401, 'Token de acceso vacío.');
  }

  try {
    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret) {
      return sendError(res, 500, 'Configuración JWT_ACCESS_SECRET ausente en el servidor.');
    }

    const decoded = jwt.verify(token, secret);
    req.user = {
      usuario_id: decoded.usuario_id,
      rol_id: decoded.rol_id,
      rol_codigo: decoded.rol_codigo,
      correo_institucional: decoded.correo_institucional,
    };
    return next();
  } catch (err) {
    return sendError(res, 401, 'Token de acceso inválido o expirado.', err.message);
  }
}

function authorizeRoles(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return sendError(res, 401, 'Usuario no autenticado.');
    }
    if (!roles.includes(req.user.rol_codigo)) {
      return sendError(
        res,
        403,
        'No tienes permisos suficientes para acceder a este recurso.'
      );
    }
    return next();
  };
}

module.exports = {
  authenticateJWT,
  authorizeRoles,
};
