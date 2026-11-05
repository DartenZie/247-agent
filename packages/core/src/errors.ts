/** The message of a thrown value: `err.message` for an `Error`, `String(err)` for anything else. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
