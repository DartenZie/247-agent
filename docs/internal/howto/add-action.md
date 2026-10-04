# Add an action kind

An action kind is one runner file that exports its zod schema and its `run` function;
the config schema, the executor, the docs and the tasks skill learn about it.
`../actions.md` has the contracts a runner keeps.

1. **Define the schema in the runner file.** `packages/core/src/actions/<kind>.ts`
   exports `<Kind>Action = z.strictObject({ kind: z.literal('<kind>'), … })` with every
   field, default and refinement, and a `run<Kind>(action, ctx)` of type `ActionRunner`.
   Templates are checked by the task-level `checkTemplates` in `config/schema.ts`; a
   field that must stay static (a prompt file, a policy) refuses `${` in its own
   refinement. Done when `npm run build` passes with the new file.
2. **Register the kind.** Add the schema to the `Action` discriminated union in
   `config/schema.ts` and the runner to `defaultRunners` in `core.ts`. If the kind can be
   a `sequence` step, add it to the step union in `actions/sequence.ts` too; `llm`,
   `decide` and `agent` deliberately are not. Done when `oa validate` accepts a tasks
   file with the new kind and rejects an unknown field in it.
3. **Reach the world only through `ActionContext`** (`actions/types.ts`): `ctx.render`
   and `ctx.renderText` for templates, `ctx.connectors` for ops, `ctx.llm` for every
   model call (never an SDK; every call is priced, budgeted and ledgered by the port),
   `ctx.agents` for sessions, `ctx.suspend` to park the run, `ctx.signal` to stop what
   you started, `ctx.log` which already carries `run_id`, `task` and `correlation_id`.
   The runner never touches the store or the bus. Done when the file imports nothing
   from `store/`, `bus/`, `@anthropic-ai/sdk`, `openai` or `@agentclientprotocol/sdk`.
4. **Decide what is retryable.** Throw `NonRetryableError` (or a subclass) for a
   configuration or policy failure the next attempt cannot fix; throw a plain `Error`
   for a transient one. The executor retries by that flag. Done when the runner's test
   asserts `retryable` on each failure path.
5. **Record what is worth graphing** on the `Metrics` registry
   (`howto/add-metric.md`), and log one structured line per outcome with a
   `<kind>.<what>` name. Done when `oa metrics` shows the counter after one run.
6. **Test it** next to the code with `fakeLlmPort`, the connector fakes or a fake
   process, never the network. Add a case to `integration.test.ts` when the kind changes
   the run lifecycle (a wait, a resume). Done when `npm test` passes.
7. **Document it**: `docs/tasks/<kind>.md` (when to use it, the smallest example, how it
   behaves, the traps, the field table last), a row in the action tables of
   `docs/index.md`, `docs/reference/task.md` and `README.md`, the contract in
   `docs/internal/actions.md` (or `model-actions.md` for a model-backed kind), and the
   `247-agent-tasks` skill (`SKILL.md` and `references/task-reference.md`; a model-backed
   kind also goes in `247-agent-model-actions`). `docs/examples/` gains an example if the
   kind is meant to be common. Done when `node scripts/check-docs.mjs` passes.
8. **Verify** with the `verify` skill: baseline, the daemon rung running the new kind by
   hand, and the linux rung if the kind spawns processes or uses the sandbox.
