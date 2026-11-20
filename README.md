# Inpa_Go Backend API REST — UNINPAHU

API REST monolítica modular para la Aplicación Móvil Inteligente de Gestión y Control de Asistencia Académica (**Inpa_Go** — UNINPAHU), desplegada en **Vercel Serverless**, con base de datos **MySQL 8.0 / TiDB Cloud (`inpa_go_db`)** y almacenamiento multimedia privado en **Vercel Blob (`inpa-go-store`)**.

## Estructura del Repositorio

- `api/index.js`: Entrypoint Serverless para Vercel.
- `src/`: Código fuente de la API Express (`config/`, `middlewares/`, `routes/`, `services/`, `utils/`, `app.js`, `server.js`).
- `database/schema_inpa_go_db.sql`: DDL oficial de las 11 tablas y datos semilla de UNINPAHU.
- `docs/specs/INPA_GO_BACKEND_SPEC.md`: Especificación técnica oficial.
- `tests/qa-audit.test.js`: Suite de verificación QA con `node:test`.
- `.agent/`: Reglas permanentes y los 6 skills de backend (`inpago-*`).

## Scripts

```bash
npm install
npm run dev
npm start
npm test
```
