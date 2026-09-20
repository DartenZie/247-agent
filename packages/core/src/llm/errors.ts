import { NonRetryableError } from '../actions/types.js';

/** A budget refused or failed the call; retrying would only spend more. */
export class BudgetExceededError extends NonRetryableError {
  constructor(
    readonly scope: 'task' | 'daily',
    message: string,
  ) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

/** The provider is not configured or this build has no adapter for its type. */
export class ProviderUnavailableError extends NonRetryableError {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

/** The call's cost could not be determined; the ledger row records the tokens with `usd = 0`. */
export class UnpricedModelError extends NonRetryableError {
  constructor(message: string) {
    super(message);
    this.name = 'UnpricedModelError';
  }
}
