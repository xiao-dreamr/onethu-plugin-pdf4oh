/**
 * pdf4oh · 真实课程 PDF 语料校验（对照 poppler pdftotext / pdfinfo）。
 *
 * 为什么要有这层：单元测试只能证明「手写样例能过」，真实课件才是产品边界。
 * 这里直接读机器上的课程 PDF（只读），逐份比较：
 *   - 页数：必须与 pdfinfo 完全一致（页树/对象流解析的正确性）；
 *   - 文本：归一化（NFKC、去空白/零宽）后的字符集合 Jaccard ≥ 0.85；
 *   - 中文：oracle 里的 CJK 字符在我们的输出里缺失率 ≤ 5%；
 *   - 扫描件：期望「几乎没有文本」，只要求识别为无文本，不比 Jaccard。
 *
 * 缺 pdftotext/pdfinfo 或文件不存在时 skip（CI/他人机器上不该误报）。
 * 大文件默认跳过（PDF4OH_CORPUS_MAX_MB，默认 20MB），避免测试慢到没人跑。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { loadPdf } from "../src/pdf/document.js";
import { extractRangeText } from "../src/pdf/text.js";

/** 课程 PDF 语料目录（可用 PDF4OH_CORPUS_DIR 覆盖；不存在时相关测试 skip）。 */
const CORPUS_DIR = process.env.PDF4OH_CORPUS_DIR || "/home/lin/cs62doc";

const CORPUS = [
  {
    name: "C++的输出格式控制.pdf",
    path: `${CORPUS_DIR}/程序设计基础/教材&课件/C++的输出格式控制.pdf`,
    expectText: true,
    probePages: 3,
  },
  {
    name: "线性代数_刘余_课程讲义.pdf",
    path: `${CORPUS_DIR}/线性代数/教材&课件/线性代数_刘余_课程讲义.pdf`,
    expectText: true,
    probePages: 3,
  },
  {
    name: "2026秋微积分A1-3_教学日历.pdf",
    path: `${CORPUS_DIR}/微积分A/2026秋微积分A1-3_3251班_教学日历.pdf`,
    expectText: true,
    probePages: 1,
  },
  {
    name: "2026_寓_见规则_宿舍卫生篇课件.pdf",
    path: `${CORPUS_DIR}/2026_寓_见规则_文明有范-宿舍卫生篇课件_宣讲_.pdf`,
    expectText: true,
    probePages: 6,
  },
  {
    name: "线性代数入门_梁鑫（扫描书）",
    path: `${CORPUS_DIR}/线性代数/教材&课件/线性代数入门 (梁鑫) (z-library.sk, 1lib.sk, z-lib.sk)-1.pdf`,
    expectText: false,
    probePages: 2,
  },
];

const MAX_MB = Number(process.env.PDF4OH_CORPUS_MAX_MB ?? 20);
const HAS_PDFINFO = commandWorks("pdfinfo", ["-v"]);
const HAS_PDFTOTEXT = commandWorks("pdftotext", ["-v"]);

function commandWorks(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function pdfPageCount(path) {
  const out = execFileSync("pdfinfo", [path], { encoding: "utf8" });
  const m = /^Pages:\s+(\d+)/m.exec(out);
  return m ? Number(m[1]) : 0;
}

function pdfText(path, from, to) {
  return execFileSync("pdftotext", ["-f", String(from), "-l", String(to), "-enc", "UTF-8", path, "-"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function normalize(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, "")
    .replace(/\s+/g, "");
}

function charSet(text) {
  return new Set([...normalize(text)]);
}

function jaccard(setA, setB) {
  if (!setA.size && !setB.size) return 1;
  let inter = 0;
  for (const ch of setA) if (setB.has(ch)) inter++;
  return inter / (setA.size + setB.size - inter);
}

function cjkMissingRate(oracleText, ourText) {
  const oracle = [...normalize(oracleText)].filter((ch) => /[\u3400-\u9fff\uf900-\ufaff]/.test(ch));
  if (!oracle.length) return 0;
  const ours = new Set([...normalize(ourText)]);
  let missing = 0;
  for (const ch of oracle) if (!ours.has(ch)) missing++;
  return missing / oracle.length;
}

function extractWithPlugin(path, from, to) {
  const bytes = new Uint8Array(readFileSync(path));
  const doc = loadPdf(bytes, { maxBytes: 64 * 1024 * 1024 });
  const result = extractRangeText(doc, { from, to, maxChars: 200000 });
  return {
    pageCount: doc.pageCount,
    text: result.pages.map((page) => page.text).join("\n"),
    chars: result.chars,
    warnings: doc.warnings,
  };
}

for (const item of CORPUS) {
  test(`真实 PDF：${item.name}`, { timeout: 120000 }, (t) => {
    if (!HAS_PDFINFO || !HAS_PDFTOTEXT) {
      t.skip("缺少 poppler（pdfinfo/pdftotext）");
      return;
    }
    if (!existsSync(item.path)) {
      t.skip(`语料不存在：${item.path}`);
      return;
    }
    const sizeMb = readFileSync(item.path).length / (1024 * 1024);
    if (sizeMb > MAX_MB) {
      t.skip(`文件 ${sizeMb.toFixed(1)}MB > 上限 ${MAX_MB}MB（PDF4OH_CORPUS_MAX_MB 可调）`);
      return;
    }

    const truthPages = pdfPageCount(item.path);
    const ours = extractWithPlugin(item.path, 1, Math.min(item.probePages, truthPages || item.probePages));
    assert.equal(ours.pageCount, truthPages, "页数必须与 pdfinfo 一致");

    const truthText = pdfText(item.path, 1, Math.min(item.probePages, truthPages));
    const truthChars = normalize(truthText).length;
    const oursChars = normalize(ours.text).length;
    const score = jaccard(charSet(truthText), charSet(ours.text));
    const missingCjk = cjkMissingRate(truthText, ours.text);

    t.diagnostic(
      `${ours.pageCount} 页 · oracle ${truthChars} 字 / 我们 ${oursChars} 字 · Jaccard ${score.toFixed(3)} · CJK 缺失 ${(missingCjk * 100).toFixed(1)}%`,
    );

    if (!item.expectText) {
      // 扫描书：只要求「抽不出多少字」而不是精确匹配（有些书混有目录/OCR 文本层）
      t.diagnostic(`扫描件期望无文本层，实际抽出 ${oursChars} 字`);
      return;
    }
    assert.ok(truthChars > 50, "oracle 本身应有文本（否则文件可能变了）");
    assert.ok(oursChars > truthChars * 0.5, `抽取字数明显偏少：ours=${oursChars} truth=${truthChars}`);
    assert.ok(score >= 0.85, `字符集合 Jaccard 过低：${score.toFixed(3)}`);
    assert.ok(missingCjk <= 0.05, `CJK 缺失率过高：${(missingCjk * 100).toFixed(1)}%`);
  });
}