#!/bin/sh
set -eu

# Provision the replication account on the existing primary as well as on a fresh volume.
PGPASSWORD="$APP_DB_PASSWORD" psql -X --no-password --host=app-db --username=admin \
    --dbname=db_online_shop --set=ON_ERROR_STOP=1 <<'SQL'
\getenv replica_password APP_DB_REPLICATION_PASSWORD
SELECT 'CREATE ROLE onlineshop_replica WITH LOGIN REPLICATION'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'onlineshop_replica')
\gexec
ALTER ROLE onlineshop_replica WITH LOGIN REPLICATION PASSWORD :'replica_password';
SQL

passfile=/var/lib/postgresql/.orders-replica.pgpass
install -m 0600 -o postgres -g postgres /dev/null "$passfile"
escaped_password=$(printf '%s' "$APP_DB_REPLICATION_PASSWORD" | sed 's/[\\:]/\\&/g')
printf 'app-db:5432:replication:onlineshop_replica:%s\n' "$escaped_password" > "$passfile"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
    # Only install the copy after pg_basebackup completes successfully.
    backup_dir=$(mktemp -d "${PGDATA%/*}/.basebackup.XXXXXX")
    trap 'rm -rf -- "$backup_dir"' EXIT
    chown postgres:postgres "$backup_dir"
    gosu postgres pg_basebackup \
        --dbname="host=app-db port=5432 user=onlineshop_replica passfile=$passfile application_name=onlineshop-orders-replica" \
        --pgdata="$backup_dir" --write-recovery-conf --wal-method=stream --checkpoint=fast --no-password
    mv -T "$backup_dir" "$PGDATA"
    trap - EXIT
fi

if [ ! -f "$PGDATA/standby.signal" ]; then
    echo "The replica data directory is missing standby.signal." >&2
    exit 1
fi

exec docker-entrypoint.sh postgres -c hba_file=/etc/postgresql/shop-pg_hba.conf
