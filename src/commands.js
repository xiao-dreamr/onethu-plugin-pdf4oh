/**
 * pdf4oh · 四个 OH 命令的实现（files / info / read / search）。
 *
 * 分层：本文件只做「解析输入 → 取字节/开文档 → 调 PDF 层 → 排版」，
 * 不自己解析 PDF，也不直接碰 DOM；PDF 层异常统一抛 PdfError(code)，
 * 由 handlePluginCommand 翻译成人话（format.formatError）。
 *
 * 为什么默认只读 1–3 页：OH 的上下文预算是有限的，一份 60 页课件一次全塞进去
 * 既慢又贵；read 支持页码范围 + 续读提示，让模型按需分块读。
 */

import { loadPdf } from "./pdf/document.js";
import { prepareFontMatching } from "./pdf/fontmatch.js";
import { extractRangeText, probeDocument, searchDocument } from "./pdf/text.js";
import { pdfError } from "./pdf/util.js";
import {
  parseCommandInput,
  parseSearchInput,
  briefInput,
} from "./args.js";
import {
  formatClip,
  formatError,
  formatFileList,
  formatHostError,
  formatInfoResult,
  formatReadResult,
  formatSearchResult,
  formatTitleLine,
} from "./format.js";
import { fetchLearnPdfBytes } from "./learn.js";

const CMD_DEFAULT_READ_PAGES = 3;
const CMD_MAX_LIST_ROWS = 40;
const CMD_SEARCH_HITS = 20;

/** 注册给宿主的命令表（顺序即管理页展示顺序）。 */
export function buildCommandList(deps) {
  return [
    {
      id: "files",
      title: "列出网络学堂课程里的 PDF 文件（输入课程名关键词，空=全部课程）",
      inputLabel: "课程名关键词（可空）",
      inputPlaceholder: "例如：线性代数（留空=全部课程）",
      run: (input) => runFilesCommand(deps, input),
    },
    {
      id: "info",
      title: "查看课程 PDF 概况：页数/可读文本页/是否扫描件（输入文件名或 fileId）",
      inputLabel: "文件名或 fileId",
      inputPlaceholder: "例如：第3讲 或 fileId=123456",
      run: (input) => runInfoCommand(deps, input),
    },
    {
      id: "read",
      title: "读取课程 PDF 正文（输入：文件名或 fileId，可带页码范围，如「第3讲 1-6」）",
      inputLabel: "文件名 [页码]，如：第3讲 1-6",
      inputPlaceholder: "例如：线性代数 1-6 / fileId=123 pages=2-5",
      run: (input) => runReadCommand(deps, input),
    },
    {
      id: "search",
      title: "在课程 PDF 内检索关键词并返回命中页上下文（输入：文件名 关键词）",
      inputLabel: "文件名 关键词",
      inputPlaceholder: "例如：第3讲 矩阵",
      run: (input) => runSearchCommand(deps, input),
    },
  ];
}

export async function handlePluginCommand(deps, cmdId, rawInput) {
  const input = String(rawInput ?? "");
  const command = buildCommandList(deps).find((item) => item.id === cmdId);
  if (!command) {
    return `${formatTitleLine("未完成")}\n未知命令 ${formatClip(cmdId, 40)}。可用命令：files / info / read / search。`;
  }
  try {
    return await command.run(input);
  } catch (err) {
    if (err && typeof err.code === "string") return formatError(err);
    return `${formatTitleLine("未完成")}\n${formatHostError(err)}`;
  }
}

/** 打开（或从缓存取）文档条目。 */
async function openDocument(deps, file) {
  const key = `learn:${file.id}`;
  const cached = deps.cache.get(key);
  if (cached) return cached;

  const { bytes } = await fetchLearnPdfBytes(deps.ctx, file, {
    maxBytes: deps.cfg.maxFileMB * 1024 * 1024,
  });
  const doc = loadPdf(bytes, { maxBytes: deps.cfg.maxFileMB * 1024 * 1024 });
  /* 中文 PDF 可能没有 ToUnicode：先准备"系统字体轮廓匹配"（宿主允许时），
     再进抽取；失败不抛错，字体层按 U+FFFD 降级并给 warning。 */
  try {
    await prepareFontMatching(doc, deps.ctx);
  } catch {
    /* 匹配是增强项，坏了不能挡住打开文档 */
  }
  const entry = {
    key,
    name: file.title,
    size: bytes.length,
    bytesLen: bytes.length,
    doc,
    pages: new Map(),
  };
  deps.cache.set(key, entry);
  return entry;
}

/** 目标不唯一/不存在时的候选清单。 */
function formatTargetCandidates(parsed, candidates) {
  if (!candidates || !candidates.length) {
    return `${formatTitleLine("未完成")}\n没有找到匹配「${briefInput(parsed.text || parsed.fileId || "")}」的 PDF 课件。先用 files 命令列出课程 PDF（可按课程名筛选），再用完整文件名或 fileId 调 read。`;
  }
  const lines = [
    formatTitleLine("需要更明确的目标"),
    `「${briefInput(parsed.text || "")}」匹配到多份 PDF，请用更完整的文件名，或直接传 fileId：`,
  ];
  for (const row of candidates.slice(0, 8)) {
    lines.push(`- ${row.file.title} · ${row.courseName ?? ""} · fileId=${row.file.id}`);
  }
  lines.push("例如：read 输入「完整文件名 1-6」或「fileId=123456 pages=1-6」。");
  return lines.join("\n");
}

