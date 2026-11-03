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

LABEL_DISPOSABLE_KEY="crm.disposable-test"
LABEL_DISPOSABLE_VALUE="true"
LABEL_OWNER_KEY="crm.owner"
LABEL_OWNER_VALUE="ci-postgres17"
LABEL_PURPOSE_KEY="crm.purpose"
LABEL_PURPOSE_VALUE="pg17-backup-restore-test"

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

assert_local_docker() {
  command -v docker >/dev/null 2>&1 || die "docker CLI is not available"

  local effective_endpoint=""
  local effective_context=""

  if [[ -n "${DOCKER_HOST:-}" ]]; then
    effective_endpoint="${DOCKER_HOST}"
  else
    if [[ -n "${DOCKER_CONTEXT:-}" ]]; then
      effective_context="${DOCKER_CONTEXT}"
    else
      if ! effective_context="$(docker context show 2>/dev/null)"; then
        die "unable to determine active Docker context; refusing to continue"
      fi
    fi

    effective_context="$(printf '%s' "${effective_context}" | tr -d '\r\n')"

    [[ -n "${effective_context}" ]] || die "active Docker context name is empty; refusing to continue"
    [[ "${effective_context}" =~ ^[a-zA-Z0-9_.-]+$ ]] || die "invalid Docker context name '${effective_context}'; refusing to continue"
    [[ "${effective_context}" != -* ]] || die "Docker context name cannot begin with dash '${effective_context}'; refusing to continue"

    local inspect_out
    if ! inspect_out="$(docker context inspect --format '{{.Endpoints.docker.Host}}' -- "${effective_context}" 2>/dev/null)"; then
      die "unable to inspect endpoint for Docker context '${effective_context}'; refusing to continue"
    fi

    effective_endpoint="$(printf '%s' "${inspect_out}" | tr -d '\r\n')"
    [[ -n "${effective_endpoint}" ]] || die "endpoint for Docker context '${effective_context}' is empty or unresolvable; refusing to continue"
  fi

  effective_endpoint="$(printf '%s' "${effective_endpoint}" | tr -d '\r\n')"

  case "${effective_endpoint}" in
    unix://?*|/*|npipe://?*)
      if [[ "${effective_endpoint}" == "unix://" || "${effective_endpoint}" == "/" || "${effective_endpoint}" == "npipe://" ]]; then
        die "invalid local Docker socket path '${effective_endpoint}'; refusing to continue"
      fi
      ;;
    tcp://*|ssh://*|http://*|https://*)
      die "refusing remote Docker endpoint (${effective_endpoint}); live tests require the local Docker socket"
      ;;
    *)
      die "unsupported or unverifiable Docker endpoint (${effective_endpoint}); live tests require the local Docker socket"
      ;;
  esac
}

check_container_ownership() {
  local container="$1"

  if ! docker inspect --type container "${container}" >/dev/null 2>&1; then
    return 2 # not found
  fi

  local l_disposable l_owner l_purpose
  l_disposable="$(docker inspect --type container --format '{{index .Config.Labels "crm.disposable-test"}}' "${container}" 2>/dev/null || true)"
  l_owner="$(docker inspect --type container --format '{{index .Config.Labels "crm.owner"}}' "${container}" 2>/dev/null || true)"
  l_purpose="$(docker inspect --type container --format '{{index .Config.Labels "crm.purpose"}}' "${container}" 2>/dev/null || true)"

  l_disposable="$(printf '%s' "${l_disposable}" | tr -d '\r\n')"
  l_owner="$(printf '%s' "${l_owner}" | tr -d '\r\n')"
  l_purpose="$(printf '%s' "${l_purpose}" | tr -d '\r\n')"

  if [[ "${l_disposable}" == "${LABEL_DISPOSABLE_VALUE}" && \
        "${l_owner}" == "${LABEL_OWNER_VALUE}" && \
        "${l_purpose}" == "${LABEL_PURPOSE_VALUE}" ]]; then
    return 0 # verified owned container
  fi

  return 1 # foreign / unverified container
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

  local status=0
  check_container_ownership "${CONTAINER_NAME}" || status=$?

  if [[ "${status}" -eq 0 ]]; then
    log "Existing disposable container '${CONTAINER_NAME}' verified with valid ownership markers; removing stale container before recreate."
    docker rm -f "${CONTAINER_NAME}" >/dev/null
  elif [[ "${status}" -eq 1 ]]; then
    die "container '${CONTAINER_NAME}' already exists but lacks valid ownership markers; refusing to overwrite or remove foreign container"
  else
    log "Container '${CONTAINER_NAME}' does not exist; ready to create."
  fi

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
    --label "${LABEL_DISPOSABLE_KEY}=${LABEL_DISPOSABLE_VALUE}" \
    --label "${LABEL_OWNER_KEY}=${LABEL_OWNER_VALUE}" \
    --label "${LABEL_PURPOSE_KEY}=${LABEL_PURPOSE_VALUE}" \
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
  assert_local_docker

  local status=0
  check_container_ownership "${CONTAINER_NAME}" || status=$?

  if [[ "${status}" -eq 0 ]]; then
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
    log "Removed disposable PostgreSQL container '${CONTAINER_NAME}'."
  elif [[ "${status}" -eq 1 ]]; then
    die "container '${CONTAINER_NAME}' exists but lacks valid ownership markers; refusing to remove foreign container"
  else
    log "Disposable PostgreSQL container '${CONTAINER_NAME}' not present; nothing to remove."
  fi
}

logs() {
  assert_local_docker

  local status=0
  check_container_ownership "${CONTAINER_NAME}" || status=$?

  if [[ "${status}" -eq 0 ]]; then
    docker logs "${CONTAINER_NAME}" 2>&1 || true
  elif [[ "${status}" -eq 1 ]]; then
    die "refusing to read logs from container '${CONTAINER_NAME}' without valid ownership markers"
  else
    log "Disposable PostgreSQL container '${CONTAINER_NAME}' not present; no logs to display."
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  logs) logs ;;
  *) die "usage: $0 {start|stop|logs}" ;;
esac
