#!/bin/sh
# Package preremove (deb and rpm): stop and disable the unit on removal, not on upgrade.
# deb passes "remove" or "upgrade"; rpm passes 0 (last instance removed) or 1 (upgrade).
set -e
case "$1" in
  remove|0)
    if [ -d /run/systemd/system ]; then
      systemctl disable --now 247-agent 2> /dev/null || true
    fi ;;
esac
