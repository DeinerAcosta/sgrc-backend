-- =============================================================================
-- MIGRACIÓN: agrupar asignaciones de backoffice creadas en rango
-- Fecha: 2026-06-25
-- Idempotente (sin transacción porque DDL hace commit implícito en MySQL).
-- =============================================================================

-- 1) Agregar columna grupo_id si no existe
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'asignaciones_backoffice'
    AND column_name = 'grupo_id'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE asignaciones_backoffice ADD COLUMN grupo_id VARCHAR(191) NULL AFTER asignado_por',
  'SELECT "grupo_id ya existe" AS info');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2) Crear índice sobre grupo_id si no existe
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'asignaciones_backoffice'
    AND index_name = 'asignaciones_backoffice_grupo_id_idx'
);
SET @sql := IF(@idx_exists = 0,
  'CREATE INDEX asignaciones_backoffice_grupo_id_idx ON asignaciones_backoffice(grupo_id)',
  'SELECT "índice ya existe" AS info');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Validaciones post-migración (correr aparte):
--   SELECT COUNT(*) FROM asignaciones_backoffice;                       -- esperado: igual al baseline
--   SELECT COUNT(*) FROM asignaciones_backoffice WHERE grupo_id IS NULL; -- esperado: igual al total (todas legacy con NULL)
--   DESCRIBE asignaciones_backoffice;                                    -- columna grupo_id presente
