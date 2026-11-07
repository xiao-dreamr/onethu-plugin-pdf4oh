/**
 * pdf4oh · PDF 词法/语法解析（容错 tokenizer + 对象解析）。
 *
 * 职责与边界：
 *   - 把字节流切成 PDF 记号（注释、NUL/空白、name 的 #xx、literal/hex 字符串、
 *     数字、关键字、数组/字典定界符），并把记号组装成 CONTRACT §3 的值模型。
 *   - 解析间接对象 `N G obj ... endobj`，其中 stream 的字节长度优先用 /Length，
 *     长度缺失/非法时回退扫描 "endstream"（真实文件里两种情况都常见）。
 *   - 不做 xref、不做解引用、不做滤镜解码；只保证「给一段字节 + 偏移，能安全地
 *     解析出值」。所有函数同步、无全局状态，坏数据尽量容错而不是抛异常。
 */

import {
  pdfError,
  isPdfWhiteSpace,
  isPdfDelimiter,
  asciiAt,
  clamp,
} from "./util.js";

/** 嵌套深度上限：防止恶意/损坏文件把调用栈打爆。 */
const LEX_MAX_DEPTH = 96;
/** 单个数组/字典的元素上限，避免异常文件吃光内存。 */
const LEX_MAX_ITEMS = 200000;

/** 跳过空白与注释（% 到行尾；NUL 也算空白）。 */
function lexSkipSpace(bytes, pos) {
  const n = bytes.length;
  let p = pos;
  while (p < n) {
    const b = bytes[p];
    if (b === 0x25) {
      // '%' 注释：吃到行尾（不包含换行本身）
      p++;
      while (p < n && bytes[p] !== 0x0a && bytes[p] !== 0x0d) p++;
    } else if (isPdfWhiteSpace(b)) {
      p++;
    } else {
      break;
    }
  }
  return p;
}

function lexHexVal(byte) {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  return -1;
}

/** 读数字：支持符号、小数、以及真实文件里偶尔出现的科学计数法。 */
function lexReadNumber(bytes, start) {
  const n = bytes.length;
  let p = start;
  let sign = 1;
  if (bytes[p] === 0x2b) {
    p++;
  } else if (bytes[p] === 0x2d) {
    sign = -1;
    p++;
  }
  let intDigits = 0;
  let intPart = 0;
  while (p < n && bytes[p] >= 0x30 && bytes[p] <= 0x39) {
    intPart = intPart * 10 + (bytes[p] - 0x30);
    p++;
    intDigits++;
  }
  let fracDigits = 0;
  let fracPart = 0;
  let scale = 1;
  if (p < n && bytes[p] === 0x2e) {
    p++;
    while (p < n && bytes[p] >= 0x30 && bytes[p] <= 0x39) {
      fracPart = fracPart * 10 + (bytes[p] - 0x30);
      scale *= 10;
      p++;
      fracDigits++;
    }
  }
  if (intDigits === 0 && fracDigits === 0) return null;
  let value = sign * (intPart + fracPart / scale);
  if (p < n && (bytes[p] === 0x65 || bytes[p] === 0x45)) {
    const save = p;
    let q = p + 1;
    let expSign = 1;
    if (q < n && (bytes[q] === 0x2b || bytes[q] === 0x2d)) {
      if (bytes[q] === 0x2d) expSign = -1;
      q++;
    }
    let expDigits = 0;
    let exp = 0;
    while (q < n && bytes[q] >= 0x30 && bytes[q] <= 0x39) {
      exp = exp * 10 + (bytes[q] - 0x30);
      q++;
      expDigits++;
    }
    if (expDigits > 0) {
      value *= Math.pow(10, expSign * exp);
      p = q;
    } else {
      p = save;
    }
  }
  return { value, pos: p };
}

/** 读 name 的字节（含 #xx 转义解码）。 */
function lexReadName(bytes, start) {
  const n = bytes.length;
  let p = start + 1; // 跳过 '/'
  const out = [];
  while (p < n) {
    const b = bytes[p];
    if (isPdfWhiteSpace(b) || isPdfDelimiter(b)) break;
    if (b === 0x23 && p + 2 < n) {
      const hi = lexHexVal(bytes[p + 1]);
      const lo = lexHexVal(bytes[p + 2]);
      if (hi >= 0 && lo >= 0) {
        out.push((hi << 4) | lo);
        p += 3;
        continue;
      }
    }
    out.push(b);
    p++;
  }
  return { kind: "name", start, pos: p, value: lexLatin1FromArray(out) };
}

