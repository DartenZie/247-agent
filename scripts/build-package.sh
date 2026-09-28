#!/usr/bin/env bash
# Builds the .deb and .rpm packages for one target from the release tree that
# scripts/build-release.sh staged (packaging/nfpm.yaml describes them):
#
#   scripts/build-package.sh [--target linux-x64|linux-arm64] [--out <dir>]
#
# Output: <out>/247-agent_<version>-1_<arch>.deb, 247-agent-<version>-1.<arch>.rpm and
# their .sha256 files. Needs nfpm; without one on PATH a pinned build is downloaded from
# GitHub (checksum verified) into .cache/nfpm/.
set -euo pipefail

NFPM_VERSION=2.47.0

root=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$root"

target=$(node -p '"linux-" + process.arch')
out=$root/dist-release
while [ $# -gt 0 ]; do
  case $1 in
    --target) target=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case $target in
  linux-x64) arch=amd64 ;;
  linux-arm64) arch=arm64 ;;
  *) echo "unsupported target: $target (packages are Linux only)" >&2; exit 2 ;;
esac

sha256() {
  if command -v sha256sum > /dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

version=$(node -p 'require("./package.json").version')
stage=$out/247-agent-$version-$target
if [ ! -f "$stage/VERSION" ]; then
  echo "no release tree at $stage; run scripts/build-release.sh --target $target first" >&2
  exit 1
fi

# nfpm: on PATH, or a pinned download.
nfpm=$(command -v nfpm || true)
if [ -z "$nfpm" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) asset=nfpm_${NFPM_VERSION}_Darwin_arm64.tar.gz ;;
    Darwin-x86_64) asset=nfpm_${NFPM_VERSION}_Darwin_x86_64.tar.gz ;;
    Linux-x86_64) asset=nfpm_${NFPM_VERSION}_Linux_x86_64.tar.gz ;;
    Linux-aarch64) asset=nfpm_${NFPM_VERSION}_Linux_arm64.tar.gz ;;
    *) echo "no nfpm on PATH and no known download for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
  esac
  cache=$root/.cache/nfpm/$NFPM_VERSION
  nfpm=$cache/nfpm
  if [ ! -x "$nfpm" ]; then
    echo "downloading nfpm $NFPM_VERSION"
    mkdir -p "$cache"
    base=https://github.com/goreleaser/nfpm/releases/download/v$NFPM_VERSION
    curl -fsSL -o "$cache/$asset" "$base/$asset"
    curl -fsSL -o "$cache/checksums.txt" "$base/checksums.txt"
    expected=$(grep " $asset\$" "$cache/checksums.txt" | cut -d' ' -f1)
    actual=$(sha256 "$cache/$asset")
    if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
      echo "checksum mismatch for $asset" >&2
      rm -f "$cache/$asset"
      exit 1
    fi
    tar -xzf "$cache/$asset" -C "$cache" nfpm
    rm -f "$cache/$asset"
  fi
fi

echo "packaging 247-agent $version for $arch (nfpm: $nfpm)"
# nfpm expands environment variables only in some fields, so fill the template ourselves.
config=$out/nfpm-$target.yaml
sed -e "s|\${VERSION}|$version|g" -e "s|\${ARCH}|$arch|g" -e "s|\${STAGE}|$stage|g" packaging/nfpm.yaml > "$config"
for fmt in deb rpm; do
  file=$("$nfpm" package --config "$config" --packager $fmt --target "$out/" | sed -n 's/.*created package: *//p' | tail -n 1)
  [ -n "$file" ] || file=$(ls -t "$out"/*."$fmt" | head -n 1)
  name=$(basename "$file")
  (cd "$out" && sha256 "$name" | sed "s|\$| $name|" > "$name.sha256")
  echo "wrote $file ($(du -h "$file" | cut -f1))"
done
