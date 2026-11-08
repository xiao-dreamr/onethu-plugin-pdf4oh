/**
 * 字体轮廓匹配（P0 增强）护栏：
 *   - 字体名归一化；
 *   - SFNT 解析对坏数据不抛错；
 *   - 有系统楷体时：Unicode→GID→轮廓指纹→Unicode 往返一致；
 *   - 有真实课件时：整页中文可还原（本地跑，CI 自动跳过）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fontFamilyKey, prepareFontMatching } from "../../src/pdf/fontmatch.js";
import { buildGlyphHashIndex, parseSfnt, sfntGlyphHash, sfntUnicodeMap } from "../../src/pdf/sfnt.js";
import { extractRangeText } from "../../src/pdf/text.js";
import { loadPdf } from "../../src/pdf/document.js";

const SIMKAI = "/mnt/c/Windows/Fonts/simkai.ttf";
const COURSE = process.env.PDF4OH_COURSE_PDF || "/mnt/d/Downloads/Oct29讲义.pdf";

test("字体名归一化", () => {
  assert.equal(fontFamilyKey("ABCDEF+KaiTi"), "kaiti");
  assert.equal(fontFamilyKey("楷体"), "kaiti");
  assert.equal(fontFamilyKey("STKaiti"), "kaiti");
  assert.equal(fontFamilyKey("SimSun"), "simsun");
  assert.equal(fontFamilyKey("Microsoft YaHei"), "yahei");
  assert.equal(fontFamilyKey("Helvetica"), null);
  assert.equal(fontFamilyKey(""), null);
});

test("坏 SFNT 不抛错", () => {
  assert.equal(parseSfnt(new Uint8Array()), null);
  assert.equal(parseSfnt(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), null);
  assert.equal(parseSfnt(new Uint8Array(500).fill(0xff)), null);
});

test("系统楷体：轮廓指纹可反推 Unicode", { skip: !existsSync(SIMKAI) && "系统无 simkai.ttf" }, () => {
  const bytes = new Uint8Array(readFileSync(SIMKAI));
  const font = parseSfnt(bytes, 0);
  assert.ok(font && font.numGlyphs > 1000);
  const unicode = sfntUnicodeMap(font);
  assert.ok(unicode.size > 5000);
  const gid = unicode.get(0x4e2d); // 中
  assert.ok(gid, "simkai 应包含「中」");
  const hash = sfntGlyphHash(font, gid);
  assert.ok(hash, "「中」应是简单字形");
  const index = buildGlyphHashIndex(font);
  assert.ok(index.size > 5000);
  assert.equal(index.get(hash), 0x4e2d);
});

test("真实课件：无 ToUnicode 的楷体页可还原成中文", {
  skip: (!existsSync(SIMKAI) || !existsSync(COURSE)) && "缺少本机课件或系统楷体",
}, async () => {
  const b64 = readFileSync(SIMKAI).toString("base64");
  const ctx = { onethu: { fonts: { system: async (family) => ({ family, path: SIMKAI, b64 }) } } };
  const doc = loadPdf(new Uint8Array(readFileSync(COURSE)));
  const summary = await prepareFontMatching(doc, ctx);
  assert.equal(summary.needed, true);
  assert.ok(summary.ready.includes("kaiti"));
  const page = extractRangeText(doc, { from: 1, to: 1, maxChars: 4000 }).pages[0];
  assert.match(page.text, /微积分/);
  assert.match(page.text, /清华大学数学科学系/);
  assert.equal((page.text.match(/\uFFFD/g) || []).length, 0);
});
