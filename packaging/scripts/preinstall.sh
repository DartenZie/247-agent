#!/bin/sh
# Package preinstall (deb and rpm): the service user must exist before the package's
# /etc/247-agent files, owned by it, are unpacked.
set -e
if ! getent passwd 247-agent > /dev/null; then
  nologin=/bin/false
  for s in /usr/sbin/nologin /sbin/nologin; do
    if [ -x "$s" ]; then nologin=$s; break; fi
  done
  useradd --system --home-dir /var/lib/247-agent --no-create-home --shell "$nologin" 247-agent
fi
