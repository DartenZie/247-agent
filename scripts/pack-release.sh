#!/usr/bin/env bash
# Packs a staged release tree into <out>/<name>.tar.gz with its .sha256
# (scripts/build-release.sh, step 7, and its test):
#
#   scripts/pack-release.sh <out> <name>
#
# <out>/<name> is the staged tree. The tarball records the stage's modes as they are and
# root (uid 0, gid 0) as the owner of every entry, whoever built it: GNU tar run as root
# restores the recorded owner on unpack (issue #86).
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: scripts/pack-release.sh <out> <name>" >&2
  exit 2
fi
out=$1
name=$2

sha256() {
  if command -v sha256sum > /dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# bsdtar (macOS) would otherwise also record Apple xattrs that GNU tar warns about on Linux.
if tar --version 2> /dev/null | grep -q bsdtar; then
  tar_flags="--no-xattrs --no-mac-metadata --uid 0 --gid 0 --uname root --gname root"
else
  tar_flags="--owner=0 --group=0 --numeric-owner"
fi
export COPYFILE_DISABLE=1
# shellcheck disable=SC2086
tar $tar_flags -C "$out" -czf "$out/$name.tar.gz" "$name"
(cd "$out" && sha256 "$name.tar.gz" > "$name.tar.gz.sha256" && sed -i.bak "s|\$| $name.tar.gz|" "$name.tar.gz.sha256" && rm -f "$name.tar.gz.sha256.bak")
