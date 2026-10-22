-- Oct-2026 · PROYECTOS-3739 punto 4 · Turno en contingencia (agenda colchón).
--
-- El coordinador marca el turno como contingencia: sale naranja en el
-- Programador y sus pacientes quedan vacíos (0). La líder de reprogramación
-- (o gerencia) pone los pacientes y lo aprueba: vuelve a su color normal.
ALTER TABLE `asignaciones`
  ADD COLUMN `es_contingencia` BOOLEAN NOT NULL DEFAULT false;
