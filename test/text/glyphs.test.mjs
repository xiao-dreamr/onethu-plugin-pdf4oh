/**
 * glyphs.js 单测：字形名 → Unicode、三种单字节编码表。
 *
 * 这些断言就是"中文课件简单字体能不能认字"的底线：/Differences 里出现
 * uni4E2D 这类名字必须能变成"中"，否则整页中文都会是 U+FFFD。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GLYPH_AGL,
  GLYPH_MAC_ROMAN,
  GLYPH_STANDARD,
  GLYPH_WIN_ANSI,
  glyphEncodingTable,
  glyphIsCjk,
  glyphIsSpace,
  glyphNameToUnicode,
} from "../../src/pdf/glyphs.js";

test("AGL 常用子集：标点、字母、连字", () => {
  assert.equal(glyphNameToUnicode("space"), " ");
  assert.equal(glyphNameToUnicode("period"), ".");
  assert.equal(glyphNameToUnicode("quotesingle"), "'");
  assert.equal(glyphNameToUnicode("hyphen"), "-");
  assert.equal(glyphNameToUnicode("ampersand"), "&");
  assert.equal(glyphNameToUnicode("A"), "A");
  assert.equal(glyphNameToUnicode("z"), "z");
  assert.equal(glyphNameToUnicode("Agrave"), "\u00C0");
  assert.equal(glyphNameToUnicode("germandbls"), "\u00DF");
  // 连字在 PDF 里是单字形，抽取时要还原成两个字母
  assert.equal(glyphNameToUnicode("fi"), "fi");
  assert.equal(glyphNameToUnicode("fl"), "fl");
  assert.equal(glyphNameToUnicode("ffi"), "ffi");
});

test("AGL：希腊/数学符号", () => {
  assert.equal(glyphNameToUnicode("alpha"), "\u03B1");
  assert.equal(glyphNameToUnicode("Sigma"), "\u03A3");
  assert.equal(glyphNameToUnicode("pi"), "\u03C0");
  assert.equal(glyphNameToUnicode("element"), "\u2208");
  assert.equal(glyphNameToUnicode("lessequal"), "\u2264");
  assert.equal(glyphNameToUnicode("infinity"), "\u221E");
  assert.equal(glyphNameToUnicode("endash"), "\u2013");
  assert.equal(glyphNameToUnicode("quoteright"), "\u2019");
});

test("uniXXXX / uXXXX / 多组 uni / 变体后缀", () => {
  assert.equal(glyphNameToUnicode("uni4E2D"), "中");
  assert.equal(glyphNameToUnicode("uni6587"), "文");
  assert.equal(glyphNameToUnicode("uni00410042"), "AB");
  assert.equal(glyphNameToUnicode("u4E2D"), "中");
  assert.equal(glyphNameToUnicode("u1F600"), "\u{1F600}");
  assert.equal(glyphNameToUnicode("uni4E2D.sc"), "中");
  assert.equal(glyphNameToUnicode("f_f_i"), "ffi");
  assert.equal(glyphNameToUnicode("one.oldstyle"), "1");
});

test("无 Unicode 语义的字形名返回 null（调用方补 U+FFFD）", () => {
  assert.equal(glyphNameToUnicode("g12"), null);
  assert.equal(glyphNameToUnicode("cid42"), null);
  assert.equal(glyphNameToUnicode("glyph17"), null);
  assert.equal(glyphNameToUnicode(""), null);
  assert.equal(glyphNameToUnicode(null), null);
});

test("WinAnsiEncoding 码表：ASCII、CP1252 特殊区、Latin-1 区", () => {
  const table = glyphEncodingTable("WinAnsiEncoding");
  assert.ok(table);
  assert.equal(table[0x41], "A");
  assert.equal(table[0x20], " ");
  assert.equal(table[0x80], "\u20AC"); // €
  assert.equal(table[0x91], "\u2018");
  assert.equal(table[0x92], "\u2019");
  assert.equal(table[0xA0], " "); // NBSP 归一成普通空格
  assert.equal(table[0xE9], "\u00E9"); // é
  assert.equal(table[0xFF], "\u00FF");
  // 未定义码位保持 null，让调用方决定怎么降级
  assert.equal(table[0x81], null);
});

test("MacRomanEncoding / StandardEncoding 码表", () => {
  const mac = glyphEncodingTable("MacRomanEncoding");
  assert.ok(mac);
  assert.equal(mac[0x41], "A");
  assert.equal(mac[0xA5], "\u2022"); // bullet
  assert.equal(mac[0xD0], "\u2013"); // en dash
  assert.equal(mac[0x8A], "\u00E4"); // ä

  const std = glyphEncodingTable("StandardEncoding");
  assert.ok(std);
  assert.equal(std[0x41], "A");
  assert.equal(std[0x27], "\u2019"); // quoteright
  assert.equal(std[0x60], "\u2018"); // quoteleft
  assert.equal(std[0xAE], "fi");
});

test("编码名容错：大小写/后缀/未知编码", () => {
  assert.equal(glyphEncodingTable("WinAnsi"), GLYPH_WIN_ANSI);
  assert.equal(glyphEncodingTable("MacRoman"), GLYPH_MAC_ROMAN);
  assert.equal(glyphEncodingTable("Standard"), GLYPH_STANDARD);
  assert.equal(glyphEncodingTable("MacExpertEncoding"), null);
  assert.equal(glyphEncodingTable(""), null);
  assert.equal(glyphEncodingTable(undefined), null);
});

test("glyphIsCjk / glyphIsSpace", () => {
  assert.equal(glyphIsCjk("中"), true);
  assert.equal(glyphIsCjk("，"), true); // 全角标点
  assert.equal(glyphIsCjk("あ"), true);
  assert.equal(glyphIsCjk("\uFF21"), true); // 全角 A
  assert.equal(glyphIsCjk("A"), false);
  assert.equal(glyphIsCjk("，"), true);
  assert.equal(glyphIsCjk("…"), false);
  assert.equal(glyphIsCjk(""), false);
  assert.equal(glyphIsSpace(" "), true);
  assert.equal(glyphIsSpace("\u00A0"), true);
  assert.equal(glyphIsSpace("\u3000"), true);
  assert.equal(glyphIsSpace("中"), false);
  assert.equal(GLYPH_AGL.space, " ");
});