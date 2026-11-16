#!/bin/sh
set -eu
release=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
case "$release" in /opt/aivideo-replica/releases/*) ;; *) printf '%s\n' 'Refusing to run outside the dedicated release directory.' >&2; exit 1;; esac
test "$(cat /opt/aivideo-replica/.aivideo-deployment-owner)" = aivideo-replica-v1
cd "$release"
docker compose -p aivideo-replica -f deploy/compose.yaml config --quiet
phase=${1:-all}
case "$phase" in all|--build-only|--start-only) ;; *) printf '%s\n' 'Unknown deployment phase' >&2; exit 1;; esac
check_memory() {
  available_kib=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)
  if [ "$available_kib" -lt "$1" ]; then
    printf '%s\n' 'Deployment paused: not enough available memory for this phase plus the shared-host reserve.' >&2
    exit 1
  fi
}
# Build/run limits apply only to this project. Never stop other containers or prune shared Docker state.
if [ "$phase" != --start-only ]; then
  check_memory 655360
  DOCKER_BUILDKIT=0 docker build --memory=384m --memory-swap=384m --cpu-period=100000 --cpu-quota=50000 --build-arg "NODE_IMAGE=${AIVIDEO_NODE_IMAGE:-node:24.12.0-bookworm-slim}" -t aivideo-replica:local -f deploy/Dockerfile .
fi
if [ "$phase" = --build-only ]; then exit 0; fi
check_memory 851968
docker compose -p aivideo-replica -f deploy/compose.yaml up -d --no-build --wait --wait-timeout 120
printf '%s\n' 'aiVideo is healthy on 127.0.0.1:14173. Install only the /aiVideo/ Nginx locations after checking the deployment instructions.'
