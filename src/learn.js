/**
 * pdf4oh · 网络学堂取数：课程 → 课件文件 → PDF 原始字节。
 *
 * 边界与为什么：
 *   - 只读：`learn.courses` / `learn.files` / `learn.fileContent` 三个接口，不碰任何写接口；
 *   - 字节取数优先用宿主新 API `learn.fileContent`（learn 专线：webvpn 包装域 + 原生
 *     cookie 仓 + _csrf）。旧宿主没有它时才回退 `net.fetch(downloadUrl)`——回退路径
 *     很容易拿到登录页 HTML，必须显式识别成「会话失效」，绝不能把 HTML 当 PDF 解；
 *   - 课程/文件清单有 TTL 缓存：一次 read 流程里 OH 往往先 files/info 再 read，
 *     每个命令都重新拉一遍网络学堂会白白吃掉 60 秒工具桥预算；
 *   - 同名匹配用「归一化后完全相等 > 包含 > 词元全含」三档打分；歧义时返回候选，
 *     由命令层让 OH 带更完整的文件名或 fileId 重试，不猜。
 */

import { pdfError } from "./pdf/util.js";

const LEARN_INDEX_TTL_MS = 10 * 60 * 1000;
const LEARN_FILE_FETCH_CONCURRENCY = 4;

/** 归一化文件名/课程名：去掉扩展名、空白、常见分隔符，统一大小写与全角。 */
export function normalizeLearnName(name) {
  return String(name ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\.pdf$/i, "")
    .replace(/[\s_\-—–·.，,、:：()（）[\]【】]+/g, "");
}

/** 是否是 PDF 课件（wjlx 或标题扩展名）。 */
export function isPdfLearnFile(file) {
  if (!file) return false;
  const type = String(file.fileType ?? "").trim().toLowerCase().replace(/^\./, "");
  if (type === "pdf") return true;
  return /\.pdf$/i.test(String(file.title ?? ""));
}

/** 归一化匹配分：0 表示不匹配。 */
export function scoreLearnMatch(query, title) {
  const q = normalizeLearnName(query);
  const t = normalizeLearnName(title);
  if (!q || !t) return 0;
  if (q === t) return 100;
  if (t.includes(q)) return 80 + Math.round((20 * q.length) / Math.max(t.length, 1));
  if (q.includes(t)) return 70;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((tok) => t.includes(tok))) return 60 + Math.min(tokens.length, 10);
  return 0;
}

/** base64 → 字节（插件门面只能过文本，二进制必须这样回来）。 */
export function decodeBase64Bytes(b64) {
  const text = String(b64 ?? "").replace(/\s+/g, "");
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 头部 1KB 内出现 %PDF- 才算 PDF（有些生成器前面带 BOM/杂字节）。 */
export function looksLikePdfBytes(bytes) {
  const head = bytes.subarray(0, Math.min(bytes.length, 1024));
  for (let i = 0; i + 5 <= head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) {
      return true;
    }
  }
  return false;
}

/** 登录墙/错误页判定（判据与宿主 isLoginWallBody 同源）。 */
export function looksLikeLoginWall(bytes, mime) {
  if (/pdf/i.test(String(mime ?? ""))) return false;
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 512)).trimStart();
  return /location\.href/i.test(head) || /^<(!doctype|html)/i.test(head);
}

export function isLoginishError(err) {
  const raw = err && err.message ? String(err.message) : String(err ?? "");
  return /会话|登录|login|auth|401|403|未登录|expired/i.test(raw);
}

/**
 * 课程/文件索引（带 TTL）。一个插件激活周期一份，commands 与 tab 共用。
 */
