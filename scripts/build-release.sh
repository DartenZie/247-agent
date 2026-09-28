#!/usr/bin/env bash
# Builds a self-contained release tarball of 247-agent for one target:
#
#   scripts/build-release.sh [--target linux-x64|linux-arm64|darwin-x64|darwin-arm64]
#                            [--node <version>] [--out <dir>] [--skip-build]
#
# The tarball unpacks to one directory (install it as /opt/247-agent):
#
#   bin/            launchers: 247-agent-core, oa, 247-agent-connector-<name>
#   lib/            one bundled .mjs per program (scripts/bundle.mjs)
#   node/           a vendored Node (bin/node, npm, npx) pinned by .node-version
#   node_modules/   better-sqlite3 with the target's prebuilt addon only
#   share/          doc/, examples/, skills/, systemd/247-agent.service, etc/ (starter config), install.sh, uninstall.sh
#   LICENSE VERSION
#
# Defaults: the host's platform-arch, the Node version in .node-version, ./dist-release.
# Node downloads are verified against nodejs.org's SHASUMS256.txt and cached in .cache/.
set -euo pipefail

sha256() {
  if command -v sha256sum > /dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

root=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$root"

target=$(node -p 'process.platform + "-" + process.arch')
node_version=$(tr -d '[:space:]' < .node-version)
out=$root/dist-release
build=1
while [ $# -gt 0 ]; do
  case $1 in
    --target) target=$2; shift 2 ;;
    --node) node_version=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --skip-build) build=0; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case $target in
  linux-x64|linux-arm64|darwin-x64|darwin-arm64) ;;
  *) echo "unsupported target: $target" >&2; exit 2 ;;
esac

version=$(node -p 'require("./package.json").version')
name=247-agent-$version-$target
stage=$out/$name
echo "building $name (node $node_version)"

if [ $build = 1 ]; then
  npm run build
fi

rm -rf "$stage"
mkdir -p "$stage" "$out"

# 1. Bundled programs.
node scripts/bundle.mjs "$stage/lib"

# 2. The native module: its JS and the one prebuilt addon this target needs.
sqlite=node_modules/better-sqlite3
addon=$sqlite/prebuilds/$target.node
if [ ! -f "$addon" ]; then
  echo "no prebuilt better-sqlite3 addon for $target ($addon)" >&2
  exit 1
fi
mkdir -p "$stage/node_modules/better-sqlite3/prebuilds"
cp -R "$sqlite/lib" "$sqlite/package.json" "$sqlite/LICENSE" "$stage/node_modules/better-sqlite3/"
cp "$addon" "$stage/node_modules/better-sqlite3/prebuilds/"

# 3. A vendored Node: node, npm and npx (npx starts the ACP agents), nothing else.
dist=node-v$node_version-$target
cache=$root/.cache/node
mkdir -p "$cache"
if [ ! -f "$cache/$dist.tar.gz" ]; then
  echo "downloading $dist"
  curl -fsSL -o "$cache/$dist.tar.gz.part" "https://nodejs.org/dist/v$node_version/$dist.tar.gz"
  curl -fsSL -o "$cache/SHASUMS256-$node_version.txt" "https://nodejs.org/dist/v$node_version/SHASUMS256.txt"
  expected=$(grep " $dist.tar.gz\$" "$cache/SHASUMS256-$node_version.txt" | cut -d' ' -f1)
  actual=$(sha256 "$cache/$dist.tar.gz.part")
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    echo "checksum mismatch for $dist.tar.gz" >&2
    rm -f "$cache/$dist.tar.gz.part"
    exit 1
  fi
  mv "$cache/$dist.tar.gz.part" "$cache/$dist.tar.gz"
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$cache/$dist.tar.gz" -C "$tmp"
mkdir -p "$stage/node/bin" "$stage/node/lib/node_modules"
cp "$tmp/$dist/bin/node" "$stage/node/bin/"
cp "$tmp/$dist/LICENSE" "$stage/node/"
cp -R "$tmp/$dist/lib/node_modules/npm" "$stage/node/lib/node_modules/"
ln -s ../lib/node_modules/npm/bin/npm-cli.js "$stage/node/bin/npm"
ln -s ../lib/node_modules/npm/bin/npx-cli.js "$stage/node/bin/npx"

# 4. Launchers, docs, examples, skills, the unit file.
cp -R bin "$stage/bin"
mkdir -p "$stage/share/doc" "$stage/share/systemd"
cp README.md docs/ARCHITECTURE.md docs/USER-GUIDE.md "$stage/share/doc/"
cp -R docs/examples "$stage/share/examples"
cp -R skills "$stage/share/skills"
cp packaging/247-agent.service "$stage/share/systemd/"
cp scripts/install.sh scripts/uninstall.sh "$stage/share/"
cp -R packaging/etc "$stage/share/etc"
cp LICENSE "$stage/LICENSE"
printf 'version=%s\ntarget=%s\nnode=%s\n' "$version" "$target" "$node_version" > "$stage/VERSION"

# 5. Smoke test when the tarball is for this machine.
if [ "$target" = "$(node -p 'process.platform + "-" + process.arch')" ]; then
  [ "$("$stage/bin/oa" --version)" = "$version" ]
  [ "$("$stage/bin/247-agent-core" --version)" = "$version" ]
  "$stage/bin/oa" validate "$stage/share/examples/agent.yaml" > /dev/null
fi

# 6. Pack.
# bsdtar (macOS) would otherwise record Apple xattrs that GNU tar warns about on Linux.
tar_flags=
if tar --version 2> /dev/null | grep -q bsdtar; then tar_flags="--no-xattrs --no-mac-metadata"; fi
export COPYFILE_DISABLE=1
# shellcheck disable=SC2086
tar $tar_flags -C "$out" -czf "$out/$name.tar.gz" "$name"
(cd "$out" && sha256 "$name.tar.gz" > "$name.tar.gz.sha256" && sed -i.bak "s|\$| $name.tar.gz|" "$name.tar.gz.sha256" && rm -f "$name.tar.gz.sha256.bak")
echo "wrote $out/$name.tar.gz ($(du -h "$out/$name.tar.gz" | cut -f1))"
