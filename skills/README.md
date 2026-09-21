# Skills

Agent skills for working with 247-agent: each directory is one skill in the
[Agent Skills](https://agentskills.io) format (`SKILL.md` with `name` and `description`
frontmatter, plus `references/`, `scripts/` and `assets/`).

| Skill | Use it to |
|---|---|
| `247-agent-tasks` | Write and review task definitions: triggers, `shell`/`connector`/`wait`/`sequence` actions, `emit` routing, `state_updates`, templates and filters |
| `247-agent-model-actions` | Design `llm`, `decide` and `agent` tasks: tiering, prompts, output schemas, decision questions and thresholds, sandboxing, budgets, `RESULT.json`, `post` gates; implement their runners |
| `247-agent-connectors` | Write manifests and connectors (TypeScript SDK or any language), fakes for tests, debug op and connector failures |
| `247-agent-operate` | Run the daemon, `oa run`/`oa emit`, inspect runs and state over the socket (`scripts/oa-api.mjs`), read logs, troubleshoot |
| `247-agent-config` | `agent.yaml`, secrets backends, `/etc/247-agent` layout, systemd unit, install and upgrade, self-configuration rules |

They live here, outside `.claude/`, because the same files are meant to ship with
production builds so that an `agent` task can configure the daemon it runs under.
`.claude/skills/` holds relative symlinks to these directories so Claude Code picks
them up in this repo.

To use them elsewhere, copy or symlink a skill directory into the agent's skills
location (`.claude/skills/<name>` for Claude Code, or the skills directory the runtime
is configured with). Each skill is self-contained; where it cites `docs/ARCHITECTURE.md`
or `docs/USER-GUIDE.md` those are the sources of truth in this repo, not required
reading at run time.

When the architecture or the CLI changes, update the affected skill in the same change.
