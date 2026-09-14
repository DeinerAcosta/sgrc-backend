-- Sep-14-2026: Alineacion del catalogo de motivos + modal + PDF al formato
-- F-AA-126 v04 oficial de la Clinica Oftalmologica del Caribe.
--
-- Cambios:
-- 1. Desactivar los 22 motivos operativos del tablero FOCA (siguen en BD
--    para no romper historico ni el dashboard de reprogramaciones, pero
--    NO aparecen en el dropdown del modal de crear ausencia).
-- 2. Agregar el motivo "Licencia no remunerada" (distinto de
--    "licencia_remunerada" existente, que es la de EPS/incapacidad).
-- 3. Agregar columnas `proceso_afecta` y `tipo_novedad` a la tabla
--    `ausencias` — son los 2 bloques del PDF que hoy no se capturan.

-- ==============================================================
-- 1. Desactivar los 22 motivos operativos del tablero FOCA
-- ==============================================================
-- Se mantienen en BD para historicos y para el dashboard de
-- reprogramaciones. Solo se ocultan del dropdown de crear ausencia
-- via activo=0. Se pueden reactivar desde /app/admin/motivos-ausencia.
UPDATE `motivos_ausencia`
   SET `activo` = 0
 WHERE `codigo` IN (
   -- Reprogramacion operativa (7)
   'formato','cambio_horario','modifica_horario','mover_agenda',
   'cambio_agenda','confirmar_agenda','adelantar_pacientes',
   -- Ajuste de cupos (2)
   'disminuir_pacientes','llenar_agenda',
   -- Ausencia profesional extras (6)
   'cirugia','vacaciones_fellow','fin_contrato','cubre_qx','retraso_qx','administrativa',
   -- Movilidad / Regional extras (4 — se deja 'sede_externa' activo porque es del formato F-AA-126)
   'regional','cambio_sede','brigada','tercer_nivel',
   -- Calendario / Festivo (1)
   'dia_festivo'
 );

-- ==============================================================
-- 2. Agregar "Licencia no remunerada" (nueva)
-- ==============================================================
-- El F-AA-126 oficial diferencia licencia REMUNERADA (paga, ej.
-- maternidad) de NO REMUNERADA (sin pago, ej. permiso extendido).
-- El motivo existente 'licencia_remunerada' queda igual (protege
-- indicador de productividad). El nuevo NO protege el indicador —
-- es una ausencia voluntaria.
INSERT INTO `motivos_ausencia`
  (`id`, `codigo`, `nombre`, `descripcion`, `familia`, `factor_impacto`, `activo`, `es_sistema`, `orden`, `creado_en`, `actualizado_en`)
SELECT UUID(),
       'licencia_no_remunerada',
       'Licencia no remunerada',
       'Licencia solicitada por el profesional sin remuneracion (permiso extendido, asuntos personales, etc.).',
       'ausencia_profesional',
       1.00, 1, 0, 8, NOW(3), NOW(3)
 WHERE NOT EXISTS (SELECT 1 FROM `motivos_ausencia` WHERE `codigo` = 'licencia_no_remunerada');

-- ==============================================================
-- 3. Columnas del formato F-AA-126 que hoy no se guardan
-- ==============================================================
-- Guardados como VARCHAR abiertos por si el formato agrega opciones
-- despues (evita otra migracion). Los valores validos los enforce el
-- Zod del backend + el select del frontend.
ALTER TABLE `ausencias`
  ADD COLUMN `proceso_afecta` VARCHAR(30) NULL COMMENT 'F-AA-126: consulta_externa | ayudas_diagnosticas | cirugia',
  ADD COLUMN `tipo_novedad`   VARCHAR(40) NULL COMMENT 'F-AA-126: cambio_permanente | cambio_periodo | ausencia_periodo';

-- ==============================================================
-- 4. Reordenar los 7 motivos del F-AA-126 para que aparezcan primero
-- ==============================================================
UPDATE `motivos_ausencia` SET `orden` = 1 WHERE `codigo` = 'enfermedad'             AND `es_sistema` = 1;
UPDATE `motivos_ausencia` SET `orden` = 2 WHERE `codigo` = 'calamidad'              AND `es_sistema` = 1;
UPDATE `motivos_ausencia` SET `orden` = 3 WHERE `codigo` = 'academico'              AND `es_sistema` = 1;
UPDATE `motivos_ausencia` SET `orden` = 4 WHERE `codigo` = 'familiar'               AND `es_sistema` = 1;
UPDATE `motivos_ausencia` SET `orden` = 5 WHERE `codigo` = 'vacaciones'             AND `es_sistema` = 1;
UPDATE `motivos_ausencia` SET `orden` = 6 WHERE `codigo` = 'licencia_remunerada'    AND `es_sistema` = 1;
-- 7 se asigna arriba al nuevo licencia_no_remunerada
UPDATE `motivos_ausencia` SET `orden` = 8 WHERE `codigo` = 'sede_externa';
