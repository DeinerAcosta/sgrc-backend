#!/usr/bin/env bash
# backup-db.sh — Backup automatizado de una base MySQL con rotación.
#
# Pensado para vivir en /opt/scripts/backup-db.sh y ejecutarse por cron diario.
# Parametrizable por nombre de base, así sirve para `sgrc`, `foca_preop`
# o cualquier base futura sin duplicar código.
#
# Uso:
#   ./backup-db.sh <db_name>
#   ./backup-db.sh sgrc
#   ./backup-db.sh foca_preop
#
# Credenciales: lee de un archivo per-database /opt/scripts/.credentials/<db>.cnf
# con el formato estándar de mysql defaults-file:
#   [client]
#   user=appuser
#   password=apppassword
# Debe tener permisos 600 (chmod 600).
#
# Rotación local: 7 días + 4 semanales (cada domingo) + 3 mensuales (día 1).
# Si se exporta S3_BUCKET=mi-bucket, sube el dump y mantiene rotación allá.

set -euo pipefail

# ---------- args ----------
DB="${1:-}"
if [[ -z "$DB" ]]; then
  echo "Uso: $0 <db_name>" >&2
  exit 1
fi

# ---------- paths ----------
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/mysql}"
CREDS_FILE="${CREDS_DIR:-/opt/scripts/.credentials}/${DB}.cnf"
LOG_FILE="${LOG_FILE:-/var/log/backup-db.log}"
DATE_TAG="$(date +%Y-%m-%d)"
DAY_OF_WEEK="$(date +%u)"   # 1=lunes ... 7=domingo
DAY_OF_MONTH="$(date +%d)"

DIR_DAILY="$BACKUP_ROOT/$DB/daily"
DIR_WEEKLY="$BACKUP_ROOT/$DB/weekly"
DIR_MONTHLY="$BACKUP_ROOT/$DB/monthly"
mkdir -p "$DIR_DAILY" "$DIR_WEEKLY" "$DIR_MONTHLY"

# ---------- helpers ----------
log() { echo "[$(date '+%F %T')] [$DB] $*" | tee -a "$LOG_FILE"; }

# ---------- precheck ----------
if [[ ! -r "$CREDS_FILE" ]]; then
  log "ERROR: no se puede leer $CREDS_FILE. Crear el archivo con [client] user/password y chmod 600."
  exit 2
fi

# ---------- dump ----------
DUMP_FILE="$DIR_DAILY/${DB}_${DATE_TAG}.sql.gz"
log "Iniciando backup de $DB → $DUMP_FILE"

# --single-transaction = consistente sin lockear tablas (InnoDB).
# --quick + --routines + --triggers para no reventar memoria con tablas grandes.
# --no-tablespaces porque sino requiere PROCESS privilege.
# --set-gtid-purged=OFF para evitar warning en MySQL 8 sin GTID.
mysqldump \
  --defaults-extra-file="$CREDS_FILE" \
  --single-transaction \
  --quick \
  --routines \
  --triggers \
  --no-tablespaces \
  --set-gtid-purged=OFF \
  --databases "$DB" \
  | gzip -9 > "$DUMP_FILE"

SIZE_KB=$(du -k "$DUMP_FILE" | cut -f1)
log "Dump local OK ($SIZE_KB KB)"

# ---------- promoción weekly / monthly ----------
# Domingo (7): promover al folder weekly
if [[ "$DAY_OF_WEEK" == "7" ]]; then
  cp "$DUMP_FILE" "$DIR_WEEKLY/"
  log "Promovido a weekly"
fi
# Día 1 del mes: promover al folder monthly
if [[ "$DAY_OF_MONTH" == "01" ]]; then
  cp "$DUMP_FILE" "$DIR_MONTHLY/"
  log "Promovido a monthly"
fi

# ---------- rotación local ----------
# Daily: mantener últimos 7
find "$DIR_DAILY" -type f -name "${DB}_*.sql.gz" -mtime +7 -delete 2>/dev/null || true
# Weekly: últimas 4 semanas (28 días)
find "$DIR_WEEKLY" -type f -name "${DB}_*.sql.gz" -mtime +28 -delete 2>/dev/null || true
# Monthly: últimos 3 meses (90 días). Compliance PHI exige 15 años → cuando
# tengamos S3, allá se hace la retención larga.
find "$DIR_MONTHLY" -type f -name "${DB}_*.sql.gz" -mtime +90 -delete 2>/dev/null || true
log "Rotación local aplicada"

# ---------- S3 (opcional) ----------
if [[ -n "${S3_BUCKET:-}" ]]; then
  if command -v aws >/dev/null 2>&1; then
    aws s3 cp "$DUMP_FILE" "s3://${S3_BUCKET}/${DB}/daily/" --only-show-errors
    if [[ "$DAY_OF_WEEK" == "7" ]]; then
      aws s3 cp "$DUMP_FILE" "s3://${S3_BUCKET}/${DB}/weekly/" --only-show-errors
    fi
    if [[ "$DAY_OF_MONTH" == "01" ]]; then
      aws s3 cp "$DUMP_FILE" "s3://${S3_BUCKET}/${DB}/monthly/" --only-show-errors
    fi
    log "Subido a s3://${S3_BUCKET}/${DB}/"
  else
    log "WARN: S3_BUCKET seteado pero AWS CLI no instalado. Saltando."
  fi
fi

log "Backup completado OK"
