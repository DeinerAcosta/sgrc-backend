#!/bin/bash
set -e

echo '[1/6] Backup de seguridad antes de tocar...'
mysqldump --defaults-file=/etc/mysql/debian.cnf --single-transaction --quick sgrc | gzip > /tmp/sgrc-safety-pre-ejecucion.sql.gz
ls -lah /tmp/sgrc-safety-pre-ejecucion.sql.gz

echo '[2/6] Restaurando backup en sgrc_check...'
mysql --defaults-file=/etc/mysql/debian.cnf -e 'DROP DATABASE IF EXISTS sgrc_check; CREATE DATABASE sgrc_check;'
zcat /var/backups/mysql/sgrc/daily/sgrc_2026-06-23.sql.gz \
  | grep -v '^CREATE DATABASE' \
  | sed 's/USE `sgrc`/USE `sgrc_check`/g' \
  | mysql --defaults-file=/etc/mysql/debian.cnf sgrc_check

echo '[3/6] Identificando ejecuciones faltantes (en backup pero NO en actual):'
mysql --defaults-file=/etc/mysql/debian.cnf -e "
SELECT b.id AS ejecucion_id_perdida,
       b.asignacion_id,
       b.pacientes_atendidos,
       b.observaciones,
       b.registrado_en
FROM sgrc_check.ejecucion b
LEFT JOIN sgrc.ejecucion a ON a.id = b.id
WHERE a.id IS NULL;"

echo '[4/6] Verificando que sus asignaciones SÍ existen en la BD actual:'
mysql --defaults-file=/etc/mysql/debian.cnf -e "
SELECT COUNT(*) AS asigs_existentes_para_esas_ejecuciones
FROM sgrc_check.ejecucion b
LEFT JOIN sgrc.ejecucion a ON a.id = b.id
JOIN sgrc.asignaciones aa ON aa.id = b.asignacion_id
WHERE a.id IS NULL;"

echo '[5/6] Insertando ejecuciones faltantes con INSERT IGNORE...'
# Solo trae las que NO están en la actual.
# IDs presentes en actual quedan intactas (INSERT IGNORE).
mysqldump --defaults-file=/etc/mysql/debian.cnf \
  --no-create-info --skip-extended-insert --skip-add-locks --skip-disable-keys \
  sgrc_check ejecucion \
  | sed 's/^INSERT INTO/INSERT IGNORE INTO/' \
  | mysql --defaults-file=/etc/mysql/debian.cnf sgrc

echo '[6/6] Conteo final:'
mysql --defaults-file=/etc/mysql/debian.cnf sgrc -B -e "SELECT COUNT(*) AS ejecuciones_actuales FROM ejecucion;"

echo ''
echo 'Limpiando sgrc_check...'
mysql --defaults-file=/etc/mysql/debian.cnf -e 'DROP DATABASE sgrc_check;'
echo 'Listo.'
