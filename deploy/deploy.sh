#!/bin/sh
# Run on the VM from anywhere: sh /srv/factory-floor/deploy/deploy.sh
# Pulls, builds, migrates and seeds with the new image while the old API is
# still serving, then brings the API and worker up on it. Migrations are
# additive, so the old API keeps working against the new schema for that window.
set -eu
cd "$(dirname "$0")/.."

[ -f .env ] || { echo ".env is missing; copy deploy/env.prod.example and fill it in" >&2; exit 1; }
for name in $(grep -oE '^[A-Z][A-Z0-9_]*' deploy/env.prod.example); do
  grep -q "^$name=." .env || { echo "$name is empty or missing in .env" >&2; exit 1; }
done

compose="docker compose -f deploy/docker-compose.prod.yml --env-file .env"

git pull --ff-only
# Builds the api service; worker, migrate and seed reuse that image.
$compose build api
$compose up -d --wait postgres rabbitmq
$compose run --rm migrate
$compose run --rm seed
# --wait returns when the API's healthcheck passes. The worker has none, so it
# only has to be running.
$compose up -d --wait api worker
$compose ps
