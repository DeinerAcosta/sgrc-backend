-- Sep-24-2026 · La consulta dura 10 minutos, para todos los tipos de recurso.
--
-- Decision de direccion. Hasta hoy `recursos.intervalo_minutos` estaba en NULL
-- para 372 de los 375 recursos activos, y cada capa aplicaba su propio valor
-- por defecto:
--
--   backend  (calcularCapacidad)          -> 15 min
--   frontend (AssignmentModal)            -> 10 min
--
-- O sea que el coordinador veia en el modal la capacidad calculada a 10 min y
-- se guardaba la de 15: un tercio menos de pacientes de los que la pantalla le
-- mostraba. Ambos defaults pasan a 10 en el codigo, y aqui se deja el valor
-- explicito en la base para no depender de ningun default.
--
-- Solo se tocan los NULL y el unico recurso que tenia 15. Si mañana algun tipo
-- necesita otra duracion, se cambia en su ficha y el calculo la respeta.

UPDATE `recursos`
   SET `intervalo_minutos` = 10
 WHERE `intervalo_minutos` IS NULL
    OR `intervalo_minutos` <> 10;

-- NO se recalcula `asignaciones.pacientes_capacidad` aqui a proposito.
-- Ese campo admite override manual del coordinador (cuando conoce la agenda
-- real del call center) y un UPDATE masivo borraria esos valores sin poder
-- distinguirlos del calculo automatico. El reproceso selectivo —solo las filas
-- que coinciden exactamente con la formula vieja de 15 min, que son las que
-- nadie toco— va aparte, en scripts/recalcular-capacidad-pacientes.js.
