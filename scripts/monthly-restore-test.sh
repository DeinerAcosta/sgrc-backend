#!/usr/bin/env bash
# monthly-restore-test.sh — Verifica mensualmente que los backups son
# RESTAURABLES, no solo que existen. Cumple el criterio de auditoría
# "tenemos pruebas de que recuperamos historia clínica".
#
# Flujo:
#   1. Toma el backup más reciente de <db>
#   2. Lo restaura a una base de datos temporal "<db>_restore_test"
#   3. Compara conteos de tablas y de filas críticas vs la base original
#   4. Si todo OK → log de éxito + DROP de la BD temporal
#   5. Si algo falla → log de error + DEJA la BD temporal para investigar
#
# Pensado para correr por cron el primer lunes del mes a las 4 AM UTC.
#
# Uso: ./monthly-restore-test.sh <db_name>

set -euo pipefail

DB="${1:-}"
if [[ -z "$DB" ]]; then
  echo "Uso: $0 <db_name>" >&2
  exit 1
fi

TARGET_DB="${DB}_restore_test"
CREDS_FILE="/opt/scripts/.credentials/${DB}.cnf"
LOG_FILE="${LOG_FILE:-/var/log/backup-restore-test.log}"
DATE_TAG="$(date +%F)"

log() { echo "[$(date '+%F %T')] [restore-test:$DB] $*" | tee -a "$LOG_FILE"; }

cleanup() {
  local exit_code=$?
  if [[ $exit_code -eq 0 ]]; then
    # éxito → DROP la BD temporal (solo si confirmamos OK)
    mysql --defaults-extra-file=/etc/mysql/debian.cnf -e "DROP DATABASE IF EXISTS \`$TARGET_DB\`;" 2>/dev/null || true
    log "BD temporal $TARGET_DB eliminada."
  else
    log "⚠️ FALLO (exit=$exit_code). BD temporal $TARGET_DB QUEDA viva para investigar."
  fi
}
trap cleanup EXIT

log "=== Inicio del test mensual de restore ($DATE_TAG) ==="

# 1) Snapshot del estado actual de la BD original (referencia)
TABLAS_ORIG=$(mysql --defaults-extra-file=/etc/mysql/debian.cnf -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB';")
FILAS_ORIG=$(mysql --defaults-extra-file=/etc/mysql/debian.cnf -N -e "SELECT SUM(table_rows) FROM information_schema.tables WHERE table_schema='$DB';")
log "Origen ($DB): $TABLAS_ORIG tablas, ~$FILAS_ORIG filas (estimado)"

# 2) Restaurar el último daily a TARGET_DB con --yes (sin confirmación interactiva)
log "Restaurando último backup a $TARGET_DB..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/restore-db.sh" "$DB" --target-db "$TARGET_DB" --yes >> "$LOG_FILE" 2>&1

# 3) Verificaciones
TABLAS_REST=$(mysql --defaults-extra-file=/etc/mysql/debian.cnf -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$TARGET_DB';")
FILAS_REST=$(mysql --defaults-extra-file=/etc/mysql/debian.cnf -N -e "SELECT SUM(table_rows) FROM information_schema.tables WHERE table_schema='$TARGET_DB';")
log "Restaurado ($TARGET_DB): $TABLAS_REST tablas, ~$FILAS_REST filas (estimado)"

# Validar que la cuenta de tablas coincide
if [[ "$TABLAS_REST" -ne "$TABLAS_ORIG" ]]; then
  log "❌ FALLA: cuenta de tablas no coincide ($TABLAS_REST vs $TABLAS_ORIG esperadas)"
  exit 10
fi

# Validar que tiene al menos 1 fila (estructura sana, no vacía)
if [[ "$FILAS_REST" -lt 1 ]]; then
  log "❌ FALLA: BD restaurada está vacía"
  exit 11
fi

# Validar margen razonable de filas (el dump puede ser de hace 24h, así que
# permitimos hasta 10% de diferencia). Solo aplica si el origen tiene > 100 filas.
if [[ "$FILAS_ORIG" -gt 100 ]]; then
  MIN_OK=$((FILAS_ORIG * 90 / 100))
  if [[ "$FILAS_REST" -lt "$MIN_OK" ]]; then
    log "❌ FALLA: filas restauradas ($FILAS_REST) < 90% del origen ($FILAS_ORIG, mínimo aceptado $MIN_OK)"
    exit 12
  fi
fi

log "✅ Test de restore EXITOSO — backup verificado restaurable"
log "=== Fin del test mensual ==="
