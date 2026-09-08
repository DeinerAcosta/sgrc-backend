-- =============================================================================
-- MIGRACIÓN RN-17: cambiar FK Ejecucion → Asignacion de Cascade a Restrict
-- Fecha: 2026-06-30
-- Idempotente.
-- =============================================================================

-- 1) Buscar y dropear la FK actual (nombre auto-generado por Prisma)
SET @fk_name := (
  SELECT constraint_name FROM information_schema.referential_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'ejecucion'
    AND referenced_table_name = 'asignaciones'
  LIMIT 1
);
SET @sql := IF(@fk_name IS NOT NULL,
  CONCAT('ALTER TABLE `ejecucion` DROP FOREIGN KEY `', @fk_name, '`'),
  'SELECT "FK no existe — se creará nueva" AS info');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2) Recrear la FK con ON DELETE RESTRICT
ALTER TABLE `ejecucion`
  ADD CONSTRAINT `ejecucion_asignacion_id_fkey`
  FOREIGN KEY (`asignacion_id`) REFERENCES `asignaciones`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Validación: la nueva FK debe tener DELETE_RULE = 'RESTRICT'
-- SELECT constraint_name, delete_rule, update_rule
-- FROM information_schema.referential_constraints
-- WHERE constraint_schema = DATABASE() AND table_name = 'ejecucion';
