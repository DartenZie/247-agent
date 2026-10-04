# Add a bundled connector

A connector ships as its own workspace package, a launcher, a bundle entry, a fake, an
example manifest, a user page and a skill reference. `../connectors.md` has the contract.

1. **Create the package.** `connectors/<name>/package.json` named
   `@247-agent/connector-<name>`, `"type": "module"`, `"main": "dist/main.js"`,
   depending on `@247-agent/connector-sdk`; a `tsconfig.json` extending
   `../../tsconfig.base.json` with a reference to `../../packages/connector-sdk`; and
   `{ "path": "connectors/<name>" }` added to the root `tsconfig.json` references. Use
   `connectors/email` as the template. Done when `npm run build` compiles the empty
   package.
2. **Add the launcher and the bundle entry.** Copy `bin/247-agent-connector-email` to
   `bin/247-agent-connector-<name>` with the bundle and checkout paths changed, and add
   `'connector-<name>': 'connectors/<name>/src/main.ts'` to `PROGRAMS` in
   `scripts/bundle.mjs`. Done when `bin/247-agent-connector-<name> --help` or an
   equivalent start prints the connector's own error about the missing `OA_*`
   environment, and `npm run release` lists `lib/connector-<name>.mjs`.
3. **Write `src/config.ts`** as a zod schema with every key, default and condition, and a
   `parseConfig` that prefixes errors with `invalid <name> connector config:`. Done when
   a unit test rejects a missing required key with that prefix.
4. **Write `src/main.ts`** on `runConnector({version, setup?, tools})`: read config from
   `rt.env.config`, do any start-up call (a `whoami`) in `setup`, define ops with
   `defineTool`, keep cursors in `rt.core.getState`/`putState`, log to `rt.log`, throw
   for an op error, and for a push-style connector emit with `rt.core.emitEvent` using
   a `dedup_key` and, for replies to a question, the `correlation_id` the asking task
   passed. Never write to stdout. Done when the connector starts under a scratch daemon
   with an inline manifest and `oa connector list` shows it `up`.
5. **Write the fake** under `packages/core/test/fixtures/fake-<name>.ts`, serving the
   same op and event shapes from data in its manifest `config`, runnable from source.
   Done when `integration.test.ts` or a new integration test drives a task through it.
6. **Test without the network.** Unit tests next to the code inject a fake `fetch` or a
   fake protocol library and cover every op, every error text and the start-up failure.
   Done when `npm test` passes and the connector's directory has no test that opens a
   socket to the outside.
7. **Add the example manifest** `docs/examples/connectors.d/<name>.yaml`, annotated.
   Done when `node packages/cli/dist/main.js validate docs/examples/connectors.d/<name>.yaml`
   prints `ok`.
8. **Document it for users**: `docs/connectors/<name>.md` (setup walkthrough, the
   manifest, every config key, every op with input and result, the events, state keys,
   task examples, traps), a row in the table of `docs/connectors/index.md`, and a row in
   `connectors/README.md`. Development notes (source layout, how to run it by hand, the
   fake) go in `connectors/<name>/README.md`, which links to the user page. Done when
   `node scripts/check-docs.mjs docs/connectors connectors` passes.
9. **Teach the skills**: a short section in
   `skills/247-agent-connectors/references/manifest.md` with the manifest and the ops.
   Done when the skill names the new connector where it lists the bundled ones.
10. **Add a smoke module** `connectors/<name>/test/smoke/smoke.mjs` (and a
    `compose.yaml` when a server can run in a container), following
    `test/smoke/connectors/README.md`; teach `.claude/skills/verify/scripts/plan.mjs`
    the new paths. A service that cannot run in a container (GitHub, Jira) gets no
    module and says so in the connector's development notes. Done when
    `npm run smoke:connectors -- <name>` prints `RESULT: PASS`.
11. **Verify** with the `verify` skill: baseline, the daemon rung on the real connector,
    and the connectors rung; end the report with the verification block.
