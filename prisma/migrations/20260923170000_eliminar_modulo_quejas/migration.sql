-- Sep-23-2026 · Se elimina el modulo Queja.
--
-- El modulo se habia implementado como MVP (PROYECTOS-3255 #4.1) sobre
-- supuestos pendientes de confirmar con el area. La decision fue no seguir con
-- el, asi que se retira el codigo completo (pagina, rutas, controller y modelo)
-- y aqui se borra su tabla.
--
-- ============================================================================
-- OJO · ESTA MIGRACION BORRA DATOS Y NO SE PUEDE DESHACER
-- ============================================================================
-- `DROP TABLE quejas` elimina las quejas registradas. Antes de correrla en
-- produccion conviene guardar una copia por si alguien ya cargo informacion:
--
--   mysqldump -u root -p sgrc quejas > ~/respaldo-quejas-$(date +%F).sql
--
-- Si la tabla esta vacia no hay nada que perder. Para comprobarlo:
--
--   SELECT COUNT(*) FROM quejas;
--
-- ============================================================================
--
-- NO se toca `ausencias.quejas_registradas`. Esa columna NO pertenece a este
-- modulo: guarda la ESTIMACION de quejas que genera una ausencia (9% de los
-- pacientes afectados si se aviso con mas de 30 dias, 8% si fue menos) y
-- alimenta la columna "Quejas" de los informes de ausentismo e impacto
-- economico. Es un calculo, no un registro de quejas reales, y sigue vigente.

-- Condicional para no abortar si el entorno nunca llego a crear la tabla
-- (mismo patron que el resto de migraciones del repo).
SET @t := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'quejas');
SET @s := IF(@t > 0, 'DROP TABLE `quejas`', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
