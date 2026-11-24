const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Readable } = require('node:stream');
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');

process.env.JWT_ACCESS_SECRET = 'test_secret_inpa_go_qa_2026';
process.env.BLOB_STORE_NAME = 'inpa-go-store';
process.env.BLOB_READ_WRITE_TOKEN = 'test_blob_token';
process.env.VOICE_SIMILARITY_THRESHOLD = '70';

const BACKEND_ROOT = path.resolve(__dirname, '..');

function buildSyntheticWav(freqHz, durationSec = 0.5, sampleRate = 16000, amplitude = 0.5) {
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // Mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i += 1) {
    const sample =
      amplitude === 0
        ? 0
        : Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * amplitude;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), 44 + i * 2);
  }
  return buf;
}

function makeToken({ usuario_id, rol_id, rol_codigo, correo_institucional }) {
  return jwt.sign(
    { usuario_id, rol_id, rol_codigo, correo_institucional },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: '30m' }
  );
}

function listJsFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listJsFiles(full));
    } else if (entry.name.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

function collectRoutes(stack, prefix = '') {
  const routes = [];
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).map((m) => m.toUpperCase());
      const rawPaths = Array.isArray(layer.route.path)
        ? layer.route.path
        : [layer.route.path];
      for (const routePath of rawPaths) {
        const fullPath = `${prefix}${routePath}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
        for (const method of methods) {
          routes.push(`${method} ${fullPath}`);
        }
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      let segment = '';
      if (!layer.regexp.fast_slash) {
        const match = layer.regexp
          .toString()
          .replace('/^\\', '')
          .replace('\\/?(?=\\/|$)/i', '')
          .replace(/\\\//g, '/');
        segment = match === '/' ? '' : match;
      }
      routes.push(...collectRoutes(layer.handle.stack, `${prefix}${segment}`));
    }
  }
  return routes;
}

// =========================================================================
// 1. Auditoría Estática de Reglas No Negociables y Trazabilidad ERS
// =========================================================================
test('Auditoría estática: cero TODOs, cero disco local, cero PostgreSQL/Prisma', () => {
  const files = [
    ...listJsFiles(path.join(BACKEND_ROOT, 'src')),
    ...listJsFiles(path.join(BACKEND_ROOT, 'api')),
  ];

  const forbiddenPatterns = [
    { name: 'TODO placeholder', regex: /\/\/\s*TODO/i },
    { name: 'multer.diskStorage', regex: /diskStorage/ },
    { name: 'fs.writeFileSync', regex: /writeFileSync/ },
    { name: 'Prisma', regex: /@prisma\/client|prisma/i },
    { name: 'PostgreSQL / Neon', regex: /require\(['"](pg|@neondatabase)/i },
  ];

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const pattern of forbiddenPatterns) {
      assert.equal(
        pattern.regex.test(content),
        false,
        `Patrón prohibido (${pattern.name}) encontrado en ${path.relative(BACKEND_ROOT, filePath)}`
      );
    }
  }

  const vercelConfig = JSON.parse(
    fs.readFileSync(path.join(BACKEND_ROOT, 'vercel.json'), 'utf8')
  );
  assert.equal(vercelConfig.version, 2);
  assert.deepEqual(vercelConfig.rewrites, [
    { source: '/health', destination: '/api/index.js' },
    { source: '/docs', destination: '/api/index.js' },
    { source: '/docs/(.*)', destination: '/api/index.js' },
    { source: '/openapi.json', destination: '/api/index.js' },
    { source: '/api/v1/(.*)', destination: '/api/index.js' },
  ]);

  const { PHOTO_MAX_BYTES, AUDIO_MAX_BYTES, EXCEL_MAX_BYTES } = require('../src/middlewares/upload.middleware');
  assert.equal(PHOTO_MAX_BYTES, 3 * 1024 * 1024);
  assert.equal(AUDIO_MAX_BYTES, 4 * 1024 * 1024);
  assert.equal(EXCEL_MAX_BYTES, 4 * 1024 * 1024);
});

// =========================================================================
// 2. Motor Geográfico Haversine (RF09)
// =========================================================================
test('Geocerca Haversine valida sedes UNINPAHU correctamente', () => {
  const { validarGeocerca } = require('../src/utils/haversine.util');

  // Sede Principal UNINPAHU: 4.62888900, -74.06583300, radio 300 m
  const exact = validarGeocerca(4.628889, -74.065833, 4.628889, -74.065833, 300);
  assert.equal(exact.distancia_metros, 0);
  assert.equal(exact.ubicacion_valida, 1);

  const inside = validarGeocerca(4.6295, -74.065833, 4.628889, -74.065833, 300);
  assert.ok(inside.distancia_metros > 50 && inside.distancia_metros < 100);
  assert.equal(inside.ubicacion_valida, 1);

  const outside = validarGeocerca(4.64, -74.065833, 4.628889, -74.065833, 300);
  assert.ok(outside.distancia_metros > 1000);
  assert.equal(outside.ubicacion_valida, 0);
});

// =========================================================================
// 3. Motor Espectral de Voz FFT Radix-2 (RF08)
// =========================================================================
test('Motor FFT Radix-2 detecta silencio, genera vector 18D L2 y compara similitud del coseno', () => {
  const {
    extractVoiceSignature,
    compareVoiceBuffers,
  } = require('../src/utils/voiceSpectrum.util');

  const silentWav = buildSyntheticWav(440, 0.4, 16000, 0);
  const silentSig = extractVoiceSignature(silentWav);
  assert.equal(silentSig.activeFrames, 0);

  const tone440 = buildSyntheticWav(440, 0.5, 16000, 0.6);
  const sig440 = extractVoiceSignature(tone440);
  assert.ok(sig440.activeFrames > 0);
  assert.equal(sig440.vector.length, 18);

  const norm = Math.sqrt(sig440.vector.reduce((acc, v) => acc + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-6, 'El vector espectral debe estar normalizado L2');

  const sameResult = compareVoiceBuffers(tone440, tone440, 70);
  assert.ok(sameResult.similitud_espectro >= 99.9);
  assert.equal(sameResult.voz_valida, 1);

  const tone3500 = buildSyntheticWav(3500, 0.5, 16000, 0.6);
  const diffResult = compareVoiceBuffers(tone440, tone3500, 70);
  assert.ok(diffResult.similitud_espectro < 70);
  assert.equal(diffResult.voz_valida, 0);
});

// =========================================================================
// 4. Auditoría de los 27 Endpoints + /health, RBAC, 400/403/409/422 y SLA < 3000ms
// =========================================================================
test('Integración API: 27 endpoints + /health, pruebas negativas críticas y SLA < 3000 ms', async () => {
  // Inyectar mocks controlados para DB y Vercel Blob antes de cargar app
  let mockQueryHandler = async () => [];
  const dbPath = require.resolve('../src/config/db');
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      query: (sql, params) => mockQueryHandler(sql, params),
      getConnection: async () => ({
        beginTransaction: async () => {},
        execute: async (sql, params) => [await mockQueryHandler(sql, params)],
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
      }),
      getPool: () => ({}),
    },
  };

  const blobPath = require.resolve('../src/services/blobStorage.service');
  require.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      uploadPrivateBlob: async (pathname) => pathname,
      getPrivateBlobStream: async () => ({
        stream: Readable.from([Buffer.from('FAKE_JPEG_BINARY')]),
        contentType: 'image/jpeg',
        size: 16,
      }),
      getPrivateBlobBuffer: async () => buildSyntheticWav(440, 0.5, 16000, 0.6),
      deletePrivateBlob: async () => {},
    },
  };

  const app = require('../src/app');

  // Verificar inventario completo de 27 endpoints + /health
  const registeredRoutes = collectRoutes(app._router.stack);
  const expectedEndpoints = [
    'GET /health',
    'POST /api/v1/auth/registro',
    'POST /api/v1/auth/login',
    'POST /api/v1/auth/refresh',
    'POST /api/v1/auth/logout',
    'POST /api/v1/usuarios/me/perfil-voz',
    'GET /api/v1/usuarios',
    'POST /api/v1/usuarios/docentes',
    'PATCH /api/v1/usuarios/:usuarioId',
    'GET /api/v1/usuarios/:usuarioId/foto',
    'POST /api/v1/importaciones/excel',
    'GET /api/v1/asignaturas',
    'POST /api/v1/asignaturas',
    'PATCH /api/v1/asignaturas/:asignaturaId',
    'POST /api/v1/grupos',
    'PATCH /api/v1/grupos/:grupoId',
    'GET /api/v1/grupos/:grupoId/estudiantes',
    'POST /api/v1/grupos/:grupoId/estudiantes',
    'DELETE /api/v1/grupos/:grupoId/estudiantes/:estudianteId',
    'GET /api/v1/configuracion/geocercas',
    'PUT /api/v1/configuracion/geocerca',
    'POST /api/v1/sesiones',
    'GET /api/v1/sesiones/abiertas',
    'PATCH /api/v1/sesiones/:sesionId/pausar',
    'PATCH /api/v1/sesiones/:sesionId/reanudar',
    'POST /api/v1/sesiones/:sesionId/evidencia-estudiante',
    'GET /api/v1/sesiones/:sesionId/lista-asistencia',
    'PUT /api/v1/sesiones/:sesionId/asistencias',
    'PATCH /api/v1/sesiones/:sesionId/finalizar',
    'GET /api/v1/asistencias/historial',
    'GET /api/v1/reportes/asistencia/pdf',
  ];

  for (const ep of expectedEndpoints) {
    assert.ok(
      registeredRoutes.includes(ep),
      `Falta el endpoint especificado: ${ep}`
    );
  }
  assert.equal(expectedEndpoints.length, 31);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const tokenAdmin = makeToken({
    usuario_id: 1,
    rol_id: 1,
    rol_codigo: 'ADMIN_BIENESTAR',
    correo_institucional: 'admin@uninpahu.edu.co',
  });
  const tokenDocente = makeToken({
    usuario_id: 10,
    rol_id: 2,
    rol_codigo: 'DOCENTE',
    correo_institucional: 'docente@uninpahu.edu.co',
  });
  const tokenEstudiante = makeToken({
    usuario_id: 20,
    rol_id: 3,
    rol_codigo: 'ESTUDIANTE',
    correo_institucional: 'estudiante@uninpahu.edu.co',
  });

  try {
    // 4.1 GET /health + SLA < 3000 ms
    const t0 = performance.now();
    const healthRes = await fetch(`${baseUrl}/health`);
    const elapsed = performance.now() - t0;
    const healthJson = await healthRes.json();
    assert.equal(healthRes.status, 200);
    assert.equal(healthJson.success, true);
    assert.equal(healthJson.data.status, 'OK');
    assert.equal(healthJson.data.storage, 'inpa-go-store');
    assert.ok(elapsed < 3000, `SLA RNF02 excedido: ${elapsed} ms`);

    // 4.2 Registro sin foto_perfil -> 400
    const regForm = new FormData();
    regForm.append('documento', '1000123456');
    regForm.append('nombre_completo', 'Estudiante Prueba');
    regForm.append('correo_institucional', 'prueba@uninpahu.edu.co');
    regForm.append('password', 'ClaveSegura123');
    const regRes = await fetch(`${baseUrl}/api/v1/auth/registro`, {
      method: 'POST',
      body: regForm,
    });
    assert.equal(regRes.status, 400);
    const regJson = await regRes.json();
    assert.equal(regJson.success, false);

    // 4.3 Foto privada: otro estudiante -> 403
    const fotoOtherStudent = await fetch(`${baseUrl}/api/v1/usuarios/99/foto`, {
      headers: { Authorization: `Bearer ${tokenEstudiante}` },
    });
    assert.equal(fotoOtherStudent.status, 403);

    // 4.4 Foto privada: docente de otro grupo -> 403
    mockQueryHandler = async () => [];
    const fotoOtherTeacher = await fetch(`${baseUrl}/api/v1/usuarios/99/foto`, {
      headers: { Authorization: `Bearer ${tokenDocente}` },
    });
    assert.equal(fotoOtherTeacher.status, 403);

    // 4.5 Foto privada: ADMIN_BIENESTAR -> 200 stream binario privado
    mockQueryHandler = async () => [
      { foto_ruta: 'fotos/test.jpg', foto_mime_type: 'image/jpeg' },
    ];
    const fotoAdmin = await fetch(`${baseUrl}/api/v1/usuarios/99/foto`, {
      headers: { Authorization: `Bearer ${tokenAdmin}` },
    });
    assert.equal(fotoAdmin.status, 200);
    assert.equal(fotoAdmin.headers.get('content-type'), 'image/jpeg');
    assert.equal(fotoAdmin.headers.get('cache-control'), 'private, max-age=300');

    // 4.6 Evidencia en sesión PAUSADA -> 409 Conflict
    mockQueryHandler = async (sql) => {
      if (sql.includes('FROM sesiones_academicas')) {
        return [{ sesion_id: 5, grupo_id: 2, estado: 'PAUSADA', sede_latitud: 4.628889, sede_longitud: -74.065833, radio_metros: 300 }];
      }
      if (sql.includes('FROM inscripciones_grupo')) {
        return [{ inscripcion_id: 1 }];
      }
      return [];
    };
    const wavValid = buildSyntheticWav(440, 0.5, 16000, 0.6);
    const evPausedForm = new FormData();
    evPausedForm.append('latitud_reportada', '4.628889');
    evPausedForm.append('longitud_reportada', '-74.065833');
    evPausedForm.append('audio_voz', new Blob([wavValid], { type: 'audio/wav' }), 'voz.wav');
    const evPausedRes = await fetch(`${baseUrl}/api/v1/sesiones/5/evidencia-estudiante`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenEstudiante}` },
      body: evPausedForm,
    });
    assert.equal(evPausedRes.status, 409);

    // 4.7 Confirmar asistencias en sesión CERRADA -> 409 Conflict
    mockQueryHandler = async () => [{ sesion_id: 5, docente_id: 10, estado: 'CERRADA' }];
    const asistClosedRes = await fetch(`${baseUrl}/api/v1/sesiones/5/asistencias`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tokenDocente}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        registros: [{ estudiante_id: 20, estado: 'PRESENTE' }],
      }),
    });
    assert.equal(asistClosedRes.status, 409);

    // 4.8 Evidencia en sesión ABIERTA -> 201 Created con Haversine + FFT
    mockQueryHandler = async (sql) => {
      if (sql.includes('FROM sesiones_academicas')) {
        return [{ sesion_id: 7, grupo_id: 2, estado: 'ABIERTA', sede_latitud: 4.628889, sede_longitud: -74.065833, radio_metros: 300 }];
      }
      if (sql.includes('FROM inscripciones_grupo')) {
        return [{ inscripcion_id: 1 }];
      }
      if (sql.includes('SELECT perfil_voz_ruta')) {
        return [{ perfil_voz_ruta: null }];
      }
      if (sql.includes('SELECT evidencia_id')) {
        return [{ evidencia_id: 77 }];
      }
      return { insertId: 77, affectedRows: 1 };
    };
    const evOpenForm = new FormData();
    evOpenForm.append('latitud_reportada', '4.628889');
    evOpenForm.append('longitud_reportada', '-74.065833');
    evOpenForm.append('audio_voz', new Blob([wavValid], { type: 'audio/wav' }), 'voz.wav');
    const evOpenRes = await fetch(`${baseUrl}/api/v1/sesiones/7/evidencia-estudiante`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenEstudiante}` },
      body: evOpenForm,
    });
    assert.equal(evOpenRes.status, 201);
    const evOpenJson = await evOpenRes.json();
    assert.equal(evOpenJson.data.ubicacion_valida, 1);
    assert.equal(evOpenJson.data.voz_valida, 1);
    assert.equal(evOpenJson.data.enrolamiento_inicial, true);

    // 4.9 Excel sin columna documento -> 422 Unprocessable Entity
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet([
      { nombre_completo: 'Sin Documento', correo_institucional: 'x@uninpahu.edu.co' },
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Usuarios');
    const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const excelForm = new FormData();
    excelForm.append(
      'archivo_excel',
      new Blob([xlsxBuf], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      'invalido.xlsx'
    );
    const excelRes = await fetch(`${baseUrl}/api/v1/importaciones/excel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenAdmin}` },
      body: excelForm,
    });
    assert.equal(excelRes.status, 422);
    const excelJson = await excelRes.json();
    assert.deepEqual(excelJson.errors.columnas_faltantes, ['documento']);

    // 4.10 Reporte PDF (RF12) -> application/pdf para DOCENTE, 403 para ESTUDIANTE
    mockQueryHandler = async () => [
      {
        sesion_id: 7,
        fecha: '2026-11-20',
        asignatura_codigo: 'ING101',
        asignatura_nombre: 'Ingeniería de Software',
        codigo_grupo: 'G01',
        periodo_academico: '2026-2',
        docente_nombre: 'Prof. Carlos Pérez',
        estudiante_documento: '1000123456',
        estudiante_nombre: 'Ana Gómez',
        estado_asistencia: 'PRESENTE',
        metodo_confirmacion: 'VOZ_GPS_FOTO',
        observacion: 'Validado',
      },
    ];
    const pdfRes = await fetch(`${baseUrl}/api/v1/reportes/asistencia/pdf?grupo_id=2`, {
      headers: { Authorization: `Bearer ${tokenDocente}` },
    });
    assert.equal(pdfRes.status, 200);
    assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');
    const pdfBytes = Buffer.from(await pdfRes.arrayBuffer());
    assert.equal(pdfBytes.subarray(0, 5).toString('ascii'), '%PDF-');

    const pdfForbidden = await fetch(`${baseUrl}/api/v1/reportes/asistencia/pdf`, {
      headers: { Authorization: `Bearer ${tokenEstudiante}` },
    });
    assert.equal(pdfForbidden.status, 403);

    // 4.11 AppSec OWASP: Cabeceras HTTP endurecidas
    assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(healthRes.headers.get('x-frame-options'), 'DENY');
    assert.ok(
      (healthRes.headers.get('strict-transport-security') || '').includes('max-age=31536000')
    );

    // 4.12 AppSec OWASP A01: Bloqueo de escalación de privilegios en auto-registro
    const validJpegBytes = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    ]);
    const escalForm = new FormData();
    escalForm.append('documento', '99999999');
    escalForm.append('nombre_completo', 'Intento Admin');
    escalForm.append('correo_institucional', 'escalacion@uninpahu.edu.co');
    escalForm.append('password', 'ClaveSegura123!');
    escalForm.append('rol_codigo', 'ADMIN_BIENESTAR');
    escalForm.append('foto_perfil', new Blob([validJpegBytes], { type: 'image/jpeg' }), 'foto.jpg');
    const escalRes = await fetch(`${baseUrl}/api/v1/auth/registro`, {
      method: 'POST',
      body: escalForm,
    });
    assert.equal(escalRes.status, 403);

    // 4.13 AppSec OWASP A04/A08: Rechazo de archivo con MIME falsificado (magic bytes)
    const spoofForm = new FormData();
    spoofForm.append('documento', '88888888');
    spoofForm.append('nombre_completo', 'Spoof Test');
    spoofForm.append('correo_institucional', 'spoof@uninpahu.edu.co');
    spoofForm.append('password', 'ClaveSegura123!');
    spoofForm.append(
      'foto_perfil',
      new Blob([Buffer.from('<html><script>alert(1)</script></html>')], { type: 'image/jpeg' }),
      'fake.jpg'
    );
    const spoofRes = await fetch(`${baseUrl}/api/v1/auth/registro`, {
      method: 'POST',
      body: spoofForm,
    });
    assert.equal(spoofRes.status, 400);

    // 4.14 AppSec OWASP A01 (IDOR): Docente no puede confirmar asistencia de estudiante fuera del grupo
    mockQueryHandler = async (sql) => {
      if (sql.includes('FROM sesiones_academicas')) {
        return [{ sesion_id: 7, grupo_id: 2, docente_id: 10, estado: 'ABIERTA' }];
      }
      if (sql.includes('FROM inscripciones_grupo')) {
        return [{ estudiante_id: 20 }]; // Solo estudiante 20 está inscrito
      }
      return [];
    };
    const idorAsistRes = await fetch(`${baseUrl}/api/v1/sesiones/7/asistencias`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tokenDocente}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        registros: [{ estudiante_id: 999, estado: 'PRESENTE' }],
      }),
    });
    assert.equal(idorAsistRes.status, 403);

    // 4.15 PATCH /api/v1/grupos/:grupoId valida rol DOCENTE activo y acepta activo booleano
    mockQueryHandler = async (sql) => {
      if (sql.includes("r.codigo = 'DOCENTE'")) {
        return []; // docente inválido o inactivo
      }
      return { affectedRows: 1 };
    };
    const invalidDocenteRes = await fetch(`${baseUrl}/api/v1/grupos/2`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${tokenAdmin}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ docente_id: 999, activo: true }),
    });
    assert.equal(invalidDocenteRes.status, 400);

    // 4.16 GET/POST/DELETE /api/v1/grupos/:grupoId/estudiantes (canManageGrupo RBAC + Ownership)
    mockQueryHandler = async (sql) => {
      if (sql.includes('SELECT grupo_id, docente_id, activo FROM grupos')) {
        return [{ grupo_id: 2, docente_id: 99, activo: 1 }]; // Pertenece a otro docente (99 != 10)
      }
      return [];
    };
    const otherGroupGetRes = await fetch(`${baseUrl}/api/v1/grupos/2/estudiantes`, {
      headers: { Authorization: `Bearer ${tokenDocente}` },
    });
    assert.equal(otherGroupGetRes.status, 403);

    mockQueryHandler = async (sql) => {
      if (sql.includes('SELECT grupo_id, docente_id, activo FROM grupos')) {
        return [{ grupo_id: 2, docente_id: 10, activo: 1 }]; // Dueño docente 10
      }
      if (sql.includes("r.codigo = 'ESTUDIANTE'")) {
        return [{ usuario_id: 20 }, { usuario_id: 21 }];
      }
      if (sql.includes('FROM inscripciones_grupo ig')) {
        return [
          {
            usuario_id: 20,
            documento: '1000123456',
            codigo_institucional: 'EST-01',
            nombre_completo: 'Ana Gómez',
            correo_institucional: 'ana@uninpahu.edu.co',
          },
        ];
      }
      return { affectedRows: 1 };
    };
    const ownerGroupGetRes = await fetch(`${baseUrl}/api/v1/grupos/2/estudiantes`, {
      headers: { Authorization: `Bearer ${tokenDocente}` },
    });
    assert.equal(ownerGroupGetRes.status, 200);
    const ownerGroupGetJson = await ownerGroupGetRes.json();
    assert.equal(ownerGroupGetJson.data.estudiantes[0].foto_url, '/api/v1/usuarios/20/foto');

    const enrollRes = await fetch(`${baseUrl}/api/v1/grupos/2/estudiantes`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenDocente}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ estudiante_ids: [20, 21] }),
    });
    assert.equal(enrollRes.status, 201);
    const enrollJson = await enrollRes.json();
    assert.equal(enrollJson.data.inscritos_procesados, 2);

    const removeRes = await fetch(`${baseUrl}/api/v1/grupos/2/estudiantes/20`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenDocente}` },
    });
    assert.equal(removeRes.status, 200);
    const removeJson = await removeRes.json();
    assert.equal(removeJson.data.estado, 'RETIRADO');

    // 4.17 GET /api/v1/usuarios: directorio de estudiantes activos para DOCENTE y bloqueo de otros filtros
    mockQueryHandler = async () => [
      {
        usuario_id: 20,
        documento: '1000123456',
        codigo_institucional: 'EST-01',
        nombre_completo: 'Ana Gómez',
        correo_institucional: 'ana@uninpahu.edu.co',
      },
    ];
    const dirAllowedRes = await fetch(
      `${baseUrl}/api/v1/usuarios?rol_codigo=ESTUDIANTE&activo=1`,
      { headers: { Authorization: `Bearer ${tokenDocente}` } }
    );
    assert.equal(dirAllowedRes.status, 200);
    const dirAllowedJson = await dirAllowedRes.json();
    assert.deepEqual(Object.keys(dirAllowedJson.data.usuarios[0]), [
      'usuario_id',
      'documento',
      'codigo_institucional',
      'nombre_completo',
      'correo_institucional',
    ]);

    const dirForbiddenRole = await fetch(
      `${baseUrl}/api/v1/usuarios?rol_codigo=DOCENTE&activo=1`,
      { headers: { Authorization: `Bearer ${tokenDocente}` } }
    );
    assert.equal(dirForbiddenRole.status, 403);

    const dirForbiddenInactive = await fetch(
      `${baseUrl}/api/v1/usuarios?rol_codigo=ESTUDIANTE&activo=0`,
      { headers: { Authorization: `Bearer ${tokenDocente}` } }
    );
    assert.equal(dirForbiddenInactive.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// =========================================================================
// 5. Sanitización de Errores en Producción (OWASP A05)
// =========================================================================
test('AppSec: sendError oculta stack y detalles SQL en NODE_ENV=production', () => {
  const { sendError } = require('../src/utils/response.util');
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    let capturedStatus = null;
    let capturedBody = null;
    const mockRes = {
      status(code) {
        capturedStatus = code;
        return this;
      },
      json(body) {
        capturedBody = body;
        return this;
      },
    };
    sendError(mockRes, 500, 'SQL Error: Unknown column in usuarios', 'Error: stack trace');
    assert.equal(capturedStatus, 500);
    assert.equal(capturedBody.success, false);
    assert.equal(capturedBody.message, 'Error interno del servidor.');
    assert.equal(capturedBody.errors, undefined);
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});
