#!/bin/bash
set -e
echo '[1/5] Recreating sgrc_temp...'
mysql --defaults-file=/etc/mysql/debian.cnf -e 'DROP DATABASE IF EXISTS sgrc_temp; CREATE DATABASE sgrc_temp;'

echo '[2/5] Restoring backup into sgrc_temp (redirecting USE sgrc to sgrc_temp)...'
zcat /var/backups/mysql/sgrc/daily/sgrc_2026-06-23.sql.gz \
  | grep -v '^CREATE DATABASE' \
  | sed 's/USE `sgrc`/USE `sgrc_temp`/g' \
  | mysql --defaults-file=/etc/mysql/debian.cnf sgrc_temp

echo '[3/5] Verifying baseline count at 2 AM:'
mysql --defaults-file=/etc/mysql/debian.cnf sgrc_temp -B -e 'SELECT COUNT(*) AS asigs_at_2am FROM asignaciones;'

echo '[4/5] Replaying binlog into sgrc_temp...'
# El replay.sql apunta a USE sgrc — necesitamos redirigirlo a sgrc_temp también.
sed 's/USE `sgrc`/USE `sgrc_temp`/g' /tmp/replay.sql > /tmp/replay-temp.sql
mysql --defaults-file=/etc/mysql/debian.cnf sgrc_temp < /tmp/replay-temp.sql 2>/tmp/replay-errors.log || echo '   (Some errors expected; continuing)'
echo "   Errors logged: $(wc -l < /tmp/replay-errors.log)"

echo '[5/5] Final counts in sgrc_temp (objective: 1964 / 1963):'
mysql --defaults-file=/etc/mysql/debian.cnf sgrc_temp -B -e 'SELECT COUNT(*) AS total, SUM(CASE WHEN estado != "cancelada" THEN 1 ELSE 0 END) AS activas FROM asignaciones;'
