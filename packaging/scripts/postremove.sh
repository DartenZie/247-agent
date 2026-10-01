#!/bin/sh
# Package postremove (deb and rpm). Removal keeps /etc/247-agent (dpkg keeps conffiles),
# /var/lib/247-agent, the drop-ins and the user; a deb "purge" removes them all. rpm has
# no purge; it passes 0 (removed) or 1 (upgraded). Secrets under /etc/credstore are
# never touched.
set -e
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload 2> /dev/null || true
fi
case "$1" in
  purge)
    rm -rf /etc/247-agent /var/lib/247-agent /etc/systemd/system/247-agent.service.d \
      /etc/systemd/system/247-agent-connector@*.service.d
    if getent passwd 247-agent > /dev/null; then
      userdel 247-agent 2> /dev/null || true
    fi ;;
esac
