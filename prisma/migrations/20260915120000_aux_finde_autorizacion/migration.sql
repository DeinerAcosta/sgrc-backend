-- Sep-15-2026 · Ley 2101 · Autorizacion directivo para auxiliares que
-- trabajan SABADO Y DOMINGO en la misma semana.
--
-- Contexto: la Ley 2101 (jornada 42h) permite trabajar fin de semana pero
-- exige que si un empleado no descansa NINGUN dia del finde, debe haber
-- autorizacion explicita del empleador (directivo). El sistema hasta hoy
-- no diferenciaba el finde en las asignaciones; se agrega el trio de
-- campos que registran quien autorizo, cuando y por que.
--
-- Cambio 100% additivo: los 3 campos son NULL para las asignaciones que
-- NO necesitan autorizacion (L-V o solo un dia del finde). El backend
-- exigira estos campos SOLO en el escenario sabado+domingo del mismo aux.

ALTER TABLE `asignaciones`
  ADD COLUMN `autorizado_por` VARCHAR(191) NULL AFTER `estado`,
  ADD COLUMN `autorizado_en` DATETIME(3) NULL AFTER `autorizado_por`,
  ADD COLUMN `motivo_autorizacion` TEXT NULL AFTER `autorizado_en`;

-- FK opcional a usuarios(id). ON DELETE SET NULL para no perder la
-- asignacion si el usuario que autorizo se elimina del sistema
-- (el registro historico queda con autorizado_por = NULL pero la
-- asignacion sigue vigente).
ALTER TABLE `asignaciones`
  ADD CONSTRAINT `asignaciones_autorizado_por_fkey`
  FOREIGN KEY (`autorizado_por`) REFERENCES `usuarios`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Indice para queries del auditor "autorizaciones que emitio el directivo X"
-- y del panel de gerencia "cuantas asignaciones excepcionales hubo esta semana".
CREATE INDEX `asignaciones_autorizado_por_idx` ON `asignaciones`(`autorizado_por`);
