-- AlterTable
ALTER TABLE `tareas_backoffice` ADD COLUMN `estado` VARCHAR(20) NOT NULL DEFAULT 'aprobada',
    ADD COLUMN `justificacion` TEXT NULL,
    ADD COLUMN `motivo_rechazo` TEXT NULL,
    ADD COLUMN `procesada_en` DATETIME(3) NULL,
    ADD COLUMN `procesada_por` VARCHAR(191) NULL,
    ADD COLUMN `solicitada_por` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `tareas_backoffice_estado_idx` ON `tareas_backoffice`(`estado`);
