-- Oct-2026 · Los pacientes REALES de la agenda, puestos por quien llama.
--
-- "Como siempre muestra un promedio de pacientes, en el cual a veces son mas
-- o menos, que el perfil de repro edite los pacientes oficiales y asi ir todo
-- correctamente."
--
-- No reemplaza a `pacientes_afectados`: ese es el estimado que calcula el
-- sistema desde la capacidad de la agenda y alimenta informes y costos.
-- Guardar los dos permite ver cuanto se desvia la estimacion de la realidad.
-- NULL = nadie lo ha corregido todavia.
ALTER TABLE `ausencias`
  ADD COLUMN `pacientes_confirmados` INT NULL;
