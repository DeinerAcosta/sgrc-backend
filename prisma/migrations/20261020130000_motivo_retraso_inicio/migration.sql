-- Oct-2026 · PROYECTOS-3398 §4 (3650) · "Retraso en el inicio de la atención".
--
-- Iba en "Tipo de novedad", que se eliminó del formulario. Queda como un motivo
-- del catálogo y se registra como ausencia parcial: de la hora en que debía
-- empezar a la hora en que empezó. Así el impacto se calcula solo sobre esas
-- horas, con el mismo cálculo de cualquier ausencia parcial.
-- es_sistema = 1: el código lo usa la aplicación, no se puede borrar.
INSERT INTO `motivos_ausencia`
  (`id`, `codigo`, `nombre`, `descripcion`, `familia`, `factor_impacto`, `activo`, `es_sistema`, `orden`, `creado_en`, `actualizado_en`)
SELECT UUID(),
       'retraso_inicio',
       'Retraso en el inicio de la atención',
       'El profesional empezó la consulta más tarde de lo programado. Se registra por horas: la hora en que debía empezar y la hora en que empezó.',
       'ausencia_profesional',
       1.00, 1, 1, 9, NOW(3), NOW(3)
 WHERE NOT EXISTS (SELECT 1 FROM `motivos_ausencia` WHERE `codigo` = 'retraso_inicio');
