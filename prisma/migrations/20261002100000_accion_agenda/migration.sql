-- Oct-2026 · PROYECTOS-3398 §6.1 · `ausencias.accion_agenda`
--
-- Que paso con la AGENDA del profesional cuando se gestiona su ausencia:
--   reprogramada | cubierta | perdida | sin_agenda
--
-- La columna `accion_tomada` ya existia, pero guarda la nota del coordinador en
-- prosa. Con texto libre no se puede contar cuantas agendas se reprogramaron ni
-- cuantas se perdieron, y el ticket pide un "reporte de la gestion realizada".
--
-- Queda NULL para quien no tiene agenda propia de pacientes (auxiliares,
-- tecnicos de apoyo, asesores): ahi no hay nada que reprogramar.
--
-- Condicional para no abortar si ya existe (mismo patron que el resto del repo).

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ausencias' AND COLUMN_NAME = 'accion_agenda');
SET @s := IF(@c = 0,
  'ALTER TABLE `ausencias` ADD COLUMN `accion_agenda` VARCHAR(20) NULL AFTER `accion_tomada`',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
