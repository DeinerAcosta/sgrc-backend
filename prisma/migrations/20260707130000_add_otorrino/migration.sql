-- Agregar tipo de recurso `otorrino` y especialidad `otorrinolaringologia`.
-- Rotativo con auxiliar (como oftalmo/anestesio) — decisiones operativas jul-2026.

-- AlterTable: recursos.tipo
ALTER TABLE `recursos` MODIFY `tipo` ENUM('oftalmologo', 'optometra', 'anestesiologo', 'asesor_servicios', 'auxiliar', 'tecnico', 'fonoaudiologa', 'otorrino') NOT NULL;

-- AlterTable: consultorios.especialidad (principal)
ALTER TABLE `consultorios` MODIFY `especialidad` ENUM('oftalmologia', 'optometria', 'anestesiologia', 'diagnostico', 'asesoria', 'fonoaudiologia', 'otorrinolaringologia') NOT NULL;

-- FIX (sep-2026): `especialidad_alternativa` está en schema.prisma pero NINGUNA
-- migración la creaba — se añadió a mano en algún entorno y el historial nunca
-- se actualizó. Resultado: este MODIFY fallaba con "Unknown column" en cualquier
-- base creada desde cero, y `prisma migrate deploy` se quedaba a medias.
--
-- Se crea solo si falta, para que la migración valga tanto en las bases donde
-- ya existe (producción) como en las que no (entorno limpio). MySQL 8 no admite
-- ADD COLUMN IF NOT EXISTS, así que se resuelve con SQL preparado.
SET @existe := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'consultorios'
    AND COLUMN_NAME = 'especialidad_alternativa'
);
SET @sql := IF(@existe = 0,
  "ALTER TABLE `consultorios` ADD COLUMN `especialidad_alternativa` ENUM('oftalmologia', 'optometria', 'anestesiologia', 'diagnostico', 'asesoria', 'fonoaudiologia', 'otorrinolaringologia') NULL",
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- AlterTable: consultorios.especialidad_alternativa (opcional)
ALTER TABLE `consultorios` MODIFY `especialidad_alternativa` ENUM('oftalmologia', 'optometria', 'anestesiologia', 'diagnostico', 'asesoria', 'fonoaudiologia', 'otorrinolaringologia') NULL;
