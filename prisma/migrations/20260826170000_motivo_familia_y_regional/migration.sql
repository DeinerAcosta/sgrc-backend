-- FIX (sep-2026): las dos ADD COLUMN y el índice se hicieron condicionales.
-- La tabla motivos_ausencia no la creaba ninguna migración (se añadió a mano),
-- así que en una base limpia se crea ya con la forma final y estos ADD chocaban
-- con "Duplicate column". Así la migración vale en los dos escenarios.

-- Ago-2026: familia en catálogo motivos_ausencia + ciudad para motivo "Regional".
-- Contexto: replicar tablero FOCA con 5 familias de causa raíz — permite agrupar
-- todos los motivos en el dashboard gerencial de reprogramaciones y reportar
-- ausencias/reprogramaciones alineadas al lenguaje de dirección médica.

-- 1. Columna familia (default = 'ausencia_profesional' cubre los 9 motivos legacy).
SET @fam := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'motivos_ausencia' AND COLUMN_NAME = 'familia'
);
SET @sql_fam := IF(@fam = 0,
  "ALTER TABLE `motivos_ausencia` ADD COLUMN `familia` VARCHAR(40) NOT NULL DEFAULT 'ausencia_profesional' AFTER `descripcion`",
  'SELECT 1');
PREPARE st_fam FROM @sql_fam;
EXECUTE st_fam;
DEALLOCATE PREPARE st_fam;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'motivos_ausencia'
    AND INDEX_NAME = 'motivos_ausencia_familia_idx');
SET @sql_idx := IF(@idx = 0,
  'CREATE INDEX `motivos_ausencia_familia_idx` ON `motivos_ausencia`(`familia`)',
  'SELECT 1');
PREPARE st_idx FROM @sql_idx;
EXECUTE st_idx;
DEALLOCATE PREPARE st_idx;

-- 2. Columna ciudad_regional en ausencias (solo se llena si motivo = 'regional').
SET @ciureg := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ausencias' AND COLUMN_NAME = 'ciudad_regional'
);
SET @sql_ciureg := IF(@ciureg = 0,
  "ALTER TABLE `ausencias` ADD COLUMN `ciudad_regional` VARCHAR(60) NULL AFTER `quejas_registradas`",
  'SELECT 1');
PREPARE st_ciureg FROM @sql_ciureg;
EXECUTE st_ciureg;
DEALLOCATE PREPARE st_ciureg;