export class LearnIndex {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.ttlMs = options.ttlMs ?? LEARN_INDEX_TTL_MS;
    this.loadedAt = 0;
    /** @type {{ courses: any[], byCourse: Map<string, any[]> } | null} */
    this.data = null;
    this.loading = null;
  }

  reset() {
    this.loadedAt = 0;
    this.data = null;
    this.loading = null;
  }

  /** 拉取当前学期课程 + 每门课的课件清单（并发受限，结果缓存）。 */
  async load(force = false) {
    if (!force && this.data && Date.now() - this.loadedAt < this.ttlMs) return this.data;
    if (this.loading) return this.loading;
    this.loading = this.loadFresh().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async loadFresh() {
    const api = this.ctx.onethu.learn;
    const coursesResult = await api.courses();
    const courses = Array.isArray(coursesResult?.courses) ? coursesResult.courses : [];
    /** @type {Map<string, any[]>} */
    const byCourse = new Map();
    let cursor = 0;
    const workers = Array.from({ length: Math.min(LEARN_FILE_FETCH_CONCURRENCY, Math.max(courses.length, 1)) }, async () => {
      while (cursor < courses.length) {
        const course = courses[cursor++];
        try {
          const files = await api.files(course.id);
          byCourse.set(course.id, Array.isArray(files) ? files : []);
        } catch {
          byCourse.set(course.id, []);
        }
      }
    });
    await Promise.all(workers);
    this.data = { courses, byCourse };
    this.loadedAt = Date.now();
    return this.data;
  }

  async matchCourses(query) {
    const { courses } = await this.load();
    const q = String(query ?? "").trim();
    if (!q) return courses;
    const scored = courses
      .map((course) => ({ course, score: scoreLearnMatch(q, course.name) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.map((row) => row.course);
  }

  /** 全部 PDF 文件行：[{courseId, courseName, file}] */
  async pdfFiles(query, courseIds = null) {
    const { courses, byCourse } = await this.load();
    const names = new Map(courses.map((c) => [c.id, c.name]));
    const rows = [];
    for (const course of courses) {
      if (courseIds && !courseIds.has(course.id)) continue;
      for (const file of byCourse.get(course.id) ?? []) {
        if (!isPdfLearnFile(file)) continue;
        if (query && scoreLearnMatch(query, file.title) === 0 && scoreLearnMatch(query, course.name) === 0) continue;
        rows.push({ courseId: course.id, courseName: names.get(course.id) ?? course.name, file });
      }
    }
    rows.sort((a, b) => {
      const byCourseName = String(a.courseName).localeCompare(String(b.courseName), "zh-CN");
      if (byCourseName !== 0) return byCourseName;
      return String(b.file.uploadTime ?? "").localeCompare(String(a.file.uploadTime ?? ""));
    });
    return rows;
  }

  /**
   * 定位目标文件。
   * @param {{fileId?: string, text?: string, courseQuery?: string, fileHint?: string}} want
   * @returns {Promise<{file: any|null, course: any|null, candidates: Array<any>}>}
   */
  async resolve(want) {
    const fileId = String(want.fileId ?? "").trim();
    const query = String(want.fileHint || want.text || "").trim();
    const courseQuery = String(want.courseQuery ?? "").trim();
    const index = await this.load();

    if (fileId) {
      for (const course of index.courses) {
        const hit = (index.byCourse.get(course.id) ?? []).find((file) => String(file.id) === fileId);
        if (hit) return { file: hit, course, candidates: [] };
      }
      // 缓存里没有也允许按 fileId 直接取（例如老师刚上传）
      return {
        file: { id: fileId, title: query || `fileId=${fileId}`, downloadUrl: "" },
        course: null,
        candidates: [],
      };
    }

    const courses = courseQuery ? await this.matchCourses(courseQuery) : index.courses;
    const courseIds = courseQuery ? new Set(courses.map((c) => c.id)) : null;
    const rows = await this.pdfFiles(query, courseIds);

    if (!query) return { file: null, course: null, candidates: [] };
    if (!rows.length) return { file: null, course: null, candidates: [] };

    const scored = rows
      .map((row) => ({ ...row, score: scoreLearnMatch(query, row.file.title) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score);
    if (!scored.length) return { file: null, course: null, candidates: rows.slice(0, 8) };

    const best = scored[0];
    const second = scored[1];
    if (best.score >= 100 || !second || best.score - second.score >= 15) {
      return { file: best.file, course: { id: best.courseId, name: best.courseName }, candidates: [] };
    }
    return {
      file: null,
      course: null,
      candidates: scored.slice(0, 8).map((row) => ({ file: row.file, courseName: row.courseName, score: row.score })),
    };
  }
}

/**
 * 取 PDF 字节：优先宿主 learn.fileContent，回退 net.fetch。
 * @returns {Promise<{ bytes: Uint8Array, name: string, via: "host"|"net" }>}
 */
export async function fetchLearnPdfBytes(ctx, file, options = {}) {
  const maxBytes = options.maxBytes ?? 40 * 1024 * 1024;
  const name = String(file.title ?? file.name ?? file.id ?? "课程文件");
  let bytes = null;
  let via = "host";
  let mime = "";

  const api = ctx.onethu.learn;
  if (api && typeof api.fileContent === "function") {
    let out;
    try {
      out = await api.fileContent(String(file.id), name);
    } catch (err) {
      if (isLoginishError(err)) throw pdfError("login-wall", err.message || "learn session expired");
      throw pdfError("download-failed", err && err.message ? err.message : String(err));
    }
    if (!out || typeof out.b64 !== "string" || !out.b64) throw pdfError("download-failed", "宿主没有返回文件内容");
    mime = String(out.mime ?? "");
    bytes = decodeBase64Bytes(out.b64);
    if (out.name) file = { ...file, title: out.name };
  } else {
    via = "net";
    bytes = await fetchPdfBytesViaNet(ctx, file);
  }

  if (!bytes || !bytes.length) throw pdfError("download-failed", "文件为空");
  if (bytes.length > maxBytes) {
    throw pdfError("too-large", `${Math.round(bytes.length / (1024 * 1024))}MB > ${Math.round(maxBytes / (1024 * 1024))}MB`);
  }
  if (looksLikeLoginWall(bytes, mime)) throw pdfError("login-wall", "login page instead of pdf");
  if (!looksLikePdfBytes(bytes)) throw pdfError("not-pdf", mime || "not a pdf");
  return { bytes, name: String(file.title ?? name), via };
}

/** 旧宿主回退：net.fetch(downloadUrl)。必须自己识别登录墙与文件类型。 */
export async function fetchPdfBytesViaNet(ctx, file) {
  const url = String(file.downloadUrl ?? "").trim();
  if (!url) throw pdfError("unsupported", "缺少课件下载地址（旧宿主回退需要 downloadUrl）");
  const res = await ctx.onethu.net.fetch(url);
  const mime = (res.headers && typeof res.headers.get === "function" ? res.headers.get("content-type") : "") || "";
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (looksLikeLoginWall(bytes, mime)) throw pdfError("login-wall", "login page instead of pdf");
  if (!looksLikePdfBytes(bytes)) throw pdfError("not-pdf", mime || "not a pdf");
  return bytes;
}