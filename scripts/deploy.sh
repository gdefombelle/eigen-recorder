#!/bin/bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage:
  ./scripts/deploy.sh

Common overrides:
  SERVER=gabriel@10.10.10.1 ./scripts/deploy.sh
  HOST_PORT=3301 ./scripts/deploy.sh

Notes:
  - Default service name  : eigenvertex_recorder
  - Default app bind      : 127.0.0.1:3301 -> container:3000
  - Default env file      : /home/gabriel/eigenvertex-recorder.env
    (static app — file can be empty, but must exist)
  - Default network       : eigenvertex_network
  - Domain                : recorder.eigenvertex.com (nginx handles HTTPS)
  - Container name matches nginx proxy_pass: http://eigenvertex_recorder:3000
EOF
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    usage
    exit 0
fi

SERVICE_NAME="${SERVICE_NAME:-eigenvertex_recorder}"
SERVER="${SERVER:-${REMOTE_SERVER:-gabriel@10.10.10.1}}"
PLATFORM="${PLATFORM:-linux/amd64}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

REMOTE_DIR="${REMOTE_DIR:-/home/gabriel/deploy/$SERVICE_NAME}"
ENV_FILE="${ENV_FILE:-/home/gabriel/eigenvertex-recorder.env}"
NETWORK="${NETWORK:-eigenvertex_network}"
ATTACH_CONTAINERS="${ATTACH_CONTAINERS:-}"

HOST_BIND_IP="${HOST_BIND_IP:-127.0.0.1}"
HOST_PORT="${HOST_PORT:-3301}"
CONTAINER_PORT="${CONTAINER_PORT:-3000}"

IMAGE_TAG="$SERVICE_NAME:latest"
TARBALL="$SERVICE_NAME.tar.gz"
CANDIDATE_NAME="${SERVICE_NAME}_candidate"
BACKUP_NAME="${SERVICE_NAME}_backup"

echo "Repo root   : $REPO_ROOT"
cd "$REPO_ROOT"

echo "Deploying   : $SERVICE_NAME → $SERVER"
echo "Env file    : $ENV_FILE"
echo "Bind        : $HOST_BIND_IP:$HOST_PORT → $CONTAINER_PORT"
echo "Network     : ${NETWORK:-none}"

echo "Building Docker image ($PLATFORM)"
docker build \
    --platform "$PLATFORM" \
    -t "$IMAGE_TAG" \
    -f Dockerfile \
    .

echo "Saving image to tarball"
docker save "$IMAGE_TAG" | gzip > "$TARBALL"

echo "Uploading to $SERVER"
ssh "$SERVER" "mkdir -p '$REMOTE_DIR'"
scp "$TARBALL" "$SERVER:$REMOTE_DIR/"
rm -f "$TARBALL"

echo "Deploying on server"
ssh "$SERVER" \
    "SERVICE_NAME='$SERVICE_NAME' \
     IMAGE_TAG='$IMAGE_TAG' \
     TARBALL='$TARBALL' \
     REMOTE_DIR='$REMOTE_DIR' \
     ENV_FILE='$ENV_FILE' \
     NETWORK='$NETWORK' \
     ATTACH_CONTAINERS='$ATTACH_CONTAINERS' \
     HOST_BIND_IP='$HOST_BIND_IP' \
     HOST_PORT='$HOST_PORT' \
     CONTAINER_PORT='$CONTAINER_PORT' \
     bash -s" <<'EOF'
set -euo pipefail

CANDIDATE_NAME="${SERVICE_NAME}_candidate"
BACKUP_NAME="${SERVICE_NAME}_backup"

cd "$REMOTE_DIR"

if [ ! -f "$ENV_FILE" ]; then
    echo "Note: env file not found at $ENV_FILE — creating empty one."
    touch "$ENV_FILE"
fi

echo "Loading Docker image"
gunzip -f "$TARBALL"
docker load < "${SERVICE_NAME}.tar"

network_args=()
if [ -n "$NETWORK" ]; then
    echo "Ensuring Docker network: $NETWORK"
    docker network create "$NETWORK" >/dev/null 2>&1 || true
    network_args=(--network "$NETWORK")
fi

