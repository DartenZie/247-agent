# Triage emails with a classification-only model

Every incoming email should get a label, an urgency and a mood, in one call that costs a
few hundredths of a cent, so that routing can act on probabilities instead of guesses.

## What you need

- An `openrouter` provider in `agent.yaml`. The classification model behind `decide`,
  TypeSafe's Jev, is served only through OpenRouter's Decisions API:

  ```yaml
  providers:
    openrouter: { type: openrouter, api_key: "${secrets.openrouter_api_key}" }
  defaults:
    decide: { provider: openrouter }      # the model defaults to typesafe/jev-1.13
  budgets: { daily_usd: 5 }
  ```

- Events to judge. Here `email.received`, as the [poll recipe](poll-and-fan-out.md)
  produces them.

## The tasks

This is `docs/examples/decide-triage.yaml`, which ships with the daemon:

```yaml
tasks:
  # 1. Three judgements in one call. Instructions and criteria are policy: the model
  #    follows them literally, so version them like code and give every choice a fallback.
  - name: triage_email
    trigger: { kind: event, type: email.received }
    action:
      kind: decide
      provider: openrouter            # must be an openrouter provider; default: defaults.decide.provider
      model: typesafe/jev-1.13        # default: defaults.decide.model
      budget: { max_usd: 0.001 }      # per run; the smaller of this and the task's budget applies
      state:                          # what the model judges; strings are templated, keys are not
        from: ${event.payload.from}
        subject: ${event.payload.subject}
        body: ${event.payload.body}
      questions:
        kind:
          type: choice
          instructions: What does the sender want done with the website?
          criteria:
            event_list_update: Add, remove or change an entry in the events list
            general_change: Any other change to pages, text, images or navigation
            ignore: Not a change request (a question, a thank-you, spam, a newsletter)
        urgent:
          type: noul
          instructions: Does the sender need this done today?
          criteria:
            "true": Names today, a deadline within 24 hours, or says urgent/ASAP
            "false": No deadline, or one further away
        anger:
          type: score
          instructions: How upset is the sender?
          criteria: [Calm or neutral, Annoyed, Furious]
    emit:
      - type: email.classified
        when: "result.kind.choice != 'ignore' && result.kind.confidence > `0.5`"
        payload:
          kind: ${result.kind.choice}
          confidence: ${result.kind.confidence}
          urgent: ${result.urgent.noul}
          anger: ${result.anger.score}
          email: ${event.payload}

  # 2. A threshold is a task decision, not the model's: calibrate it on real mail.
  - name: flag_urgent
    trigger:
      kind: event
      type: email.classified
      filter: "payload.urgent > `0.8`"
    action:
      kind: shell
      cmd: ["logger", "-t", "247-agent", "urgent ${event.payload.kind} request: ${event.payload.email.subject}"]
```

## How it works

1. `state` is what is judged. Its strings are templates, so the email's fields are
   filled in; the keys are not, so they stay as labels the model reads. The `questions`
   are static policy and may not contain `${…}`, which keeps the email's text out of the
   instructions.
2. One request carries all three questions. Each extra question costs only its own
   tokens, and the answers come back together:

   ```json
   {
     "kind":   { "type": "choice", "choice": "general_change", "confidence": 0.8,
                 "probabilities": { "general_change": 0.9, "event_list_update": 0.06, "ignore": 0.04 } },
     "urgent": { "type": "noul", "noul": 0.97 },
     "anger":  { "type": "score", "score": 1.05, "confidence": 0.92,
                 "probabilities": { "1": 0.95, "2": 0.05 } }
   }
   ```

   A `choice` answers with the winning label and its confidence. A `noul` answers with
   the probability of "yes", so `0.97` means almost certainly urgent and `0.5` means it
   cannot tell. A `score` is the probability-weighted mean of the level indexes, so
   `1.05` is "Annoyed, with a hint of Furious", not a level name.
3. The `emit` rule routes on the answer: nothing is published for `ignore`, nor for a
   label the model is not at least half sure about. The payload forwards the numbers.
4. The second task filters on a probability. `payload.urgent > \`0.8\`` is a plain
   JMESPath comparison; the backticks mark a number.
5. The ledger records the call like any other. `oa cost --by model` shows it under
   `typesafe/jev-1.13`; the input costs $0.042 per million tokens and the output nothing.

## Picking thresholds

The model is calibrated, so its probabilities mean what they say, but where you cut is
your decision. Run the task over a few dozen real emails with `oa run triage_email
--event mail.json --wait` and read the answers before you pin a number. Rough bands that
work in practice: above 0.9 act, between 0.5 and 0.9 ask for confirmation, below 0.5
escalate to a human. Sweep the value on labelled mail, not on the examples here.

## Make it yours

- **Your own taxonomy.** Change the labels and their criteria. Keep a fallback label
  (`ignore`, `other`, `unknown`) in every `choice`: without one, an email about
  something else gets a confident wrong label.
- **More questions.** Add a `choice` for the department, a `noul` for "contains an
  attachment we must process". One call, one ledger row.
- **A different source.** Chat messages, webhook bodies and ticket text work the same;
  put the text under a named key in `state`.
- **Act on the score.** Route `payload.anger > \`1.5\`` to a human first.

> [!WARNING]
> Keep the option order stable. Reordering the labels of an ambiguous question moves the
> probabilities; the choice usually holds, the confidence does not. Treat criteria as
> code: version them, change them deliberately.

> [!NOTE]
> The whole request must fit in 32k tokens. Trim long bodies in the template
> (`${event.payload.body}` is fine for mail; for a huge ticket, pass a summary). A
> request over the limit fails without retry.

> [!TIP]
> Write the questions in English even for mail in another language. Agreement with the
> criteria drops when the questions are translated; the content can be in any language.

Related: [`decide`](../tasks/decide.md), [Models and cost](../concepts/models-and-cost.md).
