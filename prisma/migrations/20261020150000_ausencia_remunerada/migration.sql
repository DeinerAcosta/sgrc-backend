-- Oct-2026 · PROYECTOS-3739 punto 1 · Si la ausencia es remunerada o no.
--
-- Lo asigna Agendas, para todos los tipos menos la licencia remunerada (que
-- lo es siempre). NULL = nadie lo ha asignado: se deduce del tipo
-- (lib/remuneracion.js). Al registrar se guarda lo que se eligió en el primer
-- nivel del formulario.
ALTER TABLE `ausencias`
  ADD COLUMN `es_remunerada` BOOLEAN NULL;
