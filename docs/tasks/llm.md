# `llm`

One model call with a JSON answer. No tools, no loop. Use it to classify, extract
fields, summarise or draft text when a [`decide`](decide.md) question is not enough and
an [`agent`](agent.md) is too much.

## The smallest example

```yaml
tasks:
  - name: classify_email
    trigger:
      kind: event
      type: email.received
      filter: "payload.from == 'editor@example.com'"
    action:
      kind: llm
      model: claude-haiku-4-5
      max_tokens: 512
      system_file: prompts/classify_email.md
      input: |
        Subject: ${event.payload.subject}

        <email>
        ${event.payload.body}
        </email>
      output_schema:
        type: object
        additionalProperties: false
        required: [kind, summary]
        properties:
          kind: { enum: [event_list_update, general_change, ignore] }
          summary: { type: string }
      budget: { max_usd: 0.05 }
    emit:
      - type: email.classified
        when: "result.kind != 'ignore'"
        payload: { kind: "${result.kind}", summary: "${result.summary}", email: "${event.payload}" }
```

The result is the parsed answer, so `${result.kind}` routes it. Without
`output_schema` the result is `{ text }`.

## Providers and models

A model is reached through a named provider from `agent.yaml`. The action's `provider`
and `model` default to `defaults.llm`:

```yaml
# agent.yaml
providers:
  anthropic:  { type: anthropic,  api_key: "${secrets.anthropic_api_key}" }
  openai:     { type: openai,     api_key: "${secrets.openai_api_key}" }
  openrouter: { type: openrouter, api_key: "${secrets.openrouter_api_key}", headers: { X-Title: 247-agent } }
defaults:
  llm: { provider: anthropic, model: claude-haiku-4-5, max_tokens: 1024 }
budgets: { daily_usd: 10 }
```

| Provider type | Models | Notes |
|---|---|---|
| `anthropic` | `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-5` | Prices built in. `effort` and adaptive thinking apply on Sonnet 5 and Opus 5 only; Haiku 4.5 ignores `effort`. The only type that supports `batch: true`. |
| `openai` | the current GPT-5 and GPT-6 models | Prices built in for the current ids; any other needs a `pricing:` entry. `effort` applies on reasoning models. |
| `openrouter` | anything OpenRouter serves, by its id | Each response reports its own cost, so no `pricing:` entry is needed. |

Start with Haiku. Before building a cascade of models, measure a stronger model at
`effort: low` on the same inputs: on the current generation it often wins, and one
model means one prompt cache.

`oa validate agent.yaml` refuses an `llm` task whose provider does not exist, whose
model has no price on an `anthropic` or `openai` provider, or whose `system_file` is
missing.

## The prompt

- **`system_file`** is a file under the configuration directory, relative to
  `agent.yaml`. It is static, sent first, and cached across runs. Put the task, the
  meaning of each output field, the rule that content inside the delimiters is data,
  and the default when unsure (`ignore`, `unknown`) in it. `system:` inline does the
  same; use one or the other. Neither may contain `${…}`.
- **`input`** is the templated part, sent last. Give the model only what the decision
  needs.
- **Inbound content is untrusted.** Wrap an email, a chat message or a ticket in a
  delimited block (`<email>…</email>`) and say in the system prompt that it is data,
  not instructions.

## The answer schema

`output_schema` is a JSON Schema with `type: object`. The model's answer is validated
against it and returned as the result. Make routing easy: enums for anything you route
on, a `summary` when a human will read the event, a `confidence` when a threshold in
`emit … when` is useful, and an escape hatch such as `ignore` so off-topic input has
somewhere to go.

> [!WARNING]
> OpenAI and OpenRouter accept a schema only in strict mode: every property must be
> listed in `required` and every object must set `additionalProperties: false`. A
> schema that breaks these rules fails the call with the vendor's error, without retry.
> Anthropic has no such rule, so a schema meant to run on any provider follows it.

## Budgets and the ledger

Every call passes through one place in the daemon that checks budgets and records the
cost. Before the call, the worst case is estimated from the prompt length and
`max_tokens` at the model's price; if it would not fit in the run's `budget.max_usd`,
the call is refused. After the call, the real cost must fit too, or the run fails
with the ledger row kept. The run's budget is the smaller of the task's and the
action's `budget`, and it covers every attempt of the run together.

The global `budgets.daily_usd` applies on top. Once the day's spend crosses it, every
model call fails fast until 00:00 UTC and one `budget.exceeded` event is published.
[Models and cost](../concepts/models-and-cost.md) has the full picture;
`oa cost --by task` shows the ledger.

## What fails, and whether it is retried

| Outcome | Run |
|---|---|
| the answer was cut off at `max_tokens` | fails without retry; raise `max_tokens` or shorten the task |
| the model refused the request | fails without retry |
| the provider rejected the request: bad key, bad schema, unknown model (HTTP 400, 401, 403, 404, 422) | fails without retry |
| a rate limit, a server error or a connection error | the attempt fails and is retried under the task's `retry` policy |
| the answer was not valid JSON for the schema | the attempt fails and is retried |
| the cost overran the run's budget, or the daily cap is reached | fails without retry |

## `batch: true`: half price for anything that can wait

```yaml
action:
  kind: llm
  provider: anthropic
  model: claude-sonnet-5
  system_file: prompts/summarise.md
  input: ${event.payload.text}
  batch: true
```

With `batch: true` the call goes through Anthropic's Message Batches API at half the
price of every token. The run submits the request and sits in `waiting`, holding no
worker; most batches end within minutes to an hour, all within 24 hours. The daemon
checks every `batches.poll` (default one minute) and, once the batch has ended,
records the cost and publishes an `llm.batch.ended` event. That event resumes the run,
which finishes exactly as a synchronous call would: the same result, the same `emit`
routing. The task's `timeout` does not count the waiting.

Only `anthropic` providers have a batch API; `oa validate` refuses the flag elsewhere.
A batch that errored, expired or was cancelled fails the attempt and `retry` submits a
new one; a run whose batch has not ended after 25 hours fails for good. While a batch
is in flight, its worst-case cost is reserved against the daily cap.

`llm.batch.ended` is an ordinary event other tasks may listen on. Its payload carries
`batch_id`, `run_id`, `task`, `provider`, `model` and `status` (`succeeded`, `errored`,
`expired` or `canceled`), plus the `output` or `text`, `usage` and `usd` when it
succeeded, or `error` and `retryable` when it did not.

> [!TIP]
> Do not batch a call a human is waiting on, or one that sits in front of an approval
> gate you want to reach quickly. Nightly digests, bulk extraction and summaries nobody
> reads at once are what the half price is for.

## Fields

| Field | Required | Default | Meaning |
|---|---|---|---|
| `provider` | no | `defaults.llm.provider` | a name from `providers:` in `agent.yaml` |
| `model` | no | `defaults.llm.model` | the model id, as the provider knows it |
| `effort` | no | `defaults.llm.effort` | `low`, `medium` or `high`; applied on models that take it |
| `max_tokens` | no | `defaults.llm.max_tokens` (1024) | the output cap, up to 128000 |
| `system` | one of the two, or neither | | the system prompt, inline; no `${…}` |
| `system_file` | one of the two, or neither | | the system prompt in a file under the configuration directory; no `${…}` |
| `input` | yes | | the user message; templated |
| `output_schema` | no | | a JSON Schema with `type: object`; without it the result is `{ text }` |
| `budget.max_usd` | no | | the cap for one run; the smaller of this and the task's applies |
| `batch` | no | `false` | `true` sends the call through Message Batches; `anthropic` providers only |
