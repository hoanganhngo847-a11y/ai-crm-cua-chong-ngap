#!/usr/bin/env bash
#
# Disposable PostgreSQL 17 target for Helper #6 live integration tests.
#
# This target is intentionally local-only and isolated from Supabase staging or
# production. It is used by CI and by local reviewers to run the plan -> apply ->
# verify -> rollback rehearsal against a real PostgreSQL catalog.
#
set -Eeuo pipefail

CONTAINER_NAME="${CRM_PG17_CONTAINER:-crm-dumpcheck-test}"
PG_IMAGE="${CRM_PG17_IMAGE:-public.ecr.aws/supabase/postgres:17.11.0.004}"
PG_FALLBACK_IMAGE="${CRM_PG17_FALLBACK_IMAGE:-postgres:17}"
PG_USER="${CRM_PG17_USER:-supabase_admin}"
PG_DATABASE="${CRM_PG17_DATABASE:-postgres}"
PG_PASSWORD="${CRM_PG17_PASSWORD:-localonly}"
READY_ATTEMPTS="${CRM_PG17_READY_ATTEMPTS:-60}"
PULL_ATTEMPTS="${CRM_PG17_PULL_ATTEMPTS:-3}"
PULL_RETRY_DELAY="${CRM_PG17_PULL_RETRY_DELAY:-10}"

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

assert_local_docker() {
  command -v docker >/dev/null 2>&1 || die "docker CLI is not available"

  if [[ -n "${DOCKER_HOST:-}" ]]; then
    case "${DOCKER_HOST}" in
      unix://*|/*) ;;
      *) die "refusing remote DOCKER_HOST (${DOCKER_HOST}); live tests require the local Docker socket" ;;
    esac
  fi

  if [[ -n "${DOCKER_CONTEXT:-}" ]]; then
    local endpoint
    endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}' -- "${DOCKER_CONTEXT}" 2>/dev/null || true)"
    [[ -n "${endpoint}" ]] || die "unable to resolve DOCKER_CONTEXT '${DOCKER_CONTEXT}'; refusing to continue"
    case "${endpoint}" in
      unix://*|/*) ;;
      *) die "refusing remote Docker context endpoint (${endpoint}); live tests require the local Docker socket" ;;
    esac
  fi
}

psql_exec() {
  docker exec -i "${CONTAINER_NAME}" \
    psql -X -qAt -v ON_ERROR_STOP=1 -U "${PG_USER}" -d "${PG_DATABASE}" "$@"
}

ensure_image() {
  local image="$1"

  if docker image inspect "${image}" >/dev/null 2>&1; then
    log "Using locally available image ${image}"
    return 0
  fi

  local attempt delay output
  for attempt in $(seq 1 "${PULL_ATTEMPTS}"); do
    output="$(mktemp)"
    log "Pulling ${image} (attempt ${attempt}/${PULL_ATTEMPTS})"
    if docker pull "${image}" >"${output}" 2>&1; then
      rm -f "${output}"
      log "Pulled ${image}"
      return 0
    fi
    tail -n 10 "${output}" >&2 || true
    rm -f "${output}"
    if [[ "${attempt}" -lt "${PULL_ATTEMPTS}" ]]; then
      delay=$((attempt * PULL_RETRY_DELAY))
      log "Pull failed for ${image}; retrying in ${delay}s"
      sleep "${delay}"
    fi
  done

  return 1
}

start() {
  assert_local_docker

  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true

  if ! ensure_image "${PG_IMAGE}"; then
    if [[ -n "${PG_FALLBACK_IMAGE}" && "${PG_FALLBACK_IMAGE}" != "${PG_IMAGE}" ]]; then
      log "Primary image ${PG_IMAGE} unavailable; falling back to ${PG_FALLBACK_IMAGE}"
      if ! ensure_image "${PG_FALLBACK_IMAGE}"; then
        die "unable to pull ${PG_IMAGE} or fallback ${PG_FALLBACK_IMAGE}"
      fi
      PG_IMAGE="${PG_FALLBACK_IMAGE}"
    else
      die "unable to pull PostgreSQL image ${PG_IMAGE}"
    fi
  fi

  log "Starting disposable PostgreSQL 17 container '${CONTAINER_NAME}' from ${PG_IMAGE}"
  docker run -d \
    --name "${CONTAINER_NAME}" \
    --label crm.disposable-test=true \
    --network none \
    -e "POSTGRES_PASSWORD=${PG_PASSWORD}" \
    -e "POSTGRES_USER=${PG_USER}" \
    -e "POSTGRES_DB=${PG_DATABASE}" \
    "${PG_IMAGE}" >/dev/null

  # The Supabase image starts a temporary server while init scripts run, then
  # stops it and starts the final server. A single pg_isready can therefore
  # observe the temporary instance. Wait for the init hand-off before probing
  # the final server.
  if [[ "${PG_IMAGE}" == *supabase/postgres* ]]; then
    local init_complete=0
    local attempt
    for attempt in $(seq 1 "${READY_ATTEMPTS}"); do
      if docker logs "${CONTAINER_NAME}" 2>&1 | grep -Fq 'PostgreSQL init process complete; ready for start up.'; then
        init_complete=1
        break
      fi
      sleep 1
    done
    if [[ "${init_complete}" -ne 1 ]]; then
      docker logs "${CONTAINER_NAME}" >&2 || true
      die "PostgreSQL container '${CONTAINER_NAME}' did not finish its init phase"
    fi
  fi

  local ready=0
  local attempt
  for attempt in $(seq 1 "${READY_ATTEMPTS}"); do
    if docker exec "${CONTAINER_NAME}" pg_isready -U "${PG_USER}" -d "${PG_DATABASE}" >/dev/null 2>&1 \
      && psql_exec -c 'SELECT 1;' >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done

  if [[ "${ready}" -ne 1 ]]; then
    docker logs "${CONTAINER_NAME}" >&2 || true
    die "PostgreSQL container '${CONTAINER_NAME}' did not become healthy after ${READY_ATTEMPTS}s"
  fi

  local version_num version_text
  version_num="$(psql_exec -c 'SHOW server_version_num;')"
  version_text="$(psql_exec -c 'SELECT version();')"
  log "PostgreSQL server_version_num=${version_num}"
  log "${version_text}"

  [[ "${version_num}" =~ ^17[0-9]{4}$ ]] || die "PostgreSQL 17.x is required; got server_version_num=${version_num}"

  psql_exec <<'SQL'
CREATE TABLE IF NOT EXISTS public._crm_disposable_test_marker (
  id serial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON DATABASE postgres IS 'crm-restore-rehearsal:disposable-test';
SQL

  local marker_count
  marker_count="$(psql_exec -c 'SELECT count(*) FROM public._crm_disposable_test_marker;')"
  [[ "${marker_count}" =~ ^[0-9]+$ ]] || die "disposable marker table verification failed"
  log "Disposable marker verified; PostgreSQL 17 target is ready."
}

stop() {
  if docker ps -a --format '{{.Names}}' | grep -Fxq "${CONTAINER_NAME}"; then
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
    log "Removed disposable PostgreSQL container '${CONTAINER_NAME}'."
  else
    log "Disposable PostgreSQL container '${CONTAINER_NAME}' not present; nothing to remove."
  fi
}

logs() {
  docker logs "${CONTAINER_NAME}" 2>&1 || true
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  logs) logs ;;
  *) die "usage: $0 {start|stop|logs}" ;;
esac
