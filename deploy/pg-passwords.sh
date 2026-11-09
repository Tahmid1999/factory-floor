#!/bin/sh
# Passwords come from the environment so none are committed.
set -e
psql -v ON_ERROR_STOP=1 -U postgres <<SQL
ALTER ROLE ff_owner PASSWORD '${FF_OWNER_PASSWORD}';
ALTER ROLE ff_app PASSWORD '${FF_APP_PASSWORD}';
SQL
