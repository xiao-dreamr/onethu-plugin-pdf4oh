/**
 * 真实 PDF 集成测试：用 pdf-core 的 loadPdf 读本地课程语料，验证端到端识字率。
 *
 * 为什么必须有一条真实文件测试：假 doc 只能证明逻辑分支正确，证明不了"中文字体
 * 的 ToUnicode / Differences 在真实生成器产物里真的能认出来"。这里只断言最稳的
 * 事实（标题关键词、字符数、U+FFFD 比例），不做逐字比对——语料不在仓库里，
 * 缺失时 skip，保证别的机器上测试仍然绿。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { loadPdf } from "../../src/pdf/document.js";
import { extractPageText, extractRangeText, probeDocument } from "../../src/pdf/text.js";

/** 课程 PDF 语料目录（可用 PDF4OH_CORPUS_DIR 覆盖；不存在时相关测试 skip）。 */
const CORPUS_DIR = process.env.PDF4OH_CORPUS_DIR || "/home/lin/cs62doc";

const CORPUS = {
  cpp: `${CORPUS_DIR}/程序设计基础/教材&课件/C++的输出格式控制.pdf`,
  linalg: `${CORPUS_DIR}/线性代数/教材&课件/线性代数_刘余_课程讲义.pdf`,
  calendar: `${CORPUS_DIR}/微积分A/2026秋微积分A1-3_3251班_教学日历.pdf`,
};

/** 打开语料；文件不存在返回 null（调用方 t.skip）。 */
function open(key, opts = {}) {
  const path = CORPUS[key];
  if (!path || !existsSync(path)) return null;
  return loadPdf(new Uint8Array(readFileSync(path)), opts);
}

/** U+FFFD 比例（缺字率），用于"不许整页丢字"的粗门槛。 */
function replacementRatio(text) {
  if (text.length === 0) return 0;
  const matches = text.match(/\uFFFD/g);
  return (matches ? matches.length : 0) / text.length;
}

test("真实 PDF：C++ 课件第 1 页（TrueType + WinAnsi + ToUnicode）", (t) => {
  const doc = open("cpp");
  if (!doc) {
    t.skip("语料不存在：" + CORPUS.cpp);
    return;
  }
  assert.ok(doc.pageCount >= 5);
  const page = extractPageText(doc, 0);
  assert.ok(page.chars > 100, "第 1 页字符数过少：" + page.chars);
  assert.match(page.text, /C\+\+的输出格式控制/);
  assert.match(page.text, /格式控制/);
  assert.ok(replacementRatio(page.text) < 0.02, "第 1 页缺字率过高：" + replacementRatio(page.text));
});

test("真实 PDF：线性代数讲义第 1 页（CID 字体 + Identity-H）", (t) => {
  const doc = open("linalg");
  if (!doc) {
    t.skip("语料不存在：" + CORPUS.linalg);
    return;
  }
  assert.ok(doc.pageCount > 100);
  const page = extractPageText(doc, 0);
  assert.match(page.text, /线性代数讲义/);
  assert.match(page.text, /刘余/);
  assert.match(page.text, /清华大学/);
  assert.ok(page.chars > 60, "第 1 页字符数过少：" + page.chars);

  // 正文页（第 5 页）应是大段中文；CJK 占比高说明 Identity-H 的 ToUnicode 解对了
  // （第 3/4 页是目录，大量点线，CJK 占比天然很低，不适合做断言）
  const body = extractPageText(doc, 4);
  assert.ok(body.chars > 300, "第 5 页字符数过少：" + body.chars);
  const cjk = (body.text.match(/[\u4e00-\u9fff]/g) || []).length;
  assert.ok(cjk / body.chars > 0.2, "第 5 页中文占比过低：" + (cjk / body.chars).toFixed(2));
});

test("真实 PDF：教学日历（单页、Type0/Identity-H）", (t) => {
  const doc = open("calendar");
  if (!doc) {
    t.skip("语料不存在：" + CORPUS.calendar);
    return;
  }
  assert.equal(doc.pageCount, 1);
  const page = extractPageText(doc, 0);
  assert.match(page.text, /教学日历/);
  assert.match(page.text, /微积分/);
  assert.match(page.text, /晏平/);
  assert.ok(page.chars > 500, "字符数过少：" + page.chars);
  assert.ok(replacementRatio(page.text) < 0.02);
});

test("真实 PDF：probe 与分页续读在真实文件上可用", (t) => {
  const doc = open("linalg");
  if (!doc) {
    t.skip("语料不存在：" + CORPUS.linalg);
    return;
  }
  const probe = probeDocument(doc, { maxPages: 4 });
  assert.equal(probe.probed, 4);
  assert.ok(probe.pagesWithText >= 3, "探测页里文本页太少：" + probe.pagesWithText);
  assert.equal(probe.looksScanned, false);

  const range = extractRangeText(doc, { from: 1, to: 20, maxChars: 600 });
  assert.equal(range.from, 1);
  assert.ok(range.pages.length >= 1);
  assert.equal(range.truncated, true);
  assert.ok(range.nextPage > range.to, "nextPage 必须在已读页之后");
  // 已取出的页文本必须完整（不能在半页处切断）
  for (const page of range.pages) assert.equal(page.chars, page.text.length);
});