export interface BeforeQuitEvent {
  preventDefault(): void;
}

export interface QuitLifecycleDependencies {
  dispose(): Promise<void>;
  unregisterIpc(): void;
  quit(): void;
  reportError(error: unknown): void;
}

export function createBeforeQuitHandler(
  dependencies: QuitLifecycleDependencies,
): (event: BeforeQuitEvent) => void {
  let state: "idle" | "disposing" | "disposed" = "idle";

  return (event) => {
    if (state === "disposed") return;
    event.preventDefault();
    if (state === "disposing") return;

    state = "disposing";
    dependencies.unregisterIpc();
    const completeQuit = () => {
      state = "disposed";
      dependencies.quit();
    };
    try {
      void dependencies
        .dispose()
        .catch((error: unknown) => dependencies.reportError(error))
        .finally(completeQuit);
    } catch (error) {
      dependencies.reportError(error);
      completeQuit();
    }
  };
}
