/**
 * fonts.js 单测：简单字体（WinAnsi / Differences / ToUnicode）与 Type0。
 *
 * 断言的"为什么"：中文课件最常见两种字体——(a) CJK TrueType 简单字体 + WinAnsi
 * + /ToUnicode；(b) Type0/Identity-H + /ToUnicode。两者都不能整页丢字；没有
 * ToUnicode 时必须给 U+FFFD + warning 而不是抛异常，否则命令层会看到崩溃。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFont } from "../../src/pdf/fonts.js";
import {
  bytes,
  cmapBytes,
  dict,
  makeDoc,
  makeSimpleFont,
  makeType0Font,
  name,
  ref,
  stream,
} from "./fixtures.mjs";

const latin = (text) => bytes(text);

test("简单字体 WinAnsi：解码 + 宽度按 /Widths", () => {
  const font = makeSimpleFont();
  const doc = makeDoc([]);
  const f = loadFont(doc, font);
  assert.equal(f.isComposite, false);
  assert.equal(f.decode(latin("Hello")), "Hello");
  const shown = f.show(latin("Hello"));
  assert.equal(shown.codes, 5);
  assert.equal(shown.width, 2500); // 5 × 500/1000 em
  assert.equal(shown.spaces, 0);
  assert.equal(f.widthOf(0x41), 500);
  assert.match(f.name, /TestFont/);
});

test("简单字体：/FirstChar + /Widths + /MissingWidth", () => {
  const font = makeSimpleFont({
    firstChar: 65,
    widths: [600, 700],
    descriptor: dict({ MissingWidth: 250 }),
  });
  const f = loadFont(makeDoc([]), font);
  assert.equal(f.widthOf(65), 600);
  assert.equal(f.widthOf(66), 700);
  assert.equal(f.widthOf(67), 250); // 超出 /Widths → MissingWidth
  assert.equal(f.widthOf(200), 250);
});

test("简单字体：/Differences 字形名 → Unicode（含中文 uniXXXX）", () => {
  const font = makeSimpleFont({
    baseFont: "SimSun",
    encoding: dict({
      BaseEncoding: name("WinAnsiEncoding"),
      Differences: [65, name("uni4E2D"), name("uni6587"), name("uni5B57"), name("uni7B26")],
    }),
  });
  const f = loadFont(makeDoc([]), font);
  assert.equal(f.decode(latin("ABCD")), "中文字符");
  // 未被 Differences 覆盖的码仍走 BaseEncoding
  assert.equal(f.decode(latin("ABCxyz")), "中文字xyz");
});

test("简单字体：Differences 里出现无法映射的字形名 → U+FFFD 且计数", () => {
  const font = makeSimpleFont({
    baseFont: "Mystery",
    encoding: dict({ BaseEncoding: name("WinAnsiEncoding"), Differences: [65, name("g123")] }),
  });
  const f = loadFont(makeDoc([]), font);
  assert.equal(f.decode(latin("A")), "\uFFFD");
  assert.equal(f.missing, 1);
  assert.ok(f.warnings.some((w) => /Differences/.test(w)));
});

test("简单字体：ToUnicode 优先于 /Encoding", () => {
  const toUni = stream(
    {},
    cmapBytes(`
      begincmap
      1 begincodespacerange
      <00> <FF>
      endcodespacerange
      2 beginbfchar
      <41> <4E2D>
      <42> <6587>
      endbfchar
      endcmap
    `),
  );
  const font = makeSimpleFont({ toUnicode: toUni });
  const f = loadFont(makeDoc([]), font);
  assert.equal(f.decode(latin("AB")), "中文");
  // ToUnicode 没有覆盖的码仍回退到 WinAnsi（否则英文正文会缺字）
  assert.equal(f.decode(latin("ABcd")), "中文cd");
});

test("简单字体：ToUnicode 用 bfrange（PDF 生成器常见写法）", () => {
  const toUni = stream(
    {},
    cmapBytes(`
      begincmap
      1 begincodespacerange
      <00> <FF>
      endcodespacerange
      1 beginbfrange
      <41> <43> <0041>
      endbfrange
      endcmap
    `),
  );
  const f = loadFont(makeDoc([]), makeSimpleFont({ toUnicode: toUni }));
  assert.equal(f.decode(latin("ABC")), "ABC");
});

test("简单字体：没有 /Encoding 时按 WinAnsi 近似（不抛）", () => {
  const font = makeSimpleFont({ encoding: null, baseFont: "BuiltinOnly" });
  const f = loadFont(makeDoc([]), font);
  assert.equal(f.decode(latin("Hi")), "Hi");
  assert.ok(f.warnings.length > 0);
});

test("Type0/Identity-H + ToUnicode：2 字节码 → 中文，宽度来自 /W 与 /DW", () => {
  const toUni = stream(
    {},
    cmapBytes(`
      begincmap
      1 begincodespacerange
      <0000> <FFFF>
      endcodespacerange
      2 beginbfchar
      <0001> <4E2D>
      <0002> <6587>
      endbfchar
      endcmap
    `),
  );
  const font = makeType0Font({
    baseFont: "SimSun",
    toUnicode: toUni,
    dw: 1000,
    w: [1, [500, 600], 3, 5, 800],
  });
  const f = loadFont(makeDoc([]), font);
  assert.equal(f.isComposite, true);
  const shown = f.show(new Uint8Array([0x00, 0x01, 0x00, 0x02]));
  assert.equal(shown.text, "中文");
  assert.equal(shown.codes, 2);
  assert.equal(shown.spaces, 0); // 2 字节码没有 Tw
  assert.equal(shown.width, 1100);
  assert.equal(f.widthOf(1), 500);
  assert.equal(f.widthOf(2), 600);
  assert.equal(f.widthOf(4), 800); // 3..5 区间
  assert.equal(f.widthOf(10), 1000); // 落在 /DW
  assert.equal(f.missing, 0);
});

test("Type0 无 ToUnicode：U+FFFD + 明确 warning（绝不抛）", () => {
  const font = makeType0Font({ baseFont: "NoUniCJK" });
  const f = loadFont(makeDoc([]), font);
  assert.equal(f.decode(new Uint8Array([0x00, 0x01, 0x00, 0x02])), "\uFFFD\uFFFD");
  assert.equal(f.missing, 2);
  assert.ok(f.warnings.some((w) => /ToUnicode/.test(w) && /U\+FFFD/.test(w)));
  // CIDToGIDMap 是字形索引，不能当 Unicode；warning 需要点出这一点
  const withGid = makeType0Font({ cidToGid: name("Identity") });
  const f2 = loadFont(makeDoc([]), withGid);
  assert.ok(f2.warnings.some((w) => /CIDToGIDMap/.test(w)));
});

test("字体对象按字体 ref 缓存（一页多字体不重复解析 CMap）", () => {
  const fontDict = makeSimpleFont({ baseFont: "Cached" });
  const doc = makeDoc([], { objects: new Map([[7, fontDict]]) });
  const first = loadFont(doc, ref(7));
  const second = loadFont(doc, ref(7));
  assert.equal(first, second);
  assert.equal(doc._fontCache.size, 1);
});

test("字体字典缺失/非法：降级 Latin-1 直读，不抛", () => {
  const doc = makeDoc([]);
  const f = loadFont(doc, ref(999));
  assert.equal(f.isComposite, false);
  assert.equal(f.decode(latin("Hi")), "Hi");
  assert.ok(f.warnings.length > 0);
  // null / 非法值也不能抛
  assert.doesNotThrow(() => loadFont(doc, null));
  assert.doesNotThrow(() => loadFont(doc, 42));
});

test("尾部残缺码：补 U+FFFD 并计数，不静默少字", () => {
  const f = loadFont(makeDoc([]), makeSimpleFont());
  // 简单字体 1 字节码不会残缺；用 Type0 验 2 字节码的奇数尾
  const t0 = loadFont(makeDoc([]), makeType0Font({ toUnicode: null }));
  assert.equal(t0.decode(new Uint8Array([0x00])), "\uFFFD");
  assert.equal(t0.missing, 1);
  assert.equal(f.decode(latin("A")), "A");
});