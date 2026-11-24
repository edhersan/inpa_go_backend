function sendSuccess(res, statusCode = 200, message = 'Operación exitosa.', data = {}) {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
  });
}

function sendError(res, statusCode = 500, message = 'Error interno del servidor.', errors = undefined) {
  const isProd = process.env.NODE_ENV === 'production';
  const safeMessage =
    isProd && statusCode >= 500
      ? 'Error interno del servidor.'
      : message || 'Error interno del servidor.';

  const payload = {
    success: false,
    message: safeMessage,
  };

  if (errors !== undefined && errors !== null) {
    // En producción nunca exponer detalles internos/SQL en errores 5xx ni strings crudos de BD en 409
    if (!(isProd && (statusCode >= 500 || (statusCode === 409 && typeof errors === 'string')))) {
      payload.errors = errors;
    }
  }

  return res.status(statusCode).json(payload);
}

module.exports = {
  sendSuccess,
  sendError,
};
