import { parseExpressionAt } from "acorn";
import type { Expression } from "acorn";
import { z } from "zod";

const ValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

type Value = z.infer<typeof ValueSchema>;

type Evaluation = () => Promise<Value>;

export type ExpressionContext = Record<string, (...args: Value[]) => Value | Promise<Value>>;

function getResolverName(node: Expression): string {
  if (node.type === "Identifier") {
    return node.name;
  }

  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property.type === "Identifier" &&
    node.object.type !== "Super"
  ) {
    return `${getResolverName(node.object)}.${node.property.name}`;
  }

  throw new SyntaxError("Unsupported expression: call a named helper directly");
}

// Compile the entire template before invoking helpers: invalid syntax has no side effects.
function compile(node: Expression, context: ExpressionContext): Evaluation {
  if (node.type === "Literal") {
    const value = ValueSchema.safeParse(node.value);

    if (value.success) {
      return async () => await Promise.resolve(value.data);
    }
  }

  if (node.type === "TemplateLiteral") {
    const evaluations = node.expressions.map((entry) => compile(entry, context));

    const parts = node.quasis.map((part) => {
      if (part.value.cooked === null) {
        throw new SyntaxError("Invalid template escape");
      }

      return part.value.cooked;
    });

    return async () => {
      const values = await Array.fromAsync(
        evaluations,
        async (evaluate, index) => `${parts[index]}${await evaluate()}`
      );

      return values.join("") + parts.at(-1);
    };
  }

  if (node.type === "CallExpression" && !node.optional && node.callee.type !== "Super") {
    const name = getResolverName(node.callee);
    const resolver = Object.hasOwn(context, name) ? context[name] : undefined;

    if (!resolver) {
      throw new SyntaxError("Template evaluation failed: unknown helper");
    }

    const arguments_ = node.arguments.map((argument) => {
      if (argument.type === "SpreadElement") {
        throw new SyntaxError("Unsupported expression: spread arguments");
      }

      return compile(argument, context);
    });

    return async () => {
      const values = await Array.fromAsync(arguments_, async (evaluate) => await evaluate());
      const result = await resolver(...values);

      return ValueSchema.parse(result);
    };
  }

  throw new SyntaxError(`Unsupported expression: ${node.type}`);
}

export async function interpolate(input: string, context: ExpressionContext): Promise<string> {
  if (!input.includes("${")) {
    return input;
  }

  const source = `\`${input}\``;
  const ast = parseExpressionAt(source, 0, { ecmaVersion: "latest" });

  if (ast.type !== "TemplateLiteral" || ast.end !== source.length) {
    throw new SyntaxError("Expected a single template literal");
  }

  return z.string().parse(await compile(ast, context)());
}
