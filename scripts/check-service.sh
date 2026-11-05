#!/bin/sh
# Checks that the 247-agent service came up and stays up after a start or a restart.
# install.sh and the package's postinstall run it right after they restart the unit; run
# it yourself after a deferred restart:
#
#   sudo systemctl restart 247-agent && sudo sh /opt/247-agent/share/check-service.sh
#
# It waits --settle seconds, then requires that the unit is active, that systemd did not
# restart it in the meantime (a build that crashes a moment after it reported ready) and
# that `oa health` answers with the dispatcher and the database not failing. Connectors
# that are down only warn. Exit 0 when it is up, 1 when it is not.
#
# Options:
#   --unit <name>     the systemd unit (default 247-agent)
#   --config <file>   agent.yaml, for its `socket:` (default /etc/247-agent/agent.yaml)
#   --oa <path>       the oa to ask (default: oa next to this script's tree, else on PATH)
#   --settle <s>      seconds to wait before checking (default 5)
#   --tries <n>       times to ask `oa health`, a second apart, before giving up (default 10)
#   -h, --help
set -eu

unit=247-agent
config=/etc/247-agent/agent.yaml
oa=
settle=5
tries=10
while [ $# -gt 0 ]; do
  case $1 in
    --unit) unit=$2; shift 2 ;;
    --config) config=$2; shift 2 ;;
    --oa) oa=$2; shift 2 ;;
    --settle) settle=$2; shift 2 ;;
    --tries) tries=$2; shift 2 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "check-service.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$oa" ]; then
  oa=$(dirname "$0")/../bin/oa
  [ -x "$oa" ] || oa=oa
fi

# The socket agent.yaml names at the top level (relative to the file, as the daemon reads
# it); none means the daemon's and oa's default.
socket=
if [ -r "$config" ]; then
  socket=$(sed -n 's/^socket:[[:space:]]*//p' "$config" | head -n 1 \
    | sed 's/[[:space:]]#.*$//; s/[[:space:]]*$//; s/^"\(.*\)"$/\1/; s/^'"'"'\(.*\)'"'"'$/\1/')
  case $socket in
    ''|/*) ;;
    *) socket=$(cd "$(dirname "$config")" && pwd)/$socket ;;
  esac
fi

fail() {
  printf '247-agent is not up: %s\n' "$1" >&2
  printf 'see: systemctl status %s; journalctl -u %s -n 50 --no-pager\n' "$unit" "$unit" >&2
  exit 1
}

restarts() { systemctl show -p NRestarts --value "$unit" 2> /dev/null || true; }

# The status of one check line of `oa health`: `dispatcher<TAB>ok since=…` gives ok.
check_status() { printf '%s\n' "$out" | awk -F '\t' -v c="$1" '$1 == c { split($2, a, " "); print a[1] }'; }

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
  if [ -n "$socket" ]; then
    out=$("$oa" health --socket "$socket" 2>&1) || true
  else
    out=$("$oa" health 2>&1) || true
  fi
  line=$(printf '%s\n' "$out" | head -n 1)
  status=$(printf '%s\n' "$line" | cut -f 1)
  case $status in
    ok)
      printf '247-agent is up: %s\n' "$line"
      exit 0 ;;
    degraded|failing)
      # A connector that is down (its server unreachable) is not a failed start.
      if [ "$(check_status dispatcher)" = ok ] && [ "$(check_status database)" = ok ]; then
        printf '247-agent is up: %s\n' "$line"
        if [ "$status" = failing ]; then
          printf 'warning: no connector is up; `oa health` and `oa connector list` show which\n' >&2
        else
          printf 'warning: 247-agent is degraded; `oa health` shows which check\n' >&2
        fi
        exit 0
      fi
      printf '%s\n' "$out" >&2
      fail "oa health reports $status" ;;
  esac
  [ $n -lt "$tries" ] && sleep 1
done
printf '%s\n' "$out" >&2
fail "oa health did not answer"
