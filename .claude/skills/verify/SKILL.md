---
name: verify
description: "Prove a change to the 247-agent repo works before reporting it done, without handing checks to the user. Picks the verification rungs a change needs from its diff (scripts/plan.mjs), then runs them: build/lint/test/validate, a real daemon, Linux with bubblewrap and systemd in a container (npm run test:linux), the connector smoke rig against real mail and FTP servers in podman (npm run smoke:connectors), the ACP smoke rig against real agents (npm run smoke:acp), or CI via gh. Use it whenever you finish a code, config, packaging or docs change in this repo, before writing \"done\", \"not verified\", \"untested\", \"please check\", \"you can confirm\", or \"worth trying on the server\"; when the user asks to verify, test, prove or smoke-test something; and when a check is skipped on macOS (bwrap, systemd, Linux-only tests)."
---

# Verify a change

The user is not a test runner. Before you report a change, run every rung it needs and
report what each one showed. There is a rung for nearly everything that used to be handed
back: real bubblewrap and systemd (a Linux container), real IMAP/POP3/SMTP/SFTP/FTP/FTPS
servers (podman), real ACP agents (Claude, Codex, OpenCode), CI. Asking the user to look
at something a rung can observe is a failure of this skill.

## 1. Plan

```
node .claude/skills/verify/scripts/plan.mjs             # this branch vs origin/main, plus uncommitted work
node .claude/skills/verify/scripts/plan.mjs --base HEAD  # only uncommitted work
node .claude/skills/verify/scripts/plan.mjs <files…>     # explicit paths
```

It prints the rungs the touched files need and the gaps no rung covers. It is a floor:
add a rung when you know the change reaches further (a shared helper, a dependency bump).
Never drop a rung it lists without saying why in the report.

## 2. Run the rungs, cheapest first, one at a time

Stop at the first failing rung, fix, and rerun from the baseline. Run the container rungs
one after another, never in parallel: the podman machine is small (about 4 GiB of memory
and 17 GB of disk), and the user's own containers run on it too.

