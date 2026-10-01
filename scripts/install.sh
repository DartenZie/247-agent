#!/bin/sh
# 247-agent installer and upgrader. Installs a release tarball as /opt/247-agent, links
# `oa` into /usr/local/bin and, on Linux, sets up the 247-agent user, /etc/247-agent
# and the systemd unit. Running it again upgrades in place (or re-installs the same
# version). One line, as root or a sudoer:
#
#   curl -fsSL https://raw.githubusercontent.com/DartenZie/247-agent/main/scripts/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/DartenZie/247-agent/main/scripts/install.sh | sh -s -- --version 0.2.0
#
# Options (each also as an environment variable):
#   --version <v>        release to install (default: the latest GitHub release)       OA_VERSION
#   --from <file|url>    install this tarball instead of a release download (local     OA_FROM
#                        builds from `npm run release`); a .sha256 next to it is checked
#   --repo <owner/name>  GitHub repository (default DartenZie/247-agent)               OA_REPO
#   --prefix <dir>       the install root, a symlink (default /opt/247-agent); each     OA_PREFIX
#                        version lives in <prefix>-<version>, so rollback is `ln -sfn`
#   --bin-dir <dir>      where the `oa` symlink goes (default /usr/local/bin)           OA_BIN_DIR
#   --no-service         only the tree and the symlinks: no user, no /etc, no unit
#   --no-restart         do not restart a running daemon after an upgrade
#   -h, --help
#
# Layout after `install.sh` (USER-GUIDE §9):
#   /opt/247-agent -> /opt/247-agent-<version>   bin/ lib/ node/ node_modules/ share/
#   /usr/local/bin/oa -> /opt/247-agent/bin/oa
#   /etc/247-agent/{agent.yaml,tasks.d,connectors.d}   created once, never overwritten
#   /etc/systemd/system/247-agent.service              replaced on upgrade; local
#                                                       changes go in `systemctl edit`
#   /etc/systemd/system/247-agent-connector@.service   the same; one instance per connector
#                                                       with `managed_by: systemd`, enabled by hand
#   /var/lib/247-agent, /run/247-agent                 by systemd (StateDirectory, RuntimeDirectory)
set -eu

version=${OA_VERSION:-}
from=${OA_FROM:-}
repo=${OA_REPO:-DartenZie/247-agent}
prefix=${OA_PREFIX:-/opt/247-agent}
bin_dir=${OA_BIN_DIR:-/usr/local/bin}
service=1
restart=1
while [ $# -gt 0 ]; do
  case $1 in
    --version) version=$2; shift 2 ;;
    --from) from=$2; shift 2 ;;
    --repo) repo=$2; shift 2 ;;
    --prefix) prefix=$2; shift 2 ;;
    --bin-dir) bin_dir=$2; shift 2 ;;
    --no-service) service=0; shift ;;
    --no-restart) restart=0; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done
