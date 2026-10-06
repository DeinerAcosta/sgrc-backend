-- Oct-2026 · PROYECTOS-3398 §4 · `ausencias.fecha_reposicion_propuesta`
--
-- La fecha en que el profesional dice que va a reponer. Hasta ahora se escribia
-- dentro de `observaciones_reposicion`, que es texto libre: no se podia filtrar,
-- ni ordenar, ni cruzar con la agenda para ver si ese dia esta disponible.
--
-- Queda NULL cuando no desea reponer, o cuando aun no tiene fecha y la acordara
-- con su coordinador.
--
-- Condicional para no abortar si ya existe (mismo patron que el resto del repo).

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ausencias' AND COLUMN_NAME = 'fecha_reposicion_propuesta');
SET @s := IF(@c = 0,
  'ALTER TABLE `ausencias` ADD COLUMN `fecha_reposicion_propuesta` DATE NULL AFTER `observaciones_reposicion`',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
