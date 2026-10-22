-- Oct-2026 · PROYECTOS-3398 §3 · Autorización de tratamiento de datos
-- personales al registrar una ausencia.
--
-- La evidencia es el instante, la IP y la VERSIÓN del texto aceptado, no un
-- sí/no: si cambia la redacción hay que poder decir qué aceptó cada quien.
-- NULL = no se pidió (la registró el coordinador o es anterior a esto).
ALTER TABLE `ausencias`
  ADD COLUMN `datos_autorizados_en` DATETIME(3) NULL,
  ADD COLUMN `datos_autorizacion_version` VARCHAR(40) NULL,
  ADD COLUMN `datos_autorizacion_ip` VARCHAR(45) NULL;
