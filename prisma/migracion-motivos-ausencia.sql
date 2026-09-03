-- =============================================================================
-- MIGRACIÓN: catálogo editable de motivos de ausencia + factor de impacto
-- Fecha: 2026-06-25
-- Idempotente: usa IF NOT EXISTS donde MySQL lo soporta.
-- =============================================================================

START TRANSACTION;

-- 1) Tabla motivos_ausencia ---------------------------------------------------
CREATE TABLE IF NOT EXISTS `motivos_ausencia` (
  `id` VARCHAR(191) NOT NULL,
  `codigo` VARCHAR(40) NOT NULL,
  `nombre` VARCHAR(100) NOT NULL,
  `descripcion` TEXT NULL,
  `factor_impacto` DECIMAL(3,2) NOT NULL DEFAULT 1.00,
  `activo` TINYINT(1) NOT NULL DEFAULT 1,
  `es_sistema` TINYINT(1) NOT NULL DEFAULT 0,
  `orden` INT NOT NULL DEFAULT 0,
  `creado_en` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `actualizado_en` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `motivos_ausencia_codigo_key` (`codigo`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2) Seed de los 9 motivos del enum original ---------------------------------
-- Si ya existen (re-run), INSERT IGNORE evita duplicados.
INSERT IGNORE INTO `motivos_ausencia`
  (`id`, `codigo`, `nombre`, `descripcion`, `factor_impacto`, `activo`, `es_sistema`, `orden`, `creado_en`, `actualizado_en`)
VALUES
  (UUID(), 'enfermedad',             'Incapacidad por enfermedad', 'Ausencia médica con incapacidad oficial', 1.00, 1, 1, 1, NOW(3), NOW(3)),
  (UUID(), 'calamidad',              'Ausencia por calamidad',     'Calamidad doméstica o emergencia familiar', 1.00, 1, 1, 2, NOW(3), NOW(3)),
  (UUID(), 'academico',              'Evento académico (congreso)', 'Congreso, capacitación o evento académico', 1.00, 1, 1, 3, NOW(3), NOW(3)),
  (UUID(), 'familiar',               'Evento familiar',            'Evento personal/familiar con previo aviso', 1.00, 1, 1, 4, NOW(3), NOW(3)),
  (UUID(), 'vacaciones',             'Vacaciones / viaje',         'Vacaciones aprobadas con antelación', 1.00, 1, 1, 5, NOW(3), NOW(3)),
  (UUID(), 'no_presentacion',        'No presentación',            'No asistió ni avisó', 1.00, 1, 1, 6, NOW(3), NOW(3)),
  (UUID(), 'licencia_remunerada',    'Licencia remunerada',        'Licencia con goce de sueldo', 1.00, 1, 1, 7, NOW(3), NOW(3)),
  (UUID(), 'licencia_no_remunerada', 'Licencia no remunerada',     'Licencia sin goce de sueldo', 1.00, 1, 1, 8, NOW(3), NOW(3)),
  (UUID(), 'otra',                   'Otra',                       'Otra causa no clasificada', 1.00, 1, 1, 9, NOW(3), NOW(3));

-- 3) Agregar columna motivo_id en ausencias ----------------------------------
-- MySQL 8.0+ soporta ADD COLUMN IF NOT EXISTS.
ALTER TABLE `ausencias`
  ADD COLUMN IF NOT EXISTS `motivo_id` VARCHAR(191) NULL AFTER `tipo`;

-- 4) Backfill: ligar cada ausencia existente con su motivo por código=tipo ---
UPDATE `ausencias` a
JOIN `motivos_ausencia` m ON m.`codigo` = a.`tipo`
SET a.`motivo_id` = m.`id`
WHERE a.`motivo_id` IS NULL;

-- 5) FK + índice -------------------------------------------------------------
-- Drop si ya existían (idempotencia) — silenciar errores en re-run.
SET @sql := (
  SELECT IF(
    EXISTS (SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_schema = DATABASE()
              AND table_name = 'ausencias'
              AND constraint_name = 'ausencias_motivo_id_fkey'),
    'ALTER TABLE `ausencias` DROP FOREIGN KEY `ausencias_motivo_id_fkey`',
    'SELECT 1'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql2 := (
  SELECT IF(
    EXISTS (SELECT 1 FROM information_schema.statistics
            WHERE table_schema = DATABASE()
              AND table_name = 'ausencias'
              AND index_name = 'ausencias_motivo_id_idx'),
    'ALTER TABLE `ausencias` DROP INDEX `ausencias_motivo_id_idx`',
    'SELECT 1'
  )
);
PREPARE stmt2 FROM @sql2; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;

CREATE INDEX `ausencias_motivo_id_idx` ON `ausencias`(`motivo_id`);

ALTER TABLE `ausencias`
  ADD CONSTRAINT `ausencias_motivo_id_fkey`
  FOREIGN KEY (`motivo_id`) REFERENCES `motivos_ausencia`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;

-- =============================================================================
-- Validaciones post-migración (correr aparte para verificar)
-- =============================================================================
-- SELECT COUNT(*) FROM motivos_ausencia;                            -- esperado: 9
-- SELECT COUNT(*) FROM ausencias;                                   -- esperado: igual al baseline
-- SELECT COUNT(*) FROM ausencias WHERE motivo_id IS NULL;           -- esperado: 0
-- SELECT a.tipo, m.codigo, COUNT(*) FROM ausencias a
--   JOIN motivos_ausencia m ON m.id = a.motivo_id
--   GROUP BY a.tipo, m.codigo;                                      -- todas las filas deben tener tipo=codigo
