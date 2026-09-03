#!/bin/bash
set -euo pipefail

echo '═══════════════════════════════════════════════════════════════'
echo '  Mover usuarios_sedes del equipo de Rosa: vieja → nueva sede   '
echo '═══════════════════════════════════════════════════════════════'

ROSA_ID='9c0a62c8-fdec-437f-adbb-e05965ddfaca'
SEDE_3_ID='b6616506-1871-4991-8646-8706959d353f'
SEDE_DIAG_ID='b9f08bd4-700b-11f1-a5ec-0ab60e60fd5b'

echo ''
echo '[1/4] Backup de seguridad…'
mysqldump --defaults-file=/etc/mysql/debian.cnf --single-transaction --quick sgrc | gzip > /tmp/sgrc-safety-pre-mover-equipo-rosa.sql.gz
ls -lah /tmp/sgrc-safety-pre-mover-equipo-rosa.sql.gz

echo ''
echo '[2/4] Estado ANTES:'
mysql --defaults-file=/etc/mysql/debian.cnf sgrc -B -e "
SELECT 'tecnicos_rosa_en_sede_3_vieja' AS metrica, COUNT(*) AS valor
FROM usuarios_sedes us
JOIN usuarios u ON u.id=us.usuario_id
JOIN recursos r ON r.id=u.recurso_id
WHERE r.coordinador_lider_id='$ROSA_ID' AND us.sede_id='$SEDE_3_ID'
UNION ALL
SELECT 'tecnicos_rosa_ya_en_sede_diag_nueva', COUNT(*)
FROM usuarios_sedes us
JOIN usuarios u ON u.id=us.usuario_id
JOIN recursos r ON r.id=u.recurso_id
WHERE r.coordinador_lider_id='$ROSA_ID' AND us.sede_id='$SEDE_DIAG_ID';"

echo ''
echo '[3/4] Aplicando cambios en TRANSACCIÓN…'
mysql --defaults-file=/etc/mysql/debian.cnf sgrc -e "
START TRANSACTION;

-- a) Insertar vínculo a la sede nueva para TODOS los técnicos liderados por Rosa
--    (INSERT IGNORE evita duplicados si ya estaban)
INSERT IGNORE INTO usuarios_sedes (usuario_id, sede_id)
SELECT DISTINCT u.id, '$SEDE_DIAG_ID'
FROM usuarios u
JOIN recursos r ON r.id=u.recurso_id
WHERE r.coordinador_lider_id='$ROSA_ID';

-- b) Quitar el vínculo a Sede 3 Alkarawi vieja SOLO para los del equipo de Rosa
DELETE us FROM usuarios_sedes us
JOIN usuarios u ON u.id=us.usuario_id
JOIN recursos r ON r.id=u.recurso_id
WHERE r.coordinador_lider_id='$ROSA_ID' AND us.sede_id='$SEDE_3_ID';

COMMIT;
"

echo ''
echo '[4/4] Estado DESPUÉS:'
mysql --defaults-file=/etc/mysql/debian.cnf sgrc -B -e "
SELECT s.nombre AS sede, COUNT(*) AS tecnicos_de_rosa
FROM usuarios_sedes us
JOIN usuarios u ON u.id=us.usuario_id
JOIN recursos r ON r.id=u.recurso_id
JOIN sedes s ON s.id=us.sede_id
WHERE r.coordinador_lider_id='$ROSA_ID'
GROUP BY s.id ORDER BY tecnicos_de_rosa DESC;"

echo ''
echo 'Verificacion de ausencias visibles para Rosa (deben aparecer las 9):'
mysql --defaults-file=/etc/mysql/debian.cnf sgrc -B -e "
SELECT COUNT(DISTINCT au.id) AS ausencias_visibles_para_rosa_en_sede_diag
FROM ausencias au
JOIN recursos r ON r.id=au.recurso_id
JOIN usuarios u ON u.recurso_id=r.id
JOIN usuarios_sedes us ON us.usuario_id=u.id
WHERE us.sede_id='$SEDE_DIAG_ID';"

echo ''
echo '✓ Listo. Backup en /tmp/sgrc-safety-pre-mover-equipo-rosa.sql.gz'
