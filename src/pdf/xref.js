/**
 * pdf4oh · 交叉引用表（xref / trailer）读取与重建。
 *
 * 职责与边界：
 *   - 从 startxref 出发读经典 xref 表、/XRef 流（含 PNG predictor）、/Prev 增量链，
 *     并处理混合文件的 /XRefStm；合并语义是「新表覆盖旧表」（先遇到的定义优先）。
 *   - xref 完全坏掉时扫描全文 "N G obj" 重建对象表，并从 trailer /XRef 流 /Catalog
 *     里找回 Root（rebuilt=true，warnings 说明原因）。
 *   - 只产出「对象号 → 条目」与 trailer 字典；不解压 /ObjStm 内的对象（document.js 做），
 *     也不解析页面树。所有函数同步、只读输入字节。
 */

import { isName, isDict, isStream, intOr, numArray, asciiAt, isPdfWhiteSpace, isPdfDelimiter } from "./util.js";
import { readToken, parseValueAt, parseIndirectObjectAt } from "./lexer.js";
import { decodeStreamData } from "./filters.js";

/** /Prev 增量链的最大节数，防止构造文件把解析拖死。 */
const XREF_MAX_SECTIONS = 64;
/** 重建扫描时的对象数上限。 */
const XREF_MAX_REBUILD_OBJECTS = 300000;
/** 先在文件尾部这么多字节里找 startxref（多数文件就在最后几行）。 */
const XREF_TAIL_SEARCH = 8192;

function xrefWarn(warnings, message) {
  if (Array.isArray(warnings)) warnings.push("[xref] " + message);
}

/** 从文件尾向前找最后一个 "startxref"，返回其起始偏移（找不到 -1）。 */
function xrefFindStartxref(bytes) {
  const n = bytes.length;
  const floor = Math.max(0, n - XREF_TAIL_SEARCH);
  for (let i = n - 9; i >= floor; i--) {
    if (bytes[i] === 0x73 && asciiAt(bytes, i, "startxref")) return i;
  }
  for (let i = floor - 1; i >= 0; i--) {
    if (bytes[i] === 0x73 && asciiAt(bytes, i, "startxref")) return i;
  }
  return -1;
}

/** 大端读 width 字节（width 为 0 表示该字段不存在，按 0 处理）。 */
function xrefReadBigEndian(data, at, width) {
  let value = 0;
  for (let i = 0; i < width; i++) value = value * 256 + data[at + i];
  return value;
}

/** 合并「对象号 → 条目」：只补空缺（调用顺序是从新到旧）。 */
function xrefMergeEntries(target, source) {
  for (const [num, entry] of source) {
    if (!target.has(num)) target.set(num, entry);
  }
}

/** 合并 trailer：只补空缺（新的优先）。 */
function xrefMergeTrailer(target, source) {
  if (!source) return;
  for (const [key, value] of source) {
    if (!target.has(key)) target.set(key, value);
  }
}

/** 解析经典 xref 表（"xref" 之后开始）。 */
function xrefReadClassicTable(bytes, pos, warnings) {
  const entries = new Map();
  let trailer = new Map();
  let p = pos;
  let guard = 0;
  while (guard++ < 1000000) {
    const token = readToken(bytes, p);
    if (token.kind === "keyword" && token.value === "trailer") {
      const parsed = parseValueAt(bytes, token.pos);
      if (parsed && isDict(parsed.value)) trailer = parsed.value.m;
      break;
    }
    if (token.kind !== "number") break;
    const countToken = readToken(bytes, token.pos);
    if (countToken.kind !== "number") break;
    const startNum = Math.trunc(token.value);
    const count = Math.trunc(countToken.value);
    if (!(count >= 0) || count > 1000000) break;
    p = countToken.pos;
    for (let i = 0; i < count; i++) {
      const offsetToken = readToken(bytes, p);
      if (offsetToken.kind !== "number") break;
      const genToken = readToken(bytes, offsetToken.pos);
      if (genToken.kind !== "number") break;
      const flagToken = readToken(bytes, genToken.pos);
      if (flagToken.kind !== "keyword" || (flagToken.value !== "n" && flagToken.value !== "f")) break;
      const num = startNum + i;
      const offset = Math.trunc(offsetToken.value);
      const gen = Math.trunc(genToken.value);
      if (flagToken.value === "n" && offset > 0 && offset < bytes.length) {
        entries.set(num, { type: "n", offset, gen });
      } else {
        entries.set(num, { type: "f" });
      }
      p = flagToken.pos;
    }
    // 防止坏数据导致原地打转
    if (p <= token.start) break;
  }
  return { entries, trailer, xrefStm: null };
}

