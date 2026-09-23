-- Sep-23-2026 · Se retiran del formulario de ausencias los bloques "Proceso que
-- afecta" y "Tipo de novedad" que habia agregado la v05 del F-AA-126.
--
-- Decision de negocio: el diligenciamiento del modal se simplifica para los
-- oftalmologos y demas profesionales. Esos dos campos ya no se capturan, asi
-- que sus columnas quedan sin uso y se eliminan.
--
-- El PDF del F-AA-126 sigue saliendo igual: vuelve a deducir el proceso del
-- tipo de recurso (oftalmologo/optometra/otorrino/fonoaudiologa -> consulta
-- externa, anestesiologo -> cirugia, tecnico -> ayudas diagnosticas) y marca
-- siempre "Ausencia de un periodo determinado" como tipo de novedad, que es el
-- unico caso que el sistema registra. Es el comportamiento previo a la v05.
--
-- Condicional para no abortar si el entorno nunca aplico la v05
-- (mismo patron que el resto de migraciones del repo).

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ausencias' AND COLUMN_NAME = 'proceso_afecta');
SET @s := IF(@c > 0, 'ALTER TABLE `ausencias` DROP COLUMN `proceso_afecta`', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ausencias' AND COLUMN_NAME = 'tipo_novedad');
SET @s := IF(@c > 0, 'ALTER TABLE `ausencias` DROP COLUMN `tipo_novedad`', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
