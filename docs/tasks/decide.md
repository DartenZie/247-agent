# `decide`

Ask typed questions about some content and get probabilities back, with no text
generated. TypeSafe's Jev is a classification-only model that answers in well under a
second for about a hundredth of the price of a chat model call. Use it wherever a step
needs a label, a yes or no, or a level: triage, routing, gating.

## The smallest example

```yaml
tasks:
  - name: triage_email
    trigger: { kind: event, type: email.received }
    action:
      kind: decide
      provider: openrouter
      budget: { max_usd: 0.001 }
      state:
        subject: ${event.payload.subject}
        body: ${event.payload.body}
      questions:
        kind:
          type: choice
          instructions: What does the sender want done with the website?
          criteria:
            event_list_update: Add, remove or change an entry in the events list
            general_change: Any other change to pages, text, images or navigation
            ignore: Not a change request (a question, a thank-you, spam)
        urgent:
          type: noul
          instructions: Does the sender need this done today?
    emit:
      - type: email.classified
        when: "result.kind.choice != 'ignore' && result.kind.confidence > `0.5`"
        payload:
          kind: ${result.kind.choice}
          urgent: ${result.urgent.noul}
          email: ${event.payload}
```

`state` is what is judged; `questions` are what to decide about it. The result is one
answer per question id, so `emit` routes on `result.kind.choice` and forwards
`result.urgent.noul`, the probability that the answer is yes.

## Three kinds of question

| `type` | Asks for | `criteria` | The answer |
|---|---|---|---|
| `noul` | yes or no | optional: `{ "true": "…", "false": "…" }`, both sides or neither | `{ type: noul, noul }` where `noul` is the probability of yes, 0 to 1; 0.5 means "cannot tell" |
| `choice` | one label | a map of label to description, 2 to 255 labels | `{ type: choice, choice, confidence, probabilities }`; `choice` is the most likely label, `probabilities` sum to 1 |
| `score` | a level | an ordered list of level descriptions, lowest first, 2 to 10 levels | `{ type: score, score, confidence, probabilities }`; `score` is the probability-weighted mean of the level indexes, so `1.05` means "level 1, a little of level 2" |

A complete result for the example above, with a third `score` question added:

```json
{
  "kind":   { "type": "choice", "choice": "general_change", "confidence": 0.8,
              "probabilities": { "general_change": 0.9, "event_list_update": 0.06, "ignore": 0.04 } },
  "urgent": { "type": "noul", "noul": 0.97 },
  "anger":  { "type": "score", "score": 1.05, "confidence": 0.92,
              "probabilities": { "1": 0.95, "2": 0.05 } }
}
```

## Rules that matter in practice

- **Always give a `choice` a fallback label** such as `ignore`, `other` or `unknown`.
  Without one, off-topic input gets a confident wrong answer.
- **Criteria are policy.** The model follows the wording literally; most misses trace
  back to a criterion that said something other than what the author meant. Keep them
  in git and version them like code.
- **Keep the order of labels stable.** Reordering shifts the confidence on ambiguous
  input. Do not shuffle.
- **Thresholds are your decision, not the model's.** `result.kind.confidence > \`0.7\``
  in `emit … when`, or `payload.urgent > \`0.8\`` in a downstream filter. Pick the
  value from labelled examples, not from the ones here. As a rough guide: above 0.9
  act, between 0.5 and 0.9 confirm, below 0.5 escalate.
- **Ask several questions in one call.** Each extra question costs only its own tokens
  and answers the same as it would alone. One `state`, one request, one ledger row.
- **State is data.** Inbound content goes in `state` under a key that names it; the
  questions describe what to decide. `${…}` is refused inside a question for this
  reason. Keep the questions in English even for content in another language.
- **Size.** The whole request must fit in 32k tokens; over that the provider answers
  with an error that is not retried. Trim long bodies in the template.

## Provider and price

Jev is served only by OpenRouter's Decisions API, so `provider` must name a provider of
type `openrouter`, either on the action or as `defaults.decide.provider` in
`agent.yaml`. `oa validate` refuses any other type. The model defaults to
`typesafe/jev-1.13`; `~typesafe/jev-latest` follows the newest version. No `pricing:`
entry is needed: the daemon knows Jev's price, $0.042 per million input tokens and
nothing for output, and uses the cost the provider reports when it is present.

Budgets and the ledger work exactly as for [`llm`](llm.md): the worst case is checked
before the call, the real cost after, the daily cap on top, and `oa cost` shows every
call.

## What fails, and whether it is retried

| Outcome | Run |
|---|---|
| the provider is not an `openrouter` one | refused by `oa validate`; at run time the run fails without retry |
| a rate limit or a server error | the attempt fails and is retried |
| the request was rejected: no key, no credits, over 32k tokens | fails without retry |
| an answer is missing, of the wrong type, a label outside the criteria or a score out of range | the attempt fails and is retried; the provider answered badly |
| the cost overran the run's budget, or the daily cap is reached | fails without retry |

[`decide-triage.yaml`](../examples/decide-triage.yaml) is a complete example, and
[Triage with decide](../recipes/triage-with-decide.md) walks through it.

## Fields

| Field | Required | Default | Meaning |
|---|---|---|---|
| `provider` | no | `defaults.decide.provider` | a provider of type `openrouter` |
| `model` | no | `defaults.decide.model` (`typesafe/jev-1.13`) | the model id |
| `state` | yes | | what is judged: a string, an object or a list; strings are templated, keys are not; must not render empty |
| `questions` | yes, at least one | | a map of question id (`[a-z][a-z0-9_]*`) to question; no `${…}` inside |
| `questions.<id>.type` | yes | | `noul`, `choice` or `score` |
| `questions.<id>.instructions` | yes | | the question, in English |
| `questions.<id>.criteria` | `choice` and `score`: yes; `noul`: no | | labels with descriptions, ordered levels, or the two sides of a yes/no |
| `budget.max_usd` | no | | the cap for one run; the smaller of this and the task's applies |
