/**
 * pdf4oh · 排版层：把内容流片段拼成"人能读的正文"，并对外提供 4 个契约 API。
 *
 * 职责与边界（why）：
 *   - content.js 只给出"某段文字画在页面哪个位置"，一份幻灯片里各段文字是散点。
 *     阅读顺序要靠几何还原：先按 y 聚行（容差随字号变，避免上下标被拆开），行内
 *     按 x 排序，行间 y 差过大就插空行——这才是用户/模型能读的"正文"。
 *   - 空格规则是中文课件的关键：中文字体常把整句画成一个字符串、字距靠 TJ 微调，
 *     若一律按几何补空格，中文句子里会满是空格，检索与阅读都会崩。因此 CJK 与
 *     CJK 相邻一律不补空格，只有"西文之间确有 0.15em 以上空隙"才补一个空格
 *     （这正是 PDF 用 TJ 位移表示词间空格的常见写法）。
 *   - 本模块依赖契约 §4 的 doc.getPage/getPageContentBytes 与 content.js；不解析
 *     PDF 对象、不碰字体细节。空页返回 text:"" 且不抛异常——课件里空白页很常见。
 *   - 超大文档由调用方（命令层）用 maxChars 分页续读；这里保证"按页边界截断、
 *     已取出的页完整返回、下一步从哪页继续"的语义稳定。
 */

import { clamp, isStream } from "./util.js";
import { glyphIsCjk, glyphIsSpace } from "./glyphs.js";
import { runContentStream } from "./content.js";

/** 行内 y 容差：字号 × 该系数（上下标/字号混排不会被拆成两行）。 */
const TEXT_LINE_TOLERANCE = 0.35;

/** 行间距超过"字号 × 该系数"时插一个空行（段落分隔）。 */
const TEXT_PARAGRAPH_GAP = 1.8;

/** 行内两段之间超过"字号 × 该系数"的空隙，视为词间空格（TJ 位移 > 0.15em）。 */
const TEXT_SPACE_GAP = 0.15;

/** 契约默认值。 */
const TEXT_MAX_CHARS_DEFAULT = 9000;
const TEXT_PROBE_PAGES_DEFAULT = 6;
const TEXT_SEARCH_HITS_DEFAULT = 20;
const TEXT_SEARCH_CONTEXT_DEFAULT = 60;

/** "有文本"的判定阈值：少于这么多字符的页在 probe 里不算文本页。 */
const TEXT_PAGE_TEXT_MIN = 20;

/** 扫描件判定：探测页平均字符数低于此值，且多数页有图。 */
const TEXT_SCANNED_AVG_CHARS = 60;

/** 扫描件判定：有图页占比达到此值。 */
const TEXT_SCANNED_IMAGE_RATIO = 0.5;

/** 扫描件判定：有文本的页占比不超过此值（否则只是排版稀疏，不是扫描件）。 */
const TEXT_SCANNED_TEXT_PAGE_RATIO = 0.25;

/** 页内容字节：优先 core 的 getPageContentBytes，缺失时自己按 /Contents 拼。 */
function TEXT_pageContentBytes(doc, page) {
  try {
    if (doc && typeof doc.getPageContentBytes === "function") {
      const bytes = doc.getPageContentBytes(page);
      if (bytes && bytes.length > 0) return bytes;
    }
  } catch (e) {
    // core 解不开就自己试，别因为一个辅助方法失败丢整页
  }
  const dict = page && page.dict;
  let contents;
  if (dict instanceof Map) contents = dict.get("Contents");
  else if (dict && dict.t === "dict" && dict.m instanceof Map) contents = dict.m.get("Contents");
  if (contents === undefined) return new Uint8Array(0);
  const resolved = doc && typeof doc.resolve === "function" ? doc.resolve(contents) : contents;
  const list = Array.isArray(resolved) ? resolved : [resolved];
  const parts = [];
  for (const item of list) {
    const stream = doc && typeof doc.resolve === "function" ? doc.resolve(item) : item;
    if (!isStream(stream)) continue;
    let bytes = null;
    try {
      if (doc && typeof doc.tryDecodeStream === "function") bytes = doc.tryDecodeStream(stream);
      else if (doc && typeof doc.decodeStream === "function") bytes = doc.decodeStream(stream);
    } catch (e) {
      bytes = null;
    }
    if (!bytes || bytes.length === 0) bytes = stream.raw || null;
    if (bytes && bytes.length > 0) parts.push(bytes);
  }
  if (parts.length === 0) return new Uint8Array(0);
  if (parts.length === 1) return parts[0];
  const pieces = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) pieces.push(new Uint8Array([0x0a]));
    pieces.push(parts[i]);
  }
  let total = 0;
  for (const p of pieces) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of pieces) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** 相邻两段之间要不要补一个空格。 */
