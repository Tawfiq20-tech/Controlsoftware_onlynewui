#!/bin/sh
# Daily Onefinity relay backup: online SQLite copy + tar of staged uploads, 14 days kept.
#
# Run it from a systemd timer as the onefinity-relay user (see relay/README.md), or from
# root's crontab: as root it reads /etc/onefinity-relay.env and re-runs itself as the
# service user, so SQLite's -wal/-shm files are never created with root ownership (which
# would stop the relay from opening its own database).
#
# Overridable: ENV_FILE, APP_DIR, NODE, SERVICE_USER, KEEP_DAYS, RELAY_DATA_DIR.
set -eu

ENV_FILE=${ENV_FILE:-/etc/onefinity-relay.env}
APP_DIR=${APP_DIR:-/opt/onefinity-relay}
NODE=${NODE:-/opt/node/bin/node}
SERVICE_USER=${SERVICE_USER:-onefinity-relay}
KEEP_DAYS=${KEEP_DAYS:-14}

case "$KEEP_DAYS" in
    ''|*[!0-9]*|0) echo "KEEP_DAYS must be a positive integer" >&2; exit 2 ;;
esac

if [ "$(id -u)" -eq 0 ]; then
    if [ -r "$ENV_FILE" ]; then
        set -a
        # shellcheck disable=SC1090
        . "$ENV_FILE"
        set +a
    fi
    exec runuser -u "$SERVICE_USER" -- env \
        RELAY_DATA_DIR="${RELAY_DATA_DIR:-/var/lib/onefinity-relay}" \
        APP_DIR="$APP_DIR" NODE="$NODE" KEEP_DAYS="$KEEP_DAYS" \
        sh "$0" "$@"
fi

DATA_DIR=${RELAY_DATA_DIR:-/var/lib/onefinity-relay}
BACKUP_DIR="$DATA_DIR/backups"
STAMP=$(date +%F)
DB_OUT="$BACKUP_DIR/relay-$STAMP.db"
BLOBS_OUT="$BACKUP_DIR/blobs-$STAMP.tar.gz"

umask 077
mkdir -p "$BACKUP_DIR"

log() {
    printf '%s onefinity-relay-backup: %s\n' "$(date -u +%FT%TZ)" "$*"
}

# Write to a temporary name first so a failed run never leaves a truncated file that
# looks like a good backup.
rm -f "$DB_OUT.partial"
"$NODE" --disable-warning=ExperimentalWarning "$APP_DIR/server/cli.js" backup --out "$DB_OUT.partial"
mv -f "$DB_OUT.partial" "$DB_OUT"
log "database -> $DB_OUT"

# Blobs can be deleted by the retention sweep while tar reads them; GNU tar exits 1 for
# that ("file changed/removed"), which is not a failed backup. Exit 2 is.
if [ -d "$DATA_DIR/blobs" ]; then
    set -- blobs
    [ -f "$DATA_DIR/secret" ] && set -- "$@" secret
    rc=0
    tar -C "$DATA_DIR" --exclude=blobs/tmp --ignore-failed-read \
        --warning=no-file-changed --warning=no-file-removed \
        -czf "$BLOBS_OUT.partial" "$@" || rc=$?
    if [ "$rc" -gt 1 ]; then
        rm -f "$BLOBS_OUT.partial"
        log "tar of blobs failed (exit $rc)"
        exit "$rc"
    fi
    mv -f "$BLOBS_OUT.partial" "$BLOBS_OUT"
    log "blobs -> $BLOBS_OUT"
fi

# -mtime +N matches files at least N+1 whole days old, so this keeps KEEP_DAYS daily sets.
find "$BACKUP_DIR" -maxdepth 1 -type f \
    \( -name 'relay-*.db' -o -name 'blobs-*.tar.gz' -o -name '*.partial' \) \
    -mtime +"$((KEEP_DAYS - 1))" -delete
log "pruned backups older than $KEEP_DAYS days"
