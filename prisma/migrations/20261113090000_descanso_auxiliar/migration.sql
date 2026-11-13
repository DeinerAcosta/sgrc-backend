-- Nov-2026 · Hector: la auxiliar puede tener un descanso (almuerzo) dentro de
-- su horario en el turno, y otra auxiliar lo cubre. El descanso se le descuenta
-- en lugar del almuerzo automático.
--   descanso_inicio / descanso_fin  el descanso de ESTA auxiliar (HH:MM)
--   cubre_descanso_de               en la fila de la auxiliar que cubre: el
--                                   `orden` de la auxiliar cuyo descanso cubre
ALTER TABLE `asignacion_auxiliares`
  ADD COLUMN `descanso_inicio` VARCHAR(5) NULL,
  ADD COLUMN `descanso_fin` VARCHAR(5) NULL,
  ADD COLUMN `cubre_descanso_de` INT NULL;
