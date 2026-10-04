# Writing the documentation

Read this before adding or changing anything under `docs/`, a connector `README.md`, a
skill, or `CLAUDE.md`. Two trees, two audiences, one checker.

| Tree | Reader | Shape |
|---|---|---|
| `docs/` (everything but `internal/` and `examples/`) | someone installing and running the product, semi-technical, often in a hurry | the published site: tutorials, guides, recipes, reference |
| `docs/internal/` | a contributor or an agent changing the code | reference co-located by concept, procedures with completion criteria |
| `skills/` | an agent operating a daemon, possibly the one it runs under | agent skills: steps first, reference behind pointers |
| `CLAUDE.md` | every agent turn in this repo | rules and pointers only |

One fact, one home. A behaviour is described once, in the file whose reader needs it
most; every other file links there. When the same fact would serve both trees, the user
page states the behaviour and the internal page states the implementation and the
invariant behind it.

## The user site

Every page answers, in its first lines, what the reader gets from it. A tutorial also
lists what the reader needs before starting.

- Address the reader as "you". Present tense, active voice, short sentences.
- Explain the first use of anything a semi-technical reader may not know: cron
  fields, JMESPath, a Unix socket, a systemd unit. Use the term from
  [`reference/glossary.md`](../reference/glossary.md) and keep using it.
- Commands go in `sh` blocks without a prompt prefix, so they copy cleanly. Show the
  expected output after a command when the reader needs it to know they are on track.
- Configuration goes in `yaml` blocks. A block that is a whole tasks file or manifest
  must validate; the checker runs `oa validate` on it. A fragment (an `action:` alone)
  must still parse as YAML. Never put `...` or `{ ... }` placeholders in YAML; use a
  comment (`# the rest of the task`) or real content.
- Callouts use GitHub alerts: `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`. They render on
  GitHub and in VitePress. One callout per trap, not per paragraph.
- Tables for parallel facts: fields, flags, options. Prose for reasoning.
- Links are relative paths ending in `.md`, so they work on GitHub, in the release
  tarball and in the site build. Never link to `packages/`, `connectors/<name>/src` or
  any other source path from a user page.
- Nothing about status, roadmaps or history. The site describes the product as it is.
  A feature that does not exist is not mentioned.
- Each action, connector and reference page ends with its complete field table. The
  guide pages (`tasks/`, `connectors/`) own the field tables for their subject;
  `reference/` owns only what has no other home (`agent.yaml`, the task envelope, the
  manifest envelope, the CLI, the API, events, metrics).

Page skeletons:

- Tutorial (`getting-started/`): what you will build, what you need, numbered steps
  each ending with something the reader can see, a short "where to go next".
- Guide page (`tasks/`, `connectors/`, `operations/`): what it is for, the smallest
  working example, how it behaves, the traps, the field table.
- Recipe (`recipes/`): the problem in one sentence, the complete YAML, how it works
  step by step, what to change for the reader's case.
- Reference (`reference/`): a one-line scope statement, then tables.

## The internal docs

These follow the writing-for-agents rules: context pointers with the trigger
front-loaded, reference disclosed behind pointers rather than inlined, steps with
completion criteria, positive phrasing, leading words, no sediment.

- `CLAUDE.md` is always loaded. It holds identity in three lines, the rules that
  change what an agent does, pointers of the form "touching X: read Y", and the
  baseline commands. Everything else lives behind a pointer.
- An internal file opens with one line saying what it covers and when to open it.
  Then flat sections by concept: definition, rules and caveats together under one
  heading. Cite code with a path (`packages/core/src/actions/agent-policy.ts`) rather
  than restating it; the code is the source of truth, the doc states the invariant and
  the reason.
- A procedure (`internal/howto/`) is a numbered list. Every step ends on a condition
  the agent can check, and the last step is the verification rungs from the `verify`
  skill.
- No status, no "done since", no implementation order, no roadmap. Git history has
  the sequence; `decisions.md` has the why.
- When the code and a doc disagree, fix one of them in the same change and say which.

## Skills

A skill's `description` is a pointer that is loaded on every turn: front-load the
trigger words, one trigger per distinct case, no synonyms. The body is steps first,
reference in `references/` behind a pointer. A skill repeats a rule from `CLAUDE.md`
only when the skill ships without the repo (the five `247-agent-*` skills do).

## The checker

```sh
node scripts/check-docs.mjs            # every Markdown file in the repo
node scripts/check-docs.mjs docs/tasks # one directory or file
```

It fails on a relative link that does not resolve, a `yaml` block that does not parse,
and a complete tasks file or manifest in a `yaml` block that `oa validate` rejects. A
block preceded by `<!-- check: skip -->` is left alone. CI runs it; run it before
reporting a docs change, together with the rungs the `verify` skill lists.
