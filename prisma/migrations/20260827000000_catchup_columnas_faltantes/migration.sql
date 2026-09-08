-- MIGRACIÓN DE RECUPERACIÓN · COLUMNAS (sep-2026)
--
-- Estas 9 columnas están declaradas en schema.prisma pero NINGUNA migración
-- las creaba: se añadieron a mano en algún entorno y el historial nunca se
-- actualizó. En una base creada desde cero el backend arrancaba pero reventaba
-- en la primera consulta con "Unknown column", porque el cliente de Prisma sí
-- las pide.
--
-- Cada ADD COLUMN es condicional para que la migración valga igual en las bases
-- donde ya existen (producción) que en una limpia. MySQL 8 no admite
-- ADD COLUMN IF NOT EXISTS, de ahí el SQL preparado.

-- asignaciones.auxiliar_hora_inicio
SET @c0 := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asignaciones' AND COLUMN_NAME = 'auxiliar_hora_inicio');
SET @sc0 := IF(@c0 = 0,
  'ALTER TABLE `asignaciones` ADD COLUMN `auxiliar_hora_inicio` VARCHAR(5) NULL',
  'SELECT 1');
PREPARE pc0 FROM @sc0;
EXECUTE pc0;
DEALLOCATE PREPARE pc0;

-- asignaciones.auxiliar_hora_fin
SET @c1 := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asignaciones' AND COLUMN_NAME = 'auxiliar_hora_fin');
SET @sc1 := IF(@c1 = 0,
  'ALTER TABLE `asignaciones` ADD COLUMN `auxiliar_hora_fin` VARCHAR(5) NULL',
  'SELECT 1');
PREPARE pc1 FROM @sc1;
EXECUTE pc1;
DEALLOCATE PREPARE pc1;

-- asignaciones.auxiliar2_id
SET @c2 := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asignaciones' AND COLUMN_NAME = 'auxiliar2_id');
SET @sc2 := IF(@c2 = 0,
  'ALTER TABLE `asignaciones` ADD COLUMN `auxiliar2_id` VARCHAR(191) NULL',
  'SELECT 1');
PREPARE pc2 FROM @sc2;
EXECUTE pc2;
DEALLOCATE PREPARE pc2;

-- asignaciones.auxiliar2_hora_inicio
SET @c3 := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asignaciones' AND COLUMN_NAME = 'auxiliar2_hora_inicio');
SET @sc3 := IF(@c3 = 0,
  'ALTER TABLE `asignaciones` ADD COLUMN `auxiliar2_hora_inicio` VARCHAR(5) NULL',
  'SELECT 1');
PREPARE pc3 FROM @sc3;
EXECUTE pc3;
DEALLOCATE PREPARE pc3;

-- asignaciones.auxiliar2_hora_fin
SET @c4 := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asignaciones' AND COLUMN_NAME = 'auxiliar2_hora_fin');
SET @sc4 := IF(@c4 = 0,
  'ALTER TABLE `asignaciones` ADD COLUMN `auxiliar2_hora_fin` VARCHAR(5) NULL',
  'SELECT 1');
PREPARE pc4 FROM @sc4;
EXECUTE pc4;
DEALLOCATE PREPARE pc4;

-- asignaciones_backoffice.grupo_id
SET @c5 := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asignaciones_backoffice' AND COLUMN_NAME = 'grupo_id');
SET @sc5 := IF(@c5 = 0,
  'ALTER TABLE `asignaciones_backoffice` ADD COLUMN `grupo_id` VARCHAR(191) NULL',
  'SELECT 1');
PREPARE pc5 FROM @sc5;
EXECUTE pc5;
DEALLOCATE PREPARE pc5;

-- ausencias.motivo_id
SET @c6 := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ausencias' AND COLUMN_NAME = 'motivo_id');
SET @sc6 := IF(@c6 = 0,
  'ALTER TABLE `ausencias` ADD COLUMN `motivo_id` VARCHAR(191) NULL',
  'SELECT 1');
PREPARE pc6 FROM @sc6;
EXECUTE pc6;
DEALLOCATE PREPARE pc6;

-- recursos.tipos_apoyo
SET @c7 := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'recursos' AND COLUMN_NAME = 'tipos_apoyo');
SET @sc7 := IF(@c7 = 0,
  'ALTER TABLE `recursos` ADD COLUMN `tipos_apoyo` VARCHAR(100) NULL',
  'SELECT 1');
PREPARE pc7 FROM @sc7;
EXECUTE pc7;
DEALLOCATE PREPARE pc7;

-- usuarios.credenciales_reenviadas_en
SET @c8 := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuarios' AND COLUMN_NAME = 'credenciales_reenviadas_en');
SET @sc8 := IF(@c8 = 0,
  'ALTER TABLE `usuarios` ADD COLUMN `credenciales_reenviadas_en` DATETIME(3) NULL',
  'SELECT 1');
PREPARE pc8 FROM @sc8;
EXECUTE pc8;
DEALLOCATE PREPARE pc8;

