-- MIGRACIÓN DE RECUPERACIÓN (sep-2026)
--
-- Tres tablas del schema no las creaba NINGUNA migración: se añadieron a mano
-- en algún entorno y el historial nunca se actualizó. Consecuencia: en una base
-- creada desde cero, "prisma migrate deploy" fallaba al llegar a las migraciones
-- que las referencian, y el proyecto no se podía desplegar en un servidor nuevo.
--
-- Se usa CREATE TABLE IF NOT EXISTS para que valga igual en las bases donde ya
-- existen (producción) que en las limpias. Va fechada justo antes de la primera
-- migración que las necesita (20260826170000_motivo_familia_y_regional).

CREATE TABLE IF NOT EXISTS `solicitudes_recurso` (
    `id` VARCHAR(191) NOT NULL,
    `solicitante_id` VARCHAR(191) NOT NULL,
    `sede_destino_id` VARCHAR(191) NOT NULL,
    `tipo_solicitud` VARCHAR(20) NOT NULL,
    `recurso_id` VARCHAR(191) NULL,
    `tipo_recurso_nuevo` VARCHAR(30) NULL,
    `especialidad` VARCHAR(200) NULL,
    `semana_inicio_id` VARCHAR(191) NULL,
    `semana_fin_id` VARCHAR(191) NULL,
    `justificacion` TEXT NOT NULL,
    `estado` VARCHAR(20) NOT NULL DEFAULT 'pendiente',
    `motivo_decision` TEXT NULL,
    `decidida_por_id` VARCHAR(191) NULL,
    `decidida_en` DATETIME(3) NULL,
    `recurso_creado_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `solicitudes_recurso_estado_idx`(`estado`),
    INDEX `solicitudes_recurso_solicitante_id_idx`(`solicitante_id`),
    INDEX `solicitudes_recurso_sede_destino_id_idx`(`sede_destino_id`),
    INDEX `solicitudes_recurso_recurso_id_idx`(`recurso_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cierres_semana_sede` (
    `id` VARCHAR(191) NOT NULL,
    `semana_id` VARCHAR(191) NOT NULL,
    `sede_id` VARCHAR(191) NOT NULL,
    `cerrada_por` VARCHAR(191) NULL,
    `cerrada_en` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `motivo` VARCHAR(255) NULL,

    INDEX `cierres_semana_sede_sede_id_idx`(`sede_id`),
    UNIQUE INDEX `cierres_semana_sede_semana_id_sede_id_key`(`semana_id`, `sede_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `motivos_ausencia` (
    `id` VARCHAR(191) NOT NULL,
    `codigo` VARCHAR(40) NOT NULL,
    `nombre` VARCHAR(100) NOT NULL,
    `descripcion` TEXT NULL,
    `familia` VARCHAR(40) NOT NULL DEFAULT 'ausencia_profesional',
    `factor_impacto` DECIMAL(3, 2) NOT NULL DEFAULT 1.00,
    `activo` BOOLEAN NOT NULL DEFAULT true,
    `es_sistema` BOOLEAN NOT NULL DEFAULT false,
    `orden` INTEGER NOT NULL DEFAULT 0,
    `creado_en` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actualizado_en` DATETIME(3) NOT NULL,

    UNIQUE INDEX `motivos_ausencia_codigo_key`(`codigo`),
    INDEX `motivos_ausencia_familia_idx`(`familia`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

