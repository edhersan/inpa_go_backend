const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const apiV1Routes = require('./routes');
const openApiSpec = require('./docs/openapi');
const { sendSuccess, sendError } = require('./utils/response.util');

const app = express();

app.set('trust proxy', 1);

app.use(helmet());

const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(
  cors({
    origin: corsOrigin === '*' ? true : corsOrigin.split(',').map((o) => o.trim()),
    credentials: true,
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Rate limit específico en login (RF01, RNF01): 40 peticiones cada 15 minutos
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) =>
    sendError(
      res,
      429,
      'Demasiados intentos de inicio de sesión. Intente nuevamente en 15 minutos.'
    ),
});

app.use('/api/v1/auth/login', loginRateLimiter);

// 0. GET /health (Público)
app.get('/health', (_req, res) => {
  return sendSuccess(res, 200, 'Servicio Inpa_Go operativo.', {
    status: 'OK',
    storage: process.env.BLOB_STORE_NAME || 'inpa-go-store',
    timestamp: new Date().toISOString(),
  });
});

// Documentación interactiva OpenAPI 3.0 / Swagger UI (compatible con Vercel Serverless)
app.get('/openapi.json', (_req, res) => {
  return res.status(200).json(openApiSpec);
});

app.get(['/docs', '/docs/'], (_req, res) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: https://unpkg.com; connect-src 'self';"
  );
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Inpa_Go API — Swagger Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; background: #fafafa; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = function () {
      window.ui = SwaggerUIBundle({
        url: '/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        persistAuthorization: true
      });
    };
  </script>
</body>
</html>`);
});

// Rutas principales API REST v1
app.use('/api/v1', apiV1Routes);

// Manejo de rutas no encontradas (404)
app.use((req, res) => {
  return sendError(res, 404, `Ruta no encontrada: ${req.method} ${req.originalUrl}`);
});

// Manejador global de errores
app.use((err, _req, res, _next) => {
  const statusCode = err.status || err.statusCode || 500;
  return sendError(
    res,
    statusCode,
    err.message || 'Error interno del servidor.',
    process.env.NODE_ENV === 'production' ? undefined : err.stack
  );
});

module.exports = app;
