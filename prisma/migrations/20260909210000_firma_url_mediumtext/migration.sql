-- Sep-2026: firma_url pasa de TEXT (64 KB) a MEDIUMTEXT (16 MB).
-- Las firmas escaneadas en base64 rutinariamente superan 64 KB (algunas ~750 KB
-- despues del padding base64). El TEXT actual truncaba silenciosamente y el
-- data URL quedaba corrupto, sin poder decodificarse en el PDF.
--
-- Migracion idempotente: solo hace el ALTER si la columna aun es TEXT.
SET @sql := (SELECT IF(
  (SELECT DATA_TYPE FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'recursos' AND COLUMN_NAME = 'firma_url'
  ) = 'text',
  'ALTER TABLE recursos MODIFY COLUMN firma_url MEDIUMTEXT NULL',
  'SELECT "firma_url ya es MEDIUMTEXT" AS msg'
));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
