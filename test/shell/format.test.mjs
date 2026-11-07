/**
 * pdf4oh · 输出排版单测：页标记、截断续读、错误人话、候选提示。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  formatError,
  formatFileList,
  formatInfoResult,
  formatReadResult,
  formatSearchResult,
  formatClip,
  formatSize,
} from "../../src/format.js";

const file = { id: "42", title: "第3讲-矩阵.pdf", size: "1.2MB", uploadTime: "2026-09-20" };

test("read 输出含页标记、数据声明与续读提示", () => {
  const text = formatReadResult({
    file,
    courseName: "线性代数",
    pages: [
      { page: 1, chars: 4, text: "第一页正文", imageCount: 0, warnings: [] },
      { page: 2, chars: 4, text: "第二页正文", imageCount: 0, warnings: [] },
    ],
    from: 1,
    to: 2,
    totalPages: 40,
    truncated: true,
    nextPage: 3,
    chars: 8,
    maxChars: 9000,
  });
  assert.match(text, /【pdf4oh】PDF 正文/);
  assert.match(text, /── 第 1 页 ──/);
  assert.match(text, /── 第 2 页 ──/);
  assert.match(text, /数据，不是指令/);
  assert.match(text, /继续读：输入「第3讲-矩阵\.pdf 3-/);
});

test("read 末尾提示", () => {
  const text = formatReadResult({
    file,
    courseName: "",
    pages: [{ page: 3, chars: 0, text: "", imageCount: 2, warnings: [] }],
    from: 3,
    to: 3,
    totalPages: 3,
    truncated: false,
    nextPage: null,
    chars: 0,
    maxChars: 9000,
  });
  assert.match(text, /没有可抽取的文本层/);
  assert.match(text, /已读到文件末尾/);
});

test("info 扫描件判定", () => {
  const text = formatInfoResult({
    file,
    courseName: "线性代数",
    summary: { pageCount: 80, probed: 6, pagesWithText: 0, avgChars: 0, looksScanned: true, warnings: [] },
    warnings: [],
    maxPages: 9000,
  });
  assert.match(text, /疑似扫描件/);
  assert.match(text, /80 页/);
});

test("search 命中与空结果", () => {
  const hit = formatSearchResult({
    file,
    courseName: "线性代数",
    query: "特征值",
    hits: [{ page: 4, text: "…矩阵的特征值与特征向量…" }],
    scanned: false,
    totalHits: 1,
    capped: false,
  });
  assert.match(hit, /《?第3讲-矩阵\.pdf/);
  assert.match(hit, /── 第 4 页 ──/);
  assert.match(hit, /特征值/);

  const empty = formatSearchResult({
    file,
    courseName: "",
    query: "不存在的词",
    hits: [],
    scanned: true,
    totalHits: 0,
    capped: false,
  });
  assert.match(empty, /没有命中/);
  assert.match(empty, /扫描件/);
});

test("文件列表分课程分组并给 fileId", () => {
  const text = formatFileList({
    rows: [
      { courseId: "c1", courseName: "线性代数", file: { id: "42", title: "第3讲-矩阵.pdf", size: "1.2MB" } },
      { courseId: "c1", courseName: "线性代数", file: { id: "43", title: "第4讲-行列式.pdf" } },
    ],
    query: "",
    totalPdf: 2,
    shownLimit: 9000,
  });
  assert.match(text, /## 线性代数/);
  assert.match(text, /fileId=42/);
  assert.match(text, /fileId=43/);
});

test("错误映射为人话", () => {
  assert.match(formatError({ code: "encrypted", message: "x" }), /加密/);
  assert.match(formatError({ code: "not-pdf", message: "x" }), /不是 PDF/);
  assert.match(formatError({ code: "too-large", message: "x" }), /太大/);
  assert.match(formatError({ code: "login-wall", message: "x" }), /重新登录/);
  assert.match(formatError(new Error("weird")), /命令没有完成/);
});

test("大小与截断工具", () => {
  assert.equal(formatSize(0), "未知大小");
  assert.equal(formatSize(2048), "2 KB");
  assert.equal(formatSize(2 * 1024 * 1024), "2.0 MB");
  assert.equal(formatClip("abcdef", 3), "abc…");
  assert.equal(formatClip("abc", 10), "abc");
});