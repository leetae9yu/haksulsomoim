const storageKey = "haksul.agent.active-case.v1";
const databaseName = "haksul-renderer-state";
const storeName = "agent-binding";

function valid(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{1,255}$/u.test(value);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Agent binding database failed"));
  });
}

export function initialAgentCaseBinding(): string | undefined {
  try {
    const value = localStorage.getItem(storageKey);
    return valid(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function loadAgentCaseBinding(): Promise<string | undefined> {
  if (typeof indexedDB === "undefined") return initialAgentCaseBinding();
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(storeName).objectStore(storeName).get(storageKey);
      request.onsuccess = () => resolve(valid(request.result) ? request.result : undefined);
      request.onerror = () => reject(request.error ?? new Error("Agent binding read failed"));
    });
  } finally {
    database.close();
  }
}

export async function persistAgentCaseBinding(caseId: string): Promise<void> {
  if (!valid(caseId)) throw new TypeError("Invalid Agent case binding");
  localStorage.setItem(storageKey, caseId);
  if (typeof indexedDB === "undefined") return;
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(caseId, storageKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Agent binding write failed"));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Agent binding write aborted"));
    });
  } finally {
    database.close();
  }
}
