/**
 * pdf4oh · PDF 值模型与公共工具（被 pdf-core / pdf-text 共用）。
 *
 * 这个模块刻意保持"哑"：只有类型判别、字典读取与字节小工具，不含解析状态。
 * 值模型见 CONTRACT.md §3。所有导出名都是顶层全局（单文件拼接），不要重名。
 */

/** PDF 解析错误：带 code，命令层据此给用户人话错误，而不是抛栈。 */
export class PdfError extends Error {
  /**
   * @param {"not-pdf"|"encrypted"|"malformed"|"too-large"|"unsupported"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "PdfError";
    this.code = code;
  }
}

export function pdfError(code, message) {
  return new PdfError(code, message);
}

export function isPdfError(e) {
  return e instanceof PdfError || (e && e.name === "PdfError" && typeof e.code === "string");
}

/* ───── 值判别 ───── */

export function isName(v) {
  return !!v && typeof v === "object" && v.t === "name" && typeof v.v === "string";
}

export function nameOf(v) {
  return isName(v) ? v.v : "";
}

export function isRef(v) {
  return !!v && typeof v === "object" && v.t === "ref" && typeof v.n === "number";
}

export function isDict(v) {
  return !!v && typeof v === "object" && v.t === "dict" && v.m instanceof Map;
}

export function isStream(v) {
  return !!v && typeof v === "object" && v.t === "stream" && v.dict instanceof Map;
}

export function isStr(v) {
  return !!v && typeof v === "object" && v.t === "str" && v.b instanceof Uint8Array;
}

/* ───── 字典读取（dict 或裸 Map 都接受） ───── */

export function dictMap(v) {
  if (isDict(v)) return v.m;
  if (v instanceof Map) return v;
  if (isStream(v)) return v.dict;
  return null;
}

export function dictGet(v, key) {
  const m = dictMap(v);
  if (!m) return undefined;
  return m.get(key);
}

export function dictHas(v, key) {
  const m = dictMap(v);
  return !!m && m.has(key);
}

export function dictEntries(v) {
  const m = dictMap(v);
  return m ? [...m.entries()] : [];
}

/** 解引用一次（不递归）；用于 dict 已 resolve 的场景。 */
export function resolveOr(doc, v, fallback) {
  if (v === undefined || v === null) return fallback;
  if (isRef(v) && doc && typeof doc.resolve === "function") {
    const out = doc.resolve(v);
    return out === undefined || out === null ? fallback : out;
  }
  return v;
}

/* ───── 取值小工具 ───── */

export function numOr(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function intOr(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

export function numArray(v, fallback) {
  if (!Array.isArray(v) || v.length < 2) return fallback;
  const out = v.map((x) => (typeof x === "number" && Number.isFinite(x) ? x : NaN));
  return out.some((x) => Number.isNaN(x)) ? fallback : out;
}

/** 字符串对象 → 原始字节；兼容个别解析器直接把 /Title 存成 JS string 的情况。 */
export function strBytes(v) {
  if (isStr(v)) return v.b;
  if (typeof v === "string") {
    const out = new Uint8Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v.charCodeAt(i) & 0xff;
    return out;
  }
  return null;
}

/** 名字数组 / 单个名字 → string[]（/Filter 等字段用）。 */
export function nameList(v) {
  if (isName(v)) return [v.v];
  if (Array.isArray(v)) return v.filter(isName).map((x) => x.v);
  return [];
}

export function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

/* ───── 字节小工具 ───── */

export function concatBytes(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const PDF_WS_TABLE = (() => {
  const t = new Uint8Array(256);
  for (const b of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) t[b] = 1;
  return t;
})();

const PDF_DELIM_TABLE = (() => {
  const t = new Uint8Array(256);
  for (const ch of "()<>[]{}/%") t[ch.charCodeAt(0)] = 1;
  return t;
})();

export function isPdfWhiteSpace(byte) {
  return PDF_WS_TABLE[byte] === 1;
}

export function isPdfDelimiter(byte) {
  return PDF_DELIM_TABLE[byte] === 1;
}

/** bytes[from, to) → Latin-1 字符串（PDF 语法层用，不做 Unicode 解释）。 */
export function latin1(bytes, from = 0, to = bytes.length) {
  let out = "";
  const CHUNK = 0x2000;
  for (let i = from; i < to; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, to)));
  }
  return out;
}

/** 在 pos 处是否出现给定 ASCII 串（不越界）。 */
export function asciiAt(bytes, pos, text) {
  if (pos < 0 || pos + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[pos + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

export function bytesStartWith(bytes, text, from = 0) {
  return asciiAt(bytes, from, text);
}

/** 找 byte 的下一个位置（找不到返回 -1）。 */
export function indexOfByte(bytes, byte, from) {
  for (let i = from | 0; i < bytes.length; i++) if (bytes[i] === byte) return i;
  return -1;
}

/** 文本 → UTF-8 字节（测试与工具用）。 */
export function utf8Bytes(text) {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text);
  const out = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return new Uint8Array(out);
}