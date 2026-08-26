import ts from "typescript";

export type Classification =
  | "immutable-contract"
  | "fixture-local-input-derived"
  | "generic-threshold"
  | "derived-parsed-record"
  | "unknown";

export type Finding = Readonly<{
  file: string;
  line: number;
  expression: string;
  classification: Classification;
}>;

export type SourceAudit = Readonly<{
  literals: readonly Finding[];
  expectations: readonly Finding[];
  unknown: readonly Finding[];
}>;

const annotationPattern =
  /@qa-literal\s+(immutable-contract|fixture-local-input-derived|generic-threshold)/;
const assertionMethods = new Set(["toBe", "toEqual", "toBeGreaterThan", "toBeLessThan"]);
const numericConverters = new Set(["Number", "parseInt", "parseFloat"]);

function ancestors(node: ts.Node): readonly ts.Node[] {
  const result: ts.Node[] = [];
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent)
    result.push(current);
  return result;
}

function annotation(source: ts.SourceFile, node: ts.Node): Classification | undefined {
  for (const ancestor of ancestors(node)) {
    if (!ts.isVariableStatement(ancestor) && !ts.isPropertyAssignment(ancestor)) continue;
    const match = annotationPattern.exec(
      source.text.slice(ancestor.getFullStart(), node.getStart(source)),
    );
    if (match?.[1] !== undefined) return match[1] as Classification;
  }
  return undefined;
}

function genericLiteral(node: ts.NumericLiteral): boolean {
  if (ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node)
    return true;
  if (ts.isPrefixUnaryExpression(node.parent) || ts.isBinaryExpression(node.parent)) return true;
  return ancestors(node).some(
    (ancestor) =>
      ts.isCallExpression(ancestor) &&
      ts.isPropertyAccessExpression(ancestor.expression) &&
      (["slice", "splice", "repeat"].includes(ancestor.expression.name.text) ||
        (assertionMethods.has(ancestor.expression.name.text) && node.text === "0")),
  );
}

function declarations(source: ts.SourceFile): Readonly<{
  variables: ReadonlyMap<string, ts.Expression>;
  functions: ReadonlyMap<string, ts.Expression>;
}> {
  const variables = new Map<string, ts.Expression>();
  const functions = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    )
      variables.set(node.name.text, node.initializer);
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
      const returned = node.body.statements.find(ts.isReturnStatement)?.expression;
      if (returned !== undefined) functions.set(node.name.text, returned);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { variables, functions };
}

function combine(values: readonly Classification[]): Classification {
  if (values.includes("unknown")) return "unknown";
  if (values.includes("derived-parsed-record")) return "derived-parsed-record";
  return values[0] ?? "derived-parsed-record";
}

function numericString(expression: ts.Expression): boolean {
  const value =
    ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)
      ? expression.text
      : undefined;
  return value !== undefined && /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim());
}

function propertyInitializer(
  expression: ts.PropertyAccessExpression,
  facts: ReturnType<typeof declarations>,
): ts.Expression | undefined {
  if (!ts.isIdentifier(expression.expression)) return undefined;
  const object = facts.variables.get(expression.expression.text);
  if (object === undefined || !ts.isObjectLiteralExpression(object)) return undefined;
  return object.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && property.name.getText() === expression.name.text,
  )?.initializer;
}

function classifyExpression(
  expression: ts.Expression,
  literals: ReadonlyMap<number, Classification>,
  facts: ReturnType<typeof declarations>,
  seen = new Set<ts.Node>(),
): Classification {
  if (seen.has(expression)) return "unknown";
  seen.add(expression);
  if (ts.isNumericLiteral(expression)) return literals.get(expression.getStart()) ?? "unknown";
  if (numericString(expression)) return "unknown";
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression))
    return classifyExpression(expression.expression, literals, facts, seen);
  if (ts.isPrefixUnaryExpression(expression))
    return classifyExpression(expression.operand, literals, facts, seen);
  if (ts.isBinaryExpression(expression))
    return combine([
      classifyExpression(expression.left, literals, facts, seen),
      classifyExpression(expression.right, literals, facts, seen),
    ]);
  if (ts.isIdentifier(expression)) {
    const initializer = facts.variables.get(expression.text);
    return initializer === undefined
      ? "derived-parsed-record"
      : classifyExpression(initializer, literals, facts, seen);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const initializer = propertyInitializer(expression, facts);
    return initializer === undefined
      ? "derived-parsed-record"
      : classifyExpression(initializer, literals, facts, seen);
  }
  if (ts.isCallExpression(expression)) {
    if (
      ts.isIdentifier(expression.expression) &&
      numericConverters.has(expression.expression.text)
    ) {
      const argument = expression.arguments[0];
      return argument === undefined || numericString(argument)
        ? "unknown"
        : classifyExpression(argument, literals, facts, seen);
    }
    if (ts.isIdentifier(expression.expression)) {
      const returned = facts.functions.get(expression.expression.text);
      if (returned !== undefined) return classifyExpression(returned, literals, facts, seen);
    }
    return "derived-parsed-record";
  }
  if (ts.isObjectLiteralExpression(expression))
    return combine(
      expression.properties.flatMap((property) =>
        ts.isPropertyAssignment(property)
          ? [classifyExpression(property.initializer, literals, facts, seen)]
          : [],
      ),
    );
  return "derived-parsed-record";
}

function summaryAssertion(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const target = node.expression.expression;
  return (
    ts.isCallExpression(target) &&
    target.expression.getText() === "expect" &&
    /summary/.test(target.arguments[0]?.getText() ?? "")
  );
}

function line(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

export function auditSource(file: string, content: string): SourceAudit {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const literals = new Map<number, Classification>();
  const facts = declarations(source);
  const literalFindings: Finding[] = [];
  const expectations: Finding[] = [];
  const unknown: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNumericLiteral(node)) {
      const classification =
        annotation(source, node) ?? (genericLiteral(node) ? "generic-threshold" : "unknown");
      literals.set(node.getStart(source), classification);
      const finding = {
        file,
        line: line(source, node),
        expression: node.getText(source),
        classification,
      };
      literalFindings.push(finding);
      if (classification === "unknown") unknown.push(finding);
    }
    ts.forEachChild(node, visit);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      assertionMethods.has(node.expression.name.text) &&
      node.arguments[0] !== undefined
    ) {
      const expected = node.arguments[0];
      const classification = classifyExpression(expected, literals, facts);
      const finding = {
        file,
        line: line(source, expected),
        expression: expected.getText(source),
        classification,
      };
      expectations.push(finding);
      if (
        classification === "unknown" ||
        (summaryAssertion(node) &&
          classification === "generic-threshold" &&
          expected.getText(source) !== "0")
      )
        unknown.push(finding);
    }
  };
  visit(source);
  return { literals: literalFindings, expectations, unknown };
}