version=${version#v}

say() { printf '%s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" > /dev/null 2>&1 || die "$1 is required"; }

# --- platform ------------------------------------------------------------------------
case $(uname -s) in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "unsupported OS: $(uname -s)" ;;
esac
case $(uname -m) in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac
target=$os-$arch
if [ "$os" != linux ] && [ $service = 1 ]; then
  say "note: no systemd on $os, installing the tree and the symlinks only (--no-service)"
  service=0
fi

# --- privileges ----------------------------------------------------------------------
# Root is needed for the service, or when the prefix or the bin dir is not ours to write
# (a user-local install, `--prefix ~/.local/opt/247-agent --bin-dir ~/.local/bin
# --no-service`, needs no sudo). Writes then go through sudo when not root already.
writable() { # the nearest existing ancestor of $1 is writable
  d=$1
  while [ ! -e "$d" ]; do d=$(dirname "$d"); done
  [ -w "$d" ]
}
needs_root=$service
writable "$(dirname "$prefix")" || needs_root=1
writable "$bin_dir" || needs_root=1
sudo=
if [ $needs_root = 1 ] && [ "$(id -u)" -ne 0 ]; then
  if command -v sudo > /dev/null 2>&1; then sudo=sudo; else die "run as root, or install sudo"; fi
fi
root() { $sudo "$@"; }

sha256() {
  if command -v sha256sum > /dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

need tar
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

# --- get the tarball -----------------------------------------------------------------
if [ -n "$from" ]; then
  case $from in
    http://*|https://*)
      need curl
      say "downloading $from"
      curl -fsSL -o "$tmp/release.tar.gz" "$from"
      curl -fsSL -o "$tmp/release.tar.gz.sha256" "$from.sha256" 2> /dev/null || true ;;
    *)
      [ -f "$from" ] || die "no such file: $from"
      cp "$from" "$tmp/release.tar.gz"
      [ -f "$from.sha256" ] && cp "$from.sha256" "$tmp/release.tar.gz.sha256" ;;
  esac
else
  need curl
  if [ -z "$version" ]; then
    # The latest release: tag_name from the API, else the redirect of /releases/latest.
    version=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" 2> /dev/null \
      | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)
    if [ -z "$version" ]; then
      version=$(curl -fsSI "https://github.com/$repo/releases/latest" | tr -d '\r' \
        | sed -n 's|^[Ll]ocation: .*/tag/v\{0,1\}||p' | head -n 1)
    fi
    [ -n "$version" ] || die "cannot determine the latest release of $repo; pass --version"
  fi
  asset=247-agent-$version-$target.tar.gz
  url=https://github.com/$repo/releases/download/v$version/$asset
  say "downloading $url"
  curl -fsSL -o "$tmp/release.tar.gz" "$url" || die "no release $version for $target at $url"
  curl -fsSL -o "$tmp/release.tar.gz.sha256" "$url.sha256" || die "missing checksum $url.sha256"
fi
if [ -f "$tmp/release.tar.gz.sha256" ]; then
  expected=$(cut -d' ' -f1 "$tmp/release.tar.gz.sha256")
  actual=$(sha256 "$tmp/release.tar.gz")
  [ "$expected" = "$actual" ] || die "checksum mismatch: expected $expected, got $actual"
  say "checksum ok"
else
  say "note: no .sha256 file, tarball not verified"
fi

# --- unpack and read what it is ------------------------------------------------------
mkdir "$tmp/unpack"
tar -xzf "$tmp/release.tar.gz" -C "$tmp/unpack"
tree_src=$(find "$tmp/unpack" -mindepth 1 -maxdepth 1 -type d | head -n 1)
[ -n "$tree_src" ] && [ -f "$tree_src/VERSION" ] && [ -x "$tree_src/bin/247-agent-core" ] \
  || die "not a 247-agent release tarball"
tb_version=$(sed -n 's/^version=//p' "$tree_src/VERSION")
tb_target=$(sed -n 's/^target=//p' "$tree_src/VERSION")
[ "$tb_target" = "$target" ] || die "tarball is for $tb_target, this machine is $target"
if [ -n "$version" ] && [ "$version" != "$tb_version" ]; then
  die "asked for $version, tarball is $tb_version"
fi
version=$tb_version
tree=$prefix-$version

# What is installed now, if anything.
# `previous` is the tree the rollback hint names.
current=
previous=
manual=0
if [ -L "$prefix" ]; then
  current=$(sed -n 's/^version=//p' "$prefix/VERSION" 2> /dev/null || true)
  previous=$(readlink "$prefix")
elif [ -e "$prefix" ]; then
  # A tree copied by hand (USER-GUIDE §2.1) sits where the symlink goes; it is moved
  # aside once the new version has accepted the config.
  current=$(sed -n 's/^version=//p' "$prefix/VERSION" 2> /dev/null || true)
  [ -n "$current" ] || die "$prefix exists and is not a 247-agent install; move it away"
  manual=1
fi

# --- stage the new version's tree ----------------------------------------------------
say "installing 247-agent $version for $target into $tree"
root rm -rf "$tree.new"
root mkdir -p "$(dirname "$tree")"
root cp -R "$tree_src" "$tree.new"
[ $needs_root = 1 ] && root chown -R 0:0 "$tree.new"

# --- the config must satisfy the new version before anything changes -----------------
config=/etc/247-agent/agent.yaml
# /etc/247-agent is 750 and owned by the service user, so a sudoer cannot see into it:
# look through root.
has_config=0
[ $service = 1 ] && root test -f "$config" && has_config=1
if [ $has_config = 1 ]; then
  if ! root "$tree.new/bin/oa" validate "$config"; then
    root rm -rf "$tree.new"
    die "247-agent $version rejects $config; nothing was changed (the old version stays)"
  fi
fi

# --- move a manual install aside ----------------------------------------------------
if [ $manual = 1 ]; then
  aside=$prefix-$current
  [ -e "$aside" ] && aside=$prefix-$current.$(date +%Y%m%d%H%M%S)
  say "moving the manual install at $prefix to $aside"
  root mv "$prefix" "$aside"
  previous=$aside
fi

# --- put the tree in place (replacing the same version, if it is there) --------------
if [ -e "$tree" ]; then
  root rm -rf "$tree.old"
  root mv "$tree" "$tree.old"
fi
root mv "$tree.new" "$tree"
root rm -rf "$tree.old"

# --- switch --------------------------------------------------------------------------
root ln -sfn "$tree" "$prefix"
root mkdir -p "$bin_dir"
root ln -sfn "$prefix/bin/oa" "$bin_dir/oa"

# --- service -------------------------------------------------------------------------
if [ $service = 1 ]; then
  user=247-agent
  if ! id "$user" > /dev/null 2>&1; then
    nologin=/bin/false
    for s in /usr/sbin/nologin /sbin/nologin; do
      if [ -x "$s" ]; then nologin=$s; break; fi
    done
    root useradd --system --home-dir /var/lib/247-agent --no-create-home --shell "$nologin" "$user"
    say "created user $user"
  fi
  root install -d -m 750 -o "$user" -g "$user" /etc/247-agent /etc/247-agent/tasks.d /etc/247-agent/connectors.d
  if [ $has_config = 0 ]; then
    # The starter config from the tree (packaging/etc in the repository, shared with the
    # .deb/.rpm): the production defaults and a manual `hello` task.
    root install -m 640 -o "$user" -g "$user" "$tree/share/etc/agent.yaml" "$config"
    root install -m 640 -o "$user" -g "$user" "$tree/share/etc/tasks.d/hello.yaml" /etc/247-agent/tasks.d/hello.yaml
    say "wrote $config and /etc/247-agent/tasks.d/hello.yaml"
  fi

  unit=/etc/systemd/system/247-agent.service
  if command -v systemctl > /dev/null 2>&1; then
    fresh=1
    [ -f "$unit" ] && fresh=0
    # The unit names /opt/247-agent; point it at this prefix.
    sed "s|/opt/247-agent/|$prefix/|g" "$tree/share/systemd/247-agent.service" > "$tmp/247-agent.service"
    root install -m 644 "$tmp/247-agent.service" "$unit"
    # The template for connectors with `managed_by: systemd`; nothing is enabled here,
    # `systemctl enable --now 247-agent-connector@<name>` is the admin's call.
    sed "s|/opt/247-agent/|$prefix/|g" "$tree/share/systemd/247-agent-connector@.service" > "$tmp/247-agent-connector@.service"
    root install -m 644 "$tmp/247-agent-connector@.service" "/etc/systemd/system/247-agent-connector@.service"
    root systemctl daemon-reload
    if [ $fresh = 1 ]; then
      root systemctl enable --now 247-agent
      say "enabled and started 247-agent"
    elif root systemctl is-active --quiet 247-agent; then
      if [ $restart = 1 ]; then
        root systemctl restart 247-agent
        say "restarted 247-agent"
      else
        say "247-agent is still running $current; restart it when no agent run is in flight:"
        say "  systemctl restart 247-agent"
      fi
    fi
  else
    say "note: no systemctl here; the unit is in $tree/share/systemd/247-agent.service"
  fi
fi

# --- report --------------------------------------------------------------------------
say ""
if [ -n "$current" ] && [ "$current" != "$version" ]; then
  say "upgraded 247-agent $current -> $version ($prefix -> $tree)"
  say "rollback: ln -sfn $previous $prefix && systemctl restart 247-agent"
  say "remove old versions with: rm -rf $prefix-<version>"
else
  say "installed 247-agent $version ($prefix -> $tree)"
fi
say "oa: $bin_dir/oa ($("$tree/bin/oa" --version))"
if [ $service = 1 ]; then
  say "config: /etc/247-agent    logs: journalctl -u 247-agent -o cat -f | jq"
  say "try:    sudo oa run hello --wait"
  say "uninstall: sh $prefix/share/uninstall.sh"
fi
