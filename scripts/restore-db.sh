#!/usr/bin/env bash
# restore-db.sh — Restauración manual de un backup MySQL.
#
# Uso:
#   ./restore-db.sh <db_name> [<backup_file>] [--target-db NAME] [--yes]
#
#   ./restore-db.sh sgrc                         → restaura el último daily a 'sgrc'
#   ./restore-db.sh sgrc 2026-06-19              → restaura ese día a 'sgrc'
#   ./restore-db.sh sgrc 2026-06-19 --target-db sgrc_restored
#                                                → restaura a DB alternativa
#   ./restore-db.sh sgrc --yes                   → salta la confirmación interactiva
#
# Credenciales: usa /opt/scripts/.credentials/<db>.cnf (debe tener GRANT
# suficiente: CREATE/DROP/INSERT/etc en target DB).
#
# CUIDADO: si target-db == db_name (default), DROPS y recrea la base entera.

set -euo pipefail

DB="${1:-}"
if [[ -z "$DB" ]]; then
  echo "Uso: $0 <db_name> [<backup_date_yyyy-mm-dd>] [--target-db NAME] [--yes]" >&2
  exit 1
fi
shift

BACKUP_DATE=""
TARGET_DB="$DB"
SKIP_CONFIRM=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-db) TARGET_DB="$2"; shift 2 ;;
    --yes) SKIP_CONFIRM=true; shift ;;
    *) BACKUP_DATE="$1"; shift ;;
  esac
done

BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/mysql}"
DIR_DAILY="$BACKUP_ROOT/$DB/daily"

# El restore requiere DROP/CREATE/INSERT en BD nuevas — privilegios admin.
# Por defecto usamos `mysql` directo (auth_socket de root cuando se corre por
# cron o sudo). Si se exporta ADMIN_CNF apuntando a un .cnf con [client]
# user/password de admin, se usa ese.
if [[ -n "${ADMIN_CNF:-}" ]]; then
  MYSQL_ADMIN=(mysql --defaults-extra-file="$ADMIN_CNF")
elif [[ -r /etc/mysql/debian.cnf ]]; then
  # En Ubuntu/Debian este archivo trae usuario `debian-sys-maint` con privilegios
  # admin completos. Está protegido con modo 600 (solo root puede leerlo).
  MYSQL_ADMIN=(mysql --defaults-extra-file=/etc/mysql/debian.cnf)
else
  MYSQL_ADMIN=(mysql)
fi

# Resolver archivo de backup
if [[ -z "$BACKUP_DATE" ]]; then
  BACKUP_FILE=$(ls -t "$DIR_DAILY"/${DB}_*.sql.gz 2>/dev/null | head -1)
  if [[ -z "$BACKUP_FILE" ]]; then
    echo "ERROR: no hay backups en $DIR_DAILY" >&2
    exit 3
  fi
else
  BACKUP_FILE="$DIR_DAILY/${DB}_${BACKUP_DATE}.sql.gz"
  if [[ ! -f "$BACKUP_FILE" ]]; then
    # buscar también en weekly y monthly
    for tier in weekly monthly; do
      ALT="$BACKUP_ROOT/$DB/$tier/${DB}_${BACKUP_DATE}.sql.gz"
      if [[ -f "$ALT" ]]; then BACKUP_FILE="$ALT"; break; fi
    done
  fi
  if [[ ! -f "$BACKUP_FILE" ]]; then
    echo "ERROR: no se encontró backup $BACKUP_FILE" >&2
    exit 3
  fi
fi

echo "──────────────────────────────────────────────"
echo "  Backup origen   : $BACKUP_FILE"
echo "  Tamaño          : $(du -h "$BACKUP_FILE" | cut -f1)"
echo "  Base de datos   : $DB"
echo "  Target          : $TARGET_DB"
if [[ "$TARGET_DB" == "$DB" ]]; then
  echo "  ⚠️  REESCRIBIRÁ la base $DB ENTERA (drop + restore)"
fi
echo "──────────────────────────────────────────────"

if [[ "$SKIP_CONFIRM" == "false" ]]; then
  read -p "¿Continuar? [escribir 'si' para confirmar] " ans
  if [[ "$ans" != "si" ]]; then
    echo "Abortado."
    exit 0
  fi
fi

echo "[$(date '+%F %T')] Restaurando..."

# Si target ≠ origen, primero creamos la base destino (si no existe).
# Si target == origen, dropeamos y recreamos para tener estado limpio.
if [[ "$TARGET_DB" == "$DB" ]]; then
  "${MYSQL_ADMIN[@]}" -e "DROP DATABASE IF EXISTS \`$TARGET_DB\`; CREATE DATABASE \`$TARGET_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
else
  "${MYSQL_ADMIN[@]}" -e "DROP DATABASE IF EXISTS \`$TARGET_DB\`; CREATE DATABASE \`$TARGET_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
fi

# El dump fue con --databases, así que incluye un USE <origen>. Para restaurar
# a otra DB la reescribimos al vuelo con sed sobre la stream.
if [[ "$TARGET_DB" == "$DB" ]]; then
  gunzip -c "$BACKUP_FILE" | "${MYSQL_ADMIN[@]}"
else
  gunzip -c "$BACKUP_FILE" \
    | sed "s/^CREATE DATABASE.*/-- skipped CREATE DATABASE/" \
    | sed "s/^USE \`$DB\`/USE \`$TARGET_DB\`/" \
    | "${MYSQL_ADMIN[@]}" "$TARGET_DB"
fi

# Validar conteo de tablas como smoke test
TABLAS=$("${MYSQL_ADMIN[@]}" -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$TARGET_DB';")
echo "[$(date '+%F %T')] OK — $TABLAS tablas en $TARGET_DB"
