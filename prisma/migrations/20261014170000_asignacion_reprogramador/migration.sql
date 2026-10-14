-- Oct-2026 · TRAZABILIDAD DE LA REPROGRAMACION
--
-- Hector, describiendo el flujo real: la lider (Duarte) entra al Programador,
-- ve en rojo donde se cayo la agenda, decide el reemplazo o el dia de la
-- reprogramacion, y **asigna a un reprogramador**. De ahi en adelante los
-- reprogramadores llaman uno a uno a los pacientes.
--
-- Ese ultimo paso no quedaba registrado en ningun lado. Su palabras: "la idea
-- es que quede la trazabilidad de que Duarte realizo y asigno al reprogramador
-- para que todo vaya correcto hasta ahi".
--
-- Las llamadas a pacientes NO se modelan: el SGRC no tiene pacientes, solo el
-- numero de impactados. La cadena termina cuando el reprogramador marca que
-- resolvio su caso.
--
-- Mismo patron que `reportado_por` y `confirmado_por`: se guarda el id del
-- usuario sin clave foranea, para no acoplar el historico al borrado de
-- usuarios.
--
-- Condicional columna por columna, para no abortar si ya esta aplicada.

-- 1. A quien se le asigno la reprogramacion.
SET @existe := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ausencias' AND COLUMN_NAME = 'reprogramador_id');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `ausencias` ADD COLUMN `reprogramador_id` VARCHAR(191) NULL',
  'SELECT "ausencias.reprogramador_id ya existe"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 2. Quien hizo la asignacion (la lider).
SET @existe := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ausencias' AND COLUMN_NAME = 'asignado_por');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `ausencias` ADD COLUMN `asignado_por` VARCHAR(191) NULL',
  'SELECT "ausencias.asignado_por ya existe"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 3. Cuando.
SET @existe := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ausencias' AND COLUMN_NAME = 'asignado_en');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `ausencias` ADD COLUMN `asignado_en` DATETIME(3) NULL',
  'SELECT "ausencias.asignado_en ya existe"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 4. Estado: NULL = sin asignar, 'asignada', 'resuelta'.
SET @existe := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ausencias' AND COLUMN_NAME = 'estado_reprogramacion');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `ausencias` ADD COLUMN `estado_reprogramacion` VARCHAR(20) NULL',
  'SELECT "ausencias.estado_reprogramacion ya existe"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 5. Instrucciones de la lider para el reprogramador.
SET @existe := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ausencias' AND COLUMN_NAME = 'notas_reprogramacion');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `ausencias` ADD COLUMN `notas_reprogramacion` TEXT NULL',
  'SELECT "ausencias.notas_reprogramacion ya existe"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 6. Cuando el reprogramador dio su caso por terminado.
SET @existe := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ausencias' AND COLUMN_NAME = 'reprogramacion_resuelta_en');
SET @sql := IF(@existe = 0,
  'ALTER TABLE `ausencias` ADD COLUMN `reprogramacion_resuelta_en` DATETIME(3) NULL',
  'SELECT "ausencias.reprogramacion_resuelta_en ya existe"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Indice: la bandeja del reprogramador filtra por "lo mio sin resolver".
SET @existe := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ausencias' AND INDEX_NAME = 'ausencias_reprogramador_id_idx');
SET @sql := IF(@existe = 0,
  'CREATE INDEX `ausencias_reprogramador_id_idx` ON `ausencias`(`reprogramador_id`)',
  'SELECT "indice ya existe"');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
