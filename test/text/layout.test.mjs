/**
 * text.js 单测：行聚合、空格规则、扫描件判定、范围截断、检索。
 *
 * 这是验收的核心：中文句子不能被空格切碎、西文词间要有一个空格、页面空白不能
 * 崩、maxChars 截断必须停在页边界且 nextPage 正确。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPageText, extractRangeText, probeDocument, searchDocument } from "../../src/pdf/text.js";
import {
  bytes,
  dict,
  makeDoc,
  makePage,
  makeResources,
  makeSimpleFont,
  name,
  stream,
} from "./fixtures.mjs";

/** 西文字体：500/1000 em，12pt 时每字符 6pt。 */
function latinFont() {
  return makeSimpleFont({ baseFont: "Latin" });
}

/** 中文字体：1000/1000 em，12pt 时每字 12pt；A–D 映射成 中文字符。 */
function cjkFont() {
  return makeSimpleFont({
    baseFont: "SimSun",
    firstChar: 32,
    widths: new Array(95).fill(1000),
    encoding: dict({
      BaseEncoding: name("WinAnsiEncoding"),
      Differences: [65, name("uni4E2D"), name("uni6587"), name("uni5B57"), name("uni7B26")],
    }),
  });
}

/** 用两个字体拼一份页面：F1 西文、F2 中文。 */
function pageWith(content, opts = {}) {
  const resources = makeResources({ F1: latinFont(), F2: cjkFont() }, opts.xobjects || {});
  return makePage(content, { resources, rotate: opts.rotate || 0, mediaBox: opts.mediaBox });
}

function docOf(pages) {
  return makeDoc(pages);
}

/** 图片 XObject（用于扫描件判定）。 */
function imageXObject() {
  return stream({ Subtype: name("Image"), Width: 1, Height: 1, BitsPerComponent: 8 }, new Uint8Array([0]));
}

test("行聚合：按 y 聚行、行内按 x 排序、行按 y 从上到下", () => {
  // 故意先画下面一行，验证输出顺序按坐标而不是绘制顺序
  const page = pageWith(`
    BT /F1 12 Tf 60 680 Td (Second) Tj ET
    BT /F1 12 Tf 60 700 Td (Right) Tj ET
    BT /F1 12 Tf 10 700 Td (Left) Tj ET
  `);
  const pageText = extractPageText(docOf([page]), 0);
  assert.equal(pageText.page, 1);
  assert.equal(pageText.text, "Left Right\nSecond");
  assert.equal(pageText.chars, pageText.text.length);
});

test("同一行的 y 抖动/上下标不拆行（容差随字号）", () => {
  const page = pageWith(`
    BT /F1 12 Tf 10 700 Td (Base) Tj ET
    BT /F1 8 Tf 60 698 Td (sub) Tj ET
  `);
  assert.equal(extractPageText(docOf([page]), 0).text, "Base sub");
});

test("大行距插空行（段落分隔），普通行距只换行", () => {
  const normal = pageWith(`
    BT /F1 12 Tf 10 700 Td (A) Tj ET
    BT /F1 12 Tf 10 686 Td (B) Tj ET
  `);
  assert.equal(extractPageText(docOf([normal]), 0).text, "A\nB");

  const paragraph = pageWith(`
    BT /F1 12 Tf 10 700 Td (A) Tj ET
    BT /F1 12 Tf 10 640 Td (B) Tj ET
  `);
  assert.equal(extractPageText(docOf([paragraph]), 0).text, "A\n\nB");
});

test("西文词间：0.15em 以上空隙补一个空格，紧贴则不补", () => {
  const spaced = pageWith(`
    BT /F1 12 Tf 10 700 Td (Hello) Tj ET
    BT /F1 12 Tf 52 700 Td (World) Tj ET
  `);
  assert.equal(extractPageText(docOf([spaced]), 0).text, "Hello World");

  const tight = pageWith(`
    BT /F1 12 Tf 10 700 Td (Hello) Tj ET
    BT /F1 12 Tf 40 700 Td (World) Tj ET
  `);
  assert.equal(extractPageText(docOf([tight]), 0).text, "HelloWorld");
});

test("TJ 负 kerning 造成的间距 = 词间空格", () => {
  const page = pageWith("BT /F1 12 Tf 10 700 Td [(Hello) -500 (World)] TJ ET");
  assert.equal(extractPageText(docOf([page]), 0).text, "Hello World");
});

