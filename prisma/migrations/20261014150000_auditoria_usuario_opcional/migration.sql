-- Oct-2026 · `auditoria.usuario_id` pasa a aceptar NULL
--
-- Una accion del sistema no la hace una persona. Los scripts de datos
-- (limpiar:pendientes, limpiar:firmas, y cualquiera que venga) corren sin
-- usuario, asi que mandaban `usuario_id = NULL` contra una columna NOT NULL
-- con clave foranea obligatoria.
--
-- Prisma rechazaba la fila, y `registrarAuditoria` se traga el error a
-- proposito para que la auditoria nunca tumbe la operacion principal. El
-- resultado: el script borraba los datos y la auditoria no quedaba, sin que
-- nadie se enterara.
--
-- Esto no es teorico. El 14-oct-2026 se eliminaron 6 ausencias pendientes de
-- junio y julio en produccion y la entrada de auditoria no se guardo. El
-- detalle hubo que rescatarlo de la salida del script.
--
-- Hacer la columna nullable no pierde datos: las filas existentes ya tienen
-- usuario. La clave foranea se mantiene — en MySQL una FK nullable permite
-- NULL y sigue validando los valores que no lo son.
--
-- Condicional para no abortar si ya esta aplicada (mismo patron que el resto
-- del repo).

SET @nullable := (
  SELECT IS_NULLABLE
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'auditoria'
    AND COLUMN_NAME = 'usuario_id'
);

SET @sql := IF(
  @nullable = 'NO',
  'ALTER TABLE `auditoria` MODIFY COLUMN `usuario_id` VARCHAR(191) NULL',
  'SELECT "auditoria.usuario_id ya acepta NULL — nada que hacer"'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
