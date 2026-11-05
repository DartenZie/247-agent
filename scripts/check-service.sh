#!/bin/sh
# Checks that the 247-agent service came up and stays up after a start or a restart.
# install.sh and the package's postinstall run it right after they restart the unit; run
# it yourself after a deferred restart:
#
#   sudo systemctl restart 247-agent && sudo sh /opt/247-agent/share/check-service.sh
#
# It waits --settle seconds, then requires that the unit is active, that systemd did not
# restart it in the meantime (a build that crashes a moment after it reported ready) and
# that `oa health` answers `ok` or `degraded`. Exit 0 when it is up, 1 when it is not.
#
# Options:
#   --unit <name>     the systemd unit (default 247-agent)
#   --oa <path>       the oa to ask (default: oa next to this script's tree, else on PATH)
#   --settle <s>      seconds to wait before checking (default 5)
#   --tries <n>       times to ask `oa health`, a second apart, before giving up (default 10)
#   -h, --help
set -eu

unit=247-agent
oa=
settle=5
tries=10
while [ $# -gt 0 ]; do
  case $1 in
    --unit) unit=$2; shift 2 ;;
    --oa) oa=$2; shift 2 ;;
    --settle) settle=$2; shift 2 ;;
    --tries) tries=$2; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "check-service.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$oa" ]; then
  oa=$(dirname "$0")/../bin/oa
  [ -x "$oa" ] || oa=oa
fi

fail() {
  printf '247-agent is not up: %s\n' "$1" >&2
  printf 'see: systemctl status %s; journalctl -u %s -n 50 --no-pager\n' "$unit" "$unit" >&2
  exit 1
}

restarts() { systemctl show -p NRestarts --value "$unit" 2> /dev/null || true; }

before=$(restarts)
sleep "$settle"
if ! systemctl is-active --quiet "$unit"; then
  fail "the unit is $(systemctl is-active "$unit" 2> /dev/null || true)"
fi
after=$(restarts)
if [ -n "$before" ] && [ -n "$after" ] && [ "$after" != "$before" ]; then
  fail "systemd restarted it $((after - before)) times in ${settle}s; it crashes after it starts"
fi

out=
n=0
while [ $n -lt "$tries" ]; do
  n=$((n + 1))
  out=$("$oa" health 2>&1) || true
  status=$(printf '%s\n' "$out" | head -n 1 | cut -f 1)
  case $status in
    ok)
      printf '247-agent is up: %s\n' "$(printf '%s\n' "$out" | head -n 1)"
      exit 0 ;;
    degraded)
      printf '247-agent is up: %s\n' "$(printf '%s\n' "$out" | head -n 1)"
      printf 'warning: 247-agent is degraded; `oa health` shows which check\n' >&2
      exit 0 ;;
    failing)
      printf '%s\n' "$out" >&2
      fail "oa health reports failing" ;;
  esac
  [ $n -lt "$tries" ] && sleep 1
done
printf '%s\n' "$out" >&2
fail "oa health did not answer"