/** 解析 /XRef 流对象（字典 + 原始字节），返回 entries。 */
function xrefParseStreamDict(dict, raw, warnings, options) {
  const W = numArray(dict.get("W"), null);
  if (!W || W.length < 3) {
    xrefWarn(warnings, "xref 流缺少合法的 /W");
    return null;
  }
  const widths = [Math.trunc(W[0]), Math.trunc(W[1]), Math.trunc(W[2])];
  for (const w of widths) {
    if (w < 0 || w > 8) {
      xrefWarn(warnings, "xref 流 /W 字段宽度非法");
      return null;
    }
  }
  const size = intOr(dict.get("Size"), 0);
  let index = numArray(dict.get("Index"), null);
  if (!index || index.length < 2) index = [0, size];
  let data;
  try {
    data = decodeStreamData(
      { warnings, maxDecodeBytes: options && options.maxDecodeBytes },
      dict,
      raw,
    );
  } catch (e) {
    xrefWarn(warnings, "xref 流解码失败：" + (e && e.message ? e.message : e));
    return null;
  }
  const rowBytes = widths[0] + widths[1] + widths[2];
  if (rowBytes <= 0) return null;
  const entries = new Map();
  let at = 0;
  let truncated = false;
  outer: for (let k = 0; k + 1 < index.length; k += 2) {
    const startNum = Math.trunc(index[k]);
    const count = Math.trunc(index[k + 1]);
    if (!(count >= 0)) continue;
    for (let i = 0; i < count; i++) {
      if (at + rowBytes > data.length) {
        truncated = true;
        break outer;
      }
      const type = widths[0] === 0 ? 1 : xrefReadBigEndian(data, at, widths[0]);
      const field2 = xrefReadBigEndian(data, at + widths[0], widths[1]);
      const field3 = xrefReadBigEndian(data, at + widths[0] + widths[1], widths[2]);
      at += rowBytes;
      const num = startNum + i;
      if (type === 0) {
        entries.set(num, { type: "f" });
      } else if (type === 1) {
        if (field2 > 0) entries.set(num, { type: "n", offset: field2, gen: field3 });
        else entries.set(num, { type: "f" });
      } else if (type === 2) {
        entries.set(num, { type: "c", stm: field2, idx: field3 });
      } else {
        xrefWarn(warnings, "xref 流出现未知条目类型 " + type);
      }
    }
  }
  if (truncated) xrefWarn(warnings, "xref 流数据长度不足，已截断");
  return { entries };
}

/**
 * 读取一个 xref 节（经典表或 xref 流）。
 * @returns {{entries:Map, trailer:Map, xrefStm:number|null}|null}
 */
function xrefReadSection(bytes, offset, warnings, options) {
  if (!(offset >= 0 && offset < bytes.length)) return null;
  const head = readToken(bytes, offset);
  if (head.kind === "keyword" && head.value === "xref") {
    return xrefReadClassicTable(bytes, head.pos, warnings);
  }
  const obj = parseIndirectObjectAt(bytes, offset, { resolveLength: null });
  if (!obj || !isStream(obj.value)) return null;
  const dict = obj.value.dict;
  const type = dict.get("Type");
  if (type && isName(type) && type.v !== "XRef") return null;
  const parsed = xrefParseStreamDict(dict, obj.value.raw, warnings, {
    ...(options || {}),
    fileLength: bytes.length,
  });
  if (!parsed) return null;
  return { entries: parsed.entries, trailer: dict, xrefStm: null };
}

