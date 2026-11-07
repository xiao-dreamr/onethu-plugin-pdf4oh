/**
 * pdf4oh · 命令输入解析。
 *
 * OH 调 run_plugin_cmd 时只能给一个字符串（input），用户/模型都很容易写出各种
 * 形态：「第3讲 1-6」「线性代数_刘余_课程讲义.pdf pages=2-5」「fileId=123 关键词」。
 * 这个模块把「键值参数 + 自然文本 + 末尾页码范围」拆开，命令层只处理语义。
 *
 * 设计取舍：
 *   - 键值参数（fileId/pages/max/course/query/file）优先且可从任意位置出现；
 *   - 页码范围只认**末尾**（"第3讲 1-6"），避免把文件名里的数字（"第3讲"、
 *     "Lecture 5.pdf"）误当页码；
 *   - 全角数字/破折号/波浪线先归一化，中文输入法下常混用；
 *   - 解析失败不抛错，退化成「整个输入都是文件名」，让上层给出候选与提示。
 */

const ARGS_KEY_NAMES = "fileId|pages|max|course|query|file";
const ARGS_KV_RE = new RegExp(
  `(?:^|\\s)(?:${ARGS_KEY_NAMES})\\s*=\\s*("([^"]*)"|'([^']*)'|(\\S+))`,
  "gi",
);
/** 末尾页码范围：第3页 / 第3-6页 / 1-6 / 3- / 3页 */
const ARGS_TRAILING_PAGE_RES = [
  /(?:^|\s)第?\s*(\d{1,4})\s*[-–—~～至到]\s*(\d{1,4})\s*页?\s*$/,
  /(?:^|\s)第\s*(\d{1,4})\s*页(?:\s*[-–—~～至到]\s*(\d{1,4}))?\s*$/,
  /(?:^|\s)(\d{1,4})\s*页\s*$/,
];

/** 全角数字/标点 → 半角（中文输入法常见）。 */
export function normalizeInputText(raw) {
  const text = String(raw ?? "");
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xff10 && cp <= 0xff19) out += String.fromCharCode(cp - 0xff10 + 48); // ０-９
    else if (cp === 0xff0d || cp === 0x2014 || cp === 0x2013 || cp === 0x2212) out += "-"; // － — – −
    else if (cp === 0xff5e || cp === 0x301c) out += "~"; // ～ 〜
    else if (cp === 0x3000) out += " "; // 全角空格
    else if (cp === 0x201c || cp === 0x201d) out += '"';
    else if (cp === 0x2018 || cp === 0x2019) out += "'";
    else out += ch;
  }
  return out;
}

export function collapseSpaces(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export function parsePositiveInt(value, fallback = null, max = 100000) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number.parseInt(String(value).replace(/[^\d]/g, ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/** "1-6" / "3" / "3-" / "第1页" / "1 到 6" → { from, to }（to=null 表示到末尾）。 */
export function parsePageRange(value) {
  const text = normalizeInputText(value).trim();
  if (!text) return null;
  const m = /^第?\s*(\d{1,4})\s*页?\s*(?:[-~至到]\s*(\d{1,4})?\s*页?)?$/.exec(text);
  if (!m) return null;
  const from = parsePositiveInt(m[1], null);
  if (!from) return null;
  const to = m[2] ? parsePositiveInt(m[2], null) : null;
  return { from, to: to && to >= from ? to : null };
}

/** 把末尾页码范围从自然文本里摘掉；摘不到返回 null。 */
export function stripTrailingPageRange(text) {
  for (const re of ARGS_TRAILING_PAGE_RES) {
    const m = re.exec(text);
    if (!m) continue;
    const from = parsePositiveInt(m[1], null);
    if (!from) continue;
    const to = m[2] ? parsePositiveInt(m[2], null) : null;
    // "作业 4-2" 这类文件名里的连字符不能被当成倒序页码范围：整段不认，保留作文本
    if (to !== null && to < from) continue;
    return { pages: { from, to }, rest: text.slice(0, m.index).trim() };
  }
  return null;
}

/**
 * 解析命令输入。
 * @returns {{ text: string, kv: Record<string,string>, pages: {from:number,to:number|null}|null,
 *            maxChars: number|null, fileId: string, courseQuery: string, fileHint: string }}
 */
export function parseCommandInput(raw) {
  let text = collapseSpaces(normalizeInputText(raw));
  const kv = Object.create(null);
  text = text.replace(ARGS_KV_RE, (_all, _quoted, dq, sq, bare) => {
    const keyMatch = /^([A-Za-z]+)\s*=\s*([\s\S]*)$/.exec(_all.trim());
    if (!keyMatch) return " ";
    const key = keyMatch[1].toLowerCase();
    kv[key] = (dq ?? sq ?? bare ?? "").trim();
    return " ";
  });
  text = collapseSpaces(text);

  let pages = parsePageRange(kv.pages);
  if (!pages) {
    const trailing = stripTrailingPageRange(text);
    if (trailing) {
      pages = trailing.pages;
      text = trailing.rest;
    }
  }

  return {
    text,
    kv,
    pages,
    maxChars: parsePositiveInt(kv.max, null, 40000),
    fileId: String(kv.fileid ?? "").trim(),
    courseQuery: String(kv.course ?? "").trim(),
    fileHint: String(kv.file ?? "").trim(),
  };
}

/**
 * search 命令的输入：文件名 + 关键词。
 * 关键词优先 query=，否则取自然文本最后一个空格分隔的片段；文件名取剩余部分。
 * 只有一个片段时把它当关键词（整库搜），文件名留空。
 */
export function parseSearchInput(raw) {
  const base = parseCommandInput(raw);
  let query = String(base.kv.query ?? "").trim();
  let fileText = base.text || base.fileHint || base.courseQuery;
  if (!query) {
    const text = collapseSpaces(base.text);
    if (base.fileId) {
      // fileId 已经指明文件，剩下的自然文本都是关键词
      fileText = "";
      query = text;
    } else {
      const at = text.lastIndexOf(" ");
      if (at > 0) {
        fileText = text.slice(0, at).trim();
        query = text.slice(at + 1).trim();
      } else {
        fileText = base.fileHint || base.courseQuery || "";
        query = text;
      }
    }
  }
  return { ...base, text: fileText, query };
}

/** 展示用：把用户输入截断，避免错误信息里带一长串。 */
export function briefInput(text, limit = 120) {
  const s = collapseSpaces(text);
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}