/** 小工具：字节数组 → Latin-1 字符串（名字/关键字只有 ASCII 语义）。 */
function lexLatin1FromArray(arr) {
  let out = "";
  const CHUNK = 0x2000;
  for (let i = 0; i < arr.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, arr.slice(i, i + CHUNK));
  }
  return out;
}

/** 读字面字符串 (...)：处理转义、八进制、括号嵌套与 EOL 归一化。 */
function lexReadLiteralString(bytes, start) {
  const n = bytes.length;
  let p = start + 1;
  const out = [];
  let depth = 1;
  while (p < n) {
    const b = bytes[p++];
    if (b === 0x5c) {
      // 反斜杠转义
      if (p >= n) break;
      const e = bytes[p++];
      if (e === 0x6e) out.push(0x0a);
      else if (e === 0x72) out.push(0x0d);
      else if (e === 0x74) out.push(0x09);
      else if (e === 0x62) out.push(0x08);
      else if (e === 0x66) out.push(0x0c);
      else if (e === 0x28 || e === 0x29 || e === 0x5c) out.push(e);
      else if (e === 0x0d) {
        if (p < n && bytes[p] === 0x0a) p++; // 续行
      } else if (e === 0x0a) {
        // 续行
      } else if (e >= 0x30 && e <= 0x37) {
        let value = e - 0x30;
        for (let k = 0; k < 2 && p < n; k++) {
          const c = bytes[p];
          if (c < 0x30 || c > 0x37) break;
          value = (value << 3) | (c - 0x30);
          p++;
        }
        out.push(value & 0xff);
      } else {
        out.push(e);
      }
      continue;
    }
    if (b === 0x28) {
      depth++;
      out.push(b);
      continue;
    }
    if (b === 0x29) {
      depth--;
      if (depth === 0) break;
      out.push(b);
      continue;
    }
    if (b === 0x0d) {
      // 字符串里的 CR / CRLF 统一成 LF
      out.push(0x0a);
      if (p < n && bytes[p] === 0x0a) p++;
      continue;
    }
    out.push(b);
  }
  return { kind: "string", start, pos: p, bytes: Uint8Array.from(out) };
}

/** 读十六进制字符串 <...>：忽略空白，奇尾补 0，非法字符处提前结束。 */
function lexReadHexString(bytes, start) {
  const n = bytes.length;
  let p = start + 1;
  const out = [];
  let hi = -1;
  while (p < n) {
    const b = bytes[p++];
    if (b === 0x3e) break;
    if (isPdfWhiteSpace(b)) continue;
    const v = lexHexVal(b);
    if (v < 0) break;
    if (hi < 0) {
      hi = v;
    } else {
      out.push((hi << 4) | v);
      hi = -1;
    }
  }
  if (hi >= 0) out.push(hi << 4);
  return { kind: "string", start, pos: p, bytes: Uint8Array.from(out) };
}

/**
 * 读一个记号。返回对象始终带 start（记号起点）与 pos（记号之后）。
 * kind: eof | number | name | string | keyword | array-start | array-end |
 *       dict-start | dict-end | invalid
 */
