#!/bin/bash
set -e

echo '[1/5] Obteniendo semana_id de la semana 21-27 jun...'
SEMANA_ID=$(mysql --defaults-file=/etc/mysql/debian.cnf sgrc -N -B -e 'SELECT id FROM semanas WHERE fecha_inicio="2026-06-21";')
echo "   semana_id = $SEMANA_ID"

echo '[2/5] Verificando que coincida con backup...'
SEMANA_ID_BK=$(mysql --defaults-file=/etc/mysql/debian.cnf sgrc_check -N -B -e 'SELECT id FROM semanas WHERE fecha_inicio="2026-06-21";')
echo "   semana_id en backup = $SEMANA_ID_BK"
if [ "$SEMANA_ID" != "$SEMANA_ID_BK" ]; then
  echo "ERROR: semana_id no coincide entre BD actual y backup. Abortando."
  exit 1
fi

echo '[3/5] Conteo BACKUP (lunes 22): '
mysql --defaults-file=/etc/mysql/debian.cnf sgrc_check -B -e "SELECT COUNT(*) AS lunes_en_backup FROM asignaciones WHERE semana_id='$SEMANA_ID' AND dia_semana='lunes' AND estado!='cancelada';"

echo '[4/5] Insertando del backup (INSERT IGNORE)...'
mysqldump --defaults-file=/etc/mysql/debian.cnf \
  --no-create-info --skip-extended-insert --skip-add-locks --skip-disable-keys \
  --where="semana_id='$SEMANA_ID' AND dia_semana='lunes' AND estado!='cancelada'" \
  sgrc_check asignaciones \
  | sed 's/^INSERT INTO/INSERT IGNORE INTO/' \
  | mysql --defaults-file=/etc/mysql/debian.cnf sgrc

echo '[5/5] Conteo final BD actual:'
mysql --defaults-file=/etc/mysql/debian.cnf sgrc -B -e "
SELECT s.fecha_inicio AS semana,
  SUM(CASE WHEN a.dia_semana='lunes'     THEN 1 ELSE 0 END) AS lunes,
  SUM(CASE WHEN a.dia_semana='martes'    THEN 1 ELSE 0 END) AS martes,
  SUM(CASE WHEN a.dia_semana='miercoles' THEN 1 ELSE 0 END) AS mier,
  SUM(CASE WHEN a.dia_semana='jueves'    THEN 1 ELSE 0 END) AS jueves,
  SUM(CASE WHEN a.dia_semana='viernes'   THEN 1 ELSE 0 END) AS viernes,
  SUM(CASE WHEN a.dia_semana='sabado'    THEN 1 ELSE 0 END) AS sabado,
  COUNT(a.id) AS total
FROM semanas s LEFT JOIN asignaciones a ON a.semana_id=s.id AND a.estado != 'cancelada'
WHERE s.fecha_inicio = '2026-06-21' GROUP BY s.id;"
