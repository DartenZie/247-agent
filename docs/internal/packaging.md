# Packaging and release

How a checkout becomes a release: the launchers, the bundle, the tarball, the packages,
the installer, the version and CI. Open this when touching `bin/`, `scripts/`,
`packaging/`, `.github/` or the version.

## The install root and the launchers

`bin/` holds the same launcher scripts in a checkout and in a release:
`247-agent-core`, `oa`, `247-agent-connector-host` and one
`247-agent-connector-<name>` per bundled connector. In a checkout they run the
workspace `dist/` under the Node on `PATH`; in a release they run `lib/<program>.mjs`
under the vendored `node/bin/node`.

`packages/core/src/home.ts` resolves the install root: `OA_HOME` if set (the launchers
set it), else the nearest ancestor of the running script that contains
`bin/247-agent-core`. The daemon exports `OA_HOME` and prepends `<root>/bin` and its
own Node's directory to `PATH` for every child it spawns, which is why a manifest can
say `exec: ["247-agent-connector-email"]` or `exec: ["node", …]` and get this install's
copies. The first log line, `daemon.home`, prints both.

Invariant: manifests name bundled connectors by launcher, never by a `dist/` path. A
new bundled connector needs a launcher in `bin/` and an entry in `scripts/bundle.mjs`
(`howto/add-connector.md`).

## The bundle

`scripts/bundle.mjs` runs esbuild once per program and writes one ESM file each under
`lib/`. `better-sqlite3` stays outside the bundle for its native addon; the release
ships `node_modules/better-sqlite3` with the target's prebuilt addon only.

## The release tarball

`scripts/build-release.sh [--target linux-x64|linux-arm64|darwin-x64|darwin-arm64]
[--node <version>] [--out <dir>] [--skip-build]` stages one directory and packs it:

```
bin/            the launchers
lib/            one bundled .mjs per program
node/           a vendored Node (bin/node, npm, npx) pinned by .node-version, verified against nodejs.org's SHASUMS256.txt, cached in .cache/
node_modules/   better-sqlite3 with the target's prebuilt addon
share/doc/      README.md and the user docs (docs/ without internal/ and examples/)
share/examples/ docs/examples
share/skills/   skills/
share/systemd/  247-agent.service, 247-agent-connector@.service
share/etc/      the starter config (packaging/etc)
share/install.sh, share/uninstall.sh
LICENSE VERSION (version=, target=, node=)
```

When the target is the build machine it smoke-tests the stage: `oa --version` and
`247-agent-core --version` print the version, and `oa validate` accepts
`share/examples/agent.yaml`. The tarball and its `.sha256` land in `dist-release/`.
`npm run release` is the same script for this machine; `--target` cross-builds, which
only needs the Node download for the target.

## The packages

`scripts/build-package.sh [--target …]` turns the staged tree into a `.deb` and an
`.rpm` with nfpm (`packaging/nfpm.yaml`, nfpm downloaded on first use). The package
installs the identical tree under `/opt/247-agent`, links `/usr/bin/oa`, ships the two
units under `/usr/lib/systemd/system` and the starter `/etc/247-agent` as conffiles.
The maintainer scripts in `packaging/scripts/` create the user on install, enable and
start the service on a fresh install, restart it on upgrade, stop it on removal and
clean up on purge. The connector template unit is installed, never enabled.

## The installer

`scripts/install.sh`, shipped as `share/install.sh` and attached to every release,
installs or upgrades from the GitHub release: it picks the tarball for the machine's
architecture, verifies the checksum, unpacks to `/opt/247-agent-<version>` with
`/opt/247-agent` as a symlink, links `oa` into `/usr/local/bin`, creates the user, writes
a starter `/etc/247-agent` once, installs the units and starts the service. On an
upgrade the new version's `oa validate` must accept the existing config before the
symlink moves; the unit file is replaced, the config never touched, and the service
restarted unless `--no-restart`. Options: `--version`, `--from <tarball>`, `--prefix`,
`--bin-dir`, `--no-service`, `--no-restart`. `uninstall.sh` removes what the installer
put there and keeps config, state, drop-ins and the user unless `--purge`.

The package and the installer both own `/opt/247-agent`; the user docs say not to mix
them on one machine.

## The version

`packages/core/src/version.ts` carries `VERSION`; `version.test.ts` keeps it equal to
the root `package.json`. Bump both together. `oa --version` and `247-agent-core
--version` print it, and it is the MCP client version connectors see. Release tags are
`v<version>`; the release workflow refuses a tag that does not match.

## CI

`.github/workflows/ci.yml` on every push to `main` and every pull request: `npm ci`,
build, lint, test, `oa validate` on the examples, the docs checker, a release tarball
(`--skip-build`), the packages, and an install of the `.deb` on the runner that checks
the unit is active and `sudo oa run hello --wait` succeeds, then purges it.

`.github/workflows/release.yml` on a `v*` tag: a matrix of `linux-x64` and
`linux-arm64` runners checks the tag against `package.json`, builds, tests, builds the
tarball and the packages for the target, and attaches the tarballs, packages, their
`.sha256` files and the installer scripts to the GitHub release with generated notes.

`scripts/linux-test.sh` (`npm run test:linux`) is the local counterpart for a Mac:
lint on the host, then `npm ci`, build, test with `OA_REQUIRE_BWRAP=1` and validate in a
Debian 13 container with bubblewrap; `--systemd=always` also installs the `.deb` and
runs the starter task (`testing.md`).

## Cutting a release

`howto/release.md` is the procedure.
