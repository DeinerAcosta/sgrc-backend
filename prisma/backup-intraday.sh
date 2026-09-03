#!/bin/bash
# Backup intra-día del SGRC. Complementa el backup diario de 2 AM con
# snapshots cada 6 horas (8 AM / 2 PM / 8 PM) para limitar la pérdida
# potencial a 6 horas máximo si pasa algún incidente.
#
# Naming: sgrc_YYYY-MM-DDTHH.sql.gz (con hora) para no chocar con el diario.
# Retención: 72 horas (12 archivos = ~12 × 8MB = ~100MB).
#
# Si el dump falla, el script sale con código != 0 y se ve en /var/log/backup-intraday.log

set -euo pipefail

DB="sgrc"
DIR_INTRADAY="/var/backups/mysql/sgrc/intraday"
DATE_TAG="$(date +%Y-%m-%dT%H)"
DUMP_FILE="${DIR_INTRADAY}/${DB}_${DATE_TAG}.sql.gz"
LOG_TAG="[$(date +%Y-%m-%dT%H:%M:%S%z)]"

log() { echo "$LOG_TAG $*"; }

mkdir -p "$DIR_INTRADAY"

log "Iniciando backup intra-día de $DB → $DUMP_FILE"

mysqldump --defaults-file=/etc/mysql/debian.cnf \
  --single-transaction --quick --skip-lock-tables --routines --triggers \
  --set-gtid-purged=OFF \
  "$DB" \
  | gzip -9 > "$DUMP_FILE"

SIZE_KB=$(du -k "$DUMP_FILE" | cut -f1)
log "Backup OK · ${SIZE_KB} KB"

# Retención: borrar archivos intra-día con más de 72 horas
find "$DIR_INTRADAY" -type f -name "${DB}_*.sql.gz" -mmin +4320 -delete 2>/dev/null || true
log "Rotación aplicada (>72 h)"

log "Backup intra-día completado"
