/**
 * pdf4oh · PDF 文档对象层（xref + 对象表 + 页树 + 流解码入口）。
 *
 * 职责与边界：
 *   - loadPdf 做「文件头容错 → xref/trailer → 加密短路 → ObjStm 对表预解」，
 *     之后 getObject/resolve 提供同步的对象访问；页树遍历做属性继承与坏节点容错。
 *   - decodeStream 只负责把 stream 字典里的 Filter/DecodeParms 解引用后交给
 *     filters.js；真正的内容流拼接由 getPageContentBytes 提供（pdf-text 直接用）。
 *   - 不解密（security.js 只识别并抛 encrypted）、不解释字体/内容流、不实现缓存淘汰
 *     （那是插件层 cache.js 的事）。所有函数同步，除 warnings 外不写外部状态。
 */

import {
  PdfError,
  pdfError,
  isPdfError,
  isName,
  nameOf,
  isRef,
  isDict,
  isStream,
  dictGet,
  dictMap,
  numOr,
  intOr,
  numArray,
  asciiAt,
  isPdfWhiteSpace,
  isPdfDelimiter,
  concatBytes,
} from "./util.js";
import { readToken, parseValueAt, parseIndirectObjectAt } from "./lexer.js";
import { readXref } from "./xref.js";
import { decodeStreamData } from "./filters.js";
import { assertNotEncrypted, isEncryptedTrailer } from "./security.js";

/** 默认最大文件体积（CONTRACT §4：默认 64MB）。 */
const DOC_MAX_BYTES_DEFAULT = 64 * 1024 * 1024;
/** 单条流解码输出上限的上下界（按文件体积放大，但有天花板）。 */
const DOC_DECODE_MIN = 16 * 1024 * 1024;
const DOC_DECODE_MAX = 192 * 1024 * 1024;
/** 引用解引用链的最大深度。 */
const DOC_MAX_RESOLVE_DEPTH = 32;
/** 页树递归最大深度。 */
const DOC_MAX_PAGE_DEPTH = 64;
/** 页数上限（异常文件保护）。 */
const DOC_MAX_PAGES = 100000;
/** warnings 最多保留这么多条，避免变态文件刷爆内存。 */
const DOC_MAX_WARNINGS = 200;
/** 缺 /MediaBox 时的 A4 兜底。 */
const DOC_DEFAULT_MEDIABOX = [0, 0, 595.28, 841.89];
/** 内容流拼接用的换行字节。 */
const DOC_NEWLINE = Uint8Array.of(0x0a);

/** 在前 1024 字节里找 "%PDF-"（允许文件前面有垃圾字节）。 */
function docFindHeader(bytes) {
  const limit = Math.min(bytes.length - 5, 1024);
  for (let i = 0; i <= limit; i++) {
    if (asciiAt(bytes, i, "%PDF-")) return i;
  }
  return -1;
}

/** 读版本号（"1.7" 之类）。 */
function docReadVersion(bytes, from) {
  let out = "";
  for (let i = from; i < bytes.length && out.length < 8; i++) {
    const b = bytes[i];
    if ((b >= 0x30 && b <= 0x39) || b === 0x2e) out += String.fromCharCode(b);
    else break;
  }
  return out || "1.4";
}

/** 归一化矩形：保证 4 个数字且 x0<x1、y0<y1。 */
function docNormalizeBox(value, fallback) {
  const arr = numArray(value, null);
  if (!arr || arr.length < 4) return fallback ? fallback.slice() : null;
  const box = [arr[0], arr[1], arr[2], arr[3]];
  if (box[2] < box[0]) {
    const t = box[0];
    box[0] = box[2];
    box[2] = t;
  }
  if (box[3] < box[1]) {
    const t = box[1];
    box[1] = box[3];
    box[3] = t;
  }
  return box;
}

/** 归一化旋转角到 0/90/180/270。 */
function docNormalizeRotate(value) {
  const raw = numOr(value, 0);
  const snapped = Math.round(raw / 90) * 90;
  return ((snapped % 360) + 360) % 360;
}

/** 归一化字典：dict / Map → Map；其它 → 空 Map。 */
function docNormalizeDict(value) {
  if (value instanceof Map) return value;
  if (isDict(value)) return value.m;
  if (isStream(value)) return value.dict;
  return new Map();
}

/**
 * PDF 文档。构造后由 loadPdf 调 _load() 完成初始化；不要直接 new 后使用。
 */
