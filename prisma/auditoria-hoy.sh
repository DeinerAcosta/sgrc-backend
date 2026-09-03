#!/bin/bash
set -e

echo '═══════════════════════════════════════════════════════════════'
echo '  AUDITORÍA: BD actual vs backup 2 AM HOY (24-jun-2026)        '
echo '═══════════════════════════════════════════════════════════════'

echo ''
echo '[1/2] Restaurando backup de HOY 2 AM en sgrc_audit...'
mysql --defaults-file=/etc/mysql/debian.cnf -e 'DROP DATABASE IF EXISTS sgrc_audit; CREATE DATABASE sgrc_audit;'
zcat /var/backups/mysql/sgrc/daily/sgrc_2026-06-24.sql.gz \
  | grep -v '^CREATE DATABASE' \
  | sed 's/USE `sgrc`/USE `sgrc_audit`/g' \
  | mysql --defaults-file=/etc/mysql/debian.cnf sgrc_audit

echo ''
echo '[2/2] Comparativa por tabla:'
echo ''
TABLAS=$(mysql --defaults-file=/etc/mysql/debian.cnf sgrc -N -B -e "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='sgrc' AND TABLE_NAME NOT LIKE '\_prisma\_%' ORDER BY TABLE_NAME;")

printf '%-32s %10s %10s %10s   %s\n' 'TABLA' 'BK 2AM' 'ACTUAL' 'DELTA' 'ESTADO'
for T in $TABLAS; do
  BACKUP=$(mysql --defaults-file=/etc/mysql/debian.cnf sgrc_audit -N -B -e "SELECT COUNT(*) FROM \`$T\`;" 2>/dev/null || echo 0)
  ACTUAL=$(mysql --defaults-file=/etc/mysql/debian.cnf sgrc -N -B -e "SELECT COUNT(*) FROM \`$T\`;" 2>/dev/null || echo 0)
  DELTA=$((ACTUAL - BACKUP))
  if [ "$DELTA" -gt 0 ]; then ESTADO="↑ +${DELTA} (creció)"
  elif [ "$DELTA" -lt 0 ]; then ESTADO="↓ ${DELTA} ⚠️ PERDIÓ"
  else ESTADO="✓ igual"; fi
  printf '%-32s %10s %10s %10s   %s\n' "$T" "$BACKUP" "$ACTUAL" "$DELTA" "$ESTADO"
done

echo ''
echo 'Detalle asignaciones por semana:'
mysql --defaults-file=/etc/mysql/debian.cnf -e "
SELECT 'BK 2AM hoy' AS fuente, s.fecha_inicio, COUNT(a.id) AS asigs
FROM sgrc_audit.semanas s LEFT JOIN sgrc_audit.asignaciones a ON a.semana_id=s.id AND a.estado!='cancelada'
WHERE s.fecha_inicio >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
GROUP BY s.id
UNION ALL
SELECT 'ACTUAL', s.fecha_inicio, COUNT(a.id)
FROM sgrc.semanas s LEFT JOIN sgrc.asignaciones a ON a.semana_id=s.id AND a.estado!='cancelada'
WHERE s.fecha_inicio >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
GROUP BY s.id
ORDER BY fecha_inicio DESC, fuente;"

echo ''
echo 'Limpiando sgrc_audit...'
mysql --defaults-file=/etc/mysql/debian.cnf -e 'DROP DATABASE sgrc_audit;'
echo 'Listo.'
