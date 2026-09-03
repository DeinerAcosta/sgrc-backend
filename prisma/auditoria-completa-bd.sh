#!/bin/bash
set -e

echo '═══════════════════════════════════════════════════════════════'
echo '  AUDITORÍA COMPLETA SGRC — comparar BD actual vs backup 2 AM   '
echo '═══════════════════════════════════════════════════════════════'

echo ''
echo '[1/3] Restaurando backup en BD temporal sgrc_audit...'
mysql --defaults-file=/etc/mysql/debian.cnf -e 'DROP DATABASE IF EXISTS sgrc_audit; CREATE DATABASE sgrc_audit;'
zcat /var/backups/mysql/sgrc/daily/sgrc_2026-06-23.sql.gz \
  | grep -v '^CREATE DATABASE' \
  | sed 's/USE `sgrc`/USE `sgrc_audit`/g' \
  | mysql --defaults-file=/etc/mysql/debian.cnf sgrc_audit

echo '[2/3] Generando script de conteo dinámico para TODAS las tablas...'
TABLAS=$(mysql --defaults-file=/etc/mysql/debian.cnf sgrc -N -B -e "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='sgrc' AND TABLE_NAME NOT LIKE '\_prisma\_%' ORDER BY TABLE_NAME;")

echo ''
echo '[3/3] Comparativa de conteos:'
echo ''
printf '%-32s %10s %10s %10s   %s\n' 'TABLA' 'BACKUP' 'ACTUAL' 'DELTA' 'ESTADO'
printf '%-32s %10s %10s %10s   %s\n' '════' '══════' '══════' '═════' '══════'

for T in $TABLAS; do
  BACKUP=$(mysql --defaults-file=/etc/mysql/debian.cnf sgrc_audit -N -B -e "SELECT COUNT(*) FROM \`$T\`;" 2>/dev/null || echo 0)
  ACTUAL=$(mysql --defaults-file=/etc/mysql/debian.cnf sgrc -N -B -e "SELECT COUNT(*) FROM \`$T\`;" 2>/dev/null || echo 0)
  DELTA=$((ACTUAL - BACKUP))
  if [ "$DELTA" -gt 0 ]; then
    ESTADO="↑ +${DELTA} (creció)"
  elif [ "$DELTA" -lt 0 ]; then
    ESTADO="↓ ${DELTA} ⚠️ PERDIÓ"
  else
    ESTADO="✓ igual"
  fi
  printf '%-32s %10s %10s %10s   %s\n' "$T" "$BACKUP" "$ACTUAL" "$DELTA" "$ESTADO"
done

echo ''
echo '═══════════════════════════════════════════════════════════════'
echo ' DETALLE: asignaciones por semana (las críticas)               '
echo '═══════════════════════════════════════════════════════════════'
mysql --defaults-file=/etc/mysql/debian.cnf -e "
SELECT 'BACKUP 2 AM' AS fuente, s.fecha_inicio AS semana, COUNT(a.id) AS asignaciones
FROM sgrc_audit.semanas s LEFT JOIN sgrc_audit.asignaciones a ON a.semana_id=s.id AND a.estado!='cancelada'
WHERE s.fecha_inicio >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
GROUP BY s.id
UNION ALL
SELECT 'ACTUAL', s.fecha_inicio, COUNT(a.id)
FROM sgrc.semanas s LEFT JOIN sgrc.asignaciones a ON a.semana_id=s.id AND a.estado!='cancelada'
WHERE s.fecha_inicio >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
GROUP BY s.id
ORDER BY semana DESC, fuente;"

echo ''
echo '═══════════════════════════════════════════════════════════════'
echo ' Limpiando sgrc_audit...'
mysql --defaults-file=/etc/mysql/debian.cnf -e 'DROP DATABASE sgrc_audit;'
echo ' Listo.'
