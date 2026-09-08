-- Revierte la columna tipo_consulta: el usuario decidió no usar este campo.
-- La migración previa (20260603151700_asignacion_tipo_consulta) queda en el
-- historial para trazabilidad — esta la deshace.
-- FIX (sep-2026): condicional, para no abortar si la columna no está.
-- OJO: si existe, SE BORRA (con sus datos). Es lo correcto — el schema final no
-- la incluye y la app no la usa — pero conviene confirmarlo en producción antes.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asignaciones' AND COLUMN_NAME = 'tipo_consulta');
SET @s := IF(@c > 0, 'ALTER TABLE `asignaciones` DROP COLUMN `tipo_consulta`', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
