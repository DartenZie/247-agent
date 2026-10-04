# Models and cost

This page explains the three model-backed actions, when to reach for each, and how the
daemon keeps spending predictable. Nothing here requires you to pick a vendor yet.

## Cheapest thing that works

Before a model is involved, ask in this order:

1. **Can a filter decide it?** A sender address, a label, a branch name, a keyword. A
   trigger filter costs nothing and runs before anything else.
2. **Can a command or a connector operation produce the answer?** Then it is a
   `shell` or `connector` action.
3. **Is the answer a label, a yes/no or a level, with no text to write?** Classify,
   route, triage, gate. That is a `decide` action: a classification-only model answers
   typed questions with probabilities, in under a second, for roughly a hundredth of
   the price of a chat model.
4. **Is it one judgement with a fixed output shape that needs text?** Extract fields,
   summarise, draft a reply. That is an `llm` action: one call, a JSON schema for the
   answer, no tools, no loop.
5. **Does it need to read files, run commands and iterate?** That is an `agent`
   action, with the narrowest scope that can succeed.

Two steps with different intelligence needs are the same action kind with a different
model, effort or budget, not different code. The reference workflow runs a small event
list edit on a mid-tier model with a tight budget and a site-wide change on the top
model with a larger one, from the same task shape.

## Providers and models

Models are reached through named **providers** declared once in `agent.yaml`. Each has
a type and an API key that is always a secret reference, never a literal:

```yaml
providers:
  anthropic:  { type: anthropic,  api_key: "${secrets.anthropic_api_key}" }
  openrouter: { type: openrouter, api_key: "${secrets.openrouter_api_key}" }
defaults:
  llm:    { provider: anthropic,  model: claude-haiku-4-5 }
  decide: { provider: openrouter }
budgets: { daily_usd: 10 }
```

| Provider type | Used by | Notes |
|---|---|---|
| `anthropic` | `llm` | Claude models: `claude-haiku-4-5` for classification and extraction, `claude-sonnet-5` and `claude-opus-5` for harder judgement. Prices are built in. |
| `openai` | `llm` | Current OpenAI models, prices built in; others need a `pricing:` entry. |
| `openrouter` | `llm`, `decide` | Any model OpenRouter serves; each response reports its own cost, so no price entry is needed. The only provider type that reaches the classification model behind `decide`. |

An `agent` action is different: the agent program (Claude Code, Codex) runs the model
with its own key, which lives in the program's connector manifest. The daemon records
what the agent reports.

## Budgets

Every model call passes through one place in the daemon that checks the budgets,
makes the call and writes a ledger row. There is no unbudgeted path.

- **Per run**: `budget: { max_usd: 0.05 }` on a task or an action. Before the call the
  daemon estimates the worst case from the input size and the output cap and refuses if
  it would not fit; after the call it checks the real cost. An agent session is
  cancelled the moment its reported cost passes the cap.
- **Per day**: `budgets.daily_usd` in `agent.yaml`, counted per UTC day from the
  ledger, so a restart changes nothing. Once crossed, every model call fails fast until
  midnight and one `budget.exceeded` event is published. Route that event to the task
  that notifies you.

A run that goes over its budget fails like any other failed run: `task.<name>.failed`
is published, and the event that triggered it can be replayed later with
`oa run --event`.

## The ledger

Every call is a row: task, provider, model, input and output tokens, cache reads and
writes, dollars, and how the price was determined. `oa cost` sums it:

```sh
oa cost --by task --since 7d
oa cost --by model --since 2026-09-01
```

A model with no known price is refused by `oa validate` unless its provider reports
cost itself. Prices are never guessed.

## Paying less for the same answer

- **Keep the system prompt static** and in a file (`system_file`). It is sent first
  with a cache marker, so repeated runs pay the cached rate for it. Put the changing
  data last, in `input`.
- **Use `batch: true`** on an `llm` action for anything that can wait an hour: every
  token at half price, the result arriving as an event that resumes the run.
- **Prefer `decide` for labels.** Several questions in one call cost only their own
  tokens, and the probabilities let a task act, ask for confirmation or escalate
  without a second call.
- **Measure before building a cascade.** A stronger model at low effort often beats a
  weaker one at high effort on the same task, and one model means one prompt cache.

Next: [Security](security.md). To write the actions: [`decide`](../tasks/decide.md),
[`llm`](../tasks/llm.md), [`agent`](../tasks/agent.md).
