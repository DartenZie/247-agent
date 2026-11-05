#!/bin/sh
# Package postinstall (deb and rpm). Fresh install: enable and start the unit. Upgrade:
# check the kept /etc/247-agent/agent.yaml with the new build, then restart the unit if it
# runs. Either way, check that the daemon came up (share/check-service.sh) and fail the
# install with the way back when it did not. deb passes "configure <old-version>" (no old
# version on a fresh install); rpm passes 1 (install) or 2 (upgrade).
set -e
old=
case "$1" in
  configure) if [ -n "$2" ]; then upgrade=1; old=$2; else upgrade=0; fi ;;
  2) upgrade=1 ;;
  *) upgrade=0 ;;
esac
config=/etc/247-agent/agent.yaml
prefix=/opt/247-agent

# The way back after an upgrade: the previous package, whose version deb tells us.
rollback() {
  if [ -n "$old" ]; then
    echo "  rollback: apt install --allow-downgrades 247-agent=$old (or the previous .deb)" >&2
  else
    echo "  rollback: install the previous 247-agent package" >&2
  fi
  echo "  (if the new version migrated state.db, restore the state.db.schema-<n>.bak copy next to it first)" >&2
}

# The new build must accept the config the upgrade kept. If it does not, the daemon is
# not restarted; it keeps running until a connector respawn or a crash restart loads the
# new tree, so the message asks for the fix now.
if [ $upgrade = 1 ] && [ -f "$config" ]; then
  if ! "$prefix/bin/oa" validate "$config" > /dev/null; then
    echo "247-agent: the new version rejects $config (the issues are above); the service was not restarted." >&2
    echo "  fix the config, then: dpkg --configure -a (deb), or systemctl restart 247-agent && sh $prefix/share/check-service.sh" >&2
    rollback
    exit 1
  fi
fi

# Not booted with systemd (a container, a chroot): nothing to start.
[ -d /run/systemd/system ] || exit 0
systemctl daemon-reload
if [ $upgrade = 1 ]; then
  # Running, or enabled but down (crash-looping after a failed upgrade, which a retry with
  # `dpkg --configure -a` must not report as fine). Stopped and disabled stays that way.
  systemctl is-active --quiet 247-agent || systemctl is-enabled --quiet 247-agent || exit 0
  # A unit that crash-looped into its start limit refuses a restart until it is reset.
  systemctl reset-failed 247-agent 2> /dev/null || true
  if ! systemctl restart 247-agent || ! sh "$prefix/share/check-service.sh"; then
    echo "247-agent: the upgraded daemon did not come up." >&2
    rollback
    exit 1
  fi
else
  systemctl reset-failed 247-agent 2> /dev/null || true
  if ! systemctl enable --now 247-agent || ! sh "$prefix/share/check-service.sh"; then
    echo "247-agent: the daemon did not come up after the install." >&2
    exit 1
  fi
fi
