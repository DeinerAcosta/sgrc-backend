-- AlterTable
ALTER TABLE `usuarios` ADD COLUMN `debe_cambiar_password` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `solicitudes_registro` (
    `id` VARCHAR(191) NOT NULL,
    `nombre` VARCHAR(150) NOT NULL,
    `email` VARCHAR(200) NOT NULL,
    `celular` VARCHAR(20) NULL,
    `rol` VARCHAR(20) NOT NULL,
    `tipo_recurso` VARCHAR(30) NULL,
    `especialidad` VARCHAR(100) NULL,
    `horas_max_semana` INTEGER NULL,
    `horas_max_dia` INTEGER NULL,
    `esquema_pago` VARCHAR(20) NULL,
    `intervalo_minutos` INTEGER NULL,
    `sedes_solicitadas` JSON NULL,
    `estado` VARCHAR(20) NOT NULL DEFAULT 'pendiente',
    `motivo_rechazo` TEXT NULL,
    `procesado_por` VARCHAR(191) NULL,
    `procesado_en` DATETIME(3) NULL,
    `usuario_creado_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `solicitudes_registro_estado_idx`(`estado`),
    INDEX `solicitudes_registro_email_idx`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
