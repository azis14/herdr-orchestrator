/** An expected, user-facing failure: the CLI prints its message and exits 1. */
export class OrchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchError";
  }
}