export class PdfDocument {
  constructor(bytes, opts) {
    const options = opts || {};
    this.bytes = bytes;
    this.maxBytes = options.maxBytes;
    this.version = "1.4";
    this.trailer = new Map();
    this.warnings = [];
    this.encrypted = false;
    this.rebuilt = false;
    this.headerOffset = 0;
    this.maxDecodeBytes = Math.min(
      DOC_DECODE_MAX,
      Math.max(DOC_DECODE_MIN, bytes.length * 8),
    );
    this._cache = new Map();
    this._loading = new Set();
    this._objStms = new Map();
    this._pages = null;
    this._xrefEntries = new Map();
  }

  _warn(message) {
    if (this.warnings.length >= DOC_MAX_WARNINGS) return;
    const text = "[doc] " + message;
    if (this.warnings.indexOf(text) >= 0) return;
    this.warnings.push(text);
  }

  /** 初始化：文件头 → xref/trailer → 加密判定 → ObjStm 对表。 */
  _load() {
    const headerAt = docFindHeader(this.bytes);
    if (headerAt < 0) throw pdfError("not-pdf", "这不是 PDF 文件（前 1024 字节里没有 %PDF- 标记）");
    this.headerOffset = headerAt;
    this.version = docReadVersion(this.bytes, headerAt + 5);

    const xrefData = readXref(this.bytes, { maxDecodeBytes: this.maxDecodeBytes });
    this.trailer = xrefData.trailer;
    this._xrefEntries = xrefData.entries;
    this.rebuilt = xrefData.rebuilt;
    for (const warning of xrefData.warnings) this._warn(warning);

    this.encrypted = isEncryptedTrailer(this.trailer);
    // 加密文档在这里短路：否则后面读到的是密文，解压只会得到垃圾
    assertNotEncrypted(this.trailer, this);

    this._preloadObjectStreams();
  }

  /* ───────── 对象访问 ───────── */

  /** 解一个间接引用（可链式），解不开返回 null 并记 warning。 */
  resolve(value) {
    let current = value;
    for (let depth = 0; depth < DOC_MAX_RESOLVE_DEPTH; depth++) {
      if (!isRef(current)) return current === undefined ? null : current;
      const next = this.getObject(current.n);
      if (next === null || next === undefined) return null;
      current = next;
    }
    this._warn("引用链过深（可能成环），放弃解引用");
    return null;
  }

  /** 同步取对象（xref 流与 ObjStm 在 load 时已经准备好）。 */
  getObject(num) {
    const n = typeof num === "number" ? Math.trunc(num) : NaN;
    if (!Number.isFinite(n) || n < 0) return null;
    if (this._cache.has(n)) return this._cache.get(n);
    if (this._loading.has(n)) {
      this._warn("对象 " + n + " 解析时检测到循环引用");
      return null;
    }
    this._loading.add(n);
    let value = null;
    try {
      value = this._loadObject(n);
    } catch (e) {
      this._warn("对象 " + n + " 解析失败：" + (isPdfError(e) ? e.message : e && e.message ? e.message : e));
      value = null;
    }
    this._loading.delete(n);
    this._cache.set(n, value);
    return value;
  }

  _loadObject(num) {
    const entry = this._xrefEntries.get(num);
    if (!entry || entry.type === "f") return null;
    if (entry.type === "n") {
      const parsed = this._parseAt(num, entry.offset);
      return parsed ? parsed.value : null;
    }
    if (entry.type === "c") return this._readCompressed(num, entry);
    return null;
  }

  /** 在指定偏移解析出对象；处理「文件头前面有垃圾导致偏移整体偏移」的情况。 */
  _parseAt(num, offset) {
    const resolveLength = (refNum) => {
      const lengthValue = this.getObject(refNum);
      return typeof lengthValue === "number" && Number.isFinite(lengthValue) ? lengthValue : null;
    };
    let parsed = parseIndirectObjectAt(this.bytes, offset, { resolveLength });
    if (parsed && parsed.num === num) return parsed;
    const shift = this.headerOffset | 0;
    if (shift > 0) {
      const shifted = parseIndirectObjectAt(this.bytes, offset + shift, { resolveLength });
      if (shifted && shifted.num === num) {
        this._warn("对象偏移需要加上文件头偏移 " + shift + "，已自动修正");
        return shifted;
      }
    }
    const scanned = this._scanForObject(num, offset);
    if (scanned) return scanned;
    this._warn("对象 " + num + " 在偏移 " + offset + " 处解析失败");
    return null;
  }