if [ -n "$NETWORK" ] && [ -n "${ATTACH_CONTAINERS:-}" ]; then
    for container in $ATTACH_CONTAINERS; do
        if docker container inspect "$container" >/dev/null 2>&1; then
            docker network connect "$NETWORK" "$container" >/dev/null 2>&1 || true
        fi
    done
fi

cleanup_candidate() { docker rm -f "$CANDIDATE_NAME" >/dev/null 2>&1 || true; }
cleanup_backup()    { docker rm -f "$BACKUP_NAME"    >/dev/null 2>&1 || true; }

restore_backup_container() {
    if docker container inspect "$BACKUP_NAME" >/dev/null 2>&1; then
        echo "Restoring backup container $BACKUP_NAME"
        docker rm -f "$SERVICE_NAME" >/dev/null 2>&1 || true
        docker rename "$BACKUP_NAME" "$SERVICE_NAME"
        docker start "$SERVICE_NAME" >/dev/null 2>&1 || true
        return 0
    fi
    return 1
}

wait_for_http() {
    local target_container="$1" attempts="$2" delay="$3" i
    for i in $(seq 1 "$attempts"); do
        if docker container inspect -f '{{.State.Running}}' "$target_container" 2>/dev/null | grep -qx 'true'; then
            if docker run --rm "${network_args[@]}" curlimages/curl:8.10.1 \
                    -fsS "http://$target_container:$CONTAINER_PORT/health" >/dev/null 2>&1; then
                return 0
            fi
        fi
        sleep "$delay"
    done
    return 1
}

rollback_previous() {
    if restore_backup_container; then
        wait_for_http "$SERVICE_NAME" 20 2 && echo "Rollback succeeded." || \
            { echo "Rollback container unhealthy."; docker logs --tail 80 "$SERVICE_NAME" || true; }
        return
    fi
    if [ -n "${PREVIOUS_IMAGE:-}" ]; then
        echo "Rollback with $PREVIOUS_IMAGE"
        docker rm -f "$SERVICE_NAME" >/dev/null 2>&1 || true
        docker run -d --name "$SERVICE_NAME" --restart always \
            "${network_args[@]}" --env-file "$ENV_FILE" \
            -p "$HOST_BIND_IP:$HOST_PORT:$CONTAINER_PORT" "$PREVIOUS_IMAGE" >/dev/null
        wait_for_http "$SERVICE_NAME" 20 2 && echo "Rollback succeeded." || \
            { echo "Rollback failed."; docker logs --tail 80 "$SERVICE_NAME" || true; }
    fi
}

PREVIOUS_IMAGE="$(docker container inspect -f '{{.Config.Image}}' "$SERVICE_NAME" 2>/dev/null || true)"
cleanup_candidate
cleanup_backup

echo "Starting candidate"
if ! docker run -d --name "$CANDIDATE_NAME" --restart no \
        "${network_args[@]}" --env-file "$ENV_FILE" "$IMAGE_TAG" >/dev/null; then
    cleanup_candidate; exit 1
fi

echo "Candidate health check"
if ! wait_for_http "$CANDIDATE_NAME" 20 2; then
    echo "Candidate unhealthy:"; docker logs --tail 80 "$CANDIDATE_NAME" || true
    cleanup_candidate; exit 1
fi

if docker container inspect "$SERVICE_NAME" >/dev/null 2>&1; then
    docker stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    docker rename "$SERVICE_NAME" "$BACKUP_NAME"
else
    PREVIOUS_IMAGE=""
fi

echo "Starting final container"
if ! docker run -d --name "$SERVICE_NAME" --restart always \
        "${network_args[@]}" --env-file "$ENV_FILE" \
        -p "$HOST_BIND_IP:$HOST_PORT:$CONTAINER_PORT" "$IMAGE_TAG" >/dev/null; then
    cleanup_candidate; rollback_previous; exit 1
fi

echo "Final health check"
if ! wait_for_http "$SERVICE_NAME" 20 2; then
    echo "Final container unhealthy:"; docker logs --tail 80 "$SERVICE_NAME" || true
    docker rm -f "$SERVICE_NAME" >/dev/null 2>&1 || true
    cleanup_candidate; rollback_previous; exit 1
fi

cleanup_candidate
cleanup_backup
rm -f "${SERVICE_NAME}.tar"
EOF

echo "Deployed successfully → https://recorder.eigenvertex.com"
