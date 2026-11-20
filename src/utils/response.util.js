function sendSuccess(res, statusCode = 200, message = 'Operación exitosa.', data = {}) {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
  });
}

function sendError(res, statusCode = 500, message = 'Error interno del servidor.', errors = undefined) {
  const payload = {
    success: false,
    message,
  };

  if (errors !== undefined && errors !== null) {
    payload.errors = errors;
  }

  return res.status(statusCode).json(payload);
}

module.exports = {
  sendSuccess,
  sendError,
};