/** 遍历 (startxref → /Prev) 链；成功返回 true。 */
function xrefReadChain(bytes, entries, trailer, warnings, options) {
  const startxrefAt = xrefFindStartxref(bytes);
  if (startxrefAt < 0) {
    xrefWarn(warnings, "找不到 startxref");
    return false;
  }
  const numberToken = readToken(bytes, startxrefAt + 9);
  if (numberToken.kind !== "number") {
    xrefWarn(warnings, "startxref 后不是数字");
    return false;
  }
  let offset = Math.trunc(numberToken.value);
  const seen = new Set();
  let firstSection = true;
  while (offset != null) {
    if (!(offset >= 0 && offset < bytes.length)) {
      xrefWarn(warnings, "xref 偏移越界：" + offset);
      if (firstSection) return false;
      break;
    }
    if (seen.has(offset)) {
      xrefWarn(warnings, "/Prev 链出现环，停止");
      break;
    }
    if (seen.size >= XREF_MAX_SECTIONS) {
      xrefWarn(warnings, "/Prev 链过长，停止");
      break;
    }
    seen.add(offset);
    const section = xrefReadSection(bytes, offset, warnings, options);
    if (!section) {
      xrefWarn(warnings, "偏移 " + offset + " 处不是 xref 表或 xref 流");
      if (firstSection) return false;
      break;
    }
    xrefMergeEntries(entries, section.entries);
    xrefMergeTrailer(trailer, section.trailer);
    // 混合文件：经典表 trailer 里的 /XRefStm 指向补充的 xref 流
    const xrefStmRaw = section.trailer instanceof Map ? section.trailer.get("XRefStm") : undefined;
    if (typeof xrefStmRaw === "number" && Number.isFinite(xrefStmRaw)) {
      const hybrid = xrefReadSection(bytes, Math.trunc(xrefStmRaw), warnings, options);
      if (hybrid) {
        xrefMergeEntries(entries, hybrid.entries);
        xrefMergeTrailer(trailer, hybrid.trailer);
      } else {
        xrefWarn(warnings, "/XRefStm 偏移无效：" + xrefStmRaw);
      }
    }
    firstSection = false;
    const prevRaw = section.trailer instanceof Map ? section.trailer.get("Prev") : undefined;
    offset = typeof prevRaw === "number" && Number.isFinite(prevRaw) ? Math.trunc(prevRaw) : null;
  }
  return true;
}

/* ───────── 重建（坏 xref / 缺 startxref） ───────── */

/** 从 "obj" 位置向前扫描出 `N G`，返回 {num, gen, offset} 或 null。 */
function xrefScanHeaderBackwards(bytes, objPos) {
  let p = objPos - 1;
  while (p >= 0 && isPdfWhiteSpace(bytes[p])) p--;
  let gen = 0;
  let mul = 1;
  let genDigits = 0;
  while (p >= 0 && bytes[p] >= 0x30 && bytes[p] <= 0x39) {
    gen += (bytes[p] - 0x30) * mul;
    mul *= 10;
    p--;
    genDigits++;
    if (genDigits > 10) break;
  }
  if (genDigits === 0) return null;
  while (p >= 0 && isPdfWhiteSpace(bytes[p])) p--;
  let num = 0;
  mul = 1;
  let numDigits = 0;
  while (p >= 0 && bytes[p] >= 0x30 && bytes[p] <= 0x39) {
    num += (bytes[p] - 0x30) * mul;
    mul *= 10;
    p--;
    numDigits++;
    if (numDigits > 10) break;
  }
  if (numDigits === 0) return null;
  const offset = p + 1;
  if (offset > 0) {
    const before = bytes[offset - 1];
    if (!isPdfWhiteSpace(before) && !isPdfDelimiter(before)) return null;
  }
  return { num, gen, offset };
}

