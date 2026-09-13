import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { withProviderSafeSchemas } from "./tool-schema.ts";

const toolsList = (schema: unknown) => ({
  jsonrpc: "2.0",
  id: 1,
  result: { tools: [{ name: "create_event", inputSchema: schema }] },
});

void test("a tools/list reply loses every pattern with lookaround, at any depth, and nothing else", () => {
  const lines: string[] = [];
  const reply = withProviderSafeSchemas(
    toolsList({
      type: "object",
      properties: {
        attendees: {
          type: "array",
          items: {
            type: "string",
            pattern: "^(?=.*@).+$",
            description: "email",
          },
        },
        title: { type: "string", pattern: "^[^\\n]+$" },
      },
    }),
    (line) => lines.push(line),
  );
  const schema = reply.result.tools[0].inputSchema as {
    properties: {
      attendees: { items: Record<string, unknown> };
      title: Record<string, unknown>;
    };
  };
  assert.deepEqual(schema.properties.attendees.items, {
    type: "string",
    description: "email",
  });
  assert.equal(schema.properties.title.pattern, "^[^\\n]+$");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /create_event: dropped 1/u);
});

void test("anything that is not a tools/list result comes back untouched, the same object", () => {
  const call = {
    jsonrpc: "2.0",
    id: 2,
    result: { content: [{ pattern: "(?=x)" }] },
  };
  assert.equal(withProviderSafeSchemas(call), call);
  assert.equal(call.result.content[0].pattern, "(?=x)");
  const request = { jsonrpc: "2.0", id: 3, method: "tools/list" };
  assert.equal(withProviderSafeSchemas(request), request);
});

// Свойство, которого не было: после прокси в схемах инструментов нет ни одного
// lookaround-паттерна, а всё остальное в сообщении сохранилось. Seed печатает fast-check.
void test("property: no lookaround pattern survives, everything else is kept, garbage never throws", () => {
  const json = fc.jsonValue({ maxDepth: 4 });
  const pattern = fc.oneof(
    fc.constant("^(?=.*@).+$"),
    fc.constant("(?!x)y"),
    fc.constant("(?<=a)b"),
    fc.constant("(?<!a)b"),
    fc.constant("^[a-z]+$"),
    fc.string({ maxLength: 12 }),
  );
  const schema = fc.letrec((tie) => ({
    node: fc.record(
      {
        type: fc.constantFrom("string", "object", "array"),
        pattern,
        description: fc.string({ maxLength: 8 }),
        items: tie("node"),
        properties: fc.dictionary(fc.string({ maxLength: 5 }), tie("node"), {
          maxKeys: 3,
        }),
      },
      { requiredKeys: [] },
    ),
  })).node;
  const hasLookaround = (node: unknown): boolean =>
    JSON.stringify(node, (key, value: unknown) =>
      key === "pattern" &&
      typeof value === "string" &&
      /\(\?<?[=!]/u.test(value)
        ? "LOOKAROUND_LEFT"
        : value,
    ).includes("LOOKAROUND_LEFT");
  fc.assert(
    fc.property(schema, (input) => {
      const before = JSON.parse(JSON.stringify(toolsList(input))) as ReturnType<
        typeof toolsList
      >;
      const after = withProviderSafeSchemas(toolsList(input));
      assert.equal(hasLookaround(after), false);
      // Всё, кроме вырезанных pattern, на месте: сравниваем «до» с уже вычищенными pattern.
      const expected = JSON.parse(
        JSON.stringify(before, (key, value: unknown) =>
          key === "pattern" &&
          typeof value === "string" &&
          /\(\?<?[=!]/u.test(value)
            ? undefined
            : value,
        ),
      ) as unknown;
      // Генератор даёт объекты без прототипа; сравниваем как JSON, а не по прототипу.
      assert.deepEqual(JSON.parse(JSON.stringify(after)), expected);
    }),
    { numRuns: 300 },
  );
  fc.assert(
    fc.property(json, (garbage) => {
      withProviderSafeSchemas(garbage);
    }),
    { numRuns: 300 },
  );
});
