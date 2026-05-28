-- AlterTable
ALTER TABLE `sedes` ADD COLUMN `responsable_id` VARCHAR(191) NULL;

-- AddForeignKey
ALTER TABLE `sedes` ADD CONSTRAINT `sedes_responsable_id_fkey` FOREIGN KEY (`responsable_id`) REFERENCES `usuarios`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
