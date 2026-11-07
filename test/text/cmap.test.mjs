/**
 * cmap.js 单测：ToUnicode CMap 的 codespacerange / bfchar / bfrange。
 *
 * 中文字体最常见的就是 Identity-H + 一份 ToUnicode；这份 CMap 解析错了，
 * 整份课件的正文就都是 U+FFFD。这里覆盖码长探测、增量式 bfrange、数组式
 * bfrange、代理对（扩展区汉字/emoji）以及"映射不到给 U+FFFD 并计数"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCMap } from "../../src/pdf/cmap.js";
import { bytes, cmapBytes } from "./fixtures.mjs";

function cmap(text) {
  return parseCMap(cmapBytes(text));
}

test("bfchar：1 字节码（codespace <00><FF>）", () => {
  const c = cmap(`
    /CIDInit /ProcSet findresource begin
    12 dict begin
    begincmap
    1 begincodespacerange
    <00> <FF>
    endcodespacerange
    2 beginbfchar
    <41> <0058>
    <42> <0059>
    endbfchar
    endcmap
  `);
  assert.equal(c.kind, "tounicode");
  assert.equal(c.codeLength, 1);
  assert.equal(c.decode(new Uint8Array([0x41, 0x42])), "XY");
  assert.equal(c.missing, 0);
});

test("bfchar：2 字节码（Identity-H 的 <0000><FFFF>）", () => {
  const c = cmap(`
    begincmap
    1 begincodespacerange
    <0000> <FFFF>
    endcodespacerange
    3 beginbfchar
    <0001> <4E2D>
    <0002> <6587>
    <0003> <D83DDE00>
    endbfchar
    endcmap
  `);
  assert.equal(c.codeLength, 2);
  const decoded = c.decode(new Uint8Array([0x00, 0x01, 0x00, 0x02, 0x00, 0x03]));
  assert.equal(decoded, "中文\u{1F600}"); // 代理对必须保留
  assert.equal(c.missing, 0);
});

test("bfrange：增量式（dst 起始串 + 偏移）", () => {
  const c = cmap(`
    begincmap
    1 begincodespacerange
    <0000> <FFFF>
    endcodespacerange
    1 beginbfrange
    <0010> <0012> <0030>
    endbfrange
    endcmap
  `);
  assert.equal(c.decode(new Uint8Array([0x00, 0x10, 0x00, 0x11, 0x00, 0x12])), "012");
  // 范围外 → U+FFFD 且计数
  assert.equal(c.decode(new Uint8Array([0x00, 0x13])), "\uFFFD");
  assert.equal(c.missing, 1);
});

test("bfrange：数组式目标（<lo> <hi> [ … ]）", () => {
  const c = cmap(`
    begincmap
    1 begincodespacerange
    <0000> <FFFF>
    endcodespacerange
    1 beginbfrange
    <0020> <0022> [<4E00> <4E8C> <4E09>]
    endbfrange
    endcmap
  `);
  assert.equal(c.decode(new Uint8Array([0x00, 0x20, 0x00, 0x21, 0x00, 0x22])), "一二三");
});

test("bfrange：UTF-16BE 多单元目标（带代理对）", () => {
  const c = cmap(`
    begincmap
    1 begincodespacerange
    <0000> <FFFF>
    endcodespacerange
    1 beginbfrange
    <0040> <0041> <D83DDE00>
    endbfrange
    endcmap
  `);
  // 增量加在最后一个 UTF-16 单元上
  assert.equal(c.decode(new Uint8Array([0x00, 0x40, 0x00, 0x41])), "\u{1F600}\u{1F601}");
});

test("未知码给 U+FFFD 并累计 missing（不抛）", () => {
  const c = cmap(`
    begincmap
    1 begincodespacerange
    <0000> <FFFF>
    endcodespacerange
    1 beginbfchar
    <0001> <4E2D>
    endbfchar
    endcmap
  `);
  assert.equal(c.decode(new Uint8Array([0x00, 0x01, 0x00, 0x99])), "中\uFFFD");
  assert.equal(c.missing, 1);
  // 尾部残缺的半个码也不能静默丢
  assert.equal(c.decode(new Uint8Array([0x00])), "\uFFFD");
});

test("usecmap：忽略并留下 warning（可退化但不能静默）", () => {
  const c = cmap(`
    begincmap
    /Adobe-Identity-UCS usecmap
    1 begincodespacerange
    <0000> <FFFF>
    endcodespacerange
    endcmap
  `);
  assert.equal(c.warnings.length, 1);
  assert.match(c.warnings[0], /usecmap/);
  assert.equal(c.decode(new Uint8Array([0x00, 0x01])), "\uFFFD");
});

test("无 codespace 时按 bfchar 长度推断 codeLength", () => {
  const c = cmap(`
    begincmap
    1 beginbfchar
    <0001> <4E2D>
    endbfchar
    endcmap
  `);
  assert.equal(c.codeLength, 2);
  assert.equal(c.decode(new Uint8Array([0x00, 0x01])), "中");
});

test("decode 的 forcedLength 覆盖 codespace 探测", () => {
  const c = cmap(`
    begincmap
    1 begincodespacerange
    <00> <FF>
    endcodespacerange
    1 beginbfchar
    <41> <0041>
    endbfchar
    endcmap
  `);
  // 强制按 1 字节解码：0x41 → A
  assert.equal(c.decode(new Uint8Array([0x41]), 1), "A");
  // 强制 2 字节时 0x4141 不在表中 → U+FFFD
  assert.equal(c.decode(new Uint8Array([0x41, 0x41]), 2), "\uFFFD");
});

test("codeLengthAt 按 codespace 匹配（混合 1/2 字节）", () => {
  const c = cmap(`
    begincmap
    2 begincodespacerange
    <00> <7F>
    <0000> <FFFF>
    endcodespacerange
    endcmap
  `);
  assert.equal(c.codeLength, null); // 混合长度 → 不固定
  assert.equal(c.codeLengthAt(new Uint8Array([0x41]), 0), 1);
  assert.equal(c.codeLengthAt(new Uint8Array([0x00, 0x41]), 0), 1); // 0x00 命中 <00><7F>
  assert.equal(c.codeLengthAt(new Uint8Array([0x81, 0x41]), 0), 2);
});

test("空的/垃圾 CMap 不抛错，kind=unknown", () => {
  const c = parseCMap(bytes("not a cmap at all"));
  assert.equal(c.kind, "unknown");
  assert.equal(c.decode(new Uint8Array([0x41])), "\uFFFD");
});