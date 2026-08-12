import { describe, expect, mock, test } from "bun:test";
import { createBeforeQuitHandler } from "./lifecycle";

function deferred(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}> {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function eventFixture() {
  return { preventDefault: mock(() => undefined) };
}

describe("main-process quit lifecycle", () => {
  test("prevents quit until disposal completes and disposes exactly once", async () => {
    const disposal = deferred();
    const quitSignal = deferred();
    const dispose = mock(() => disposal.promise);
    const unregisterIpc = mock(() => undefined);
    const quit = mock(() => quitSignal.resolve());
    const reportError = mock(() => undefined);
    const beforeQuit = createBeforeQuitHandler({ dispose, unregisterIpc, quit, reportError });
    const firstEvent = eventFixture();
    const repeatedEvent = eventFixture();

    beforeQuit(firstEvent);
    beforeQuit(repeatedEvent);

    expect(firstEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(repeatedEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(unregisterIpc).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();

    disposal.resolve();
    await quitSignal.promise;

    expect(quit).toHaveBeenCalledTimes(1);
    const finalEvent = eventFixture();
    beforeQuit(finalEvent);
    expect(finalEvent.preventDefault).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("reports disposal rejection and still completes quit", async () => {
    const failure = new Error("dispose failed");
    const quitSignal = deferred();
    const dispose = mock(() => Promise.reject(failure));
    const quit = mock(() => quitSignal.resolve());
    const reportError = mock(() => undefined);
    const beforeQuit = createBeforeQuitHandler({
      dispose,
      unregisterIpc: mock(() => undefined),
      quit,
      reportError,
    });

    beforeQuit(eventFixture());
    await quitSignal.promise;

    expect(reportError).toHaveBeenCalledWith(failure);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
