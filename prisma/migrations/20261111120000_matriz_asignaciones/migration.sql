-- Nov-2026 · Matriz de asignaciones: la malla fija de cada auxiliar (horario
-- por día y con qué profesionales va). Reemplaza la hoja HORARIO AUXILIARES
-- del Excel LISTADO AUXILIARES. Arranca vacía.
CREATE TABLE `matriz_auxiliares` (
    `id` VARCHAR(191) NOT NULL,
    `auxiliar_id` VARCHAR(191) NOT NULL,
    `dia` ENUM('lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo') NOT NULL,
    `franjas` JSON NOT NULL,
    `nota` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `matriz_auxiliares_auxiliar_id_dia_key`(`auxiliar_id`, `dia`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `matriz_auxiliares_profesionales` (
    `dia_matriz_id` VARCHAR(191) NOT NULL,
    `recurso_id` VARCHAR(191) NOT NULL,
    `orden` INTEGER NOT NULL DEFAULT 0,

    INDEX `matriz_auxiliares_profesionales_recurso_id_idx`(`recurso_id`),
    PRIMARY KEY (`dia_matriz_id`, `recurso_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `matriz_auxiliares` ADD CONSTRAINT `matriz_auxiliares_auxiliar_id_fkey` FOREIGN KEY (`auxiliar_id`) REFERENCES `recursos`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `matriz_auxiliares_profesionales` ADD CONSTRAINT `matriz_auxiliares_profesionales_dia_matriz_id_fkey` FOREIGN KEY (`dia_matriz_id`) REFERENCES `matriz_auxiliares`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `matriz_auxiliares_profesionales` ADD CONSTRAINT `matriz_auxiliares_profesionales_recurso_id_fkey` FOREIGN KEY (`recurso_id`) REFERENCES `recursos`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