function TEXT_needsSpace(lastChar, firstChar, gap, fontSize) {
  if (!lastChar || !firstChar) return false;
  if (glyphIsSpace(lastChar) || glyphIsSpace(firstChar)) return false;
  // CJK↔CJK：中文排版不补空格；两个汉字被拆成两段是常态
  if (glyphIsCjk(lastChar) && glyphIsCjk(firstChar)) return false;
  // 西文（或西文与 CJK 交界）：PDF 用 TJ 位移表示词间空格，>0.15em 才补
  return gap > fontSize * TEXT_SPACE_GAP;
}

/** 行内按 x 排序后用空格规则拼成一行文本。 */
function TEXT_joinLine(line) {
  const items = line.items.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  let out = "";
  let prev = null;
  for (const item of items) {
    if (item.text.length === 0) continue;
    if (out.length === 0) {
      out = item.text;
      prev = item;
      continue;
    }
    const fontSize = Math.max(prev.fontSize, item.fontSize, 1);
    const gap = item.x - (prev.x + prev.w);
    if (TEXT_needsSpace(out[out.length - 1], item.text[0], gap, fontSize)) out += " ";
    out += item.text;
    prev = item;
  }
  return out;
}

/** 把 item 列表聚成行并按阅读顺序拼成整页文本。 */
function TEXT_assembleItems(items) {
  const usable = items.filter((item) => item && typeof item.text === "string" && item.text.length > 0);
  if (usable.length === 0) return "";

  // 先按显示坐标排序：y 向下，所以 y 小的在前（页面上方）；同一行内按 x
  const sorted = usable.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  let line = null;
  for (const item of sorted) {
    const itemFont = item.fontSize > 0 ? item.fontSize : 10;
    if (!line) {
      line = { items: [item], ySum: item.y, fontSize: itemFont };
      continue;
    }
    const lineY = line.ySum / line.items.length;
    const tolerance = Math.max(line.fontSize, itemFont) * TEXT_LINE_TOLERANCE;
    if (Math.abs(item.y - lineY) <= tolerance) {
      line.items.push(item);
      line.ySum += item.y;
      if (itemFont > line.fontSize) line.fontSize = itemFont;
    } else {
      lines.push(line);
      line = { items: [item], ySum: item.y, fontSize: itemFont };
    }
  }
  if (line) lines.push(line);

  let out = "";
  let prevLine = null;
  for (const current of lines) {
    const text = TEXT_joinLine(current).replace(/[ \t\u00A0]+$/g, "").replace(/^[ \t\u00A0]+/g, "");
    if (text.length === 0) continue;
    const y = current.ySum / current.items.length;
    if (out.length > 0) {
      const fontSize = Math.max(prevLine.fontSize, current.fontSize, 1);
      const gap = y - prevLine.y;
      out += gap > fontSize * TEXT_PARAGRAPH_GAP ? "\n\n" : "\n";
    }
    out += text;
    prevLine = { y, fontSize: current.fontSize };
  }
  return out;
}

/** 一页的原始抽取：items + 图片数 + warnings（对外 API 的公共内核）。 */
function TEXT_pageData(doc, pageIndex) {
  const page = doc.getPage(pageIndex);
  const bytes = TEXT_pageContentBytes(doc, page);
  const run = runContentStream(doc, page, bytes, { resources: page.resources });
  return { page, bytes, run, text: TEXT_assembleItems(run.items) };
}

/**
 * 抽取单页正文（CONTRACT §5）。
 * @returns {{page:number, chars:number, text:string, imageCount:number, warnings:string[]}}
 */
