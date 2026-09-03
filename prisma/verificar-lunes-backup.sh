#!/bin/bash
set -e
echo '[1/3] Restoring backup into sgrc_check...'
mysql --defaults-file=/etc/mysql/debian.cnf -e 'DROP DATABASE IF EXISTS sgrc_check; CREATE DATABASE sgrc_check;'
zcat /var/backups/mysql/sgrc/daily/sgrc_2026-06-23.sql.gz \
  | grep -v '^CREATE DATABASE' \
  | sed 's/USE `sgrc`/USE `sgrc_check`/g' \
  | mysql --defaults-file=/etc/mysql/debian.cnf sgrc_check

echo '[2/3] Conteo por día en BACKUP (estado 2 AM hoy):'
mysql --defaults-file=/etc/mysql/debian.cnf sgrc_check -B -e '
SELECT s.fecha_inicio AS semana,
  SUM(CASE WHEN a.dia_semana="lunes"     THEN 1 ELSE 0 END) AS lunes,
  SUM(CASE WHEN a.dia_semana="martes"    THEN 1 ELSE 0 END) AS martes,
  SUM(CASE WHEN a.dia_semana="miercoles" THEN 1 ELSE 0 END) AS mier,
  SUM(CASE WHEN a.dia_semana="jueves"    THEN 1 ELSE 0 END) AS jueves,
  SUM(CASE WHEN a.dia_semana="viernes"   THEN 1 ELSE 0 END) AS viernes,
  SUM(CASE WHEN a.dia_semana="sabado"    THEN 1 ELSE 0 END) AS sabado,
  SUM(CASE WHEN a.dia_semana="domingo"   THEN 1 ELSE 0 END) AS domingo,
  COUNT(a.id) AS total
FROM semanas s LEFT JOIN asignaciones a ON a.semana_id=s.id AND a.estado != "cancelada"
WHERE s.fecha_inicio = "2026-06-21"
GROUP BY s.id;'

echo '[3/3] Conteo por día en BD ACTUAL:'
mysql --defaults-file=/etc/mysql/debian.cnf sgrc -B -e '
SELECT s.fecha_inicio AS semana,
  SUM(CASE WHEN a.dia_semana="lunes"     THEN 1 ELSE 0 END) AS lunes,
  SUM(CASE WHEN a.dia_semana="martes"    THEN 1 ELSE 0 END) AS martes,
  SUM(CASE WHEN a.dia_semana="miercoles" THEN 1 ELSE 0 END) AS mier,
  SUM(CASE WHEN a.dia_semana="jueves"    THEN 1 ELSE 0 END) AS jueves,
  SUM(CASE WHEN a.dia_semana="viernes"   THEN 1 ELSE 0 END) AS viernes,
  SUM(CASE WHEN a.dia_semana="sabado"    THEN 1 ELSE 0 END) AS sabado,
  SUM(CASE WHEN a.dia_semana="domingo"   THEN 1 ELSE 0 END) AS domingo,
  COUNT(a.id) AS total
FROM semanas s LEFT JOIN asignaciones a ON a.semana_id=s.id AND a.estado != "cancelada"
WHERE s.fecha_inicio = "2026-06-21"
GROUP BY s.id;'
