#!/bin/bash
set -euo pipefail

echo '═══════════════════════════════════════════════════════════════'
echo '  Separar Sede 3 Alkarawi → crear Sede 3 Alkarawi - Diagnóstico  '
echo '═══════════════════════════════════════════════════════════════'

ROSA_ID='9c0a62c8-fdec-437f-adbb-e05965ddfaca'
ROY_ID='5f473027-4f62-48eb-8ff4-c10b2d976c46'
SEDE_3_ID='b6616506-1871-4991-8646-8706959d353f'

echo ''
echo '[1/5] Estado ANTES (backup ya generado en run anterior, no se rehace):'
mysql --defaults-file=/etc/mysql/debian.cnf sgrc -B -e "
SELECT 'consultorios_diag_en_sede_3' AS metrica, COUNT(*) AS valor FROM consultorios WHERE sede_id='$SEDE_3_ID' AND especialidad='diagnostico'
UNION ALL SELECT 'rosa_en_sede_3', COUNT(*) FROM usuarios_sedes WHERE usuario_id='$ROSA_ID' AND sede_id='$SEDE_3_ID';"

echo ''
echo '[2/5] Generando UUID para la nueva sede...'
NUEVA_SEDE_ID=$(mysql --defaults-file=/etc/mysql/debian.cnf sgrc -N -B -e "SELECT UUID();")
echo "   NUEVA_SEDE_ID = $NUEVA_SEDE_ID"

echo ''
echo '[3/5] Aplicando cambios en TRANSACCIÓN...'
mysql --defaults-file=/etc/mysql/debian.cnf sgrc -e "
START TRANSACTION;

INSERT INTO sedes (id, nombre, ciudad, activa, responsable_id, created_at, updated_at)
VALUES ('$NUEVA_SEDE_ID', 'Sede 3 Alkarawi - Diagnóstico', 'Barranquilla', 1, '$ROSA_ID', NOW(3), NOW(3));

UPDATE consultorios
SET sede_id = '$NUEVA_SEDE_ID', updated_at = NOW(3)
WHERE sede_id = '$SEDE_3_ID' AND especialidad = 'diagnostico';

DELETE FROM usuarios_sedes WHERE usuario_id = '$ROSA_ID' AND sede_id = '$SEDE_3_ID';
INSERT IGNORE INTO usuarios_sedes (usuario_id, sede_id) VALUES ('$ROSA_ID', '$NUEVA_SEDE_ID');

COMMIT;
"

echo ''
echo '[4/5] Estado DESPUÉS:'
mysql --defaults-file=/etc/mysql/debian.cnf sgrc -B -e "
SELECT s.id, s.nombre, s.activa,
  (SELECT COUNT(*) FROM consultorios WHERE sede_id=s.id) AS consultorios,
  (SELECT COUNT(*) FROM consultorios WHERE sede_id=s.id AND activo=1) AS cons_activos,
  (SELECT u.nombre FROM usuarios u WHERE u.id=s.responsable_id) AS responsable
FROM sedes s WHERE s.nombre LIKE 'Sede 3 Alkarawi%' ORDER BY s.nombre;"

echo ''
echo 'Sedes asignadas a cada coord:'
mysql --defaults-file=/etc/mysql/debian.cnf sgrc -B -e "
SELECT u.nombre AS coord, GROUP_CONCAT(s.nombre SEPARATOR ' | ') AS sedes
FROM usuarios u
LEFT JOIN usuarios_sedes us ON us.usuario_id=u.id
LEFT JOIN sedes s ON s.id=us.sede_id
WHERE u.id IN ('$ROSA_ID','$ROY_ID') GROUP BY u.id;"

echo ''
echo '[5/5] Asignaciones por sede (totales semana actual):'
mysql --defaults-file=/etc/mysql/debian.cnf sgrc -B -e "
SELECT s.nombre, COUNT(a.id) AS asigs_actual
FROM sedes s
LEFT JOIN consultorios c ON c.sede_id=s.id
LEFT JOIN asignaciones a ON a.consultorio_id=c.id AND a.estado='activa' AND a.semana_id IN (SELECT id FROM semanas WHERE fecha_inicio='2026-06-21')
WHERE s.nombre LIKE 'Sede 3 Alkarawi%' GROUP BY s.id;"

echo ''
echo '✓ Separación completada. Backup en /tmp/sgrc-safety-pre-separar-sede3.sql.gz'