-- 3. Sembrar los 21 motivos nuevos del tablero FOCA.
-- Todos activos, no de sistema (editables/desactivables). factor_impacto=1.00
-- salvo los motivos operativos donde el impacto real depende del contexto (dejamos
-- default 1.00 y que supervisor ajuste después).
INSERT INTO `motivos_ausencia` (`id`, `codigo`, `nombre`, `descripcion`, `familia`, `factor_impacto`, `activo`, `es_sistema`, `orden`, `creado_en`, `actualizado_en`) VALUES
  -- Reprogramación operativa (7)
  (UUID(), 'formato',              'Formato',              'Ajuste de agenda por formato administrativo interno.',        'reprogramacion_operativa', 1.00, 1, 0, 100, NOW(3), NOW(3)),
  (UUID(), 'cambio_horario',       'Cambio Horario',       'Cambio de horario del profesional (traslado de bloques).',    'reprogramacion_operativa', 1.00, 1, 0, 101, NOW(3), NOW(3)),
  (UUID(), 'modifica_horario',     'Modifica Horario',     'Modificación puntual del horario asignado.',                  'reprogramacion_operativa', 1.00, 1, 0, 102, NOW(3), NOW(3)),
  (UUID(), 'mover_agenda',         'Mover Agenda',         'Movimiento de pacientes de un día/franja a otra.',            'reprogramacion_operativa', 1.00, 1, 0, 103, NOW(3), NOW(3)),
  (UUID(), 'cambio_agenda',        'Cambio Agenda',        'Cambio de estructura de agenda (tipo de servicio/orden).',    'reprogramacion_operativa', 1.00, 1, 0, 104, NOW(3), NOW(3)),
  (UUID(), 'confirmar_agenda',     'Confirmar Agenda',     'Ajuste tras confirmación de pacientes (no confirmados).',     'reprogramacion_operativa', 1.00, 1, 0, 105, NOW(3), NOW(3)),
  (UUID(), 'adelantar_pacientes',  'Adelantar Pacientes',  'Adelanto de pacientes por optimización operativa.',           'reprogramacion_operativa', 1.00, 1, 0, 106, NOW(3), NOW(3)),
  -- Ajuste de cupos (2)
  (UUID(), 'disminuir_pacientes',  'Disminuir Pacientes',  'Reducción de cupos por decisión operativa.',                   'ajuste_cupos',              1.00, 1, 0, 200, NOW(3), NOW(3)),
  (UUID(), 'llenar_agenda',        'Llenar Agenda',        'Apertura o llenado adicional de cupos.',                       'ajuste_cupos',              1.00, 1, 0, 201, NOW(3), NOW(3)),
  -- Ausencia profesional (6 adicionales)
  (UUID(), 'cirugia',              'Cirugia',              'Ausencia por asistir a cirugía (no cubre agenda).',            'ausencia_profesional',      1.00, 1, 0, 300, NOW(3), NOW(3)),
  (UUID(), 'vacaciones_fellow',    'Vacaciones Fellow',    'Vacaciones del programa Fellow (formación).',                  'ausencia_profesional',      1.00, 1, 0, 301, NOW(3), NOW(3)),
  (UUID(), 'fin_contrato',         'Fin Contrato',         'Finalización de contrato del profesional.',                    'ausencia_profesional',      1.00, 1, 0, 302, NOW(3), NOW(3)),
  (UUID(), 'cubre_qx',             'Cubre Qx',             'Sale del consultorio para cubrir cirugía.',                    'ausencia_profesional',      1.00, 1, 0, 303, NOW(3), NOW(3)),
  (UUID(), 'retraso_qx',           'Retraso Qx',           'Retraso por cirugía extendida más allá del horario.',          'ausencia_profesional',      1.00, 1, 0, 304, NOW(3), NOW(3)),
  (UUID(), 'administrativa',       'Administrativa',       'Ausencia por labores administrativas internas.',               'ausencia_profesional',      1.00, 1, 0, 305, NOW(3), NOW(3)),
  -- Movilidad / Regional (5)
  (UUID(), 'regional',             'Regional',             'Cobertura de sede regional (indicar ciudad en el registro).',  'movilidad_regional',        1.00, 1, 0, 400, NOW(3), NOW(3)),
  (UUID(), 'cambio_sede',          'Cambio De Sede',       'Traslado del profesional a otra sede del grupo.',              'movilidad_regional',        1.00, 1, 0, 401, NOW(3), NOW(3)),
  (UUID(), 'brigada',              'Brigada',              'Participación en brigada de salud.',                           'movilidad_regional',        1.00, 1, 0, 402, NOW(3), NOW(3)),
  (UUID(), 'tercer_nivel',         'Tercer Nivel',         'Atención en tercer nivel (fuera del consultorio base).',       'movilidad_regional',        1.00, 1, 0, 403, NOW(3), NOW(3)),
  (UUID(), 'sede_externa',         'Sede Externa',         'Traslado a sede externa (no propia).',                         'movilidad_regional',        1.00, 1, 0, 404, NOW(3), NOW(3)),
  -- Calendario / Festivo (1)
  (UUID(), 'dia_festivo',          'Dia Festivo',          'Bloqueo de agenda por día festivo/no laborable.',              'calendario_festivo',        1.00, 1, 0, 500, NOW(3), NOW(3));

-- 4. Actualizar descripciones de los 3 motivos legacy que ahora mapean tipos del tablero.
UPDATE `motivos_ausencia`
   SET `descripcion` = CONCAT(COALESCE(`descripcion`, ''),
       CASE WHEN `descripcion` IS NULL OR `descripcion` = '' THEN '' ELSE ' — ' END,
       'Equivale a "Personal" en el tablero de reprogramaciones.')
 WHERE `codigo` = 'familiar' AND `es_sistema` = 1;

UPDATE `motivos_ausencia`
   SET `descripcion` = CONCAT(COALESCE(`descripcion`, ''),
       CASE WHEN `descripcion` IS NULL OR `descripcion` = '' THEN '' ELSE ' — ' END,
       'Equivale a "Medica" en el tablero de reprogramaciones.')
 WHERE `codigo` = 'enfermedad' AND `es_sistema` = 1;

UPDATE `motivos_ausencia`
   SET `descripcion` = CONCAT(COALESCE(`descripcion`, ''),
       CASE WHEN `descripcion` IS NULL OR `descripcion` = '' THEN '' ELSE ' — ' END,
       'Equivale a "Congreso" y "Capacitacion" en el tablero de reprogramaciones.')
 WHERE `codigo` = 'academico' AND `es_sistema` = 1;

UPDATE `motivos_ausencia`
   SET `descripcion` = CONCAT(COALESCE(`descripcion`, ''),
       CASE WHEN `descripcion` IS NULL OR `descripcion` = '' THEN '' ELSE ' — ' END,
       'Equivale a "Incapacidad" en el tablero de reprogramaciones.')
 WHERE `codigo` = 'licencia_remunerada' AND `es_sistema` = 1;
