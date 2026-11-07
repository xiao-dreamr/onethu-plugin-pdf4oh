/**
 * pdf4oh · 取数单测：课程/文件索引、匹配打分、字节获取与登录墙识别。
 * 用假 ctx，不联网。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  LearnIndex,
  fetchLearnPdfBytes,
  isPdfLearnFile,
  scoreLearnMatch,
  looksLikePdfBytes,
  looksLikeLoginWall,
} from "../../src/learn.js";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const toB64 = (bytes) => Buffer.from(bytes).toString("base64");

function makeCtx(overrides = {}) {
  const calls = { courses: 0, files: 0, fileContent: 0, net: 0 };
  const filesByCourse = {
    c1: [
      { id: "f1", title: "第3讲-矩阵.pdf", fileType: "pdf", uploadTime: "2026-09-20", size: "1.2MB", downloadUrl: "https://learn.test/f1" },
      { id: "f2", title: "作业1.docx", fileType: "docx", uploadTime: "2026-09-19" },
    ],
    c2: [
      { id: "f3", title: "链表与树.pdf", fileType: "pdf", uploadTime: "2026-09-18" },
      { id: "f4", title: "讲义", fileType: "", downloadUrl: "https://learn.test/f4" },
      { id: "f5", title: "第3讲-矩阵习题.pdf", fileType: "pdf", uploadTime: "2026-09-17" },
    ],
  };
  const ctx = {
    onethu: {
      learn: {
        courses: async () => {
          calls.courses += 1;
          return {
            semester: "2026-2027-1",
            courses: [
              { id: "c1", name: "线性代数" },
              { id: "c2", name: "数据结构" },
            ],
          };
        },
        files: async (courseId) => {
          calls.files += 1;
          return filesByCourse[courseId] ?? [];
        },
        fileContent: async (fileId, name) => {
          calls.fileContent += 1;
          return { name: name || fileId, mime: "application/pdf", size: PDF_BYTES.length, b64: toB64(PDF_BYTES) };
        },
      },
      net: {
        fetch: async () => {
          calls.net += 1;
          return new Response(PDF_BYTES, { headers: { "content-type": "application/pdf" } });
        },
      },
    },
  };
  Object.assign(ctx.onethu.learn, overrides.learn ?? {});
  Object.assign(ctx.onethu.net, overrides.net ?? {});
  return { ctx, calls };
}

test("PDF 判定：fileType 或扩展名", () => {
  assert.equal(isPdfLearnFile({ fileType: "pdf" }), true);
  assert.equal(isPdfLearnFile({ fileType: ".PDF" }), true);
  assert.equal(isPdfLearnFile({ title: "讲义.PDF" }), true);
  assert.equal(isPdfLearnFile({ title: "作业.docx", fileType: "docx" }), false);
  assert.equal(isPdfLearnFile(null), false);
});

test("匹配打分：完全相等 > 包含 > 无", () => {
  assert.ok(scoreLearnMatch("第3讲", "第3讲-矩阵.pdf") >= 80);
  assert.equal(scoreLearnMatch("链表与树.pdf", "链表与树.pdf"), 100);
  assert.ok(scoreLearnMatch("矩阵", "第3讲-矩阵.pdf") >= 80);
  assert.ok(scoreLearnMatch("线性 代数", "线性代数") >= 60);
  assert.equal(scoreLearnMatch("数据结构", "第3讲-矩阵.pdf"), 0);
});

test("索引带 TTL 缓存：第二次不再打网络学堂", async () => {
  const { ctx, calls } = makeCtx();
  const index = new LearnIndex(ctx);
  await index.load();
  await index.load();
  assert.equal(calls.courses, 1);
  assert.equal(calls.files, 2);
});

test("pdfFiles 过滤非 PDF 并支持课程/文件名筛选", async () => {
  const { ctx } = makeCtx();
  const index = new LearnIndex(ctx);
  const all = await index.pdfFiles("");
  assert.deepEqual(all.map((row) => row.file.id).sort(), ["f1", "f3", "f5"]);
  const byCourse = await index.pdfFiles("线性代数");
  assert.deepEqual(byCourse.map((row) => row.file.id), ["f1"]);
  const byTitle = await index.pdfFiles("链表");
  assert.deepEqual(byTitle.map((row) => row.file.id), ["f3"]);
});

test("resolve：唯一命中 / 歧义 / fileId 直取 / 找不到", async () => {
  const { ctx } = makeCtx();
  const index = new LearnIndex(ctx);

  const exact = await index.resolve({ text: "第3讲-矩阵.pdf" });
  assert.equal(exact.file.id, "f1");
  assert.equal(exact.course.name, "线性代数");

  const ambiguous = await index.resolve({ text: "第3讲" });
  assert.equal(ambiguous.file, null);
  assert.ok(ambiguous.candidates.length >= 2);

  const byId = await index.resolve({ fileId: "f1" });
  assert.equal(byId.file.id, "f1");

  const unknownId = await index.resolve({ fileId: "nope" });
  assert.equal(unknownId.file.id, "nope");
  assert.equal(unknownId.course, null);

  const none = await index.resolve({ text: "完全不存在的课件" });
  assert.equal(none.file, null);
});

test("fetchLearnPdfBytes：宿主 API 路径", async () => {
  const { ctx, calls } = makeCtx();
  const out = await fetchLearnPdfBytes(ctx, { id: "f1", title: "第3讲-矩阵.pdf" });
  assert.equal(out.via, "host");
  assert.equal(out.name, "第3讲-矩阵.pdf");
  assert.ok(looksLikePdfBytes(out.bytes));
  assert.equal(calls.fileContent, 1);
});

test("fetchLearnPdfBytes：登录墙 / 非 PDF / 超限", async () => {
  const login = makeCtx({
    learn: {
      fileContent: async () => ({
        name: "x",
        mime: "text/html",
        size: 40,
        b64: toB64(new TextEncoder().encode("<!DOCTYPE html><html>登录</html>")),
      }),
    },
  });
  await assert.rejects(
    () => fetchLearnPdfBytes(login.ctx, { id: "f1", title: "x.pdf" }),
    (err) => err.code === "login-wall",
  );

  const notPdf = makeCtx({
    learn: {
      fileContent: async () => ({ name: "x", mime: "application/octet-stream", size: 4, b64: toB64(new Uint8Array([1, 2, 3, 4])) }),
    },
  });
  await assert.rejects(
    () => fetchLearnPdfBytes(notPdf.ctx, { id: "f1", title: "x.pdf" }),
    (err) => err.code === "not-pdf",
  );

  const huge = makeCtx();
  await assert.rejects(
    () => fetchLearnPdfBytes(huge.ctx, { id: "f1", title: "x.pdf" }, { maxBytes: 8 }),
    (err) => err.code === "too-large",
  );
});

test("fetchLearnPdfBytes：旧宿主回退 net.fetch", async () => {
  const { ctx, calls } = makeCtx({ learn: { fileContent: undefined } });
  const out = await fetchLearnPdfBytes(ctx, { id: "f1", title: "第3讲-矩阵.pdf", downloadUrl: "https://learn.test/f1" });
  assert.equal(out.via, "net");
  assert.equal(calls.net, 1);
  assert.ok(looksLikePdfBytes(out.bytes));
});

test("looksLikeLoginWall 只对 HTML/跳转页成立", () => {
  const enc = (s) => new TextEncoder().encode(s);
  assert.equal(looksLikeLoginWall(enc("<!DOCTYPE html><html></html>"), "text/html"), true);
  assert.equal(looksLikeLoginWall(enc("location.href='/'"), ""), true);
  assert.equal(looksLikeLoginWall(PDF_BYTES, "application/pdf"), false);
});