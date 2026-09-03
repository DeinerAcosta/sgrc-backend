-- Agrega referencia al coordinador-líder de cada recurso.
-- NULL = sin asignar (el supervisor puede definir después).
-- ON DELETE SET NULL: si se borra el usuario coordinador, el recurso queda
-- huérfano (no se rompe), el supervisor reasigna.
-- FIX (sep-2026): las tres partes se separaron y se hicieron condicionales.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'recursos' AND COLUMN_NAME = 'coordinador_lider_id');
SET @s := IF(@c = 0, 'ALTER TABLE `recursos` ADD COLUMN `coordinador_lider_id` VARCHAR(191) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'recursos' AND INDEX_NAME = 'recursos_coordinador_lider_id_idx');
SET @s := IF(@i = 0, 'ALTER TABLE `recursos` ADD INDEX `recursos_coordinador_lider_id_idx` (`coordinador_lider_id`)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @k := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'recursos' AND CONSTRAINT_NAME = 'recursos_coordinador_lider_id_fkey');
SET @s := IF(@k = 0, 'ALTER TABLE `recursos` ADD CONSTRAINT `recursos_coordinador_lider_id_fkey` FOREIGN KEY (`coordinador_lider_id`) REFERENCES `usuarios`(`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
