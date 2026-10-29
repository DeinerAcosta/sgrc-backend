-- Oct-2026 · Histórico de reprogramaciones (enero-octubre 2026) del Excel de
-- Agendas, cargado con scripts/importar-reprogramaciones.js. Las ausencias del
-- histórico no tienen turnos en el Programador: la sede, la agenda y quién
-- cubrió se guardan en la propia ausencia. Las registradas en el sistema
-- quedan con origen 'sgrc' y estos campos en NULL.
ALTER TABLE `ausencias`
    ADD COLUMN `origen` VARCHAR(20) NOT NULL DEFAULT 'sgrc',
    ADD COLUMN `clave_importacion` VARCHAR(64) NULL,
    ADD COLUMN `sede_id` VARCHAR(191) NULL,
    ADD COLUMN `agenda` VARCHAR(150) NULL,
    ADD COLUMN `cubierta_por` VARCHAR(150) NULL,
    ADD COLUMN `fecha_cobertura` DATE NULL,
    ADD COLUMN `repone_mismo` BOOLEAN NULL;

CREATE UNIQUE INDEX `ausencias_clave_importacion_key` ON `ausencias`(`clave_importacion`);
CREATE INDEX `ausencias_origen_idx` ON `ausencias`(`origen`);

ALTER TABLE `ausencias` ADD CONSTRAINT `ausencias_sede_id_fkey` FOREIGN KEY (`sede_id`) REFERENCES `sedes`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
