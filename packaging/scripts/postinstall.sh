#!/bin/sh
# Package postinstall (deb and rpm). Fresh install: enable and start the unit. Upgrade:
# restart it if it runs. deb passes "configure <old-version>" (no old version on a fresh
# install); rpm passes 1 (install) or 2 (upgrade).
set -e
case "$1" in
  configure) if [ -n "$2" ]; then upgrade=1; else upgrade=0; fi ;;
  2) upgrade=1 ;;
  *) upgrade=0 ;;
esac
# Not booted with systemd (a container, a chroot): nothing to start.
[ -d /run/systemd/system ] || exit 0
systemctl daemon-reload
if [ $upgrade = 1 ]; then
  if systemctl is-active --quiet 247-agent; then
    systemctl restart 247-agent
  fi
else
  systemctl enable --now 247-agent
fi
