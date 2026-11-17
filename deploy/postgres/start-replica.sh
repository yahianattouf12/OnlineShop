#!/bin/sh
# Requirement 3: starts the read replica, a read-only copy of app-db that follows it all the time.
set -eu

# Only the first time (the replica's volume is still empty): copy the whole primary database.
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "Copying the primary database with pg_basebackup..."
  # -R          writes standby.signal + the primary's address: "you are a copy, keep following app-db"
  # -X stream   also copies the changes (WAL) written while the copy runs, so the copy is complete
  PGPASSWORD="$APP_DB_PASSWORD" pg_basebackup -h app-db -U admin -D "$PGDATA" -R -X stream --checkpoint=fast
  chown -R postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
fi

# Start PostgreSQL as usual. Because of standby.signal it starts read-only and streams every change from app-db.
exec docker-entrypoint.sh postgres
