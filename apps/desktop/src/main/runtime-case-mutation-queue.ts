export class RuntimeCaseMutationQueue {
  readonly #tails = new Map<string, Promise<void>>();

  async run<Result>(caseId: string, operation: () => Promise<Result>): Promise<Result> {
    const previous = this.#tails.get(caseId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(caseId, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(caseId) === tail) this.#tails.delete(caseId);
    }
  }
}
