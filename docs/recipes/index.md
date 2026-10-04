# Recipes

Complete workflows to copy. Each page states the problem, gives you the whole YAML, walks
through how it works, and says what to change for your case. Every tasks file here passes
`oa validate` as written.

| Recipe | What it does | Model? |
|---|---|---|
| [Poll and fan out](poll-and-fan-out.md) | a cron task fetches what is new, keeps its cursor, and publishes one event per item | no |
| [Ask a human before acting](approval-gate.md) | ask on chat, wait for the reply to this question, act on the answer | no |
| [Notify on failure](notify-on-failure.md) | one task hears every failure and the daily budget alarm and tells you | no |
| [Deploy on push](deploy-on-push.md) | a verified GitHub webhook on the main branch runs your deploy script | no |
| [Triage with `decide`](triage-with-decide.md) | three typed questions in one cheap call, routed on the probabilities | one call |
| [Batch classification](batch-classification.md) | half-price model calls for work that can wait an hour | one batched call |
| [Website from email](website-from-email.md) | the reference workflow: mail in, an agent edits the site, a human approves, SFTP out | two agents |

Start with the first three: together they are the skeleton of almost every workflow.