| rung | command | needs | time | proves |
|---|---|---|---|---|
| baseline | `npm run build && npm run lint && npm test && node packages/cli/dist/main.js validate docs/examples/*.yaml docs/examples/connectors.d/*.yaml` | nothing | 1–2 min | types, style, unit and integration tests on fakes, example configs |
| daemon | a scratch daemon, `oa run`/`oa emit`, then `oa runs show`, `oa runs logs` and the log (`247-agent-operate` skill) | build | 1 min | the change on the real binary: wiring, API, CLI output, reload |
| linux | `npm run test:linux` | podman or docker | 1 min cached, 5 min after a Dockerfile or Node change | lint, then the suite on Debian 13 with real bwrap: the bwrap tests run (`OA_REQUIRE_BWRAP=1` fails them if they can't) |
| linux-systemd | `npm run test:linux -- --systemd=always` | podman or docker | 2 min | also the release tree, `.deb` install, unit active, `oa run hello --wait`, purge |
| connectors | `npm run smoke:connectors -- <names>` | podman with compose | 1.5 min, longer on the first run (image pulls) | every op of email and ftp against real servers, TLS/STARTTLS refusals, a password scan of the whole database |
| acp | `npm run smoke:acp -- opencode-acp`, then `-- claude-acp` | build; claude-acp: the Claude login | 1–3 min each | done/blocked/mcp_servers/model+effort on a real agent, what the agent committed, a canary-secret scan of the whole database, `oa cost` |
| ci | push the branch and watch the run (`247-agent-operate` skill, "Linux") | `gh` auth, the user's go-ahead to push | 5–10 min | the workflow itself, or Linux when no container engine works |

Notes per rung:

- **baseline** is always required. For a docs-only change, also check that every command,
  flag, path and exit code the doc states matches the code, running the command when it
  is cheap: prettier skips Markdown and `docs/`, so lint proves nothing there.
- **daemon**: use a config in the scratchpad, never `local/` (the user's real rigs and
  secrets live there). The hello-world example (`docs/examples/hello-world/`) needs no
  secrets. Show the run record, not just the exit code.
- **linux** copies the working tree, so uncommitted changes are tested. On Apple Silicon
  it tests linux-arm64; CI tests linux-x64.
- **acp**: run `opencode-acp` first; it uses free models and needs no login, but it is
  flaky (see the exit codes). `claude-acp` is the agent production uses. It runs on the
  user's Claude subscription, so it costs nothing extra; run it whenever the plan lists
  it. Run `codex-acp` only when the plan lists it and `~/.codex/auth.json` exists. Caps:
  $0.50 per run and $3 per day of notional ledger cost, counted across the day's smoke
  runs in `test/smoke/acp/.state/`.
- **ci** publishes the branch, so push only when the user has allowed it for this
  branch. Without an open PR, `gh pr create --draft` starts CI.

### Reading the result

Every rung script ends with one line: `RESULT: PASS …`, `RESULT: FAIL …` or
`RESULT: ERROR …`. Quote it in the report. The exit codes are shared:

| exit | meaning | what you do |
|---|---|---|
| 0 | every check passed | record the RESULT line |
| 1 | a check failed | it is your bug until proven otherwise: read the FAIL lines and the logs, fix, rerun |
| 2 | the rig could not start: usage, missing build, no login, a server that never came up, another run holds the lock | fix the environment (section 3) and rerun |
| 3 | `test:linux`: the environment (no engine, the image or container could not be set up, a step OOM-killed). `smoke:acp`: every failure was the provider being unavailable, even after a retry | section 3; for acp, rerun later or test another agent |
| 130 | interrupted | everything it started was stopped |

A check that throws is a FAIL (exit 1), not a 2. Rerun a failed rung only when the failure
is outside the code, such as an image pull that timed out. Never rerun to turn a check that
failed on your change green. The ACP rig already retries provider outages once.

Where to look on failure:

| rung | logs |
|---|---|
| linux | the output above the RESULT line; rerun with `--keep`, then `podman exec -it <name> bash` |
| connectors | `test/smoke/connectors/.state/daemon.log`; rerun with `--keep` to inspect the servers |
| acp | `test/smoke/acp/.state/daemon.log`, `.state/<agent>/` (the generated config), `oa runs logs <id>` (the transcript) |

## 3. Fix the environment, don't hand it over

| symptom | fix |
|---|---|
| podman cannot connect, or linux exit 3 "no container engine" | `podman machine start`, then rerun |
| linux exit 3 "did not build", `no space left on device` | `podman machine ssh df -h /` and `podman system df`. Remove only images this repo made (`247-agent-linux-test:*`, `oa-smoke/*`, and dangling images whose `podman history` shows the linux-test Dockerfile). Anything else on the machine belongs to the user: ask before removing it |
| a step killed (exit 137, OOM) | run the rungs one at a time; if it persists, tell the user that the podman machine needs more memory |
| compose provider missing | `podman compose version`; installing `podman-compose` needs the user's go-ahead, otherwise use the ci rung |
| `dist/` missing or stale (exit 2) | `npm run build` |
| claude-acp exit 2 "no working login" | the user has to run `claude /login`, the one step here that needs them. Run `opencode-acp` meanwhile |
| "another … run holds the lock" | another checkout is running the rig. Wait for it, or stop the holder if its pid is one of your own stuck runs |
| a warning that Node is not the `.node-version` major | the result still counts; say in the report which Node ran it |
| a permission prompt or denial on a rung's command | say which command and rung was blocked, and ask the user to allow it. Never route around it |

A run killed outright (SIGKILL, a tool timeout) leaves its daemon running. The next run
of the same rig stops it on its own (`.state/daemon.pid`), and the connector rig also
recreates its servers.

## 4. Report

End the report with a verification block, one line per rung the plan listed:

```
Verification
- baseline: passed (build, lint, 757 tests, validate)
- linux: RESULT: PASS (--systemd=never), 757 tests, none skipped
- acp: opencode-acp RESULT: PASS 26/26; claude-acp RESULT: PASS 26/26
- not verified live: llm adapter against the real Anthropic API (no live-key rig)
```

Rules:

- Name the command and quote the RESULT line. A rung you did not run is listed with the
  reason (blocked by a permission, needs the user's login, no rig exists), never left out.
- "Not verified" is allowed only for the gaps `plan.mjs` prints, or for a rung that could
  not run for a reason you state. It never replaces running a rung that exists.
- Never ask the user to watch Telegram, a mailbox, a log or the server for something a
  rung or a command's output shows. The evidence is a chat `send` result with a
  `message_id`, an `oa runs show` record, or a log line.

## What still needs the user

- Interactive logins: `claude /login` (also on the server) and the Codex/ChatGPT login.
- Live provider keys for `llm` and `decide`. There is no live-key rig, so changes there
  are reported as "not verified live" after the unit tests pass.
- Anything on the production server (agent-01) beyond the commands the `orchestra-server`
  skill allows, and any deploy the user did not ask for.
- Pushing a branch for the ci rung.
- Granting permissions. Never edit permission settings to unblock a rung.

## Adding a rung

When you find yourself writing "not verified" about something a script could check,
propose the rig to the user. A new connector rig is
`connectors/<name>/test/smoke/{compose.yaml,smoke.mjs}` (see
`test/smoke/connectors/README.md`). A new ACP agent is `test/smoke/acp/agents/<name>.yaml`.
A new rig follows the exit contract and the RESULT line in `test/smoke/lib.mjs`. Then
teach `scripts/plan.mjs` the paths it covers.
