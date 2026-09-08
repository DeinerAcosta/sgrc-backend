-- FIX (sep-2026): CREATE TABLE -> IF NOT EXISTS y los 6 índices envueltos en SQL
-- preparado. Producción tiene estructuras creadas a mano; sin esto la migración
-- aborta a medias y deja el despliegue roto. MySQL 8 no admite CREATE INDEX IF NOT EXISTS.

-- Fase 3 (ago-2026) — Reposición de ausencias por parte del profesional.
-- Un rol=recurso con una ausencia CONFIRMADA puede proponer reponerla
-- trabajando en otro horario. Coord/gerencia aprueba o rechaza. Al aprobar,
-- Dirección Médica recibe copia informativa (mismo canal de Fase 1).
-- Estados: solicitada → aprobada | rechazada → (opcional) realizada.

CREATE TABLE IF NOT EXISTS `reposiciones_ausencia` (
  `id`                  VARCHAR(191) NOT NULL,
  `ausencia_id`         VARCHAR(191) NOT NULL,
  `fecha_reposicion`    DATE         NOT NULL,
  `hora_inicio`         VARCHAR(5)   NOT NULL,
  `hora_fin`            VARCHAR(5)   NOT NULL,
  `tipo_reposicion`     VARCHAR(20)  NOT NULL,
  `motivo_solicitud`    TEXT         NOT NULL,
  `consultorio_id`      VARCHAR(191) NULL,
  `pacientes_estimados` INT          NULL,
  `estado`              VARCHAR(20)  NOT NULL DEFAULT 'solicitada',
  `solicitado_por`      VARCHAR(191) NOT NULL,
  `solicitado_en`       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `aprobado_por`        VARCHAR(191) NULL,
  `aprobado_en`         DATETIME(3)  NULL,
  `nota_aprobador`      TEXT         NULL,
  `motivo_rechazo`      TEXT         NULL,
  `realizada_en`        DATETIME(3)  NULL,
  `created_at`          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`          DATETIME(3)  NOT NULL,

  PRIMARY KEY (`id`),
  CONSTRAINT `reposiciones_ausencia_ausencia_fk`
    FOREIGN KEY (`ausencia_id`) REFERENCES `ausencias`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `reposiciones_ausencia_solicitante_fk`
    FOREIGN KEY (`solicitado_por`) REFERENCES `usuarios`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `reposiciones_ausencia_aprobador_fk`
    FOREIGN KEY (`aprobado_por`) REFERENCES `usuarios`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `reposiciones_ausencia_consultorio_fk`
    FOREIGN KEY (`consultorio_id`) REFERENCES `consultorios`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reposiciones_ausencia' AND INDEX_NAME = 'reposiciones_ausencia_ausencia_id_idx');
SET @s := IF(@i = 0, 'CREATE INDEX `reposiciones_ausencia_ausencia_id_idx` ON `reposiciones_ausencia`(`ausencia_id`)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reposiciones_ausencia' AND INDEX_NAME = 'reposiciones_ausencia_estado_idx');
SET @s := IF(@i = 0, 'CREATE INDEX `reposiciones_ausencia_estado_idx` ON `reposiciones_ausencia`(`estado`)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reposiciones_ausencia' AND INDEX_NAME = 'reposiciones_ausencia_fecha_reposicion_idx');
SET @s := IF(@i = 0, 'CREATE INDEX `reposiciones_ausencia_fecha_reposicion_idx` ON `reposiciones_ausencia`(`fecha_reposicion`)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reposiciones_ausencia' AND INDEX_NAME = 'reposiciones_ausencia_solicitado_por_idx');
SET @s := IF(@i = 0, 'CREATE INDEX `reposiciones_ausencia_solicitado_por_idx` ON `reposiciones_ausencia`(`solicitado_por`)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reposiciones_ausencia' AND INDEX_NAME = 'reposiciones_ausencia_consultorio_id_idx');
SET @s := IF(@i = 0, 'CREATE INDEX `reposiciones_ausencia_consultorio_id_idx` ON `reposiciones_ausencia`(`consultorio_id`)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @i := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reposiciones_ausencia' AND INDEX_NAME = 'reposiciones_ausencia_aprobado_por_idx');
SET @s := IF(@i = 0, 'CREATE INDEX `reposiciones_ausencia_aprobado_por_idx` ON `reposiciones_ausencia`(`aprobado_por`)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