test("CJK 相邻不塞空格（即使有很大字距）", () => {
  const page = pageWith(`
    BT /F2 12 Tf 10 700 Td (AB) Tj 24 0 Td (CD) Tj ET
  `);
  assert.equal(extractPageText(docOf([page]), 0).text, "中文字符");

  const wideGap = pageWith(`
    BT /F2 12 Tf 10 700 Td (AB) Tj ET
    BT /F2 12 Tf 200 700 Td (CD) Tj ET
  `);
  // 中文之间即使有大空隙也不补空格（中文排版没有"词间空格"概念）
  assert.equal(extractPageText(docOf([wideGap]), 0).text, "中文字符");
});

test("中英混排：[中文][English words][中文]", () => {
  const page = pageWith(`
    BT /F2 12 Tf 10 700 Td (AB) Tj ET
    BT /F1 12 Tf 50 700 Td (English words) Tj ET
    BT /F2 12 Tf 146 700 Td (AB) Tj ET
  `);
  assert.equal(extractPageText(docOf([page]), 0).text, "中文 English words 中文");
});

test("空页/坏页：text 为空字符串且不抛", () => {
  const empty = makePage("", { resources: makeResources({ F1: latinFont() }) });
  const text = extractPageText(docOf([empty]), 0);
  assert.equal(text.text, "");
  assert.equal(text.chars, 0);
  assert.equal(text.imageCount, 0);

  // 越界页码：core 会抛 RangeError，extractPageText 必须转成 warning
  const bad = extractPageText(docOf([empty]), 5);
  assert.equal(bad.chars, 0);
  assert.ok(bad.warnings.length > 0);
});

test("imageCount 统计 Do 图片与内联图片（扫描件判定的依据）", () => {
  const page = pageWith("/Img Do", { xobjects: { Img: imageXObject() } });
  assert.equal(extractPageText(docOf([page]), 0).imageCount, 1);

  const inline = makePage(
    new Uint8Array([...bytes("BI /W 1 /H 1 /BPC 8 /CS /G ID "), 0x00, 0x20, 0x45, 0x49, 0x20]),
    { resources: makeResources({ F1: latinFont() }) },
  );
  assert.equal(extractPageText(docOf([inline]), 0).imageCount, 1);
});

test("probeDocument：文本页不是扫描件，纯图片页是扫描件", () => {
  const textPage = pageWith("BT /F1 12 Tf 10 700 Td (0123456789ABCDEFGHIJKLMN) Tj ET");
  const textProbe = probeDocument(docOf([textPage, textPage]), { maxPages: 6 });
  assert.equal(textProbe.pageCount, 2);
  assert.equal(textProbe.probed, 2);
  assert.equal(textProbe.pagesWithText, 2);
  assert.equal(textProbe.looksScanned, false);

  const imagePage = pageWith("/Img Do", { xobjects: { Img: imageXObject() } });
  const scannedProbe = probeDocument(docOf([imagePage, imagePage]), { maxPages: 6 });
  assert.equal(scannedProbe.probed, 2);
  assert.equal(scannedProbe.pagesWithText, 0);
  assert.equal(scannedProbe.looksScanned, true);

  const emptyProbe = probeDocument(docOf([]));
  assert.equal(emptyProbe.pageCount, 0);
  assert.equal(emptyProbe.looksScanned, false);
});

test("probeDocument：maxPages 限制探测页数", () => {
  const textPage = pageWith("BT /F1 12 Tf 10 700 Td (0123456789ABCDEFGHIJKLMN) Tj ET");
  const pages = [textPage, textPage, textPage, textPage, textPage];
  assert.equal(probeDocument(docOf(pages), { maxPages: 2 }).probed, 2);
  assert.equal(probeDocument(docOf(pages)).probed, 5);
});

test("extractRangeText：缺省范围 = 全部页", () => {
  const page = pageWith("BT /F1 12 Tf 10 700 Td (Page) Tj ET");
  const range = extractRangeText(docOf([page, page, page]));
  assert.equal(range.pages.length, 3);
  assert.deepEqual(range.pages.map((p) => p.page), [1, 2, 3]);
  assert.equal(range.from, 1);
  assert.equal(range.to, 3);
  assert.equal(range.totalPages, 3);
  assert.equal(range.truncated, false);
  assert.equal(range.nextPage, null);
});

