-- AlterTable: agrega tipo_consulta (free-text) a asignaciones para que el
-- coordinador marque la categoría real de la cita (PRIORITARIA, Cirugía, etc.)
-- FIX (sep-2026): condicional. Si producción ya tiene la columna, sin esto la
-- migración falla y aborta el despliegue a mitad.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asignaciones' AND COLUMN_NAME = 'tipo_consulta');
SET @s := IF(@c = 0, 'ALTER TABLE `asignaciones` ADD COLUMN `tipo_consulta` VARCHAR(60) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
