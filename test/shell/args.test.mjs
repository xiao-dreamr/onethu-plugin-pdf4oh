/**
 * pdf4oh · 输入解析单测。
 *
 * 这些用例来自真实的 OH/用户输入形态：中文文件名、末尾页码、键值参数、全角数字。
 * 解析错了会让 read 读错页或把文件名当页码，所以这里把边界钉死。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseCommandInput, parseSearchInput, parsePageRange, normalizeInputText } from "../../src/args.js";

test("自然语言 + 末尾页码", () => {
  const r = parseCommandInput("第3讲 1-6");
  assert.equal(r.text, "第3讲");
  assert.deepEqual(r.pages, { from: 1, to: 6 });

  const pages = parseCommandInput("线性代数 第2-4页");
  assert.equal(pages.text, "线性代数");
  assert.deepEqual(pages.pages, { from: 2, to: 4 });

  const single = parseCommandInput("课件 第 3 页");
  assert.equal(single.text, "课件");
  assert.deepEqual(single.pages, { from: 3, to: null });
});

test("文件名里的数字不被当页码", () => {
  const r = parseCommandInput("第3讲");
  assert.equal(r.text, "第3讲");
  assert.equal(r.pages, null);

  const reversed = parseCommandInput("作业 4-2");
  assert.equal(reversed.text, "作业 4-2");
  assert.equal(reversed.pages, null);

  const lecture = parseCommandInput("Lecture 5.pdf");
  assert.equal(lecture.text, "Lecture 5.pdf");
  assert.equal(lecture.pages, null);
});

test("键值参数", () => {
  const r = parseCommandInput("fileId=123456 pages=2-5 max=4000");
  assert.equal(r.fileId, "123456");
  assert.deepEqual(r.pages, { from: 2, to: 5 });
  assert.equal(r.maxChars, 4000);
  assert.equal(r.text, "");

  const c = parseCommandInput('course="线性代数" 第3讲');
  assert.equal(c.courseQuery, "线性代数");
  assert.equal(c.text, "第3讲");
});

test("全角输入归一化", () => {
  assert.equal(normalizeInputText("１－６"), "1-6");
  const r = parseCommandInput("课件 １－６");
  assert.deepEqual(r.pages, { from: 1, to: 6 });
});

test("页码范围解析", () => {
  assert.deepEqual(parsePageRange("1-6"), { from: 1, to: 6 });
  assert.deepEqual(parsePageRange("3"), { from: 3, to: null });
  assert.deepEqual(parsePageRange("3-"), { from: 3, to: null });
  assert.equal(parsePageRange("abc"), null);
  assert.equal(parsePageRange(""), null);
});

test("search 输入拆分", () => {
  const r = parseSearchInput("第3讲 矩阵");
  assert.equal(r.text, "第3讲");
  assert.equal(r.query, "矩阵");

  const kv = parseSearchInput("第3讲 query=特征值");
  assert.equal(kv.text, "第3讲");
  assert.equal(kv.query, "特征值");

  const onlyKeyword = parseSearchInput("矩阵");
  assert.equal(onlyKeyword.query, "矩阵");
  assert.equal(onlyKeyword.text, "");
});