/** 全文扫描重建对象表与 trailer。 */
function xrefRebuild(bytes, warnings, options) {
  const entries = new Map();
  const trailerCandidates = [];
  const xrefStreams = [];
  let catalogRef = null;
  const n = bytes.length;
  let parsedCount = 0;
  let i = 0;
  while (i + 3 <= n) {
    const b = bytes[i];
    if (b === 0x6f && bytes[i + 1] === 0x62 && bytes[i + 2] === 0x6a) {
      // "obj"：确认后面是分隔符，再向前找 `N G`
      const after = i + 3 < n ? bytes[i + 3] : 0x0a;
      if (isPdfWhiteSpace(after) || isPdfDelimiter(after)) {
        const header = xrefScanHeaderBackwards(bytes, i);
        if (header && header.num > 0) {
          const obj = parseIndirectObjectAt(bytes, header.offset, { resolveLength: null });
          if (obj && obj.num === header.num) {
            entries.set(obj.num, { type: "n", offset: header.offset, gen: obj.gen });
            parsedCount++;
            if (isStream(obj.value)) {
              const type = obj.value.dict.get("Type");
              if (isName(type) && type.v === "XRef") xrefStreams.push(obj.value);
              // 跳过流内容，避免把二进制里的 "obj" 误当对象头
              i = Math.max(i + 1, obj.end - 3);
              if (parsedCount > XREF_MAX_REBUILD_OBJECTS) {
                xrefWarn(warnings, "重建对象数超过上限，已停止扫描");
                break;
              }
              continue;
            }
            const dict = isDict(obj.value) ? obj.value.m : null;
            const nodeType = dict ? dict.get("Type") : null;
            if (isName(nodeType) && nodeType.v === "Catalog") {
              catalogRef = { t: "ref", n: obj.num, g: obj.gen };
            }
            if (parsedCount > XREF_MAX_REBUILD_OBJECTS) {
              xrefWarn(warnings, "重建对象数超过上限，已停止扫描");
              break;
            }
          }
        }
      }
    } else if (b === 0x74 && asciiAt(bytes, i, "trailer")) {
      // "trailer" 关键字（前面必须是边界，避免匹配到别的单词）
      const before = i > 0 ? bytes[i - 1] : 0x20;
      const afterTrailer = i + 7 < n ? bytes[i + 7] : 0x20;
      if ((isPdfWhiteSpace(before) || isPdfDelimiter(before)) && (isPdfWhiteSpace(afterTrailer) || isPdfDelimiter(afterTrailer))) {
        const parsed = parseValueAt(bytes, i + 7);
        if (parsed && isDict(parsed.value)) trailerCandidates.push(parsed.value.m);
        i += 7;
        continue;
      }
    }
    i++;
  }

  // trailer：按文件顺序合并（后出现的增量 trailer 覆盖旧值）
  const trailer = new Map();
  for (const candidate of trailerCandidates) {
    for (const [key, value] of candidate) trailer.set(key, value);
  }
  // xref 流既是对象表补充，也带 trailer 字段
  const xrefTrailerKeys = ["Root", "Info", "Size", "Encrypt", "ID", "Prev"];
  for (const stream of xrefStreams) {
    const parsed = xrefParseStreamDict(stream.dict, stream.raw, warnings, {
      ...(options || {}),
      fileLength: n,
    });
    if (parsed) {
      for (const [num, entry] of parsed.entries) {
        if (!entries.has(num)) entries.set(num, entry);
      }
    }
    for (const key of xrefTrailerKeys) {
      if (stream.dict.has(key)) trailer.set(key, stream.dict.get(key));
    }
  }
  if (!trailer.has("Root") && catalogRef) trailer.set("Root", catalogRef);
  return { entries, trailer };
}

/**
 * 读取 xref 与 trailer。
 * @param {Uint8Array} bytes
 * @param {{maxDecodeBytes?: number}} [opts]
 * @returns {{entries: Map<number, object>, trailer: Map<string, *>, warnings: string[], rebuilt: boolean}}
 */
export function readXref(bytes, opts) {
  const options = opts || {};
  const warnings = [];
  const entries = new Map();
  const trailer = new Map();
  let rebuilt = false;
  let ok = false;
  try {
    ok = xrefReadChain(bytes, entries, trailer, warnings, options);
  } catch (e) {
    xrefWarn(warnings, "xref 解析异常：" + (e && e.message ? e.message : e));
    ok = false;
  }
  if (!ok || entries.size === 0) {
    if (ok) xrefWarn(warnings, "xref 没有可用条目，改用全文扫描重建");
    entries.clear();
    trailer.clear();
    const rebuiltData = xrefRebuild(bytes, warnings, options);
    for (const [num, entry] of rebuiltData.entries) entries.set(num, entry);
    for (const [key, value] of rebuiltData.trailer) trailer.set(key, value);
    rebuilt = true;
  } else if (!trailer.has("Root")) {
    xrefWarn(warnings, "trailer 缺少 /Root，尝试扫描重建补齐");
    const rebuiltData = xrefRebuild(bytes, warnings, options);
    for (const [num, entry] of rebuiltData.entries) {
      if (!entries.has(num)) entries.set(num, entry);
    }
    for (const [key, value] of rebuiltData.trailer) trailer.set(key, value);
    rebuilt = true;
  }
  return { entries, trailer, warnings, rebuilt };
}