export function readToken(bytes, pos) {
  const n = bytes.length;
  const start = lexSkipSpace(bytes, pos);
  if (start >= n) return { kind: "eof", start, pos: start };
  const b = bytes[start];
  if (b === 0x3c) {
    if (start + 1 < n && bytes[start + 1] === 0x3c) return { kind: "dict-start", start, pos: start + 2 };
    return lexReadHexString(bytes, start);
  }
  if (b === 0x3e) {
    if (start + 1 < n && bytes[start + 1] === 0x3e) return { kind: "dict-end", start, pos: start + 2 };
    return { kind: "invalid", start, pos: start + 1, value: ">" };
  }
  if (b === 0x5b) return { kind: "array-start", start, pos: start + 1 };
  if (b === 0x5d) return { kind: "array-end", start, pos: start + 1 };
  if (b === 0x28) return lexReadLiteralString(bytes, start);
  if (b === 0x2f) return lexReadName(bytes, start);
  if (b === 0x2b || b === 0x2d || b === 0x2e || (b >= 0x30 && b <= 0x39)) {
    const num = lexReadNumber(bytes, start);
    if (num) return { kind: "number", start, pos: num.pos, value: num.value };
    return { kind: "invalid", start, pos: start + 1, value: String.fromCharCode(b) };
  }
  // 关键字：连续的非空白非定界符
  let p = start;
  while (p < n && !isPdfWhiteSpace(bytes[p]) && !isPdfDelimiter(bytes[p])) p++;
  if (p === start) return { kind: "invalid", start, pos: start + 1, value: String.fromCharCode(b) };
  let value = "";
  for (let i = start; i < p; i++) value += String.fromCharCode(bytes[i]);
  return { kind: "keyword", start, pos: p, value };
}

/** name 字节 → 字符串（#xx 转义）。供外部按需解码名字内容。 */
export function decodeNameBytes(bytes) {
  if (!bytes || typeof bytes.length !== "number") return "";
  const out = [];
  for (let p = 0; p < bytes.length; ) {
    const b = bytes[p];
    if (b === 0x23 && p + 2 < bytes.length) {
      const hi = lexHexVal(bytes[p + 1]);
      const lo = lexHexVal(bytes[p + 2]);
      if (hi >= 0 && lo >= 0) {
        out.push((hi << 4) | lo);
        p += 3;
        continue;
      }
    }
    out.push(b);
    p++;
  }
  return lexLatin1FromArray(out);
}

/* PDFDocEncoding 的特殊码位（其余与 Latin-1 相同）。 */
const LEX_PDFDOC_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) table[i] = i;
  const specials = [
    [0x18, 0x02d8], [0x19, 0x02c7], [0x1a, 0x02c6], [0x1b, 0x02d9],
    [0x1c, 0x02dd], [0x1d, 0x02db], [0x1e, 0x02da], [0x1f, 0x02dc],
    [0x80, 0x2022], [0x81, 0x2020], [0x82, 0x2021], [0x83, 0x2026],
    [0x84, 0x2014], [0x85, 0x2013], [0x86, 0x0192], [0x87, 0x2044],
    [0x88, 0x2039], [0x89, 0x203a], [0x8a, 0x2212], [0x8b, 0x2030],
    [0x8c, 0x201e], [0x8d, 0x201c], [0x8e, 0x201d], [0x8f, 0x2018],
    [0x90, 0x2019], [0x91, 0x201a], [0x92, 0x2122], [0x93, 0xfb01],
    [0x94, 0xfb02], [0x95, 0x0141], [0x96, 0x0152], [0x97, 0x0160],
    [0x98, 0x0178], [0x99, 0x017d], [0x9a, 0x0131], [0x9b, 0x0142],
    [0x9c, 0x0153], [0x9d, 0x0161], [0x9e, 0x017e], [0xa0, 0x20ac],
  ];
  for (const [from, to] of specials) table[from] = to;
  return table;
})();

/**
 * PDF 文本字符串 → JS 字符串（仅用于 /Title /Author 一类元数据）。
 * 支持 UTF-16BE/LE BOM 与 UTF-8 BOM，其余按 PDFDocEncoding 近似。
 * 注意：正文文本不在这里解码（那需要字体 CMap，属于 pdf-text）。
 */
