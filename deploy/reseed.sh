#!/bin/sh
# A one-off for the slice-2 deploy, run once on the VM; deploy.sh stays the
# normal path. It empties the factory database and seeds it again by running
# the line on a fast clock from 1 Oct 2026 00:00 UTC to the moment the seed
# starts, closing October on the way. The API is down for all of it, about an
# hour on the VM. Run it inside tmux: a dropped ssh session takes the seed
# with it, half done.
#
#   sh deploy/reseed.sh          prints what it would do, does nothing
#   sh deploy/reseed.sh --yes    does it
#
# RESEED_ENV_FILE, RESEED_LOG and RESEED_NO_PULL=1 are for the local
# rehearsal (a scratch env file, a log it can write, no pull); leave them
# unset on the VM.
set -eu
cd "$(dirname "$0")/.."

env_file=${RESEED_ENV_FILE:-.env}
log=${RESEED_LOG:-/srv/deploy-factory-reseed.log}
# -p pins the project: a COMPOSE_PROJECT_NAME left in the shell would beat the
# file's name, and Live Room is the other project on this box.
compose="docker compose -p factory-floor -f deploy/docker-compose.prod.yml --env-file $env_file"

case "${1:-}" in
  --yes) ;;
  "")
    cat <<EOF
This wipes the factory database: every bundle, posting, roll, close, guest
and audit row in it. With --yes it will:
  1. git pull --ff-only, build the api image, make sure postgres and rabbitmq are up
  2. stop api and worker (the API is down from here until step 8)
  3. purge the scan.apply queue
  4. prisma migrate reset --force as ff_owner, on the factory database only
  5. run seed-history, 1 Oct 2026 00:00 UTC to now, October closed; log in $log
  6. run seed (the admin login)
  7. purge the scan.apply queue again
  8. start api and worker, then docker image prune -f
Nothing outside the factory-floor compose project is touched, apart from the
prune of dangling images that deploy.sh does too.
Run again with --yes to do it.
EOF
    exit 0
    ;;
  *) echo "usage: sh deploy/reseed.sh [--yes]" >&2; exit 2 ;;
esac

[ -f "$env_file" ] || { echo "$env_file is missing; copy deploy/env.prod.example and fill it in" >&2; exit 1; }
for name in $(grep -oE '^[A-Z][A-Z0-9_]*' deploy/env.prod.example); do
  grep -q "^$name=." "$env_file" || { echo "$name is empty or missing in $env_file" >&2; exit 1; }
done
# Found out here rather than after the API is already down.
touch "$log" || { echo "cannot write $log" >&2; exit 1; }

step() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$log"; }
# Old scans for a database that is about to go, or the seed's own leftovers
# (the sweep republishes a row the worker had not reached yet; apply skips it).
# The healthcheck's ping answers once the node is up, before the broker app is,
# so a freshly started rabbitmq refuses the purge without the wait. A
# recreated container comes up as a new node with no queues (its name is the
# hostname), and the api and worker declare the queue when they start, so a
# missing one has nothing to purge.
purge() {
  $compose exec -T rabbitmq rabbitmqctl -q await_startup
  if $compose exec -T rabbitmq rabbitmqctl -q list_queues --no-table-headers name | grep -qx scan.apply; then
    $compose exec -T rabbitmq rabbitmqctl -q purge_queue scan.apply
  fi
}

step "reseed started"
if [ "${RESEED_NO_PULL:-}" != 1 ]; then git pull --ff-only; fi
# Builds the api service; worker, migrate, seed and seed-history reuse that image.
$compose build api
$compose up -d --wait postgres rabbitmq

step "stopping api and worker"
$compose stop api worker
purge

step "resetting the factory database"
# migrate reset drops and recreates the schema, then reapplies every migration,
# grants included. Single quotes: the owner's URL is expanded in the migrate
# container, which already has it, so this script never reads the password
# out of the env file. --skip-generate because the image's
# client is already generated and node_modules is not the node user's to write.
$compose run --rm -T migrate sh -c 'DATABASE_URL="$OWNER_DATABASE_URL" npx prisma migrate reset --force --skip-seed --skip-generate'

step "seed-history started"
# A pipe would hide the seed's exit status from set -e, and POSIX sh has no
# pipefail, so the status goes through a file.
rc=$(mktemp)
{ $compose run --rm -T seed-history 2>&1 && echo 0 >"$rc" || echo 1 >"$rc"; } | tee -a "$log"
if [ "$(cat "$rc")" != 0 ]; then
  rm -f "$rc"
  step "seed-history failed"
  cat >&2 <<EOF

seed-history exited non-zero; the api and worker are still stopped and the
factory database holds whatever the run got to. Read $log first.
  - To run the whole reseed again: sh deploy/reseed.sh --yes
  - If the log ends in "ticks did not settle" and the summary line looks
    right, the data is probably fine (the sweep resends). To start on it:
      $compose run --rm seed
      $compose up -d --wait api worker
EOF
  exit 1
fi
rm -f "$rc"

step "seed"
$compose run --rm -T seed
purge

step "starting api and worker"
$compose up -d --wait api worker
$compose ps
docker image prune -f
step "reseed done"
grep -E '^(close|bundles) ' "$log" | tail -2
