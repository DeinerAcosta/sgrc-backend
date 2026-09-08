-- PROYECTOS-3255 · FASE 6 (sep-2026)
--
-- (1) #5.1 · Firma escaneada del profesional
--     Columna `recursos.firma_url` (TEXT, opcional) — guarda data URL base64.
--     El PDF F-AA-126 la pinta en la caja "Firma del prestador" cuando existe.
--
-- (2) #4.1 · Módulo Queja (MVP)
--     Tabla `quejas` con FK a recursos + sedes + ausencias (opcional).
--     Estados: pendiente / en_atencion / resuelta / desestimada.
--     Prioridad: baja / media / alta.
--     Origen: paciente / interno / directivo.
--
-- IDEMPOTENTE: se puede correr N veces sin efecto adicional. MySQL 8 no admite
-- ADD COLUMN IF NOT EXISTS ni CREATE TABLE de una tabla con FKs preexistentes
-- si ya existe, por eso todo va con checks de information_schema.

-- ================================================
-- (1) recursos.firma_url
-- ================================================
SET @c0 := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'recursos' AND COLUMN_NAME = 'firma_url');
SET @sc0 := IF(@c0 = 0,
  'ALTER TABLE `recursos` ADD COLUMN `firma_url` TEXT NULL',
  'SELECT 1');
PREPARE pc0 FROM @sc0;
EXECUTE pc0;
DEALLOCATE PREPARE pc0;

-- ================================================
-- (2) Tabla `quejas`
-- ================================================
SET @t1 := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'quejas');
SET @st1 := IF(@t1 = 0,
  'CREATE TABLE `quejas` (
    `id` VARCHAR(191) NOT NULL,
    `recurso_id` VARCHAR(191) NOT NULL,
    `sede_id` VARCHAR(191) NOT NULL,
    `ausencia_id` VARCHAR(191) NULL,
    `origen` VARCHAR(20) NOT NULL,
    `descripcion` TEXT NOT NULL,
    `prioridad` VARCHAR(10) NOT NULL DEFAULT ''media'',
    `estado` VARCHAR(20) NOT NULL DEFAULT ''pendiente'',
    `notas` TEXT NULL,
    `reportado_por` VARCHAR(191) NOT NULL,
    `atendido_por` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `resolved_at` DATETIME(3) NULL,
    PRIMARY KEY (`id`),
    INDEX `quejas_recurso_id_idx` (`recurso_id`),
    INDEX `quejas_sede_id_idx` (`sede_id`),
    INDEX `quejas_estado_idx` (`estado`),
    INDEX `quejas_ausencia_id_idx` (`ausencia_id`),
    CONSTRAINT `quejas_recurso_id_fkey` FOREIGN KEY (`recurso_id`) REFERENCES `recursos`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT `quejas_sede_id_fkey` FOREIGN KEY (`sede_id`) REFERENCES `sedes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT `quejas_ausencia_id_fkey` FOREIGN KEY (`ausencia_id`) REFERENCES `ausencias`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
  ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE pt1 FROM @st1;
EXECUTE pt1;
DEALLOCATE PREPARE pt1;
