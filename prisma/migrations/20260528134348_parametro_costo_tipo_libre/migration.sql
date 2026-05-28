-- Liberar tipoConsulta del enum Especialidad para que el supervisor pueda
-- agregar tipos nuevos (p.ej. "cirugia_general"). Se hace ya aplicado vía
-- prisma db push --accept-data-loss; el archivo se incluye para historial.

ALTER TABLE `parametros_costo`
  MODIFY `tipo_consulta` VARCHAR(40) NOT NULL;
