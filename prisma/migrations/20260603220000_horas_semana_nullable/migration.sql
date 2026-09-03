-- Oftalmólogos no tienen tope semanal contractual (esquema por paciente).
-- Cambiamos la columna a NULLABLE para representar "sin tope".
-- El default de 42 se mantiene para el resto de tipos.
ALTER TABLE `recursos` MODIFY `horas_max_semana` INT NULL DEFAULT 42;
