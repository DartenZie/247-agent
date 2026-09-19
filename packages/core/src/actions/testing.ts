import type { TemplateScope } from '../expr/template.js';
import { nullLogger } from '../log.js';
import type { ActionContext } from './types.js';
import { withScope } from './types.js';

/** An action context for runner tests: a real scope and renderers, the rest as given. */
export function testContext(
  over: Partial<ActionContext> & { scope?: TemplateScope } = {},
): ActionContext {
  const scope: TemplateScope = over.scope ?? {};
  const base = {
    run: {
      id: 'run_test',
      task: 'test',
      attempt: 1,
      event_id: 'evt_test',
      correlation_id: 'cor_test',
    },
    event: { id: 'evt_test', type: 'test', payload: null },
    task: { name: 'test' },
    signal: new AbortController().signal,
    log: nullLogger,
    state: {},
    secrets: {},
    scope,
    render: () => null,
    renderText: () => '',
    suspend: () => Promise.reject(new Error('suspend is not available in this test context')),
    ...over,
  } as unknown as ActionContext;
  return withScope(base, {});
}
