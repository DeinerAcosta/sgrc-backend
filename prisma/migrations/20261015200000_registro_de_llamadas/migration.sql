-- Oct-2026 · Registro de llamadas de quien recibe el encargo de reprogramacion.
--
-- "El reprogramador solamente mira a que profesional le asignaron y que el
-- mismo ponga cuantos pacientes fueron los que llamo, cuales contestaron y
-- cuales no, para asi ver en el indicador de su personal."
--
-- El total de llamados no se guarda: es la suma de las dos columnas.
-- NULL significa "todavia no registro nada", distinto de 0 ("llamo y nadie
-- contesto"), por eso las columnas son opcionales y sin valor por defecto.
ALTER TABLE `ausencias`
  ADD COLUMN `pacientes_contestaron`    INT NULL,
  ADD COLUMN `pacientes_no_contestaron` INT NULL,
  ADD COLUMN `llamadas_registradas_en`  DATETIME(3) NULL;
