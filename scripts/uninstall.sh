#!/bin/sh
# 247-agent uninstaller: the counterpart of install.sh. Stops and removes the systemd
# unit, the connector template unit and its enabled instances, the `oa` symlink, the
# install root symlink and every installed version tree. Keeps the config
# (/etc/247-agent), the state (/var/lib/247-agent), the units' drop-ins
# (/etc/systemd/system/247-agent.service.d and 247-agent-connector@<name>.service.d, where
# LoadCredential= lines live) and the 247-agent user, so a later install.sh brings the
# same daemon back; --purge removes those too. Secrets under /etc/credstore are never
# touched.
#
#   sh /opt/247-agent/share/uninstall.sh [--purge] [--yes]
#   curl -fsSL https://raw.githubusercontent.com/DartenZie/247-agent/main/scripts/uninstall.sh | sh -s -- --yes
#
# Options:
#   --purge              also remove /etc/247-agent, /var/lib/247-agent, the drop-ins and the user
#   --yes                do not ask for confirmation
#   --prefix <dir>       the install root symlink (default /opt/247-agent)   OA_PREFIX
#   --bin-dir <dir>      where the `oa` symlink is (default /usr/local/bin)  OA_BIN_DIR
#   -h, --help
set -eu

prefix=${OA_PREFIX:-/opt/247-agent}
bin_dir=${OA_BIN_DIR:-/usr/local/bin}
purge=0
yes=0
while [ $# -gt 0 ]; do
  case $1 in
    --purge) purge=1; shift ;;
    --yes|-y) yes=1; shift ;;
    --prefix) prefix=$2; shift 2 ;;
    --bin-dir) bin_dir=$2; shift 2 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "uninstall.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'uninstall.sh: %s\n' "$*" >&2; exit 1; }

unit=/etc/systemd/system/247-agent.service
dropins=$unit.d
# Connectors in their own units: the template, its enabled instances and their drop-ins.
template=/etc/systemd/system/247-agent-connector@.service
instances=$(cd /etc/systemd/system 2> /dev/null && ls -d ./*.wants/247-agent-connector@*.service 2> /dev/null | sed 's|.*/||' | sort -u)
connector_dropins=$(ls -d /etc/systemd/system/247-agent-connector@*.service.d 2> /dev/null || true)

# Root is needed when the unit exists, on --purge, or when the trees are not ours.
needs_root=$purge
[ -f "$unit" ] && needs_root=1
[ -f "$template" ] && needs_root=1
[ -w "$(dirname "$prefix")" ] || needs_root=1
[ -w "$bin_dir" ] || needs_root=1
sudo=
if [ $needs_root = 1 ] && [ "$(id -u)" -ne 0 ]; then
  if command -v sudo > /dev/null 2>&1; then sudo=sudo; else die "run as root, or install sudo"; fi
fi
root() { $sudo "$@"; }

# Everything install.sh created: the symlink, and each <prefix>-<version> tree, which we
# recognise by its launcher so an unrelated <prefix>-something is left alone.
trees=
for d in "$prefix"-*; do
  [ -d "$d" ] && [ ! -L "$d" ] && [ -x "$d/bin/247-agent-core" ] && trees="$trees $d"
done
manual=
if [ -e "$prefix" ] && [ ! -L "$prefix" ] && [ -x "$prefix/bin/247-agent-core" ]; then
  manual=$prefix
fi
say "this removes:"
[ -L "$prefix" ] && say "  $prefix (symlink)"
[ -n "$manual" ] && say "  $manual (install tree)"
for d in $trees; do say "  $d"; done
[ -L "$bin_dir/oa" ] && say "  $bin_dir/oa"
[ -f "$unit" ] && say "  $unit (stopped and disabled first)"
[ -f "$template" ] && say "  $template"
for i in $instances; do say "  $i (stopped and disabled first)"; done
if [ $purge = 1 ]; then
  for d in $connector_dropins; do say "  $d"; done
  [ -d "$dropins" ] && say "  $dropins"
  [ -d /etc/247-agent ] && say "  /etc/247-agent (config)"
  [ -d /var/lib/247-agent ] && say "  /var/lib/247-agent (state, database, agent workspaces)"
  id 247-agent > /dev/null 2>&1 && say "  the 247-agent user"
else
  say "and keeps /etc/247-agent, /var/lib/247-agent, $dropins and the user (--purge removes them)"
fi
if [ $yes = 0 ]; then
  [ -t 0 ] || [ -r /dev/tty ] || die "not interactive; pass --yes"
  printf 'continue? [y/N] '
  if [ -t 0 ]; then read -r answer; else read -r answer < /dev/tty; fi
  case $answer in y|Y|yes) ;; *) say "aborted"; exit 1 ;; esac
fi

if command -v systemctl > /dev/null 2>&1; then
  for i in $instances; do root systemctl disable --now "$i" 2> /dev/null || true; done
  [ -f "$unit" ] && { root systemctl disable --now 247-agent 2> /dev/null || true; }
fi
[ -f "$unit" ] && root rm -f "$unit"
[ -f "$template" ] && root rm -f "$template"
[ $purge = 1 ] && [ -d "$dropins" ] && root rm -rf "$dropins"
if [ $purge = 1 ]; then
  for d in $connector_dropins; do root rm -rf "$d"; done
fi
if command -v systemctl > /dev/null 2>&1; then
  root systemctl daemon-reload 2> /dev/null || true
fi

if [ -L "$bin_dir/oa" ]; then
  case $(readlink "$bin_dir/oa") in
    "$prefix"/*) root rm -f "$bin_dir/oa" ;;
    *) say "note: $bin_dir/oa points elsewhere, left alone" ;;
  esac
fi
[ -L "$prefix" ] && root rm -f "$prefix"
[ -n "$manual" ] && root rm -rf "$manual"
for d in $trees; do root rm -rf "$d"; done

if [ $purge = 1 ]; then
  root rm -rf /etc/247-agent /var/lib/247-agent
  if id 247-agent > /dev/null 2>&1; then
    root userdel 247-agent 2> /dev/null || say "note: could not remove the 247-agent user"
  fi
fi
say "247-agent removed"
