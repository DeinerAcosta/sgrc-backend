-- Oct-2026 · PROYECTOS-3583 §5 · Bloquear una sede completa.
--
-- Supervisor y gerencia bloquean una sede por unas fechas, con motivo, cuando
-- no hay disponibilidad. Mientras dure no se programa en ella y no cuenta en
-- los informes de ocupación. No se borra: se levanta (levantado_en), para que
-- quede el rastro de quién la bloqueó, por qué y cuándo se reabrió.
CREATE TABLE `bloqueos_sede` (
    `id` VARCHAR(191) NOT NULL,
    `sede_id` VARCHAR(191) NOT NULL,
    `desde` DATE NOT NULL,
    `hasta` DATE NOT NULL,
    `motivo` TEXT NOT NULL,
    `creado_por` VARCHAR(191) NOT NULL,
    `creado_en` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `levantado_por` VARCHAR(191) NULL,
    `levantado_en` DATETIME(3) NULL,

    INDEX `bloqueos_sede_sede_id_desde_hasta_idx`(`sede_id`, `desde`, `hasta`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `bloqueos_sede` ADD CONSTRAINT `bloqueos_sede_sede_id_fkey`
  FOREIGN KEY (`sede_id`) REFERENCES `sedes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