test("extractRangeText：maxChars 截断停在页边界，nextPage 指向下一页", () => {
  // 每页 24 字符
  const page = pageWith("BT /F1 12 Tf 10 700 Td (0123456789ABCDEFGHIJKLMN) Tj ET");
  const pages = [page, page, page, page];

  const tight = extractRangeText(docOf(pages), { maxChars: 10 });
  assert.deepEqual(tight.pages.map((p) => p.page), [1]); // 超限的那页也完整返回
  assert.equal(tight.chars, 24);
  assert.equal(tight.truncated, true);
  assert.equal(tight.nextPage, 2);

  const mid = extractRangeText(docOf(pages), { maxChars: 30 });
  assert.deepEqual(mid.pages.map((p) => p.page), [1, 2]);
  assert.equal(mid.truncated, true);
  assert.equal(mid.nextPage, 3);

  // 到最后一页超限但没有下一页 → 不算截断
  const exact = extractRangeText(docOf(pages), { maxChars: 96 });
  assert.equal(exact.pages.length, 4);
  assert.equal(exact.truncated, false);
  assert.equal(exact.nextPage, null);
});

test("extractRangeText：from/to 越界与空文档", () => {
  const page = pageWith("BT /F1 12 Tf 10 700 Td (0123456789ABCDEFGHIJKLMN) Tj ET");
  const pages = [page, page, page];

  const sub = extractRangeText(docOf(pages), { from: 2, to: 99 });
  assert.deepEqual(sub.pages.map((p) => p.page), [2, 3]);
  assert.equal(sub.from, 2);
  assert.equal(sub.to, 3);

  const beyond = extractRangeText(docOf(pages), { from: 9 });
  assert.deepEqual(beyond.pages, []);
  assert.equal(beyond.truncated, false);

  const empty = extractRangeText(docOf([]));
  assert.deepEqual(empty.pages, []);
  assert.equal(empty.totalPages, 0);
});

test("searchDocument：大小写/空白/全角归一化后命中", () => {
  const p1 = pageWith("BT /F1 12 Tf 10 700 Td (Hello World 2026) Tj ET");
  const p2 = pageWith("BT /F1 12 Tf 10 700 Td (hello world again) Tj ET");
  const doc = docOf([p1, p2]);

  const hits = searchDocument(doc, { query: "HELLO   WORLD" });
  assert.equal(hits.totalHits, 2);
  assert.deepEqual(hits.hits.map((h) => h.page), [1, 2]);
  assert.match(hits.hits[0].text, /Hello World/);
  assert.equal(hits.capped, false);
  assert.equal(hits.scanned, false);

  // 全角数字也能命中
  const fullwidth = searchDocument(doc, { query: "２０２６" });
  assert.equal(fullwidth.totalHits, 1);
  assert.equal(fullwidth.hits[0].page, 1);
});

test("searchDocument：maxHits / capped / contextChars", () => {
  const p1 = pageWith("BT /F1 12 Tf 10 700 Td (needle one) Tj ET");
  const p2 = pageWith("BT /F1 12 Tf 10 700 Td (needle two) Tj ET");
  const doc = docOf([p1, p2]);

  const limited = searchDocument(doc, { query: "needle", maxHits: 1 });
  assert.equal(limited.hits.length, 1);
  assert.equal(limited.totalHits, 2);
  assert.equal(limited.capped, true);

  const tight = searchDocument(doc, { query: "needle", contextChars: 2 });
  assert.match(tight.hits[0].text, /…/); // 截断处有省略号提示
});

test("searchDocument：无命中且全页无文本 → scanned", () => {
  const imagePage = pageWith("/Img Do", { xobjects: { Img: imageXObject() } });
  const scanned = searchDocument(docOf([imagePage, imagePage]), { query: "任意" });
  assert.deepEqual(scanned.hits, []);
  assert.equal(scanned.totalHits, 0);
  assert.equal(scanned.scanned, true);

  const textPage = pageWith("BT /F1 12 Tf 10 700 Td (something else entirely) Tj ET");
  const notScanned = searchDocument(docOf([textPage]), { query: "missing" });
  assert.equal(notScanned.scanned, false);

  // 空 query 不能当"命中所有"处理
  assert.deepEqual(searchDocument(docOf([textPage]), { query: "   " }).hits, []);
});

test("字体缺失时单页仍返回文本 + warning（整页不丢）", () => {
  const page = pageWith("BT /F9 12 Tf 10 700 Td (Fallback) Tj ET");
  const text = extractPageText(docOf([page]), 0);
  assert.equal(text.text, "Fallback");
  assert.ok(text.warnings.some((w) => /F9/.test(w)));
});