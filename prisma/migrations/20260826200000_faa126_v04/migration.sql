-- Fase 5 · F-AA-126 v04 (ago-2026)
-- Formato oficial actualizado a versión 04, fecha 26/08/2026.
-- Cambios frente a v03:
--   1. Nuevo checkbox "¿A QUÉ EMPRESA APLICA?" → columna empresa_afectada
--   2. Nuevo motivo "Traslado a sedes externas" en catálogo motivos_ausencia
--   3. Nuevo checkbox "¿DESEA REPONER?" → columna desea_reponer + observaciones
--   4. PDF renderizado con la nueva plantilla (código app, no SQL)

-- 1. Columnas nuevas en ausencias
-- FIX (sep-2026): las 3 ADD COLUMN se hicieron condicionales. Si producción ya
-- las tiene (se añadieron a mano), sin esto la migración falla y aborta el deploy.

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ausencias' AND COLUMN_NAME = 'empresa_afectada');
SET @s := IF(@c = 0, "ALTER TABLE `ausencias` ADD COLUMN `empresa_afectada` VARCHAR(6) NULL AFTER `ciudad_regional`", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ausencias' AND COLUMN_NAME = 'desea_reponer');
SET @s := IF(@c = 0, "ALTER TABLE `ausencias` ADD COLUMN `desea_reponer` TINYINT(1) NULL AFTER `empresa_afectada`", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ausencias' AND COLUMN_NAME = 'observaciones_reposicion');
SET @s := IF(@c = 0, "ALTER TABLE `ausencias` ADD COLUMN `observaciones_reposicion` TEXT NULL AFTER `desea_reponer`", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 2. Nuevo motivo "Traslado a sedes externas" — familia movilidad_regional.
-- Solo insertamos si no existe (idempotente por si se reaplica).
INSERT INTO `motivos_ausencia`
  (`id`, `codigo`, `nombre`, `descripcion`, `familia`, `factor_impacto`, `activo`, `es_sistema`, `orden`, `creado_en`, `actualizado_en`)
SELECT
  UUID(), 'traslado_sedes_externas', 'Traslado a sedes externas',
  'Motivo del formato F-AA-126 v04 — el profesional se traslada temporalmente a otra sede del grupo.',
  'movilidad_regional', 1.00, 1, 0, 405, NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM `motivos_ausencia` WHERE `codigo` = 'traslado_sedes_externas'
);
