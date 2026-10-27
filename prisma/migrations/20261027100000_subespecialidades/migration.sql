-- Oct-2026 · PROYECTOS-3800 · Catálogo de subespecialidades (Nelson): la
-- subespecialidad pasa de texto libre a lista obligatoria al crear el recurso.
-- Oftalmología: las que hoy existen como especialidad en los recursos, sin
-- duplicados ni errores de escritura. Otorrinolaringología: las del ejemplo
-- del campo, más la general (3 otorrinos ya la tienen).
CREATE TABLE `subespecialidades` (
  `id` VARCHAR(191) NOT NULL,
  `tipo_recurso` VARCHAR(30) NOT NULL,
  `nombre` VARCHAR(100) NOT NULL,
  `orden` INTEGER NOT NULL DEFAULT 0,
  `activo` BOOLEAN NOT NULL DEFAULT true,
  `creado_en` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `subespecialidades_tipo_recurso_nombre_key`(`tipo_recurso`, `nombre`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `subespecialidades` (`id`, `tipo_recurso`, `nombre`, `orden`) VALUES
  (UUID(), 'oftalmologo', 'Oftalmología general', 1),
  (UUID(), 'oftalmologo', 'Segmento anterior', 2),
  (UUID(), 'oftalmologo', 'Córnea y refractiva', 3),
  (UUID(), 'oftalmologo', 'Glaucoma', 4),
  (UUID(), 'oftalmologo', 'Retina y vítreo', 5),
  (UUID(), 'oftalmologo', 'Oculoplastia', 6),
  (UUID(), 'oftalmologo', 'Oftalmopediatría', 7),
  (UUID(), 'oftalmologo', 'Neuro-oftalmología', 8),
  (UUID(), 'otorrino', 'Otorrinolaringología general', 1),
  (UUID(), 'otorrino', 'Otología', 2),
  (UUID(), 'otorrino', 'Rinología', 3),
  (UUID(), 'otorrino', 'Laringología', 4);
