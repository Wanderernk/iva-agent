import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import {
  blockButtons,
  button,
  buttonRow,
  classicScreen,
  screenPayload,
} from "./telegram-buttons.ts";
import { escapeRichText } from "./menu/buttons.ts";

void test("classic: a button line becomes one keyboard row and its explanation stays in the text", () => {
  const md = [
    "# Заголовок",
    `${button("Обновить", "iva_update:go", "success")} — поставить новую версию.`,
    buttonRow([button("Да", "y"), button("Нет", "n", "danger")]),
  ].join("\n");
  const screen = classicScreen(md);
  assert.equal(screen.text.split("\n")[0], "Заголовок");
  assert.match(screen.text, /поставить новую версию\./);
  assert.deepEqual(screen.reply_markup, {
    inline_keyboard: [
      [{ text: "Обновить", callback_data: "iva_update:go", style: "success" }],
      [
        { text: "Да", callback_data: "y" },
        { text: "Нет", callback_data: "n", style: "danger" },
      ],
    ],
  });
});

void test("classic: a tag without data or label yields no keyboard, text survives", () => {
  const screen = classicScreen(
    '<tg-button type="callback_data"></tg-button>\nтекст',
  );
  assert.equal(screen.reply_markup, undefined);
  assert.match(screen.text, /текст/);
});

void test("blockButtons: «button — explanation» becomes a full-width row over a paragraph; a row of two is left alone", () => {
  const one = `${button("A", "a")} — что делает.`;
  assert.equal(
    blockButtons(one),
    `${buttonRow([button("A", "a")])}\nчто делает.`,
  );
  const two = buttonRow([button("A", "a"), button("B", "b")]);
  assert.equal(blockButtons(two), two);
});

void test("screenPayload: rich only when settings.json says so, classic otherwise", () => {
  const saved = process.env.ASSISTANT_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), "iva-buttons-"));
  try {
    process.env.ASSISTANT_DATA_DIR = dir;
    const md = `${button("A", "a")} — пояснение`;
    assert.ok("text" in screenPayload(md)); // no settings.json → classic
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ menuStyle: "rich" }),
    );
    const rich = screenPayload(md);
    assert.ok("rich_message" in rich);
    assert.equal(rich.rich_message.markdown, blockButtons(md));
  } finally {
    if (saved === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = saved;
  }
});

// Парсер classic-экрана: roundtrip кнопки и «не падает на мусоре». Seed печатает fast-check.
void test("property: button(text, data) survives the classic parse; any markdown parses without throwing", () => {
  const label = fc
    .string({ minLength: 1, maxLength: 20 })
    .filter((s) => !/[<>]/.test(s) && s.trim() !== "");
  const data = fc
    .string({ minLength: 1, maxLength: 40 })
    .filter((s) => !/["<>&]/.test(s));
  fc.assert(
    fc.property(label, data, (text, callback) => {
      const screen = classicScreen(`${button(text, callback)} — пояснение`);
      const rows = screen.reply_markup?.inline_keyboard ?? [];
      assert.equal(rows.length, 1);
      assert.equal(rows[0][0].callback_data, callback);
      assert.equal(rows[0][0].text, text.trim());
    }),
    { numRuns: 200 },
  );
  fc.assert(
    fc.property(fc.string({ maxLength: 300 }), (md) => {
      const screen = classicScreen(md);
      assert.equal(typeof screen.text, "string");
      assert.equal(typeof blockButtons(md), "string");
      assert.equal(typeof escapeRichText(md), "string");
    }),
    { numRuns: 300 },
  );
});
