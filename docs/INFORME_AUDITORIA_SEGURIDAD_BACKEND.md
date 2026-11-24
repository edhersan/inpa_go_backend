# Informe de Auditoría de Seguridad Defensiva (AppSec — OWASP Top 10)

**Proyecto:** `inpa-go-backend` (Inpa_Go — UNINPAHU)  
**Fecha:** 2026-11-24  
**Estándar de referencia:** OWASP Top 10:2021 (`A01`–`A10`) + `INPA_GO_BACKEND_SPEC.md` (`RNF01`, `RNF06`)  
**Estado:** Parches defensivos aplicados y verificados mediante suite automatizada (`npm test`).

---

## 1. Resumen Ejecutivo

Se realizó una auditoría defensiva de código fuente sobre todos los módulos del backend (`src/app.js`, `src/middlewares/`, `src/routes/`, `src/services/`, `src/utils/`).  
Se identificaron y remediaron **9 hallazgos** (1 Crítico, 4 Altos, 3 Medios, 1 Bajo), además de verificar el cumplimiento estricto de consultas SQL parametrizadas (`?`) en el 100% de las sentencias contra TiDB/MySQL (`inpa_go_db`) y el uso exclusivo de `access: 'private'` en Vercel Blob (`inpa-go-store`).

---

## 2. Tabla de Hallazgos y Correcciones Aplicadas

| ID | Severidad | Categoría OWASP | Archivo(s) Afectado(s) | Descripción del Riesgo | Corrección Aplicada |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **SEC-01** | **Crítica** | A01:2021 — Broken Access Control | `src/routes/auth.routes.js` | `POST /api/v1/auth/registro` (público) aceptaba `rol_codigo` desde `req.body` sin restricción, permitiendo que un atacante se auto-registrara como `ADMIN_BIENESTAR` o `DOCENTE` (escalación de privilegios). | Se restringió el auto-registro público exclusivamente al rol `ESTUDIANTE`, devolviendo `403 Forbidden` ante cualquier intento de solicitar otro rol. Los docentes solo pueden ser creados por `ADMIN_BIENESTAR` vía `POST /api/v1/usuarios/docentes`. |
| **SEC-02** | **Alta** | A01:2021 — Broken Access Control (IDOR) | `src/routes/sesiones.routes.js` | `PUT /api/v1/sesiones/:sesionId/asistencias` validaba la titularidad de la sesión, pero no comprobaba que cada `estudiante_id` del arreglo `registros` estuviera inscrito activamente en `sesion.grupo_id` ni que `evidencia_id` perteneciera a `(sesionId, estudiante_id)`. | Se agregó validación de pertenencia activa contra `inscripciones_grupo` (`403 Forbidden` si el estudiante no pertenece al grupo), verificación de correspondencia `evidencia_id <-> (sesionId, estudiante_id)` (`400 Bad Request`) y límite máximo de `500` registros por lote. |
| **SEC-03** | **Alta** | A04 / A08 — Insecure File Upload (MIME Spoofing) | `src/middlewares/upload.middleware.js`, `src/routes/auth.routes.js` | La carga de fotos (`foto_perfil`), audios (`audio_voz`) y libros Excel (`archivo_excel`) validaba únicamente `mimetype` y extensión declarados por el cliente, permitiendo suplantación de tipo de archivo. | Se implementó verificación real de **magic bytes** en memoria (`detectImageMagicBytes` para JPEG/PNG/WebP, `detectAudioMagicBytes` para WAV/MP4-M4A/MP3/WebM y `detectExcelMagicBytes` para ZIP-XLSX/OLE2-XLS), manteniendo límites de `3 MB` (fotos) y `4 MB` (audios/Excel) y usando el MIME detectado al subir a Vercel Blob. |
| **SEC-04** | **Alta** | A05:2021 — Security Misconfiguration (CWE-209) | `src/utils/response.util.js`, `src/app.js` | En `NODE_ENV=production`, los bloques `catch` y el manejador global de errores podían exponer `err.message` (mensajes crudos de MySQL/TiDB) o `err.stack` en respuestas `500` y `409`. | Se centralizó la sanitización en `sendError()` y en el manejador global de `src/app.js`: en `NODE_ENV=production`, todo error `>= 500` retorna únicamente `"Error interno del servidor."` sin `errors` ni `stack`, y se suprimen textos crudos de SQL en `409`. |
| **SEC-05** | **Alta** | A03:2021 — Injection & DoS (Excel) | `src/routes/academico.routes.js` | `POST /api/v1/importaciones/excel` no limitaba el número máximo de filas (riesgo de denegación de servicio por descompresión masiva en Vercel Serverless) ni sanitizaba celdas contra **CSV/Formula Injection** (`=`, `+`, `-`, `@`). | Se impuso `MAX_EXCEL_ROWS = 1000` (`422 Unprocessable Entity` si se excede), verificación de firma binaria ZIP/XLSX o XLS antes de `XLSX.read()`, y `sanitizeExcelCell()` para limpiar caracteres de control y prefijos peligrosos (`^[=+\-@\t\r]+`). |
| **SEC-06** | **Media** | A07:2021 — Identification & Authentication Failures | `src/app.js` | Solo `/api/v1/auth/login` contaba con rate limiting; `/api/v1/auth/registro` (público con bcrypt cost 12 + subida a Blob) y `/api/v1/auth/refresh` carecían de límite contra fuerza bruta y abuso de recursos. | Se agregaron `registroRateLimiter` (`15 req / 15 min`) en `/api/v1/auth/registro` y `refreshRateLimiter` (`60 req / 15 min`) en `/api/v1/auth/refresh`, conservando `loginRateLimiter` (`40 req / 15 min`). |
| **SEC-07** | **Media** | A05:2021 — Security Misconfiguration (HTTP Headers & CORS) | `src/app.js` | `helmet()` por defecto emitía `X-Frame-Options: SAMEORIGIN` en lugar de `DENY`, no fijaba HSTS explícito con `preload`, y `cors` activaba `credentials: true` incluso con `CORS_ORIGIN=*`. | Se configuró explícitamente `helmet({ frameguard: { action: 'deny' }, noSniff: true, hsts: { maxAge: 31536000, includeSubDomains: true, preload: true } })`, `app.disable('x-powered-by')` y `credentials: !allowAllOrigins`. |
| **SEC-08** | **Media** | A02 / A07 — Cryptographic / JWT Pinning | `src/middlewares/auth.middleware.js`, `src/routes/auth.routes.js` | `jwt.sign` y `jwt.verify` no restringían explícitamente el algoritmo permitido (`HS256`), y los errores `401` devolvían `err.message` en producción. | Se fijó `algorithm: 'HS256'` en firma y `algorithms: ['HS256']` en verificación, ocultando detalles técnicos en `401` cuando `NODE_ENV=production`. |
| **SEC-09** | **Baja** | A01 / A03 — Defense-in-Depth (Path Traversal, Query Types & Ownership) | `src/services/blobStorage.service.js`, `src/routes/reportes.routes.js`, `src/routes/usuarios.routes.js` | 1) `blobStorage.service.js` no validaba secuencias `..` o barras invertidas en `pathname`. 2) `reportes.routes.js` convertía query params numéricos sin validar `NaN`. 3) `GET /usuarios/:id/foto` no filtraba `ig.estado = 'ACTIVO'` para docentes. | 1) Se agregó `assertSafeBlobPathname()` manteniendo `access: 'private'`. 2) Se validan `asignatura_id`, `grupo_id` y `sesion_id` como enteros positivos (`400`). 3) Se agregó `AND ig.estado = 'ACTIVO'` en la verificación de pertenencia docente para fotos privadas. |

