-- Nov-2026 · Hector: un turno lleva las auxiliares que hagan falta (en
-- secuencia hasta cubrir el horario del médico, o solapadas). Hasta hoy eran
-- dos columnas fijas en `asignaciones` (auxiliar_id / auxiliar2_id, cada una
-- con su sub-horario). Pasan a una tabla aparte, una fila por auxiliar.
--
-- Orden: 1) crear la tabla, 2) copiar las auxiliares que ya había, 3) recién
-- entonces quitar las columnas viejas. Sin pérdida de datos.

-- 1) Tabla nueva ---------------------------------------------------------
CREATE TABLE `asignacion_auxiliares` (
    `id` VARCHAR(191) NOT NULL,
    `asignacion_id` VARCHAR(191) NOT NULL,
    `recurso_id` VARCHAR(191) NOT NULL,
    `hora_inicio` VARCHAR(5) NULL,
    `hora_fin` VARCHAR(5) NULL,
    `orden` INTEGER NOT NULL DEFAULT 0,

    INDEX `asignacion_auxiliares_recurso_id_idx`(`recurso_id`),
    UNIQUE INDEX `asignacion_auxiliares_asignacion_id_recurso_id_key`(`asignacion_id`, `recurso_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `asignacion_auxiliares` ADD CONSTRAINT `asignacion_auxiliares_asignacion_id_fkey` FOREIGN KEY (`asignacion_id`) REFERENCES `asignaciones`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `asignacion_auxiliares` ADD CONSTRAINT `asignacion_auxiliares_recurso_id_fkey` FOREIGN KEY (`recurso_id`) REFERENCES `recursos`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- 2) Copiar las auxiliares existentes --------------------------------------
-- La 1ª (auxiliar_id) queda en orden 0 y la 2ª (auxiliar2_id) en orden 1, cada
-- una con sus horas tal cual (NULL = hereda el horario del turno).
-- El JOIN a recursos descarta un id huérfano: auxiliar2_id nunca tuvo FK en
-- las bases creadas por migraciones (llegó con 20260827000000 catchup).
INSERT INTO `asignacion_auxiliares` (`id`, `asignacion_id`, `recurso_id`, `hora_inicio`, `hora_fin`, `orden`)
SELECT UUID(), a.`id`, a.`auxiliar_id`, a.`auxiliar_hora_inicio`, a.`auxiliar_hora_fin`, 0
FROM `asignaciones` a
JOIN `recursos` r ON r.`id` = a.`auxiliar_id`
WHERE a.`auxiliar_id` IS NOT NULL;

-- Si la 2ª era la misma persona que la 1ª (no debería, pero la regla vivía
-- solo en el código) no se duplica: la tabla no admite a alguien dos veces.
INSERT INTO `asignacion_auxiliares` (`id`, `asignacion_id`, `recurso_id`, `hora_inicio`, `hora_fin`, `orden`)
SELECT UUID(), a.`id`, a.`auxiliar2_id`, a.`auxiliar2_hora_inicio`, a.`auxiliar2_hora_fin`, 1
FROM `asignaciones` a
JOIN `recursos` r ON r.`id` = a.`auxiliar2_id`
WHERE a.`auxiliar2_id` IS NOT NULL
  AND (a.`auxiliar_id` IS NULL OR a.`auxiliar_id` <> a.`auxiliar2_id`);

-- 3) Quitar las columnas viejas --------------------------------------------
-- Las FK se quitan de forma condicional: auxiliar_id la tiene desde el init,
-- pero auxiliar2_id solo la tendría en una base que haya pasado por
-- `prisma db push`. MySQL 8 no admite DROP FOREIGN KEY IF EXISTS.
SET @fk1 := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asignaciones'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY' AND CONSTRAINT_NAME = 'asignaciones_auxiliar_id_fkey');
SET @sfk1 := IF(@fk1 > 0, 'ALTER TABLE `asignaciones` DROP FOREIGN KEY `asignaciones_auxiliar_id_fkey`', 'SELECT 1');
PREPARE pfk1 FROM @sfk1;
EXECUTE pfk1;
DEALLOCATE PREPARE pfk1;

SET @fk2 := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asignaciones'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY' AND CONSTRAINT_NAME = 'asignaciones_auxiliar2_id_fkey');
SET @sfk2 := IF(@fk2 > 0, 'ALTER TABLE `asignaciones` DROP FOREIGN KEY `asignaciones_auxiliar2_id_fkey`', 'SELECT 1');
PREPARE pfk2 FROM @sfk2;
EXECUTE pfk2;
DEALLOCATE PREPARE pfk2;

SET @ix1 := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asignaciones'
    AND INDEX_NAME = 'asignaciones_auxiliar_id_dia_semana_hora_inicio_idx');
SET @six1 := IF(@ix1 > 0, 'DROP INDEX `asignaciones_auxiliar_id_dia_semana_hora_inicio_idx` ON `asignaciones`', 'SELECT 1');
PREPARE pix1 FROM @six1;
EXECUTE pix1;
DEALLOCATE PREPARE pix1;

ALTER TABLE `asignaciones` DROP COLUMN `auxiliar2_hora_fin`,
    DROP COLUMN `auxiliar2_hora_inicio`,
    DROP COLUMN `auxiliar2_id`,
    DROP COLUMN `auxiliar_hora_fin`,
    DROP COLUMN `auxiliar_hora_inicio`,
    DROP COLUMN `auxiliar_id`;
