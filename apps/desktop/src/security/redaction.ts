import { createHmac } from "node:crypto";

const redactedTextBrand: unique symbol = Symbol("RedactedText");

export type RedactedText = string & {
  readonly [redactedTextBrand]: true;
};

export interface RedactedDiagnostic {
  readonly scope: string;
  readonly fields: Readonly<Record<string, RedactedText>>;
}

type IdentifierKind = "RRN" | "PHONE" | "ADDRESS" | "ACCOUNT" | "CASE" | "EMAIL" | "PERSON";

export interface StructuredSensitiveFields {
  readonly email?: readonly string[];
  readonly personName?: readonly string[];
}

interface IdentifierPattern {
  readonly kind: IdentifierKind;
  readonly pattern: RegExp;
}

const IDENTIFIER_PATTERNS: readonly IdentifierPattern[] = [
  {
    kind: "CASE",
    pattern: /(?<!\d)(?:19|20)\d{2}[가-힣]{1,4}\d{1,10}(?!\d)/gu,
  },
  {
    kind: "RRN",
    pattern: /(?<!\d)\d{6}-?[1-4]\d{6}(?!\d)/g,
  },
  {
    kind: "PHONE",
    pattern: /(?<!\d)01[016789][ -]?\d{3,4}[ -]?\d{4}(?!\d)/g,
  },
  {
    kind: "ADDRESS",
    pattern:
      /(?:서울(?:특별시)?|부산(?:광역시)?|대구(?:광역시)?|인천(?:광역시)?|광주(?:광역시)?|대전(?:광역시)?|울산(?:광역시)?|세종(?:특별자치시)?|경기(?:도)?|강원(?:특별자치도|도)?|충청[남북]도|전라[남북]도|경상[남북]도|제주(?:특별자치도|도)?)\s+[가-힣0-9·]+(?:시|군|구)\s+[가-힣0-9·.-]+(?:대로|로|길|동|읍|면)\s+\d+(?:-\d+)?/gu,
  },
  {
    kind: "ACCOUNT",
    pattern: /(?<!\d)\d{2,6}(?:-\d{2,6}){2,4}(?!\d)/g,
  },
];

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Prefix(bytes: Uint8Array, characterCount: number): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < characterCount) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (output.length === characterCount) {
      return output;
    }
  }

  if (bits > 0 && output.length < characterCount) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output.slice(0, characterCount);
}

export class Redactor {
  readonly #tokenKey: Uint8Array;

  constructor(tokenKey: Uint8Array) {
    if (tokenKey.byteLength < 32) {
      throw new RangeError("The redaction token key must contain at least 32 bytes");
    }
    this.#tokenKey = Uint8Array.from(tokenKey);
  }

  redact(caseId: string, input: string): RedactedText {
    return this.redactStructured(caseId, input, {});
  }

  redactStructured(caseId: string, input: string, fields: StructuredSensitiveFields): RedactedText {
    if (caseId.length === 0) {
      throw new TypeError("A non-empty case id is required for redaction");
    }

    let output = input;
    const structuredValues = [
      ...this.#structuredValues("EMAIL", fields.email),
      ...this.#structuredValues("PERSON", fields.personName),
    ] as const;
    for (const { kind, value } of structuredValues) {
      output = output.replaceAll(value, this.#token(caseId, kind, value));
    }
    for (const { kind, pattern } of IDENTIFIER_PATTERNS) {
      output = output.replace(pattern, (identifier) => this.#token(caseId, kind, identifier));
    }
    return output as RedactedText;
  }

  #structuredValues(
    kind: "EMAIL" | "PERSON",
    values: readonly string[] | undefined,
  ): ReadonlyArray<Readonly<{ kind: "EMAIL" | "PERSON"; value: string }>> {
    return (values ?? []).map((value) => {
      if (value.length === 0) {
        throw new TypeError(`Structured ${kind.toLowerCase()} fields must not be empty`);
      }
      return { kind, value };
    });
  }

  #token(caseId: string, kind: IdentifierKind, identifier: string): string {
    const digest = createHmac("sha256", this.#tokenKey)
      .update(caseId, "utf8")
      .update("\0")
      .update(kind, "utf8")
      .update("\0")
      .update(identifier, "utf8")
      .digest();
    return `[${kind}_${base32Prefix(digest, 16)}]`;
  }
}

export function sanitizeSecret(text: string, secret: string | undefined): string {
  const values = [...new Set([secret, secret?.trim()])]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .sort((left, right) => right.length - left.length);
  return values.reduce((sanitized, value) => sanitized.replaceAll(value, "[REDACTED]"), text);
}

export function createRedactedDiagnostic(
  scope: string,
  fields: Readonly<Record<string, RedactedText>>,
): RedactedDiagnostic {
  return Object.freeze({
    scope,
    fields: Object.freeze({ ...fields }),
  });
}
