const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Inpa_Go — API REST de Gestión y Control de Asistencia Académica (UNINPAHU)',
    version: '1.0.0',
    description:
      'API REST monolítica modular desplegada en Vercel Serverless, conectada a MySQL 8.0 / TiDB Cloud (`inpa_go_db`) y almacenamiento multimedia privado en Vercel Blob (`inpa-go-store`). Estándar ANSI/IEEE 830-1998 (`RF01`–`RF14`, `RNF01`–`RNF06`).',
  },
  servers: [
    {
      url: '/',
      description: 'Servidor actual (Local / Vercel Serverless)',
    },
  ],
  tags: [
    { name: 'Salud', description: 'Estado operativo del servicio' },
    {
      name: '1. Autenticación y Perfil de Voz',
      description: 'RF01, RF02, RF08, RF13, RF14 — Registro con foto, login JWT, refresh, logout y enrolamiento vocal',
    },
    {
      name: '2. Administración, Académico y Geocercas',
      description: 'RF03–RF06, RF09 — Gestión de usuarios, carga Excel, asignaturas, grupos y sedes UNINPAHU',
    },
    {
      name: '3. Sesiones, Voz FFT, GPS y Foto Privada',
      description: 'RF07–RF10, RF14 — Ciclo de vida de sesión, Haversine GPS, FFT Radix-2, lista con foto privada y confirmación',
    },
    {
      name: '4. Historial y Reportes PDF',
      description: 'RF11, RF12 — Consulta histórica por rol y exportación PDF oficial UNINPAHU',
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Token JWT de acceso emitido por POST /api/v1/auth/login o POST /api/v1/auth/refresh.',
      },
    },
    schemas: {
      SuccessResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string', example: 'Operación exitosa.' },
          data: { type: 'object' },
        },
        required: ['success', 'message', 'data'],
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          message: { type: 'string', example: 'Descripción del error.' },
          errors: {
            oneOf: [{ type: 'string' }, { type: 'object' }, { type: 'array', items: {} }],
          },
        },
        required: ['success', 'message'],
      },
    },
    responses: {
      BadRequest: {
        description: 'Datos faltantes o inválidos (400)',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
        },
      },
      Unauthorized: {
        description: 'No autenticado o token inválido/expirado (401)',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
        },
      },
      Forbidden: {
        description: 'Sin permisos RBAC o fuera de pertenencia/ownership (403)',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
        },
      },
      NotFound: {
        description: 'Recurso no encontrado (404)',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
        },
      },
      Conflict: {
        description: 'Conflicto de estado o duplicidad (409)',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
        },
      },
    },
  },
  paths: {
    '/health': {
      get: {
        tags: ['Salud'],
        summary: 'Verificar estado del servicio',
        responses: {
          200: {
            description: 'Servicio operativo',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } },
            },
          },
        },
      },
    },

    // =========================================================================
    // Módulo 1 — Autenticación, Fotografía y Perfil de Voz
    // =========================================================================
    '/api/v1/auth/registro': {
      post: {
        tags: ['1. Autenticación y Perfil de Voz'],
        summary: 'Registro público con fotografía obligatoria (RF01, RF02, RF14)',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: [
                  'documento',
                  'nombre_completo',
                  'correo_institucional',
                  'password',
                  'foto_perfil',
                ],
                properties: {
                  documento: { type: 'string', example: '1000123456' },
                  codigo_institucional: { type: 'string', example: 'EST-2026-001' },
                  nombre_completo: { type: 'string', example: 'Ana María Gómez' },
                  correo_institucional: { type: 'string', format: 'email', example: 'ana.gomez@uninpahu.edu.co' },
                  password: { type: 'string', format: 'password', example: 'ClaveSegura123!' },
                  rol_codigo: {
                    type: 'string',
                    enum: ['ESTUDIANTE', 'DOCENTE', 'ADMIN_BIENESTAR'],
                    default: 'ESTUDIANTE',
                  },
                  foto_perfil: {
                    type: 'string',
                    format: 'binary',
                    description: 'Imagen obligatoria (image/jpeg, image/png o image/webp, máx. 3 MB)',
                  },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Usuario registrado exitosamente',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          409: { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/api/v1/auth/login': {
      post: {
        tags: ['1. Autenticación y Perfil de Voz'],
        summary: 'Iniciar sesión institucional (rate-limit 40 req/15min)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['correo_institucional', 'password'],
                properties: {
                  correo_institucional: { type: 'string', format: 'email', example: 'ana.gomez@uninpahu.edu.co' },
                  password: { type: 'string', format: 'password', example: 'ClaveSegura123!' },
                  device_id: { type: 'string', example: 'expo-ios-device-01' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Tokens emitidos y perfil del usuario',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          429: { description: 'Demasiados intentos de inicio de sesión' },
        },
      },
    },
    '/api/v1/auth/refresh': {
      post: {
        tags: ['1. Autenticación y Perfil de Voz'],
        summary: 'Renovar access_token mediante refresh_token activo',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['refresh_token'],
                properties: {
                  refresh_token: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Nuevo access_token generado',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/api/v1/auth/logout': {
      post: {
        tags: ['1. Autenticación y Perfil de Voz'],
        summary: 'Cerrar sesión y revocar refresh token(s) (RF13)',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  refresh_token: {
                    type: 'string',
                    description: 'Opcional; si se omite revoca todas las sesiones activas del usuario.',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Sesión cerrada exitosamente',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/api/v1/usuarios/me/perfil-voz': {
      post: {
        tags: ['1. Autenticación y Perfil de Voz'],
        summary: 'Registrar o actualizar muestra base de voz FFT (RF08)',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['audio_voz'],
                properties: {
                  audio_voz: {
                    type: 'string',
                    format: 'binary',
                    description: 'Audio de voz (WAV, M4A, MP4, MP3 o WebM, máx. 4 MB)',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Perfil base de voz guardado en inpa-go-store',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    // =========================================================================
    // Módulo 2 — Administración Institucional, Excel, Académico y Geocercas
    // =========================================================================
    '/api/v1/usuarios': {
      get: {
        tags: ['2. Administración, Académico y Geocercas'],
        summary: 'Listar usuarios con filtros (ADMIN_BIENESTAR)',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'rol_codigo',
            in: 'query',
            schema: { type: 'string', enum: ['ADMIN_BIENESTAR', 'DOCENTE', 'ESTUDIANTE'] },
          },
          {
            name: 'activo',
            in: 'query',
            schema: { type: 'integer', enum: [0, 1] },
          },
        ],
        responses: {
          200: {
            description: 'Listado de usuarios',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
    '/api/v1/usuarios/docentes': {
      post: {
        tags: ['2. Administración, Académico y Geocercas'],
        summary: 'Crear cuenta docente (ADMIN_BIENESTAR)',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: [
                  'documento',
                  'nombre_completo',
                  'correo_institucional',
                  'password_temporal',
                ],
                properties: {
                  documento: { type: 'string', example: '80123456' },
                  codigo_institucional: { type: 'string', example: 'DOC-2026-01' },
                  nombre_completo: { type: 'string', example: 'Carlos Eduardo Pérez' },
                  correo_institucional: { type: 'string', format: 'email', example: 'cperez@uninpahu.edu.co' },
                  password_temporal: { type: 'string', format: 'password', example: 'TempUninpahu2026*' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Docente creado exitosamente',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          403: { $ref: '#/components/responses/Forbidden' },
          409: { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/api/v1/usuarios/{usuarioId}': {
      patch: {
        tags: ['2. Administración, Académico y Geocercas'],
        summary: 'Actualizar datos o estado de un usuario (ADMIN_BIENESTAR)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'usuarioId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  nombre_completo: { type: 'string' },
                  codigo_institucional: { type: 'string' },
                  activo: { type: 'integer', enum: [0, 1] },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Usuario actualizado',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/v1/importaciones/excel': {
      post: {
        tags: ['2. Administración, Académico y Geocercas'],
        summary: 'Importación masiva de usuarios, asignaturas, grupos y matrículas desde Excel (ADMIN_BIENESTAR)',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['archivo_excel'],
                properties: {
                  archivo_excel: {
                    type: 'string',
                    format: 'binary',
                    description: 'Libro Excel (.xlsx o .xls, máx. 4 MB). Columnas obligatorias: documento, nombre_completo, correo_institucional.',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Importación procesada con resumen y arreglo errores[]',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          403: { $ref: '#/components/responses/Forbidden' },
          422: {
            description: 'Hoja vacía o columnas obligatorias faltantes',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
            },
          },
        },
      },
    },
    '/api/v1/asignaturas': {
      get: {
        tags: ['2. Administración, Académico y Geocercas'],
        summary: 'Consultar asignaturas y grupos filtrados según el rol del usuario',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'periodo_academico', in: 'query', schema: { type: 'string', example: '2026-2' } },
        ],
        responses: {
          200: {
            description: 'Asignaturas y grupos',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
      post: {
        tags: ['2. Administración, Académico y Geocercas'],
        summary: 'Crear asignatura académica (ADMIN_BIENESTAR)',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['codigo', 'nombre'],
                properties: {
                  codigo: { type: 'string', example: 'ING-101' },
                  nombre: { type: 'string', example: 'Ingeniería de Software' },
                  creditos: { type: 'integer', example: 3 },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Asignatura creada',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          403: { $ref: '#/components/responses/Forbidden' },
          409: { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/api/v1/asignaturas/{asignaturaId}': {
      patch: {
        tags: ['2. Administración, Académico y Geocercas'],
        summary: 'Actualizar asignatura académica (ADMIN_BIENESTAR)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'asignaturaId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  codigo: { type: 'string' },
                  nombre: { type: 'string' },
                  creditos: { type: 'integer' },
                  activa: { type: 'integer', enum: [0, 1] },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Asignatura actualizada',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } },
            },
          },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/v1/grupos': {
      post: {
        tags: ['2. Administración, Académico y Geocercas'],
        summary: 'Crear grupo académico y asignar docente (ADMIN_BIENESTAR)',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['asignatura_id', 'docente_id', 'codigo_grupo', 'periodo_academico'],
                properties: {
                  asignatura_id: { type: 'integer', example: 1 },
                  docente_id: { type: 'integer', example: 2 },
                  codigo_grupo: { type: 'string', example: 'G01' },
                  periodo_academico: { type: 'string', example: '2026-2' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Grupo creado',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          403: { $ref: '#/components/responses/Forbidden' },
          409: { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/api/v1/grupos/{grupoId}': {
      patch: {
        tags: ['2. Administración, Académico y Geocercas'],
        summary: 'Actualizar grupo académico (ADMIN_BIENESTAR)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'grupoId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  docente_id: { type: 'integer' },
                  codigo_grupo: { type: 'string' },
                  periodo_academico: { type: 'string' },
                  activo: { type: 'integer', enum: [0, 1] },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Grupo actualizado',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } },
            },
          },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/v1/configuracion/geocercas': {
      get: {
        tags: ['2. Administración, Académico y Geocercas'],
        summary: 'Listar sedes y geocercas activas de UNINPAHU (Todos los roles)',
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Geocercas activas',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/api/v1/configuracion/geocerca': {
      put: {
        tags: ['2. Administración, Académico y Geocercas'],
        summary: 'Crear o actualizar una geocerca institucional (ADMIN_BIENESTAR)',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['sede', 'latitud', 'longitud'],
                properties: {
                  geocerca_id: { type: 'integer', description: 'Opcional; si se envía actualiza esa geocerca.' },
                  sede: { type: 'string', example: 'UNINPAHU - Sede Principal' },
                  latitud: { type: 'number', example: 4.628889 },
                  longitud: { type: 'number', example: -74.065833 },
                  radio_metros: { type: 'integer', default: 300 },
                  activa: { type: 'integer', enum: [0, 1], default: 1 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Geocerca actualizada' },
          201: { description: 'Geocerca creada' },
          400: { $ref: '#/components/responses/BadRequest' },
          403: { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    // =========================================================================
    // Módulo 3 — Sesiones, Voz FFT, GPS y Confirmación con Foto
    // =========================================================================
    '/api/v1/sesiones': {
      post: {
        tags: ['3. Sesiones, Voz FFT, GPS y Foto Privada'],
        summary: 'Abrir nueva sesión académica (DOCENTE)',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['grupo_id', 'geocerca_id', 'fecha', 'hora_inicio'],
                properties: {
                  grupo_id: { type: 'integer', example: 1 },
                  geocerca_id: { type: 'integer', example: 1 },
                  fecha: { type: 'string', format: 'date', example: '2026-11-20' },
                  hora_inicio: { type: 'string', example: '08:00:00' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Sesión abierta en estado ABIERTA',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          403: { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
    '/api/v1/sesiones/abiertas': {
      get: {
        tags: ['3. Sesiones, Voz FFT, GPS y Foto Privada'],
        summary: 'Consultar sesiones ABIERTA o PAUSADA del usuario (ESTUDIANTE o DOCENTE)',
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Listado de sesiones activas',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
    '/api/v1/sesiones/{sesionId}/pausar': {
      patch: {
        tags: ['3. Sesiones, Voz FFT, GPS y Foto Privada'],
        summary: 'Pausar sesión académica ABIERTA -> PAUSADA (DOCENTE)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'sesionId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: {
          200: { description: 'Sesión pausada' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          409: { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/api/v1/sesiones/{sesionId}/reanudar': {
      patch: {
        tags: ['3. Sesiones, Voz FFT, GPS y Foto Privada'],
        summary: 'Reanudar sesión académica PAUSADA -> ABIERTA (DOCENTE)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'sesionId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: {
          200: { description: 'Sesión reanudada' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          409: { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/api/v1/sesiones/{sesionId}/evidencia-estudiante': {
      post: {
        tags: ['3. Sesiones, Voz FFT, GPS y Foto Privada'],
        summary: 'Enviar evidencia biométrica de voz (FFT Radix-2) + ubicación GPS (Haversine) (ESTUDIANTE)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'sesionId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['latitud_reportada', 'longitud_reportada', 'audio_voz'],
                properties: {
                  latitud_reportada: { type: 'number', example: 4.628889 },
                  longitud_reportada: { type: 'number', example: -74.065833 },
                  precision_metros: { type: 'number', example: 12.5 },
                  transcripcion_voz: { type: 'string', example: 'Presente profesor' },
                  audio_voz: {
                    type: 'string',
                    format: 'binary',
                    description: 'Audio de evidencia (WAV, M4A, MP4, MP3 o WebM, máx. 4 MB)',
                  },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Evidencia evaluada y registrada',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          403: { $ref: '#/components/responses/Forbidden' },
          409: { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/api/v1/sesiones/{sesionId}/lista-asistencia': {
      get: {
        tags: ['3. Sesiones, Voz FFT, GPS y Foto Privada'],
        summary: 'Obtener lista de asistencia con evidencias y foto_url privada (DOCENTE)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'sesionId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: {
          200: {
            description: 'Metadatos de sesión y listado completo de estudiantes activos',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } },
            },
          },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/v1/usuarios/{usuarioId}/foto': {
      get: {
        tags: ['3. Sesiones, Voz FFT, GPS y Foto Privada'],
        summary: 'Stream autenticado de fotografía privada desde inpa-go-store (RF14, RNF06)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'usuarioId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: {
          200: {
            description: 'Stream binario de la imagen privada',
            content: {
              'image/jpeg': { schema: { type: 'string', format: 'binary' } },
              'image/png': { schema: { type: 'string', format: 'binary' } },
              'image/webp': { schema: { type: 'string', format: 'binary' } },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/v1/sesiones/{sesionId}/asistencias': {
      put: {
        tags: ['3. Sesiones, Voz FFT, GPS y Foto Privada'],
        summary: 'Confirmar o corregir asistencias en transacción atómica (DOCENTE)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'sesionId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['registros'],
                properties: {
                  registros: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['estudiante_id', 'estado'],
                      properties: {
                        estudiante_id: { type: 'integer', example: 20 },
                        evidencia_id: { type: 'integer', nullable: true, example: 77 },
                        estado: {
                          type: 'string',
                          enum: ['PRESENTE', 'AUSENTE', 'TARDE', 'EXCUSA'],
                        },
                        metodo_confirmacion: {
                          type: 'string',
                          enum: ['VOZ_GPS_FOTO', 'MANUAL_DOCENTE'],
                          default: 'VOZ_GPS_FOTO',
                        },
                        observacion: { type: 'string', example: 'Confirmado en aula' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Asistencias guardadas exitosamente' },
          400: { $ref: '#/components/responses/BadRequest' },
          403: { $ref: '#/components/responses/Forbidden' },
          409: { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/api/v1/sesiones/{sesionId}/finalizar': {
      patch: {
        tags: ['3. Sesiones, Voz FFT, GPS y Foto Privada'],
        summary: 'Cerrar definitivamente una sesión académica (DOCENTE)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'sesionId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  hora_fin: { type: 'string', example: '10:00:00' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Sesión cerrada definitivamente' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
          409: { $ref: '#/components/responses/Conflict' },
        },
      },
    },

    // =========================================================================
    // Módulo 4 — Historial y Reportes PDF
    // =========================================================================
    '/api/v1/asistencias/historial': {
      get: {
        tags: ['4. Historial y Reportes PDF'],
        summary: 'Consultar historial de asistencias según rol (ESTUDIANTE o DOCENTE)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'asignatura_id', in: 'query', schema: { type: 'integer' } },
          { name: 'grupo_id', in: 'query', schema: { type: 'integer' } },
          { name: 'fecha_desde', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'fecha_hasta', in: 'query', schema: { type: 'string', format: 'date' } },
        ],
        responses: {
          200: {
            description: 'Historial de registros de asistencia',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
    '/api/v1/reportes/asistencia/pdf': {
      get: {
        tags: ['4. Historial y Reportes PDF'],
        summary: 'Descargar reporte oficial de asistencia en PDF (DOCENTE)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'asignatura_id', in: 'query', schema: { type: 'integer' } },
          { name: 'grupo_id', in: 'query', schema: { type: 'integer' } },
          { name: 'sesion_id', in: 'query', schema: { type: 'integer' } },
        ],
        responses: {
          200: {
            description: 'Documento PDF generado dinámicamente con PDFKit',
            content: {
              'application/pdf': { schema: { type: 'string', format: 'binary' } },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
  },
};

module.exports = openApiSpec;
