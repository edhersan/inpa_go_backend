CREATE DATABASE IF NOT EXISTS inpa_go_db
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE inpa_go_db;

-- 1. Catálogo de Roles Institucionales (RF02)
CREATE TABLE roles (
    rol_id TINYINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    codigo VARCHAR(30) NOT NULL UNIQUE,
    nombre VARCHAR(60) NOT NULL,
    descripcion VARCHAR(255) NULL,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 2. Usuarios: Bienestar Institucional, Docentes y Estudiantes (RF01, RF03, RF08, RF14, RNF01)
CREATE TABLE usuarios (
    usuario_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    rol_id TINYINT UNSIGNED NOT NULL,
    documento VARCHAR(25) NOT NULL UNIQUE,
    codigo_institucional VARCHAR(30) NULL UNIQUE,
    nombre_completo VARCHAR(150) NOT NULL,
    correo_institucional VARCHAR(120) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    foto_ruta VARCHAR(255) NULL,
    foto_mime_type VARCHAR(50) NULL,
    foto_hash_sha256 CHAR(64) NULL,
    perfil_voz_ruta VARCHAR(255) NULL,
    perfil_voz_hash_sha256 CHAR(64) NULL,
    biometria_habilitada TINYINT(1) NOT NULL DEFAULT 0,
    activo TINYINT(1) NOT NULL DEFAULT 1,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_usuarios_rol FOREIGN KEY (rol_id) REFERENCES roles(rol_id),
    INDEX idx_usuarios_rol_activo (rol_id, activo)
) ENGINE=InnoDB;

-- 3. Sesiones JWT / Refresh Tokens Revocables (RF01, RF13)
CREATE TABLE sesiones_auth (
    sesion_auth_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    usuario_id INT UNSIGNED NOT NULL,
    refresh_token_hash CHAR(64) NOT NULL UNIQUE,
    device_id VARCHAR(100) NULL,
    ip_origen VARCHAR(45) NULL,
    expira_en DATETIME NOT NULL,
    revocada TINYINT(1) NOT NULL DEFAULT 0,
    revocada_en DATETIME NULL,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_sesiones_auth_usuario FOREIGN KEY (usuario_id)
        REFERENCES usuarios(usuario_id) ON DELETE CASCADE,
    INDEX idx_sesiones_auth_usuario (usuario_id, revocada)
) ENGINE=InnoDB;

-- 4. Asignaturas Académicas (RF04, RF05)
CREATE TABLE asignaturas (
    asignatura_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    codigo VARCHAR(25) NOT NULL UNIQUE,
    nombre VARCHAR(150) NOT NULL,
    creditos TINYINT UNSIGNED NULL,
    activa TINYINT(1) NOT NULL DEFAULT 1,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 5. Grupos Académicos y Asignación Docente (RF05, RF06)
CREATE TABLE grupos (
    grupo_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    asignatura_id INT UNSIGNED NOT NULL,
    docente_id INT UNSIGNED NOT NULL,
    codigo_grupo VARCHAR(30) NOT NULL,
    periodo_academico VARCHAR(20) NOT NULL,
    activo TINYINT(1) NOT NULL DEFAULT 1,
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_grupos_asignatura FOREIGN KEY (asignatura_id) REFERENCES asignaturas(asignatura_id),
    CONSTRAINT fk_grupos_docente FOREIGN KEY (docente_id) REFERENCES usuarios(usuario_id),
    UNIQUE KEY uk_grupo_asignatura_periodo (asignatura_id, codigo_grupo, periodo_academico),
    INDEX idx_grupos_docente (docente_id, activo)
) ENGINE=InnoDB;

-- 6. Matrícula / Vinculación Estudiantes <-> Grupos (RF04, RF06)
CREATE TABLE inscripciones_grupo (
    inscripcion_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    grupo_id INT UNSIGNED NOT NULL,
    estudiante_id INT UNSIGNED NOT NULL,
    estado ENUM('ACTIVO', 'RETIRADO') NOT NULL DEFAULT 'ACTIVO',
    fecha_vinculacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_inscripciones_grupo FOREIGN KEY (grupo_id) REFERENCES grupos(grupo_id),
    CONSTRAINT fk_inscripciones_estudiante FOREIGN KEY (estudiante_id) REFERENCES usuarios(usuario_id),
    UNIQUE KEY uk_grupo_estudiante (grupo_id, estudiante_id),
    INDEX idx_inscripciones_estudiante (estudiante_id, estado)
) ENGINE=InnoDB;

-- 7. Zonas Geográficas Autorizadas UNINPAHU (RF09)
CREATE TABLE geocercas_institucionales (
    geocerca_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    sede VARCHAR(120) NOT NULL,
    latitud DECIMAL(10, 8) NOT NULL,
    longitud DECIMAL(11, 8) NOT NULL,
    radio_metros SMALLINT UNSIGNED NOT NULL DEFAULT 300,
    activa TINYINT(1) NOT NULL DEFAULT 1,
    actualizado_por INT UNSIGNED NULL,
    actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_geocercas_admin FOREIGN KEY (actualizado_por) REFERENCES usuarios(usuario_id)
) ENGINE=InnoDB;

-- 8. Sesiones Académicas de Clase (RF07)
CREATE TABLE sesiones_academicas (
    sesion_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    grupo_id INT UNSIGNED NOT NULL,
    docente_id INT UNSIGNED NOT NULL,
    geocerca_id INT UNSIGNED NOT NULL,
    fecha DATE NOT NULL,
    hora_inicio TIME NOT NULL,
    hora_fin TIME NULL,
    estado ENUM('ABIERTA', 'PAUSADA', 'CERRADA') NOT NULL DEFAULT 'ABIERTA',
    creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cerrada_en DATETIME NULL,
    CONSTRAINT fk_sesiones_grupo FOREIGN KEY (grupo_id) REFERENCES grupos(grupo_id),
    CONSTRAINT fk_sesiones_docente FOREIGN KEY (docente_id) REFERENCES usuarios(usuario_id),
    CONSTRAINT fk_sesiones_geocerca FOREIGN KEY (geocerca_id) REFERENCES geocercas_institucionales(geocerca_id),
    INDEX idx_sesiones_grupo_fecha (grupo_id, fecha),
    INDEX idx_sesiones_docente_estado (docente_id, estado)
) ENGINE=InnoDB;

-- 9. Evidencia Biométrica de Voz y Ubicación GPS del Estudiante (RF08, RF09, RNF06)
CREATE TABLE evidencias_asistencia (
    evidencia_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    sesion_id INT UNSIGNED NOT NULL,
    estudiante_id INT UNSIGNED NOT NULL,
    latitud_reportada DECIMAL(10, 8) NOT NULL,
    longitud_reportada DECIMAL(11, 8) NOT NULL,
    precision_metros DECIMAL(6, 2) NULL,
    distancia_metros DECIMAL(8, 2) NOT NULL,
    ubicacion_valida TINYINT(1) NOT NULL,
    audio_voz_ruta VARCHAR(255) NOT NULL,
    audio_voz_hash_sha256 CHAR(64) NOT NULL,
    transcripcion_voz VARCHAR(255) NULL,
    similitud_espectro DECIMAL(5, 2) NULL,
    voz_valida TINYINT(1) NOT NULL DEFAULT 0,
    enviado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_evidencias_sesion FOREIGN KEY (sesion_id) REFERENCES sesiones_academicas(sesion_id),
    CONSTRAINT fk_evidencias_estudiante FOREIGN KEY (estudiante_id) REFERENCES usuarios(usuario_id),
    UNIQUE KEY uk_evidencia_sesion_estudiante (sesion_id, estudiante_id)
) ENGINE=InnoDB;

-- 10. Registro Oficial de Asistencia Confirmado por el Docente (RF10, RF11, RF12, RNF03)
CREATE TABLE registros_asistencia (
    asistencia_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    sesion_id INT UNSIGNED NOT NULL,
    estudiante_id INT UNSIGNED NOT NULL,
    evidencia_id BIGINT UNSIGNED NULL,
    estado ENUM('PRESENTE', 'AUSENTE', 'TARDE', 'EXCUSA') NOT NULL,
    metodo_confirmacion ENUM('VOZ_GPS_FOTO', 'MANUAL_DOCENTE') NOT NULL DEFAULT 'VOZ_GPS_FOTO',
    observacion VARCHAR(255) NULL,
    confirmado_por INT UNSIGNED NOT NULL,
    confirmado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_asistencia_sesion FOREIGN KEY (sesion_id) REFERENCES sesiones_academicas(sesion_id),
    CONSTRAINT fk_asistencia_estudiante FOREIGN KEY (estudiante_id) REFERENCES usuarios(usuario_id),
    CONSTRAINT fk_asistencia_evidencia FOREIGN KEY (evidencia_id)
        REFERENCES evidencias_asistencia(evidencia_id) ON DELETE SET NULL,
    CONSTRAINT fk_asistencia_docente FOREIGN KEY (confirmado_por) REFERENCES usuarios(usuario_id),
    UNIQUE KEY uk_asistencia_sesion_estudiante (sesion_id, estudiante_id),
    INDEX idx_asistencia_estudiante (estudiante_id, confirmado_en)
) ENGINE=InnoDB;

-- 11. Auditoría de Importaciones Masivas Excel (RF04)
CREATE TABLE importaciones_excel (
    importacion_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    administrador_id INT UNSIGNED NOT NULL,
    nombre_archivo VARCHAR(200) NOT NULL,
    total_filas INT UNSIGNED NOT NULL DEFAULT 0,
    filas_exitosas INT UNSIGNED NOT NULL DEFAULT 0,
    filas_con_error INT UNSIGNED NOT NULL DEFAULT 0,
    detalle_errores_json JSON NULL,
    ejecutado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_importaciones_admin FOREIGN KEY (administrador_id) REFERENCES usuarios(usuario_id)
) ENGINE=InnoDB;

-- Datos Semilla Iniciales (Roles + Sedes Oficiales UNINPAHU Bogotá)
INSERT INTO roles (codigo, nombre, descripcion) VALUES
('ADMIN_BIENESTAR', 'Administrador (Bienestar Institucional)', 'Gestión integral de usuarios, carga Excel, asignaturas, grupos y geocercas'),
('DOCENTE', 'Docente', 'Gestión de sesiones académicas, revisión visual/voz/GPS, confirmación de asistencia y reportes PDF'),
('ESTUDIANTE', 'Estudiante', 'Confirmación de asistencia por voz/GPS y consulta de historial personal');

INSERT INTO geocercas_institucionales (sede, latitud, longitud, radio_metros, activa) VALUES
('UNINPAHU - Sede Principal (Cl. 44 # 16-40, Teusaquillo)', 4.62888900, -74.06583300, 300, 1),
('UNINPAHU - Sede Académica 2 (Cra. 16 # 43-20)', 4.63050000, -74.06720000, 250, 1);
