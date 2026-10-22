-- Oct-2026 · Hector: una tarjeta por ausencia en Mis reprogramaciones, con una
-- fila por cada médico que la cubre y sus llamadas (contestaron / no
-- contestaron). Las llamadas se guardan en el turno que cubre; las de la
-- ausencia (pacientes_contactados / pacientes_no_contestaron) quedan como la
-- suma, que es lo que leen los tableros.
ALTER TABLE `asignaciones`
  ADD COLUMN `llamadas_contestaron` INT NULL,
  ADD COLUMN `llamadas_no_contestaron` INT NULL;
