/**
 * pdf-text 单测的共享 fixture：构造 PDF 值模型 + 假 doc。
 *
 * 为什么要有假 doc：pdf-text 只依赖 CONTRACT §4 的五个方法（getPage /
 * getPageContentBytes / resolve / tryDecodeStream / pageCount），用假 doc 能把
 * "内容流解释"和"真实文件解析"解耦，单测既快又能精确构造边界情形（空页、坏字体、
 * 旋转页等）。真实 PDF 的集成测试单独放 realpdf.test.mjs。
 *
 * 这个文件名以 .test.mjs 结尾是为了落在 write scope 内；它自己的测试只有一条
 * "fixture 自检"，被别的测试文件 import 时会重复注册一次，无害。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

/** PDF name 值：/Foo */
export function name(value) {
  return { t: "name", v: value };
}

/** PDF 字典值（对象字面量 → Map，保持 PDF 键序语义）。 */
export function dict(entries) {
  const map = new Map();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) map.set(key, value);
  }
  return { t: "dict", m: map };
}

/** PDF 流值；raw 就是"解码后"的字节（假 doc 的 decodeStream 直接返回 raw）。 */
export function stream(entries, raw) {
  const map = new Map();
  for (const [key, value] of Object.entries(entries || {})) {
    if (value !== undefined) map.set(key, value);
  }
  return { t: "stream", dict: map, raw };
}

/** 间接引用。 */
export function ref(n, g = 0) {
  return { t: "ref", n, g };
}

/** 字符串（Latin-1 语义，测试里够用）。 */
export function pdfString(text) {
  return { t: "str", b: bytes(text) };
}

/** JS 字符串 → 字节（只处理 Latin-1 范围，测试构造用）。 */
export function bytes(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** ToUnicode CMap 字节（测试里手写 CMap 文本）。 */
export function cmapBytes(text) {
  return bytes(text);
}

/** 简单字体（WinAnsi / Differences / ToUnicode 都用它构造）。 */
export function makeSimpleFont(opts = {}) {
  const entries = {
    Type: name("Font"),
    Subtype: name(opts.subtype || "TrueType"),
    BaseFont: name(opts.baseFont || "TestFont"),
    FirstChar: opts.firstChar !== undefined ? opts.firstChar : 32,
    Widths: opts.widths || new Array(95).fill(500),
  };
  if (opts.encoding !== null) entries.Encoding = opts.encoding !== undefined ? opts.encoding : name("WinAnsiEncoding");
  if (opts.toUnicode) entries.ToUnicode = opts.toUnicode;
  if (opts.descriptor) entries.FontDescriptor = opts.descriptor;
  if (opts.extra) Object.assign(entries, opts.extra);
  return dict(entries);
}

/** Type0 / Identity-H 字体（CIDFontType2 + /W 宽度）。 */
export function makeType0Font(opts = {}) {
  const descendantEntries = {
    Type: name("Font"),
    Subtype: name(opts.descendantSubtype || "CIDFontType2"),
    BaseFont: name(opts.baseFont || "TestCJK"),
    DW: opts.dw !== undefined ? opts.dw : 1000,
    W: opts.w || [],
  };
  if (opts.cidToGid !== undefined) descendantEntries.CIDToGIDMap = opts.cidToGid;
  const entries = {
    Type: name("Font"),
    Subtype: name("Type0"),
    BaseFont: name(opts.baseFont || "TestCJK"),
    Encoding: opts.encoding !== undefined ? opts.encoding : name("Identity-H"),
    DescendantFonts: [dict(descendantEntries)],
  };
  if (opts.toUnicode) entries.ToUnicode = opts.toUnicode;
  return dict(entries);
}

/** 页面；resources 默认空 Map，content 是已"解码"的字节。 */
export function makePage(content, opts = {}) {
  return {
    index: opts.index !== undefined ? opts.index : 0,
    dict: new Map(),
    mediaBox: opts.mediaBox || [0, 0, 600, 800],
    rotate: opts.rotate !== undefined ? opts.rotate : 0,
    resources: opts.resources || new Map(),
    _content: typeof content === "string" ? bytes(content) : content || new Uint8Array(0),
  };
}

/** /Resources 字典：字体名 → 字体字典，XObject 名 → 流。 */
export function makeResources(fonts = {}, xobjects = {}) {
  const resources = new Map();
  if (Object.keys(fonts).length > 0) resources.set("Font", new Map(Object.entries(fonts)));
  if (Object.keys(xobjects).length > 0) resources.set("XObject", new Map(Object.entries(xobjects)));
  return resources;
}

/** 假 doc：实现 CONTRACT §4 中 pdf-text 实际用到的全部方法。 */
export function makeDoc(pages, opts = {}) {
  const objects = opts.objects || new Map();
  const doc = {
    warnings: [],
    pageCount: pages.length,
    objects,
    resolve(value) {
      if (value && value.t === "ref") return objects.has(value.n) ? objects.get(value.n) : null;
      return value;
    },
    getPage(index) {
      if (!(index >= 0 && index < pages.length)) throw new RangeError("页码越界");
      return pages[index];
    },
    tryDecodeStream(s) {
      return s && s.raw ? s.raw : new Uint8Array(0);
    },
    decodeStream(s) {
      return s && s.raw ? s.raw : new Uint8Array(0);
    },
    getPageContentBytes(page) {
      return page && page._content ? page._content : new Uint8Array(0);
    },
    loadXObject(page, xname) {
      const xobjects = page && page.resources ? page.resources.get("XObject") : null;
      if (!xobjects) return null;
      const raw = xobjects.get(xname);
      const resolved = raw && raw.t === "ref" ? doc.resolve(raw) : raw;
      return resolved && resolved.t === "stream" ? { dict: resolved.dict, bytes: resolved.raw } : null;
    },
  };
  return doc;
}

test("fixture 自检：值模型与假 doc 可用", () => {
  const page = makePage("BT /F1 12 Tf (Hi) Tj ET", { resources: makeResources({ F1: makeSimpleFont() }) });
  const doc = makeDoc([page]);
  assert.equal(doc.pageCount, 1);
  assert.equal(doc.getPage(0), page);
  assert.equal(doc.resolve(ref(1)), null);
  assert.deepEqual([...dict({ A: 1 }).m.entries()], [["A", 1]]);
  assert.equal(pdfString("A").b[0], 65);
});