/** 解析目标并给出「找不到时的回复文本」。 */
async function resolveOrHint(deps, parsed) {
  const target = await deps.index.resolve({
    fileId: parsed.fileId,
    text: parsed.text,
    courseQuery: parsed.courseQuery,
    fileHint: parsed.fileHint,
  });
  if (target.file) return { target };
  return { hint: formatTargetCandidates(parsed, target.candidates) };
}

async function runFilesCommand(deps, rawInput) {
  const parsed = parseCommandInput(rawInput);
  const query = parsed.text || parsed.courseQuery || "";
  const rows = await deps.index.pdfFiles(query);
  if (!rows.length && query) {
    // 课程名匹配不到时，再给一次"是不是课程名"的机会：直接列出全部课程里的 PDF 供挑选
    const all = await deps.index.pdfFiles("");
    if (all.length) {
      return formatFileList({
        rows: all.slice(0, CMD_MAX_LIST_ROWS),
        query: "",
        totalPdf: all.length,
        shownLimit: deps.cfg.maxChars + 400,
      });
    }
  }
  return formatFileList({
    rows: rows.slice(0, CMD_MAX_LIST_ROWS),
    query,
    totalPdf: rows.length,
    shownLimit: deps.cfg.maxChars + 400,
  });
}

async function runInfoCommand(deps, rawInput) {
  const parsed = parseCommandInput(rawInput);
  if (!parsed.text && !parsed.fileId) {
    return `${formatTitleLine("未完成")}\n请给出文件信息：info 输入「文件名」或「fileId=123456」。可以先用 files 列出课程 PDF。`;
  }
  const { target, hint } = await resolveOrHint(deps, parsed);
  if (hint) return hint;
  const entry = await openDocument(deps, target.file);
  const summary = probeDocument(entry.doc, { maxPages: deps.cfg.probePages });
  return formatInfoResult({
    file: target.file,
    courseName: target.course ? target.course.name : "",
    summary,
    warnings: entry.doc.warnings,
    maxPages: deps.cfg.maxChars,
  });
}

async function runReadCommand(deps, rawInput) {
  const parsed = parseCommandInput(rawInput);
  const { target, hint } = await resolveOrHint(deps, parsed);
  if (hint) return hint;

  const entry = await openDocument(deps, target.file);
  const totalPages = entry.doc.pageCount;
  if (!totalPages) throw pdfError("malformed", "文档没有可解析的页面");

  const from = parsed.pages ? Math.min(Math.max(1, parsed.pages.from), totalPages) : 1;
  const toWanted = parsed.pages
    ? parsed.pages.to
      ? Math.min(parsed.pages.to, totalPages)
      : totalPages
    : Math.min(CMD_DEFAULT_READ_PAGES, totalPages);
  const to = Math.max(from, toWanted);
  if (parsed.pages && parsed.pages.from > totalPages) {
    return `${formatTitleLine("未完成")}\n这份 PDF 只有 ${totalPages} 页，没有第 ${parsed.pages.from} 页。可以 read 输入「${target.file.title} 1-${Math.min(6, totalPages)}」。`;
  }

  const result = extractRangeText(entry.doc, {
    from,
    to,
    maxChars: parsed.maxChars ?? deps.cfg.maxChars,
  });
  for (const page of result.pages) deps.cache.pageText(entry, page.page, () => page);

  const allEmpty = result.pages.every((page) => !page.chars);
  const text = formatReadResult({
    file: target.file,
    courseName: target.course ? target.course.name : "",
    pages: result.pages,
    from: result.from,
    to: result.to,
    totalPages,
    truncated: result.truncated,
    nextPage: result.nextPage,
    chars: result.chars,
    maxChars: parsed.maxChars ?? deps.cfg.maxChars,
  });
  return allEmpty
    ? `${text}\n判定：这几页都没有文本层，可能是扫描件/图片型 PDF。先用 info 看整份是不是扫描件；插件只能读文字。`
    : text;
}

async function runSearchCommand(deps, rawInput) {
  const parsed = parseSearchInput(rawInput);
  if (!parsed.query) {
    return `${formatTitleLine("未完成")}\nsearch 需要一个关键词：输入「文件名 关键词」，例如「第3讲 矩阵」。`;
  }
  if (!parsed.text && !parsed.fileId) {
    return `${formatTitleLine("未完成")}\nsearch 需要同时给出文件名与关键词：输入「文件名 关键词」，例如「第3讲 矩阵」；先 files 列出课程 PDF 再选一份。`;
  }
  const { target, hint } = await resolveOrHint(deps, parsed);
  if (hint) return hint;

  const entry = await openDocument(deps, target.file);
  const result = searchDocument(entry.doc, {
    query: parsed.query,
    maxHits: CMD_SEARCH_HITS,
    contextChars: 80,
  });
  return formatSearchResult({
    file: target.file,
    courseName: target.course ? target.course.name : "",
    query: parsed.query,
    hits: result.hits,
    scanned: result.scanned,
    totalHits: result.totalHits,
    capped: result.capped,
  });
}