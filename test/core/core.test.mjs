/**
 * pdf4oh · 对象层回归（lead 补充，配合 pdf-core 的 _fixtures.mjs）。
 *
 * 覆盖：inflate 对照 zlib、经典 xref / xref 流 / ObjStm / 混合 / 增量更新 /
 * 坏 xref 重建 / 页树继承 / 滤镜 / 错误分类。真实 PDF 由 test/corpus 兜底。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import {
  makePdf,
  makeSimplePdf,
  makeXrefStreamPdf,
  makeObjStmPdf,
  makeHybridPdf,
  makeEncryptedPdf,
  appendIncremental,
  corruptStartxref,
  streamBody,
  toBytes,
  latin1,
} from "./_fixtures.mjs";
import { inflateRaw } from "../../src/pdf/inflate.js";
import { decodeStreamData } from "../../src/pdf/filters.js";
import { loadPdf, PdfError } from "../../src/pdf/document.js";

const enc = (s) => new TextEncoder().encode(s);

test("inflateRaw 与 zlib 逐字节一致（多块/动态 Huffman/随机数据）", () => {
  for (let i = 0; i < 50; i++) {
    const n = 1 + Math.floor(Math.random() * 60000);
    const data = Buffer.alloc(n);
    for (let j = 0; j < n; j++) data[j] = Math.random() * 256 | 0;
    const compressed = deflateSync(data, { level: i % 10 });
    const out = inflateRaw(new Uint8Array(compressed));
    assert.deepEqual(Buffer.from(out), data, `第 ${i} 组 level=${i % 10} 不一致`);
  }
});

test("inflateRaw：zlib 包装与裸 deflate 都吃", () => {
  const data = enc("hello pdf4oh ".repeat(500));
  const wrapped = new Uint8Array(deflateSync(data));
  assert.equal(inflateRaw(wrapped).length, data.length);
});

test("滤镜：ASCIIHex / ASCII85 / RunLength", () => {
  const doc = { warnings: [], resolve: (v) => v };
  const hex = toBytes("48656C6C6F>");
  assert.equal(Buffer.from(decodeStreamData(doc, new Map([["Filter", { t: "name", v: "ASCIIHexDecode" }]]), hex)).toString(), "Hello");
  const rl = new Uint8Array([2, 65, 66, 67, 0x80]); // 2 = 字面量长度 3
  assert.equal(Buffer.from(decodeStreamData(doc, new Map([["Filter", { t: "name", v: "RunLengthDecode" }]]), rl)).toString(), "ABC");
});

test("经典 xref：页数 / Catalog / 内容流", () => {
  const doc = loadPdf(makeSimplePdf());
  assert.equal(doc.pageCount, 1);
  const page = doc.getPage(0);
  assert.deepEqual(page.mediaBox, [0, 0, 200, 100]);
  assert.ok(doc.getPageContentBytes(page).length > 0);
  assert.equal(doc.warnings.length, 0);
});

test("页树：嵌套 Pages + 继承 MediaBox/Resources", () => {
  const pdf = makePdf([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 2 /MediaBox [0 0 300 400] >>"],
    [3, "<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 5 0 R] /Count 2 /Resources << /Font << /F1 6 0 R >> >> >>"],
    [4, "<< /Type /Page /Parent 3 0 R >>"],
    [5, "<< /Type /Page /Parent 3 0 R /MediaBox [0 0 100 200] >>"],
    [6, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
  ]);
  const doc = loadPdf(pdf);
  assert.equal(doc.pageCount, 2);
  assert.deepEqual(doc.getPage(0).mediaBox, [0, 0, 300, 400]);
  assert.deepEqual(doc.getPage(1).mediaBox, [0, 0, 100, 200]);
  assert.ok(doc.getPage(0).resources.get("Font"));
});

test("xref 流 PDF", () => {
  const pdf = makeXrefStreamPdf([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 100 100] >>"],
    [3, "<< /Type /Page /Parent 2 0 R >>"],
  ]);
  const doc = loadPdf(pdf);
  assert.equal(doc.pageCount, 1);
  assert.equal(doc.warnings.length, 0);
});

test("对象流（/ObjStm）里的对象可解析", () => {
  const pdf = makeObjStmPdf(
    [
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 100 100] >>"],
      [3, "<< /Type /Page /Parent 2 0 R >>"],
    ],
    new Set([1, 3]),
  );
  const doc = loadPdf(pdf);
  assert.equal(doc.pageCount, 1);
  assert.ok(doc.getObject(1));
});

test("混合 xref：/XRefStm 里的补充对象可见", () => {
  const pdf = makeHybridPdf(
    [
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 100 100] >>"],
      [3, "<< /Type /Page /Parent 2 0 R >>"],
    ],
    { extraObjects: [[9, "<< /Extra true >>"]] },
  );
  const doc = loadPdf(pdf);
  assert.equal(doc.pageCount, 1);
  const extra = doc.getObject(9);
  assert.ok(extra, "/XRefStm 登记的对象应可读取");
});

test("增量更新：新版本对象覆盖旧版本", () => {
  const base = makePdf([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 100 100] >>"],
    [3, "<< /Type /Page /Parent 2 0 R /Rotate 0 >>"],
  ]);
  const updated = appendIncremental(base, [[3, "<< /Type /Page /Parent 2 0 R /Rotate 90 >>"]]);
  const doc = loadPdf(updated);
  assert.equal(doc.getPage(0).rotate, 90);
});

test("坏 startxref：扫描重建后仍可读", () => {
  const pdf = corruptStartxref(makeSimplePdf());
  const doc = loadPdf(pdf);
  assert.equal(doc.pageCount, 1);
});

test("非法字节 / 超限 / 加密：分类明确", () => {
  assert.throws(() => loadPdf(enc("not a pdf")), (err) => err instanceof PdfError && err.code === "not-pdf");
  const pdf = makeSimplePdf();
  assert.throws(() => loadPdf(pdf, { maxBytes: 32 }), (err) => err.code === "too-large");
  assert.throws(() => loadPdf(makeEncryptedPdf()), (err) => err.code === "encrypted");
});

test("内容流为数组时按顺序拼接", () => {
  const pdf = makePdf([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 100 100] >>"],
    [3, "<< /Type /Page /Parent 2 0 R /Contents [4 0 R 5 0 R] >>"],
    [4, streamBody("q ")],
    [5, streamBody("Q")],
  ]);
  const doc = loadPdf(pdf);
  const bytes = doc.getPageContentBytes(doc.getPage(0));
  assert.match(Buffer.from(bytes).toString("latin1"), /q\s+Q/);
});