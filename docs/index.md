# 247-agent

247-agent is a small, always-on automation daemon for one Linux server. You describe
what should happen and when in a YAML file; it runs around the clock, and it calls a
language model only where judgement is needed, with a budget you set.

```
connector ──event──▶ trigger ──▶ task ──result──▶ more events ──▶ more tasks
```

Everything is an **event**. A mailbox connector turns new mail into events, a cron
schedule ticks as events, a finished task publishes its result as an event. A **task**
listens for an event, does one thing, and publishes the outcome. Tasks never call each
other, which is what makes a workflow easy to extend: add a task that listens, and
nothing else changes.

## What it is good at

- **Chores on a schedule** without a model in sight: fetch mail, mirror a folder over
  SFTP, run a build, post a report to chat.
- **Reacting to the outside world**: a GitHub push, a Jira ticket, a webhook, a message
  in a Telegram or Matrix room.
- **One cheap judgement in the middle**: classify an email, extract fields, decide
  whether something is urgent, for a fraction of a cent.
- **An agent for the part that needs hands**: edit a website from an editor's email,
  in a fresh git worktree, with an allowlist of commands, a dollar cap, a build gate,
  and a human approving on chat before anything is published.

The order matters. Filtering, deduplication, routing, retries and publishing are plain
code. A model runs only inside the three actions built for it, from the cheapest tier
that does the job, and every call is recorded with its cost.

## The steps you can combine

| Action | What it does | Model? |
|---|---|---|
| `shell` | run a command | no |
| `connector` | call one operation on a connector, such as `email.send` | no |
| `wait` | pause until an event arrives, such as a human's reply | no |
| `sequence` | a few of the above in one run | no |
| `decide` | ask typed questions of a classification-only model, get probabilities back | one call, very cheap |
| `llm` | one model call with a JSON answer: classify, extract, summarise | one call |
| `agent` | an agent session in a sandboxed workspace, with tool and command allowlists | a budgeted loop |

## Where to start

1. [Install](getting-started/install.md) the package, the installer script, or build
   from source.
2. [Your first task](getting-started/first-task.md): a shell command on a schedule, an
   event, and the commands that show you what happened. Fifteen minutes.
3. [Your first workflow](getting-started/first-workflow.md): a mailbox, one model
   call, and a reply. Connectors, secrets and a budget.

Then:

- [How it works](concepts/how-it-works.md), [Models and cost](concepts/models-and-cost.md)
  and [Security](concepts/security.md) give you the mental model.
- [Tasks](tasks/index.md) explains triggers, every action, routing and templates.
- [Connectors](connectors/index.md) covers email, files, chat, webhooks, GitHub, Jira,
  agent programs, and writing your own.
- [Recipes](recipes/index.md) are complete workflows to copy.
- [Operations](operations/index.md) is production: the systemd unit,
  credentials, upgrades, monitoring and troubleshooting.
- [Reference](reference/index.md) has the exhaustive tables: the CLI, `agent.yaml`,
  the task and manifest envelopes, the HTTP API, events and metrics.

## In one picture

A website maintained from a trusted editor's emails, the reference workflow that ships
with the daemon:

1. Every two minutes, fetch new mail. No model.
2. Mail from the editor's address gets one short classification call: an events-list
   update, a general change, or ignore.
3. An events-list update runs a small, tightly scoped agent.
4. A general change runs a larger agent, then asks you on chat before pushing.
5. A successful update is mirrored over SFTP. No model.
6. Every failure, and every publish, is reported on chat.

The whole thing is one tasks file: [Website from email](recipes/website-from-email.md).