export function extractPageText(doc, pageIndex, opts) {
  const options = opts || {};
  const warnings = [];
  let text = "";
  let imageCount = 0;
  try {
    const data = TEXT_pageData(doc, pageIndex);
    text = data.text;
    imageCount = data.run.imageCount;
    for (const note of data.run.warnings) warnings.push(note);
  } catch (e) {
    // 单页坏掉不能炸整篇：给空文本 + warning，命令层会把它当作"该页无文本"
    warnings.push(`第 ${pageIndex + 1} 页抽取失败：${e && e.message ? e.message : String(e)}`);
  }
  if (typeof options.maxChars === "number" && options.maxChars > 0 && text.length > options.maxChars) {
    text = text.slice(0, options.maxChars);
  }
  return { page: pageIndex + 1, chars: text.length, text, imageCount, warnings };
}

/**
 * 按页范围抽取（CONTRACT §5）：逐页累加，超过 maxChars 时停在页边界，
 * 已取出的页文本保持完整，nextPage 指向下一页。
 */
export function extractRangeText(doc, opts) {
  const options = opts || {};
  const totalPages = typeof doc.pageCount === "number" ? doc.pageCount : 0;
  const maxChars = typeof options.maxChars === "number" && options.maxChars > 0 ? options.maxChars : TEXT_MAX_CHARS_DEFAULT;
  const requestedFrom = typeof options.from === "number" && Number.isFinite(options.from) ? Math.trunc(options.from) : 1;
  const requestedTo = typeof options.to === "number" && Number.isFinite(options.to) ? Math.trunc(options.to) : totalPages;

  if (totalPages <= 0) {
    return { pages: [], from: 1, to: 0, totalPages: 0, chars: 0, truncated: false, nextPage: null };
  }
  // from 超出总页数时不要"夹到最后一页"：调用方多半是页码写错了，
  // 返回空页列表 + from/to 让它能给出"页码超出范围"的提示。
  const from = Math.max(1, requestedFrom);
  if (from > totalPages) {
    return { pages: [], from, to: from - 1, totalPages, chars: 0, truncated: false, nextPage: null };
  }
  const to = clamp(requestedTo, from, totalPages);

  const pages = [];
  let chars = 0;
  let truncated = false;
  let nextPage = null;
  for (let pageNumber = from; pageNumber <= to; pageNumber++) {
    const pageText = extractPageText(doc, pageNumber - 1);
    pages.push(pageText);
    chars += pageText.chars;
    if (chars >= maxChars && pageNumber < to) {
      truncated = true;
      nextPage = pageNumber + 1;
      break;
    }
  }
  const actualFrom = pages.length > 0 ? pages[0].page : from;
  const actualTo = pages.length > 0 ? pages[pages.length - 1].page : from - 1;
  return { pages, from: actualFrom, to: actualTo, totalPages, chars, truncated, nextPage };
}

/** 探测文档是否"有文本层"（CONTRACT §5），用于 info 命令提示扫描件。 */
export function probeDocument(doc, opts) {
  const options = opts || {};
  const pageCount = typeof doc.pageCount === "number" ? doc.pageCount : 0;
  const maxPages = typeof options.maxPages === "number" && options.maxPages > 0 ? Math.trunc(options.maxPages) : TEXT_PROBE_PAGES_DEFAULT;
  const probed = Math.min(maxPages, pageCount);
  const warnings = [];
  const seen = new Set();
  let pagesWithText = 0;
  let imagePages = 0;
  let totalChars = 0;

  for (let i = 0; i < probed; i++) {
    const pageText = extractPageText(doc, i);
    totalChars += pageText.chars;
    if (pageText.chars >= TEXT_PAGE_TEXT_MIN) pagesWithText += 1;
    if (pageText.imageCount > 0) imagePages += 1;
    for (const note of pageText.warnings) {
      if (seen.has(note)) continue;
      seen.add(note);
      if (warnings.length < 100) warnings.push(note);
    }
  }

  const avgChars = probed > 0 ? totalChars / probed : 0;
  // 扫描件 = 几乎没有字符 *且* 多数页只有图。只看"字符少"会把排版稀疏的
  // 幻灯片/封面误判成扫描件（真实课件里每页只有一两行标题很常见）。
  const looksScanned =
    probed > 0 &&
    avgChars < TEXT_SCANNED_AVG_CHARS &&
    pagesWithText <= Math.floor(probed * TEXT_SCANNED_TEXT_PAGE_RATIO) &&
    imagePages >= Math.max(1, Math.ceil(probed * TEXT_SCANNED_IMAGE_RATIO));

  return { pageCount, probed, pagesWithText, avgChars, looksScanned, warnings };
}

