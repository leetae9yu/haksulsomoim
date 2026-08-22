import type {
  RedactionMapping,
  RedactionResult,
  Redactor,
  StructuredSensitiveFields,
} from "./redaction";

export class SecureComputerRedactionSession {
  readonly #caseId: string;
  readonly #redactor: Redactor;
  readonly #valuesByToken = new Map<string, string>();
  #disposed = false;

  constructor(caseId: string, redactor: Redactor) {
    if (caseId.length === 0) throw new TypeError("A non-empty case id is required");
    this.#caseId = caseId;
    this.#redactor = redactor;
  }

  redact(input: string, fields: StructuredSensitiveFields = {}): RedactionResult {
    this.#assertActive();
    const result = this.#redactor.redactWithMappings(this.#caseId, input, fields);
    for (const mapping of result.mappings) this.#remember(mapping);
    return result;
  }

  rehydrate(token: string): string {
    this.#assertActive();
    const value = this.#valuesByToken.get(token);
    if (value === undefined) throw new Error("Unknown redaction token");
    return value;
  }

  dispose(): void {
    this.#disposed = true;
    this.#valuesByToken.clear();
  }

  #remember(mapping: RedactionMapping): void {
    const existing = this.#valuesByToken.get(mapping.token);
    if (existing !== undefined && existing !== mapping.value)
      throw new Error("Redaction token collision");
    this.#valuesByToken.set(mapping.token, mapping.value);
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("Redaction session is disposed");
  }
}