---

## 3. Verificaciones Positivas (Controles Conformes)

- **Inyección SQL (`OWASP A03`):** El 100% de las consultas en `src/routes/*.js` utilizan consultas parametrizadas (`?`) vía `mysql2/promise` (`pool.execute` / `conn.execute`). Las cláusulas dinámicas (`WHERE` / `SET`) solo concatenan literales de columna fijos definidos en código, nunca entradas del usuario.
- **Almacenamiento Privado (`RNF06`):** `src/services/blobStorage.service.js` utiliza exclusivamente `@vercel/blob` (`v2.9.0`) con `access: 'private'` en `put()` y `get()`, sin escritura en disco local ni exposición de URLs públicas.
- **Autenticación y Contraseñas (`RNF01`):** Contraseñas hasheadas con `bcryptjs` (costo `12`), `refresh_token` aleatorio de 48 bytes almacenado únicamente como hash `SHA-256` en `sesiones_auth` con revocación en `/logout`.
- **Verificación Automatizada (`tests/qa-audit.test.js`):** Se añadieron pruebas de regresión AppSec verificando cabeceras HTTP (`nosniff`, `DENY`, `HSTS`), bloqueo de escalación de privilegios (`403`), rechazo de archivos con MIME falsificado (`400`), bloqueo de IDOR en asistencias (`403`) y sanitización de errores `500` en producción.
