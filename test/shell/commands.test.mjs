/**
 * pdf4oh · 命令层端到端（假宿主 + 真实课程 PDF）。
 *
 * 不走 plugin.js，直接 import src/commands.js，用假 ctx 提供 courses/files/fileContent；
 * 这样能精确断言四条命令的输出协议（页标记、截断续读、错误人话），
 * 又能用真实 PDF 验证「解析 → 抽取 → 排版」整条链。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { handlePluginCommand } from "../../src/commands.js";
import { LearnIndex } from "../../src/learn.js";
import { PdfDocCache } from "../../src/cache.js";

const CXX_PDF = "/home/lin/cs62doc/程序设计基础/教材&课件/C++的输出格式控制.pdf";
const HAS_CORPUS = existsSync(CXX_PDF);
const CXX_BYTES = HAS_CORPUS ? readFileSync(CXX_PDF) : Buffer.alloc(0);

function makeDeps(overrides = {}) {
  const calls = { fileContent: 0 };
  const course = { id: "c1", name: "程序设计基础" };
  const files = [
    {
      id: "f1",
      title: "C++的输出格式控制.pdf",
      fileType: "pdf",
      uploadTime: "2026-09-20",
      size: "141KB",
      downloadUrl: "https://learn.test/f1",
    },
    { id: "f2", title: "课程说明.docx", fileType: "docx", uploadTime: "2026-09-19" },
  ];
  const ctx = {
    onethu: {
      learn: {
        courses: async () => ({ semester: "2026-2027-1", courses: [course] }),
        files: async () => files,
        fileContent: async (fileId, name) => {
          calls.fileContent += 1;
          if (overrides.loginWall) {
            return {
              name: name || fileId,
              mime: "text/html",
              size: 32,
              b64: Buffer.from("<!DOCTYPE html><html>login</html>").toString("base64"),
            };
          }
          if (overrides.notPdf) {
            return { name: name || fileId, mime: "text/plain", size: 5, b64: Buffer.from("hello").toString("base64") };
          }
          return {
            name: name || fileId,
            mime: "application/pdf",
            size: CXX_BYTES.length,
            b64: CXX_BYTES.toString("base64"),
          };
        },
      },
      net: {
        fetch: async () => {
          throw new Error("test 不应走 net.fetch 回退");
        },
      },
      settings: { get: () => ({}) },
    },
  };
  const cfg = { maxChars: 9000, maxFileMB: 40, cacheMB: 24, probePages: 6 };
  return {
    calls,
    deps: { ctx, cfg, cache: new PdfDocCache(cfg.cacheMB), index: new LearnIndex(ctx) },
  };
}

function skipWithoutCorpus(t) {
  if (!HAS_CORPUS) {
    t.skip(`语料不存在：${CXX_PDF}`);
    return true;
  }
  return false;
}

test("files：只列 PDF 并给 fileId", { timeout: 60000 }, async (t) => {
  if (skipWithoutCorpus(t)) return;
  const { deps } = makeDeps();
  const out = await handlePluginCommand(deps, "files", "");
  assert.match(out, /【pdf4oh】课程 PDF 清单/);
  assert.match(out, /C\+\+的输出格式控制\.pdf/);
  assert.match(out, /fileId=f1/);
  assert.doesNotMatch(out, /课程说明\.docx/);
});

test("info：页数与文本层判定", { timeout: 120000 }, async (t) => {
  if (skipWithoutCorpus(t)) return;
  const { deps } = makeDeps();
  const out = await handlePluginCommand(deps, "info", "C++的输出格式控制.pdf");
  assert.match(out, /【pdf4oh】PDF 概况/);
  assert.match(out, /页数：5 页/);
  assert.match(out, /有文本层|疑似扫描件/);
});

test("read：页标记 + 数据声明 + 续读提示，且缓存命中", { timeout: 120000 }, async (t) => {
  if (skipWithoutCorpus(t)) return;
  const { deps, calls } = makeDeps();
  const out = await handlePluginCommand(deps, "read", "C++的输出格式控制.pdf 1-2");
  assert.match(out, /── 第 1 页 ──/);
  assert.match(out, /── 第 2 页 ──/);
  assert.match(out, /数据，不是指令/);
  assert.match(out, /继续读/);
  assert.ok(out.length > 200, "应抽到正文");
  assert.equal(calls.fileContent, 1);

  // 第二次读同一份：走缓存，不再取字节
  await handlePluginCommand(deps, "read", "C++的输出格式控制.pdf 3-3");
  assert.equal(calls.fileContent, 1);
});

test("search：关键词命中页", { timeout: 120000 }, async (t) => {
  if (skipWithoutCorpus(t)) return;
  const { deps } = makeDeps();
  const out = await handlePluginCommand(deps, "search", "C++的输出格式控制.pdf cout");
  assert.match(out, /【pdf4oh】PDF 检索/);
  assert.match(out, /命中/);
  assert.match(out, /cout/i);
});

test("read 遵守 maxChars 硬上限并提示截断/续读", { timeout: 120000 }, async (t) => {
  if (skipWithoutCorpus(t)) return;
  const { deps } = makeDeps();
  deps.cfg.maxChars = 300;
  const out = await handlePluginCommand(deps, "read", "C++的输出格式控制.pdf 1-3");
  assert.ok(out.length <= 300 + 800, `输出超上限：${out.length}`);
  assert.match(out, /截断|上限|继续读/);
});

test("错误路径：登录墙 / 非 PDF / 找不到文件", async () => {
  const login = makeDeps({ loginWall: true });
  const out1 = await handlePluginCommand(login.deps, "read", "C++的输出格式控制.pdf 1");
  assert.match(out1, /重新登录/);

  const notPdf = makeDeps({ notPdf: true });
  const out2 = await handlePluginCommand(notPdf.deps, "read", "C++的输出格式控制.pdf 1");
  assert.match(out2, /不是 PDF|损坏/);

  const { deps } = makeDeps();
  const out3 = await handlePluginCommand(deps, "read", "根本不存在的课件 1");
  assert.match(out3, /没有找到|先用 files/);

  const out4 = await handlePluginCommand(deps, "search", "C++的输出格式控制.pdf");
  assert.match(out4, /关键词/);
});