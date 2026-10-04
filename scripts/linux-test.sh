#!/usr/bin/env bash
# Builds and tests this checkout on Linux, in a Debian 13 container with the Node version in
# .node-version and bubblewrap, so the tests that need a real bwrap run instead of being
# skipped (as they are on macOS):
#
#   scripts/linux-test.sh [--systemd=never|always] [--keep]
#
# Default (--systemd=never): npm ci, build, test and validate the examples, like CI.
# --systemd=always boots systemd in the container and, after those, does what the last CI
# steps do: builds the release tree and the .deb, installs it, checks the unit is active,
# runs `oa run hello --wait` and purges the package.
# --keep leaves the container running afterwards (its name is printed) to look inside.
#
# The working tree is copied in (tracked and untracked files, minus what .gitignore drops),
# so uncommitted changes are tested; node_modules is installed fresh for Linux. The npm,
# Node and nfpm downloads are cached in the volume 247-agent-linux-test-cache. Runs on
# docker, else podman (CONTAINER_ENGINE=docker|podman picks one). The container is
# privileged: bwrap needs to create user, pid and network namespaces and mount a /proc.
#
# Exit status: 0 passed, 1 a step failed, 2 usage, 3 no container engine is available.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$root"

systemd=never
keep=0
while [ $# -gt 0 ]; do
  case $1 in
    --systemd=never|--systemd=always) systemd=${1#--systemd=}; shift ;;
    --keep) keep=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# A container engine whose daemon (or podman machine) answers.
engine=${CONTAINER_ENGINE:-}
if [ -z "$engine" ]; then
  for candidate in docker podman; do
    if command -v "$candidate" > /dev/null && "$candidate" info > /dev/null 2>&1; then
      engine=$candidate
      break
    fi
  done
fi
if [ -z "$engine" ] || ! "$engine" info > /dev/null 2>&1; then
  echo "no container engine available: start Docker or the podman machine, or set CONTAINER_ENGINE" >&2
  exit 3
fi

node_version=$(tr -d '[:space:]' < .node-version)
image=247-agent-linux-test:node-$node_version
cache=247-agent-linux-test-cache
name=247-agent-linux-test-$$

echo "==> image $image ($engine)"
ctx=$(mktemp -d)
cat > "$ctx/Dockerfile" << 'EOF'
FROM docker.io/library/debian:trixie
ARG NODE_VERSION
# g++, make, python3: the npm of Node 22 builds better-sqlite3 from source, as on CI's runner.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bubblewrap ca-certificates curl g++ git make python3 systemd systemd-sysv xz-utils
RUN set -eu; \
    case $(dpkg --print-architecture) in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) exit 1 ;; esac; \
    dist=node-v$NODE_VERSION-linux-$arch; \
    cd /tmp; \
    curl -fsSLO "https://nodejs.org/dist/v$NODE_VERSION/$dist.tar.xz"; \
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $dist.tar.xz\$" | sha256sum -c -; \
    tar -xJf "$dist.tar.xz" -C /usr/local --strip-components=1 --no-same-owner; \
    rm "$dist.tar.xz"
RUN useradd -m -u 1000 ci && mkdir -p /work /cache/npm /cache/repo && chown -R ci:ci /work /cache
EOF
"$engine" build --build-arg "NODE_VERSION=$node_version" -t "$image" "$ctx" > "$ctx/build.log" 2>&1 || {
  cat "$ctx/build.log" >&2
  rm -rf "$ctx"
  exit 1
}
rm -rf "$ctx"

cleanup() {
  if [ $keep = 1 ]; then
    echo "container $name kept: $engine exec -it -u ci -w /work $name bash; $engine rm -f $name"
  else
    "$engine" rm -f "$name" > /dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

run_flags=(-d --name "$name" --privileged -v "$cache:/cache")
if [ $systemd = always ]; then
  if [ "$engine" = podman ]; then
    run_flags+=(--systemd=always)
  else
    run_flags+=(--cgroupns=private --tmpfs /run --tmpfs /run/lock)
  fi
  "$engine" run "${run_flags[@]}" "$image" /sbin/init > /dev/null
  echo "==> waiting for systemd"
  state=
  for _ in $(seq 60); do
    state=$("$engine" exec "$name" systemctl is-system-running 2> /dev/null || true)
    case $state in running|degraded) break ;; esac
    sleep 1
  done
  case $state in
    running|degraded) ;;
    *) echo "systemd did not come up in the container (state: ${state:-none})" >&2; exit 1 ;;
  esac
else
  "$engine" run "${run_flags[@]}" "$image" sleep infinity > /dev/null
fi

echo "==> copying the working tree"
tar_flags=()
if tar --version 2> /dev/null | grep -q bsdtar; then tar_flags=(--no-xattrs --no-mac-metadata); fi
git ls-files -z --cached --others --exclude-standard |
  while IFS= read -r -d '' f; do
    # Files only (a deleted tracked file is gone; a nested worktree is listed as a directory).
    if [ -f "$f" ] || [ -L "$f" ]; then printf '%s\0' "$f"; fi
  done |
  COPYFILE_DISABLE=1 tar ${tar_flags[@]+"${tar_flags[@]}"} -cf - --null -T - |
  "$engine" exec -i -u ci -w /work "$name" tar -xf -
"$engine" exec -u ci -w /work "$name" ln -sfn /cache/repo .cache

# Runs a bash script in the container as the given user, in /work.
in_container() {
  local user=$1 script=$2
  "$engine" exec -u "$user" -w /work -e npm_config_cache=/cache/npm -e CI=true "$name" \
    bash -c "set -euo pipefail; step() { printf '\n==> %s\n' \"\$*\"; }; $script" || exit 1
}

in_container ci '
step "bubblewrap can create namespaces"
bwrap --unshare-pid --unshare-net --ro-bind / / --proc /proc --dev /dev true
step "npm ci"
npm ci --no-audit --no-fund
step "build"
npm run build
step "test"
npm test
step "validate"
node packages/cli/dist/main.js validate docs/examples/*.yaml docs/examples/connectors.d/*.yaml
'

if [ $systemd = always ]; then
  in_container ci '
step "release tarball"
scripts/build-release.sh --skip-build
step "packages"
scripts/build-package.sh
'
  in_container root '
step "the .deb installs, starts the service and runs the starter task"
apt-get install -y ./dist-release/247-agent_*_"$(dpkg --print-architecture)".deb
for _ in $(seq 30); do systemctl is-active --quiet 247-agent && break; sleep 1; done
systemctl is-active 247-agent || { journalctl -u 247-agent --no-pager -n 50; exit 1; }
oa --version
oa run hello --wait
apt-get purge -y 247-agent
'
fi

echo
echo "==> linux-test passed (--systemd=$systemd)"