/** 检索归一化：NFKC + 小写 + 去掉所有空白（跨行/跨空格都能命中）。 */
function TEXT_normalizeSearch(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (glyphIsSpace(ch)) continue;
    const folded = typeof ch.normalize === "function" ? ch.normalize("NFKC").toLowerCase() : ch.toLowerCase();
    out += folded;
  }
  return out;
}

/** 同上的"带位置映射"版本：norm 的下标 → 原文下标，用于取上下文。 */
function TEXT_normalizeWithMap(text) {
  let norm = "";
  const map = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (glyphIsSpace(ch)) continue;
    const folded = typeof ch.normalize === "function" ? ch.normalize("NFKC").toLowerCase() : ch.toLowerCase();
    for (let k = 0; k < folded.length; k++) {
      norm += folded[k];
      map.push(i);
    }
  }
  map.push(text.length);
  return { norm, map };
}

/** 命中位置 → 可读上下文（折叠成单行，截断处用省略号提示）。 */
function TEXT_contextAround(text, map, normStart, needleLength, contextChars) {
  const firstIndex = Math.max(0, Math.min(normStart, map.length - 1));
  const lastIndex = Math.max(0, Math.min(normStart + needleLength - 1, map.length - 1));
  const originalStart = map[firstIndex];
  const originalEnd = Math.max(originalStart + 1, map[lastIndex] + 1);
  const from = Math.max(0, originalStart - contextChars);
  const to = Math.min(text.length, originalEnd + contextChars);
  const body = text.slice(from, to).replace(/\s+/g, " ").trim();
  return (from > 0 ? "…" : "") + body + (to < text.length ? "…" : "");
}

/** 在文档中检索关键词（CONTRACT §5），返回命中页与上下文。 */
export function searchDocument(doc, opts) {
  const options = opts || {};
  const query = typeof options.query === "string" ? options.query : "";
  const needle = TEXT_normalizeSearch(query);
  const totalPages = typeof doc.pageCount === "number" ? doc.pageCount : 0;
  const maxHits = typeof options.maxHits === "number" && options.maxHits > 0 ? Math.trunc(options.maxHits) : TEXT_SEARCH_HITS_DEFAULT;
  const contextChars = typeof options.contextChars === "number" && options.contextChars >= 0 ? Math.trunc(options.contextChars) : TEXT_SEARCH_CONTEXT_DEFAULT;
  if (needle.length === 0) {
    return { hits: [], scanned: false, totalHits: 0, capped: false };
  }
  const requestedFrom = typeof options.from === "number" && Number.isFinite(options.from) ? Math.trunc(options.from) : 1;
  const requestedTo = typeof options.to === "number" && Number.isFinite(options.to) ? Math.trunc(options.to) : totalPages;
  if (totalPages <= 0) {
    return { hits: [], scanned: false, totalHits: 0, capped: false };
  }
  const from = clamp(requestedFrom, 1, totalPages);
  const to = clamp(requestedTo, from, totalPages);

  const hits = [];
  let totalHits = 0;
  let pagesWithText = 0;
  const searched = to - from + 1;

  for (let pageNumber = from; pageNumber <= to; pageNumber++) {
    const pageText = extractPageText(doc, pageNumber - 1);
    // 检索场景的"有文本"只需 >0：一句话的标题页也算有文本层，
    // 否则会把它误报成扫描件（扫描件的特征是整页 0 字符）。
    if (pageText.chars > 0) pagesWithText += 1;
    if (pageText.chars === 0) continue;
    const { norm, map } = TEXT_normalizeWithMap(pageText.text);
    if (norm.length === 0) continue;
    let at = norm.indexOf(needle);
    while (at >= 0) {
      totalHits += 1;
      if (hits.length < maxHits) {
        hits.push({ page: pageNumber, text: TEXT_contextAround(pageText.text, map, at, needle.length, contextChars) });
      }
      at = norm.indexOf(needle, at + needle.length);
    }
  }

  // 范围内所有页都几乎没有文本 → 大概率是扫描件（PDF 只有图片）
  const scanned = searched > 0 && pagesWithText === 0;
  return { hits, scanned, totalHits, capped: totalHits > hits.length };
}