  /** 偏移不准时的兜底：在附近小范围扫描 "N G obj"。 */
  _scanForObject(num, nearOffset) {
    const bytes = this.bytes;
    const from = Math.max(0, nearOffset - 64);
    const to = Math.min(bytes.length - 1, nearOffset + 1024);
    const resolveLength = (refNum) => {
      const value = this.getObject(refNum);
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    };
    for (let p = from; p <= to; p++) {
      const b = bytes[p];
      if (b < 0x30 || b > 0x39) continue;
      if (p > 0) {
        const prev = bytes[p - 1];
        if (!isPdfWhiteSpace(prev) && !isPdfDelimiter(prev)) continue;
      }
      const parsed = parseIndirectObjectAt(bytes, p, { resolveLength });
      if (parsed && parsed.num === num) {
        this._warn("对象 " + num + " 偏移不准，已在附近扫描定位");
        return parsed;
      }
    }
    return null;
  }

  _readCompressed(num, entry) {
    const holder = this._loadObjStm(entry.stm);
    if (!holder || !holder.data) {
      this._warn("对象 " + num + " 所在的 /ObjStm " + entry.stm + " 不可用");
      return null;
    }
    let offset = holder.byNum.get(num);
    if (offset === undefined && typeof entry.idx === "number" && entry.idx >= 0 && entry.idx < holder.order.length) {
      if (holder.order[entry.idx] === num) offset = holder.byNum.get(num);
    }
    if (offset === undefined) {
      this._warn("对象 " + num + " 不在 /ObjStm " + entry.stm + " 的 /N 表里");
      return null;
    }
    const parsed = parseValueAt(holder.data, holder.first + offset);
    return parsed ? parsed.value : null;
  }

  /** 解压并解析一个 /ObjStm 的 /N /First 对表（每个容器只做一次）。 */
  _loadObjStm(stmNum) {
    const key = Math.trunc(stmNum);
    const cached = this._objStms.get(key);
    if (cached) return cached;
    const holder = { data: null, first: 0, byNum: new Map(), order: [] };
    this._objStms.set(key, holder); // 先占位，防止自引用递归
    const stream = this.getObject(key);
    if (!isStream(stream)) {
      this._warn("/ObjStm " + key + " 不是流对象");
      return holder;
    }
    let data;
    try {
      data = this.decodeStream(stream);
    } catch (e) {
      this._warn("/ObjStm " + key + " 解压失败：" + (e && e.message ? e.message : e));
      return holder;
    }
    const count = Math.max(0, Math.min(200000, intOr(stream.dict.get("N"), 0)));
    const first = Math.max(0, intOr(stream.dict.get("First"), 0));
    holder.data = data;
    holder.first = first;
    let p = 0;
    for (let i = 0; i < count; i++) {
      const numToken = readToken(data, p);
      if (numToken.kind !== "number") {
        this._warn("/ObjStm " + key + " 的 /N 表在第 " + i + " 项中断");
        break;
      }
      const offToken = readToken(data, numToken.pos);
      if (offToken.kind !== "number") {
        this._warn("/ObjStm " + key + " 的 /N 表在第 " + i + " 项缺少偏移");
        break;
      }
      const objNum = Math.trunc(numToken.value);
      holder.byNum.set(objNum, Math.trunc(offToken.value));
      holder.order.push(objNum);
      p = offToken.pos;
    }
    return holder;
  }

  /** 预解所有被引用的 /ObjStm（只解 /N /First 对表，对象按需解析）。 */
  _preloadObjectStreams() {
    const containers = new Set();
    for (const entry of this._xrefEntries.values()) {
      if (entry && entry.type === "c" && typeof entry.stm === "number") containers.add(entry.stm);
    }
    let guard = 0;
    for (const stm of containers) {
      if (guard++ > 4096) {
        this._warn("/ObjStm 容器过多，剩余部分改为按需解析");
        break;
      }
      this._loadObjStm(stm);
    }
  }

  /* ───────── 页树 ───────── */

  get pageCount() {
    return this._ensurePages().length;
  }

  getPage(index) {
    const pages = this._ensurePages();
    const i = typeof index === "number" ? Math.trunc(index) : NaN;
    if (!Number.isFinite(i) || i < 0 || i >= pages.length) {
      throw new RangeError("页码越界：" + index + "（共 " + pages.length + " 页，0-based）");
    }
    return pages[i];
  }