export function decodePdfTextBytes(bytes) {
  if (!bytes || bytes.length === 0) return "";
  if (bytes.length >= 2) {
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      let out = "";
      for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      return out;
    }
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      let out = "";
      for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
      return out;
    }
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      let out = "";
      for (let i = 3; i < bytes.length; ) {
        const b0 = bytes[i++];
        if (b0 < 0x80) {
          out += String.fromCharCode(b0);
        } else if (b0 >= 0xc0 && b0 < 0xe0 && i < bytes.length) {
          out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i++] & 0x3f));
        } else if (b0 >= 0xe0 && b0 < 0xf0 && i + 1 < bytes.length) {
          out += String.fromCharCode(((b0 & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
        } else if (b0 >= 0xf0 && b0 < 0xf8 && i + 2 < bytes.length) {
          const cp =
            ((b0 & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
          out += String.fromCodePoint(cp);
        } else {
          out += "\uFFFD";
        }
      }
      return out;
    }
  }
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(LEX_PDFDOC_TABLE[bytes[i]]);
  return out;
}

/**
 * 从 pos 解析一个 PDF 值（公开入口：opts.depth 只用于内部递归）。
 * @returns {{value: *, pos: number}}  value 遵循 CONTRACT §3；解析失败时尽量返回 null 值
 */
export function parseValueAt(bytes, pos, opts) {
  const depth = opts && typeof opts.depth === "number" ? opts.depth : 0;
  return parseValueInternal(bytes, pos, depth);
}

function parseValueInternal(bytes, pos, depth) {
  if (depth > LEX_MAX_DEPTH) throw pdfError("malformed", "PDF 对象嵌套过深");
  const token = readToken(bytes, pos);
  switch (token.kind) {
    case "eof":
      return { value: null, pos: token.pos };
    case "number": {
      // 间接引用：整数 整数 R（中间允许空白与注释）
      if (Number.isInteger(token.value) && token.value >= 0) {
        const t1 = readToken(bytes, token.pos);
        if (t1.kind === "number" && Number.isInteger(t1.value) && t1.value >= 0) {
          const t2 = readToken(bytes, t1.pos);
          if (t2.kind === "keyword" && t2.value === "R") {
            return { value: { t: "ref", n: token.value, g: t1.value }, pos: t2.pos };
          }
        }
      }
      return { value: token.value, pos: token.pos };
    }
    case "name":
      return { value: { t: "name", v: token.value }, pos: token.pos };
    case "string":
      return { value: { t: "str", b: token.bytes }, pos: token.pos };
    case "keyword":
      if (token.value === "true") return { value: true, pos: token.pos };
      if (token.value === "false") return { value: false, pos: token.pos };
      if (token.value === "null") return { value: null, pos: token.pos };
      // 容错：未知关键字当 name 处理（有些文件的 /Filter 位置直接裸写名字）
      return { value: { t: "name", v: token.value }, pos: token.pos };
    case "array-start":
      return parseValueArray(bytes, token.pos, depth);
    case "dict-start":
      return parseValueDict(bytes, token.pos, depth);
    case "array-end":
    case "dict-end":
      return { value: null, pos: token.pos };
    default:
      return { value: null, pos: token.pos };
  }
}

function parseValueArray(bytes, pos, depth) {
  const arr = [];
  let p = pos;
  while (arr.length < LEX_MAX_ITEMS) {
    const token = readToken(bytes, p);
    if (token.kind === "eof") break;
    if (token.kind === "array-end") {
      p = token.pos;
      break;
    }
    if (token.kind === "dict-end") {
      // 坏数据：数组里出现 ">>"，消费掉避免死循环
      p = token.pos;
      break;
    }
    const parsed = parseValueInternal(bytes, token.start, depth + 1);
    if (!parsed) {
      p = token.pos;
      continue;
    }
    arr.push(parsed.value);
    p = parsed.pos > p ? parsed.pos : token.pos;
  }
  return { value: arr, pos: p };
}

function parseValueDict(bytes, pos, depth) {
  const map = new Map();
  let p = pos;
  let items = 0;
  while (items < LEX_MAX_ITEMS) {
    const token = readToken(bytes, p);
    if (token.kind === "eof") break;
    if (token.kind === "dict-end") {
      p = token.pos;
      break;
    }
    if (token.kind !== "name") {
      // 容错：跳过字典里的杂项记号（如多余的数字/关键字）
      p = token.pos;
      items++;
      continue;
    }
    const parsed = parseValueInternal(bytes, token.pos, depth + 1);
    map.set(token.value, parsed ? parsed.value : null);
    p = parsed && parsed.pos > token.pos ? parsed.pos : token.pos;
    items++;
  }
  return { value: { t: "dict", m: map }, pos: p };
}

/** stream 数据结束后是否紧跟 endstream（允许中间有几个 EOL/空白）。 */
function lexLooksLikeEndstream(bytes, pos) {
  let p = pos;
  let skipped = 0;
  while (p < bytes.length && skipped < 4 && isPdfWhiteSpace(bytes[p])) {
    p++;
    skipped++;
  }
  return asciiAt(bytes, p, "endstream");
}

/** 扫描 "endstream"，返回其起始位置（找不到 -1）。 */
function lexFindEndstream(bytes, from) {
  const n = bytes.length;
  const needle = "endstream";
  for (let i = Math.max(0, from); i + needle.length <= n; i++) {
    if (bytes[i] !== 0x65) continue; // 'e'
    if (asciiAt(bytes, i, needle)) return i;
  }
  return -1;
}

/**
 * 解析一个间接对象：`N G obj <value> [stream ... endstream] endobj`。
 * @returns {{num:number, gen:number, value:*, end:number}|null}
 */
export function parseIndirectObjectAt(bytes, offset, opts) {
  if (!bytes || typeof bytes.length !== "number") return null;
  let p = lexSkipSpace(bytes, clamp(offset | 0, 0, bytes.length));
  const t1 = readToken(bytes, p);
  if (t1.kind !== "number" || !Number.isInteger(t1.value) || t1.value < 0) return null;
  const t2 = readToken(bytes, t1.pos);
  if (t2.kind !== "number" || !Number.isInteger(t2.value) || t2.value < 0) return null;
  const t3 = readToken(bytes, t2.pos);
  if (t3.kind !== "keyword" || t3.value !== "obj") return null;

  const num = t1.value;
  const gen = t2.value;
  const parsed = parseValueAt(bytes, t3.pos, opts);
  if (!parsed) return null;
  let value = parsed.value;
  p = parsed.pos;

  const afterValue = readToken(bytes, p);
  if (afterValue.kind === "keyword" && afterValue.value === "stream") {
    let dataStart = afterValue.pos;
    if (dataStart < bytes.length && bytes[dataStart] === 0x0d) dataStart++;
    if (dataStart < bytes.length && bytes[dataStart] === 0x0a) dataStart++;
    const dict = value && value.t === "dict" ? value.m : null;
    let declared = null;
    if (dict && dict.has("Length")) {
      const lenValue = dict.get("Length");
      if (typeof lenValue === "number" && Number.isFinite(lenValue)) {
        declared = Math.trunc(lenValue);
      } else if (lenValue && lenValue.t === "ref" && opts && typeof opts.resolveLength === "function") {
        const resolved = opts.resolveLength(lenValue.n);
        if (typeof resolved === "number" && Number.isFinite(resolved)) declared = Math.trunc(resolved);
      }
    }
    let dataEnd = -1;
    if (declared != null && declared >= 0) {
      const candidate = dataStart + declared;
      if (candidate <= bytes.length && (lexLooksLikeEndstream(bytes, candidate) || candidate === bytes.length)) {
        dataEnd = candidate;
      }
    }
    if (dataEnd < 0) {
      const found = lexFindEndstream(bytes, dataStart);
      if (found < 0) {
        dataEnd = bytes.length;
      } else {
        dataEnd = found;
        while (dataEnd > dataStart && (bytes[dataEnd - 1] === 0x0a || bytes[dataEnd - 1] === 0x0d)) dataEnd--;
      }
    }
    value = {
      t: "stream",
      dict: dict || new Map(),
      raw: bytes.subarray(dataStart, Math.max(dataStart, dataEnd)),
    };
    p = dataEnd;
    const endStreamToken = readToken(bytes, p);
    if (endStreamToken.kind === "keyword" && endStreamToken.value === "endstream") p = endStreamToken.pos;
  }

  let end = p;
  const endObjToken = readToken(bytes, end);
  if (endObjToken.kind === "keyword" && endObjToken.value === "endobj") end = endObjToken.pos;
  return { num, gen, value, end };
}

/** 供 xref.js 复用的内部工具：判断某个偏移处是否是 "N G obj"（不完整解析）。 */
export function looksLikeIndirectHeader(bytes, offset) {
  const t1 = readToken(bytes, offset);
  if (t1.kind !== "number") return false;
  const t2 = readToken(bytes, t1.pos);
  if (t2.kind !== "number") return false;
  const t3 = readToken(bytes, t2.pos);
  return t3.kind === "keyword" && t3.value === "obj";
}