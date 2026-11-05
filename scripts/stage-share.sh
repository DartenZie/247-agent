#!/usr/bin/env bash
# Fills <stage>/share of a release tree from this checkout (scripts/build-release.sh,
# step 4, and the release-docs test):
#
#   scripts/stage-share.sh <stage>
#
#   share/doc/         the user docs (docs/ without internal/), doc/examples a link to ../examples
#   share/examples/    docs/examples
#   share/connectors/  connectors/<name>/examples
#   share/skills/      skills/
#   share/systemd/     247-agent.service, 247-agent-connector@.service
#   share/etc/         the starter config (packaging/etc)
#   share/install.sh, share/uninstall.sh, share/check-service.sh
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: scripts/stage-share.sh <stage>" >&2
  exit 2
fi
stage=$1
root=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$root"

mkdir -p "$stage/share/doc" "$stage/share/systemd"
tar -C docs --exclude=./internal --exclude=./examples -cf - . | tar -C "$stage/share/doc" -xf -
cp -R docs/examples "$stage/share/examples"
# The docs link ../examples/… as in a checkout, where docs/examples sits inside docs/.
ln -s ../examples "$stage/share/doc/examples"
# The connector example task files, where the docs' ../../connectors/<name>/examples/…
# links land from share/doc. The connector READMEs are development notes and stay in
# the repository; docs/connectors/<name>.md is the reference that ships.
for dir in connectors/*/examples; do
  [ -d "$dir" ] || continue
  mkdir -p "$stage/share/$(dirname "$dir")"
  cp -R "$dir" "$stage/share/$dir"
done
cp -R skills "$stage/share/skills"
cp packaging/247-agent.service packaging/247-agent-connector@.service "$stage/share/systemd/"
cp scripts/install.sh scripts/uninstall.sh scripts/check-service.sh "$stage/share/"
cp -R packaging/etc "$stage/share/etc"