  _ensurePages() {
    if (this._pages) return this._pages;
    const pages = [];
    const visited = new Set();
    const root = this.resolve(this.trailer.get("Root"));
    const pagesRef = isDict(root) || root instanceof Map ? docGetKey(root, "Pages") : undefined;
    const pagesNode = this.resolve(pagesRef);
    if (pagesNode) {
      this._walkPages(pagesNode, pagesRef, {}, pages, visited, 0);
    } else {
      this._warn("trailer /Root 里没有可用的 /Pages，尝试扫描页面对象");
    }
    if (pages.length === 0) this._fallbackPages(pages);
    this._pages = pages;
    return pages;
  }

  _walkPages(node, nodeRef, inherited, out, visited, depth) {
    if (depth > DOC_MAX_PAGE_DEPTH) {
      this._warn("页树深度超过 " + DOC_MAX_PAGE_DEPTH + "，已截断");
      return;
    }
    const dict = docNormalizeDict(node);
    if (dict.size === 0) {
      this._warn("页树节点不是字典，已跳过");
      return;
    }
    if (isRef(nodeRef)) {
      if (visited.has(nodeRef.n)) {
        this._warn("页树 /Kids 出现环（对象 " + nodeRef.n + "），已跳过");
        return;
      }
      visited.add(nodeRef.n);
    }
    // 继承属性：子节点没写的沿用父节点
    const nextInherited = {
      Resources: inherited.Resources,
      MediaBox: inherited.MediaBox,
      CropBox: inherited.CropBox,
      Rotate: inherited.Rotate,
    };
    if (dict.has("Resources")) nextInherited.Resources = dict.get("Resources");
    if (dict.has("MediaBox")) nextInherited.MediaBox = dict.get("MediaBox");
    if (dict.has("CropBox")) nextInherited.CropBox = dict.get("CropBox");
    if (dict.has("Rotate")) nextInherited.Rotate = dict.get("Rotate");

    const typeName = nameOf(dict.get("Type"));
    const kidsRaw = dict.get("Kids");
    const kids = kidsRaw === undefined ? undefined : this.resolve(kidsRaw);
    if (Array.isArray(kids)) {
      for (const kidRef of kids) {
        if (out.length >= DOC_MAX_PAGES) {
          this._warn("页数超过上限 " + DOC_MAX_PAGES + "，已截断");
          return;
        }
        const kid = this.resolve(kidRef);
        if (!kid) {
          this._warn("页树 /Kids 里有一项解不开，已跳过");
          continue;
        }
        this._walkPages(kid, kidRef, nextInherited, out, visited, depth + 1);
      }
      return;
    }
    if (typeName === "Pages") {
      this._warn("页树中间节点 /Type=/Pages 但 /Kids 不可用，已跳过");
      return;
    }
    out.push(this._makePage(out.length, nodeRef, dict, nextInherited));
  }

  _makePage(index, ref, dict, inherited) {
    const mediaBox = docNormalizeBox(this.resolve(inherited.MediaBox), DOC_DEFAULT_MEDIABOX);
    const cropBox = docNormalizeBox(this.resolve(inherited.CropBox), null);
    const rotate = docNormalizeRotate(this.resolve(inherited.Rotate));
    const resources = docNormalizeDict(this.resolve(inherited.Resources));
    return {
      index,
      ref: isRef(ref) ? { t: "ref", n: ref.n, g: ref.g } : null,
      dict,
      mediaBox,
      cropBox,
      rotate,
      resources,
    };
  }

  /** 页树彻底不可用时的兜底：按对象号扫描 /Type /Page。 */
  _fallbackPages(pages) {
    const nums = [...this._xrefEntries.keys()].sort((a, b) => a - b);
    if (nums.length > 20000) {
      this._warn("xref 条目过多（" + nums.length + "），放弃按 /Type /Page 恢复");
      return;
    }
    for (const num of nums) {
      if (pages.length >= DOC_MAX_PAGES) break;
      const object = this.getObject(num);
      const dict = isDict(object) ? object.m : null;
      if (!dict) continue;
      if (nameOf(dict.get("Type")) !== "Page") continue;
      const pageRef = { t: "ref", n: num, g: 0 };
      this._walkPages({ t: "dict", m: dict }, pageRef, {}, pages, new Set(), 0);
    }
    if (pages.length > 0) this._warn("已按 /Type /Page 扫描恢复页列表（" + pages.length + " 页）");
  }

