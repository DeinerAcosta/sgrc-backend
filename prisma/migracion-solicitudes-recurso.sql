-- Migración manual: crear tabla solicitudes_recurso
-- IMPORTANTE: solo CREATE TABLE — no modifica tablas existentes.
-- Si la tabla ya existe, falla con error claro (no la sobrescribe).

CREATE TABLE `solicitudes_recurso` (
    `id`                 VARCHAR(191) NOT NULL,
    `solicitante_id`     VARCHAR(191) NOT NULL,
    `sede_destino_id`    VARCHAR(191) NOT NULL,
    `tipo_solicitud`     VARCHAR(20)  NOT NULL,
    `recurso_id`         VARCHAR(191) NULL,
    `tipo_recurso_nuevo` VARCHAR(30)  NULL,
    `especialidad`       VARCHAR(200) NULL,
    `semana_inicio_id`   VARCHAR(191) NULL,
    `semana_fin_id`      VARCHAR(191) NULL,
    `justificacion`      TEXT         NOT NULL,
    `estado`             VARCHAR(20)  NOT NULL DEFAULT 'pendiente',
    `motivo_decision`    TEXT         NULL,
    `decidida_por_id`    VARCHAR(191) NULL,
    `decidida_en`        DATETIME(3)  NULL,
    `recurso_creado_id`  VARCHAR(191) NULL,
    `created_at`         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at`         DATETIME(3)  NOT NULL,

    INDEX `solicitudes_recurso_estado_idx`(`estado`),
    INDEX `solicitudes_recurso_solicitante_id_idx`(`solicitante_id`),
    INDEX `solicitudes_recurso_sede_destino_id_idx`(`sede_destino_id`),
    INDEX `solicitudes_recurso_recurso_id_idx`(`recurso_id`),

    CONSTRAINT `solicitudes_recurso_solicitante_id_fkey`   FOREIGN KEY (`solicitante_id`)   REFERENCES `usuarios`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT `solicitudes_recurso_sede_destino_id_fkey`  FOREIGN KEY (`sede_destino_id`)  REFERENCES `sedes`(`id`)    ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT `solicitudes_recurso_recurso_id_fkey`       FOREIGN KEY (`recurso_id`)       REFERENCES `recursos`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT `solicitudes_recurso_decidida_por_id_fkey`  FOREIGN KEY (`decidida_por_id`)  REFERENCES `usuarios`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT `solicitudes_recurso_semana_inicio_id_fkey` FOREIGN KEY (`semana_inicio_id`) REFERENCES `semanas`(`id`)  ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT `solicitudes_recurso_semana_fin_id_fkey`    FOREIGN KEY (`semana_fin_id`)    REFERENCES `semanas`(`id`)  ON DELETE SET NULL ON UPDATE CASCADE,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
