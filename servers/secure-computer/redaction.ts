import { createHmac } from "node:crypto";

type IdentifierKind = "RRN" | "PHONE" | "ADDRESS" | "ACCOUNT" | "CASE" | "EMAIL" | "PERSON";

export interface StructuredSensitiveFields {
  readonly email?: readonly string[];
  readonly personName?: readonly string[];
}

export interface RedactionMapping {
  readonly kind: IdentifierKind;
  readonly token: string;
  readonly value: string;
}

export interface RedactionResult {
  readonly text: string;
  readonly mappings: readonly RedactionMapping[];
}

interface IdentifierPattern {
  readonly kind: IdentifierKind;
  readonly pattern: RegExp;
}

const IDENTIFIER_PATTERNS: readonly IdentifierPattern[] = [
  { kind: "EMAIL", pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu },
  { kind: "CASE", pattern: /(?<!\d)(?:19|20)\d{2}[가-힣]{1,4}\d{1,10}(?!\d)/gu },
  { kind: "RRN", pattern: /(?<!\d)\d{6}-?[1-4]\d{6}(?!\d)/g },
  { kind: "PHONE", pattern: /(?<!\d)01[016789][ -]?\d{3,4}[ -]?\d{4}(?!\d)/g },
  {
    kind: "ADDRESS",
    pattern:
      /(?:서울(?:특별시)?|부산(?:광역시)?|대구(?:광역시)?|인천(?:광역시)?|광주(?:광역시)?|대전(?:광역시)?|울산(?:광역시)?|세종(?:특별자치시)?|경기(?:도)?|강원(?:특별자치도|도)?|충청[남북]도|전라[남북]도|경상[남북]도|제주(?:특별자치도|도)?)\s+[가-힣0-9·]+(?:시|군|구)\s+[가-힣0-9·.-]+(?:대로|로|길|동|읍|면)\s+\d+(?:-\d+)?/gu,
  },
  {
    kind: "ACCOUNT",
    pattern:
      /(?<!\d)(?!(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?!\d))\d{2,6}(?:-\d{2,6}){2,4}(?!\d)/g,
  },
];
const CONTEXTUAL_PERSON =
  /((?:성명|이름|신청인|송금인|sender)\s*[:=]\s*)([가-힣]{2,4})(?![가-힣])/giu;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const containsDirectIdentifier = (input: string): boolean => {
  if (CONTEXTUAL_PERSON.test(input)) {
    CONTEXTUAL_PERSON.lastIndex = 0;
    return true;
  }
  CONTEXTUAL_PERSON.lastIndex = 0;
  return IDENTIFIER_PATTERNS.some(({ pattern }) => {
    const matched = pattern.test(input);
    pattern.lastIndex = 0;
    return matched;
  });
};

const base32Prefix = (bytes: Uint8Array, count: number): string => {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < count) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (output.length === count) return output;
  }
  if (bits > 0 && output.length < count) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output.slice(0, count);
};

export class Redactor {
  readonly #tokenKey: Uint8Array;

  constructor(tokenKey: Uint8Array) {
    if (tokenKey.byteLength < 32)
      throw new RangeError("Redaction token key must be at least 32 bytes");
    this.#tokenKey = Uint8Array.from(tokenKey);
  }

  redactWithMappings(
    caseId: string,
    input: string,
    fields: StructuredSensitiveFields = {},
  ): RedactionResult {
    if (caseId.length === 0) throw new TypeError("A non-empty case id is required for redaction");
    let text = input;
    const mappings = new Map<string, RedactionMapping>();
    const replace = (kind: IdentifierKind, value: string): string => {
      const token = this.#token(caseId, kind, value);
      mappings.set(token, { kind, token, value });
      return token;
    };
    for (const [kind, values] of [
      ["EMAIL", fields.email],
      ["PERSON", fields.personName],
    ] as const) {
      for (const value of values ?? []) {
        if (value.length === 0)
          throw new TypeError(`Structured ${kind.toLowerCase()} fields must not be empty`);
        text = text.replaceAll(value, replace(kind, value));
      }
    }
    text = text.replace(
      CONTEXTUAL_PERSON,
      (_match, label: string, person: string) => `${label}${replace("PERSON", person)}`,
    );
    for (const { kind, pattern } of IDENTIFIER_PATTERNS)
      text = text.replace(pattern, (value) => replace(kind, value));
    return Object.freeze({ text, mappings: Object.freeze([...mappings.values()]) });
  }

  #token(caseId: string, kind: IdentifierKind, value: string): string {
    const digest = createHmac("sha256", this.#tokenKey)
      .update(caseId, "utf8")
      .update("\0")
      .update(kind, "utf8")
      .update("\0")
      .update(value, "utf8")
      .digest();
    return `[${kind}_${base32Prefix(digest, 16)}]`;
  }
}