  /* ───────── 流与 XObject ───────── */

  /** 解码一个 stream（/Filter、/DecodeParms 的间接引用在这里解掉）。 */
  decodeStream(stream) {
    if (!isStream(stream)) {
      this._warn("decodeStream 收到非流对象");
      return new Uint8Array(0);
    }
    let dict = stream.dict;
    const filter = dict.get("Filter");
    const parms = dict.get("DecodeParms");
    if (isRef(filter) || isRef(parms)) {
      dict = new Map(dict);
      if (isRef(filter)) dict.set("Filter", this.resolve(filter));
      if (isRef(parms)) dict.set("DecodeParms", this.resolve(parms));
    }
    return decodeStreamData(this, dict, stream.raw);
  }

  /** 容错版 decodeStream：失败记 warning 返回空字节，不抛（CONTRACT §4 补充）。 */
  tryDecodeStream(stream) {
    try {
      return this.decodeStream(stream);
    } catch (e) {
      this._warn("流解码失败：" + (isPdfError(e) ? e.message : e && e.message ? e.message : e));
      return new Uint8Array(0);
    }
  }

  /** 按顺序拼接 /Contents（单流或数组）解码后的字节，段间补 "\n"。 */
  getPageContentBytes(page) {
    if (!page || !(page.dict instanceof Map)) {
      this._warn("getPageContentBytes 收到非法页面");
      return new Uint8Array(0);
    }
    const contents = this.resolve(page.dict.get("Contents"));
    if (!contents) return new Uint8Array(0);
    const list = Array.isArray(contents) ? contents : [contents];
    const parts = [];
    for (const item of list) {
      const stream = this.resolve(item);
      if (!isStream(stream)) {
        this._warn("页面 /Contents 里有一项不是流，已跳过");
        continue;
      }
      const bytes = this.tryDecodeStream(stream);
      if (bytes.length > 0) parts.push(bytes);
    }
    if (parts.length === 0) return new Uint8Array(0);
    if (parts.length === 1) return parts[0];
    const pieces = [];
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) pieces.push(DOC_NEWLINE);
      pieces.push(parts[i]);
    }
    return concatBytes(pieces);
  }

  /** 解析 page 的 /Resources /XObject 中名为 name 的 XObject。 */
  loadXObject(page, name) {
    if (!page) return null;
    const resources = page.resources instanceof Map ? page.resources : docNormalizeDict(this.resolve(page.dict && page.dict.get("Resources")));
    const xobjects = docNormalizeDict(this.resolve(resources.get("XObject")));
    const raw = xobjects.get(name);
    if (raw === undefined) return null;
    const stream = this.resolve(raw);
    if (!isStream(stream)) {
      this._warn("/XObject " + name + " 不是流对象");
      return null;
    }
    return { dict: stream.dict, bytes: this.tryDecodeStream(stream) };
  }
}

/** 从 dict/Map 里取一个键（小工具，避免重复判型）。 */
function docGetKey(node, key) {
  if (node instanceof Map) return node.get(key);
  if (isDict(node)) return node.m.get(key);
  return undefined;
}

/**
 * 载入一份 PDF。
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {{maxBytes?: number, maxDecodeBytes?: number}} [opts]
 * @returns {PdfDocument}
 */
export function loadPdf(bytes, opts) {
  const options = opts || {};
  let data = bytes;
  if (data instanceof ArrayBuffer) {
    data = new Uint8Array(data);
  } else if (data && typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(data) && !(data instanceof Uint8Array)) {
    data = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (!(data instanceof Uint8Array)) throw pdfError("not-pdf", "输入不是 PDF 字节数组");
  const maxBytes =
    typeof options.maxBytes === "number" && options.maxBytes > 0
      ? Math.floor(options.maxBytes)
      : DOC_MAX_BYTES_DEFAULT;
  if (data.length > maxBytes) {
    const sizeMB = (data.length / (1024 * 1024)).toFixed(1);
    const maxMB = (maxBytes / (1024 * 1024)).toFixed(0);
    throw pdfError("too-large", "PDF 体积 " + sizeMB + "MB，超过上限 " + maxMB + "MB");
  }
  const doc = new PdfDocument(data, { ...options, maxBytes });
  doc._load();
  return doc;
}

/** 契约 §4：PdfError 从 document 也可导入（便于调用方只 import 一个模块）。 */
export { PdfError };
