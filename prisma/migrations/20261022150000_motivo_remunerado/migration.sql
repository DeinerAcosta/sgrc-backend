-- Oct-2026 · Hector: cada motivo dice si es remunerado (antes la lista estaba
-- fija en el código y un motivo nuevo no aparecía en el formulario), y se quita
-- la "familia" de la pantalla: todos quedan como ausencia profesional.
ALTER TABLE `motivos_ausencia`
  ADD COLUMN `es_remunerada` BOOLEAN NOT NULL DEFAULT false;

UPDATE `motivos_ausencia`
  SET `es_remunerada` = true
  WHERE `codigo` IN ('enfermedad', 'calamidad', 'familiar', 'academico', 'vacaciones', 'licencia_remunerada');

UPDATE `motivos_ausencia` SET `familia` = 'ausencia_profesional';
