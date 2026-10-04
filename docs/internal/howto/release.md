# Cut a release

A release is a tag; CI builds and attaches everything (`../packaging.md`).

1. **Start from a green `main`.** The CI run of the commit you will tag passed. Done
   when `gh run list --branch main --limit 1` shows success for that commit.
2. **Bump the version** in `packages/core/src/version.ts` and the root `package.json`,
   together, to the same value. Done when `npm test` passes (`version.test.ts` compares
   them) and `node packages/cli/dist/main.js --version` prints the new value after
   `npm run build`.
3. **Check the user docs for the version** where they quote it: the install page's
   download commands name a tarball and a package file. Done when
   `grep -rn "0\.[0-9]\+\.[0-9]\+" docs --include=*.md` shows only the new version or
   placeholders.
4. **Build what CI will build**, on this machine: `npm run release` and `npm run
   package` (or `npm run test:linux -- --systemd=always`, which also installs the
   `.deb`). Done when both scripts exit 0 and `dist-release/` holds the tarball, the
   `.deb`, the `.rpm` and their `.sha256` files.
5. **Commit the bump** with the message `Release v<version>` and push it. Done when CI
   is green on that commit.
6. **Tag and push the tag**: `git tag v<version> && git push origin v<version>`. The
   release workflow refuses a tag that does not match `package.json`. Done when the
   `release` workflow finishes and the GitHub release of that tag lists, for both
   `linux-x64` and `linux-arm64`, the tarball, the `.deb`, the `.rpm`, their `.sha256`
   files, and once `install.sh` and `uninstall.sh`.
7. **Prove the artefacts.** On a Linux host or in the container
   (`scripts/linux-test.sh --systemd=always` with the released `.deb`), or with the
   installer against the release: `curl -fsSL
   https://raw.githubusercontent.com/DartenZie/247-agent/main/scripts/install.sh | sh`
   then `sudo oa run hello --wait`. Done when the run succeeds and `oa --version`
   prints the new version.
8. **Report** with the verification block the `verify` skill asks for.
