/**
 * pdf4oh · 流滤镜链解码（CONTRACT §4）。
 *
 * 职责与边界：
 *   - 输入「已解析的 stream 字典 + 原始字节」，输出解码后的字节；负责 /Filter 链、
 *     /DecodeParms 对齐、PNG/TIFF predictor、LZW/ASCII 系列/RunLength。
 *   - 不解引用（Filter/DecodeParms 里的间接引用在这里按 doc 解一次，方便调用方）；
 *     不处理加密（Crypt 只做空操作）；不解释图片内容（DCT/JPX/CCITT/JBIG2 原样返回
 *     并记 warning，交给上层计图或后续版本处理）。
 *   - 所有函数同步、无副作用（除 doc.warnings）；失败抛 PdfError。
 */

import {
  pdfError,
  isPdfError,
  dictMap,
  dictGet,
  intOr,
  nameList,
  resolveOr,
} from "./util.js";
import { inflateRaw } from "./inflate.js";

/** 单条流解码输出的默认上限（防解压炸弹）。 */
const FILTER_MAX_DECODED_BYTES = 64 * 1024 * 1024;

/** 这些滤镜产出的是图片编码，本层不解码，原样返回。 */
const FILTER_IMAGE_NAMES = {
  DCTDecode: true,
  DCT: true,
  JPXDecode: true,
  CCITTFaxDecode: true,
  CCF: true,
  JBIG2Decode: true,
};

function filtersWarn(doc, message) {
  if (doc && Array.isArray(doc.warnings)) doc.warnings.push("[filters] " + message);
}

function filtersMaxBytes(doc) {
  if (doc && typeof doc.maxDecodeBytes === "number" && doc.maxDecodeBytes > 0) return Math.floor(doc.maxDecodeBytes);
  return FILTER_MAX_DECODED_BYTES;
}

/** 从 /DecodeParms（可能是单字典或与 Filter 一一对应的数组）取第 index 项。 */
function filtersGetParm(doc, parms, index) {
  if (!parms) return null;
  const item = Array.isArray(parms) ? parms[index] : index === 0 ? parms : null;
  const resolved = resolveOr(doc, item, null);
  if (!resolved) return null;
  return dictMap(resolved) || null;
}

function filtersEnsureOut(out, extra) {
  const need = out.len + extra;
  if (need > out.max) throw pdfError("too-large", "解码输出超过上限（" + out.max + " 字节）");
  if (need <= out.buf.length) return;
  let cap = out.buf.length;
  while (cap < need) cap *= 2;
  if (cap > out.max) cap = out.max;
  if (cap < need) cap = need;
  const next = new Uint8Array(cap);
  next.set(out.buf.subarray(0, out.len));
  out.buf = next;
}

function filtersOutBytes(out) {
  return out.len === out.buf.length ? out.buf : out.buf.slice(0, out.len);
}

/** FlateDecode：先严格解，坏流再 lenient 一遍，尽量给出可用字节。 */
function filtersInflate(doc, data) {
  const maxBytes = filtersMaxBytes(doc);
  try {
    return inflateRaw(data, { maxBytes });
  } catch (e) {
    if (isPdfError(e) && e.code === "too-large") throw e;
    let soft;
    try {
      soft = inflateRaw(data, { maxBytes, lenient: true });
    } catch (e2) {
      soft = null;
    }
    if (soft && soft.length > 0) {
      filtersWarn(doc, "Flate 数据不完整，已尽量解码（" + soft.length + " 字节）");
      return soft;
    }
    throw e;
  }
}

function filtersHexVal(byte) {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  return -1;
}

/** ASCIIHexDecode：忽略空白，'>' 结束，奇尾补 0。 */
function filtersDecodeAsciiHex(doc, data) {
  const out = new Uint8Array(data.length + 1);
  let len = 0;
  let hi = -1;
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b === 0x3e) break; // '>'
    if (b === 0x00 || b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d || b === 0x20) continue;
    const v = filtersHexVal(b);
    if (v < 0) {
      filtersWarn(doc, "ASCIIHex 流出现非法字符，已提前结束");
      break;
    }
    if (hi < 0) {
      hi = v;
    } else {
      out[len++] = (hi << 4) | v;
      hi = -1;
    }
  }
  if (hi >= 0) out[len++] = hi << 4;
  return out.slice(0, len);
}

function filtersWriteAscii85Group(out, group, count) {
  let value = 0;
  for (let i = 0; i < 5; i++) value = value * 85 + (i < group.length ? group[i] : 84);
  if (value > 0xffffffff) {
    value = 0xffffffff; // 容错：溢出的组按全 1 处理
  }
  const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  const take = count === 5 ? 4 : count - 1;
  filtersEnsureOut(out, take);
  for (let i = 0; i < take; i++) out.buf[out.len++] = bytes[i];
}

/** ASCII85Decode（Adobe 变体）：'z' 表示四个 0，'~>' 结束。 */
function filtersDecodeAscii85(doc, data) {
  const maxBytes = filtersMaxBytes(doc);
  const out = { buf: new Uint8Array(Math.max(256, Math.min(data.length * 4, maxBytes))), len: 0, max: maxBytes };
  const group = [];
  let started = false;
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b === 0x00 || b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d || b === 0x20) continue;
    if (!started) {
      started = true;
      // 可选的 '<~' 起始标记
      if (b === 0x3c) continue;
    }
    if (b === 0x7e) break; // '~'
    if (b === 0x7a && group.length === 0) {
      filtersEnsureOut(out, 4);
      out.buf[out.len++] = 0;
      out.buf[out.len++] = 0;
      out.buf[out.len++] = 0;
      out.buf[out.len++] = 0;
      continue;
    }
    if (b < 0x21 || b > 0x75) {
      filtersWarn(doc, "ASCII85 流出现非法字符，已提前结束");
      break;
    }
    group.push(b - 0x21);
    if (group.length === 5) {
      filtersWriteAscii85Group(out, group, 5);
      group.length = 0;
    }
  }
  if (group.length === 1) {
    filtersWarn(doc, "ASCII85 尾部只有 1 个字符，已忽略");
  } else if (group.length > 1) {
    filtersWriteAscii85Group(out, group, group.length);
  }
  return filtersOutBytes(out);
}

/** RunLengthDecode：0..127 字面量、129..255 重复、128 结束。 */
function filtersDecodeRunLength(doc, data) {
  const maxBytes = filtersMaxBytes(doc);
  const out = { buf: new Uint8Array(Math.max(256, Math.min(data.length * 2, maxBytes))), len: 0, max: maxBytes };
  let i = 0;
  while (i < data.length) {
    const n = data[i++];
    if (n === 128) break;
    if (n < 128) {
      let count = n + 1;
      if (i + count > data.length) {
        filtersWarn(doc, "RunLength 字面量越过流末尾，已截断");
        count = data.length - i;
      }
      filtersEnsureOut(out, count);
      out.buf.set(data.subarray(i, i + count), out.len);
      out.len += count;
      i += count;
    } else {
      const count = 257 - n;
      if (i >= data.length) {
        filtersWarn(doc, "RunLength 重复段缺少字节，已停止");
        break;
      }
      const value = data[i++];
      filtersEnsureOut(out, count);
      out.buf.fill(value, out.len, out.len + count);
      out.len += count;
    }
  }
  return filtersOutBytes(out);
}

/** LZWDecode（PDF 变体，默认 EarlyChange=1）。 */
function filtersDecodeLzw(doc, data, parm) {
  const early = parm ? intOr(dictGet(parm, "EarlyChange"), 1) : 1;
  const maxBytes = filtersMaxBytes(doc);
  const out = { buf: new Uint8Array(Math.max(256, Math.min(data.length * 3, maxBytes))), len: 0, max: maxBytes };
  const table = new Array(4096).fill(null);
  const resetTable = () => {
    for (let i = 0; i < 256; i++) table[i] = Uint8Array.of(i);
    for (let i = 256; i < 4096; i++) table[i] = null;
  };
  resetTable();
  let next = 258;
  let codeLen = 9;
  let prev = null;
  let bitBuf = 0;
  let bitCnt = 0;
  let pos = 0;

  const readCode = () => {
    while (bitCnt < codeLen) {
      if (pos >= data.length) return -1;
      bitBuf |= data[pos++] << bitCnt;
      bitCnt += 8;
    }
    const code = bitBuf & ((1 << codeLen) - 1);
    bitBuf >>>= codeLen;
    bitCnt -= codeLen;
    return code;
  };

  const emit = (bytes) => {
    filtersEnsureOut(out, bytes.length);
    out.buf.set(bytes, out.len);
    out.len += bytes.length;
  };

  for (;;) {
    const code = readCode();
    if (code < 0) {
      filtersWarn(doc, "LZW 数据提前结束");
      break;
    }
    if (code === 256) {
      resetTable();
      next = 258;
      codeLen = 9;
      prev = null;
      continue;
    }
    if (code === 257) break;
    let entry;
    if (code < next && table[code]) {
      entry = table[code];
    } else if (prev && code === next) {
      entry = new Uint8Array(prev.length + 1);
      entry.set(prev);
      entry[prev.length] = prev[0];
    } else {
      filtersWarn(doc, "LZW 码流非法，已停止解码");
      break;
    }
    emit(entry);
    if (prev && next < 4096) {
      const fresh = new Uint8Array(prev.length + 1);
      fresh.set(prev);
      fresh[prev.length] = entry[0];
      table[next++] = fresh;
      if (next + early >= 1 << codeLen && codeLen < 12) codeLen++;
    }
    prev = entry;
  }
  return filtersOutBytes(out);
}

/* ───────── Predictor（PNG 10–15 / TIFF 2） ───────── */

function filtersPaeth(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = p > left ? p - left : left - p;
  const pb = p > up ? p - up : up - p;
  const pc = p > upLeft ? p - upLeft : upLeft - p;
  if (pa <= pb && pa <= pc) return left;
  return pb <= pc ? up : upLeft;
}

/** PNG predictor（10–15 一律按「每行首字节是行过滤器」处理，这是实际文件的写法）。 */
function filtersPngPredictor(doc, data, rowBytes, bytesPerPixel) {
  if (rowBytes <= 0) return data;
  const rows = Math.floor(data.length / (rowBytes + 1));
  if (rows <= 0) {
    filtersWarn(doc, "PNG predictor 数据不足一行，已忽略");
    return data;
  }
  const out = new Uint8Array(rows * rowBytes);
  let prev = new Uint8Array(rowBytes);
  let cur = new Uint8Array(rowBytes);
  let src = 0;
  for (let r = 0; r < rows; r++) {
    const filter = data[src++];
    const rowStart = src;
    src += rowBytes;
    for (let i = 0; i < rowBytes; i++) cur[i] = data[rowStart + i];
    if (filter === 1) {
      for (let i = bytesPerPixel; i < rowBytes; i++) cur[i] = (cur[i] + cur[i - bytesPerPixel]) & 0xff;
    } else if (filter === 2) {
      for (let i = 0; i < rowBytes; i++) cur[i] = (cur[i] + prev[i]) & 0xff;
    } else if (filter === 3) {
      for (let i = 0; i < rowBytes; i++) {
        const left = i >= bytesPerPixel ? cur[i - bytesPerPixel] : 0;
        cur[i] = (cur[i] + ((left + prev[i]) >> 1)) & 0xff;
      }
    } else if (filter === 4) {
      for (let i = 0; i < rowBytes; i++) {
        const left = i >= bytesPerPixel ? cur[i - bytesPerPixel] : 0;
        const upLeft = i >= bytesPerPixel ? prev[i - bytesPerPixel] : 0;
        cur[i] = (cur[i] + filtersPaeth(left, prev[i], upLeft)) & 0xff;
      }
    } else if (filter !== 0) {
      // 未知过滤器：按 none 处理并警告（比整页失败好）
      filtersWarn(doc, "未知的 PNG 行过滤器 " + filter + "，按 none 处理");
    }
    out.set(cur, r * rowBytes);
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return out;
}

/** 取 1/2/4/8/16 bpc 打包样本中的第 index 个。 */
function filtersGetSample(row, index, bpc) {
  if (bpc === 8) return row[index];
  if (bpc === 16) return (row[index * 2] << 8) | row[index * 2 + 1];
  const bitPos = index * bpc;
  const bytePos = bitPos >> 3;
  const shift = 8 - bpc - (bitPos & 7);
  return (row[bytePos] >> shift) & ((1 << bpc) - 1);
}

function filtersSetSample(row, index, bpc, value) {
  if (bpc === 8) {
    row[index] = value & 0xff;
    return;
  }
  if (bpc === 16) {
    row[index * 2] = (value >>> 8) & 0xff;
    row[index * 2 + 1] = value & 0xff;
    return;
  }
  const bitPos = index * bpc;
  const bytePos = bitPos >> 3;
  const shift = 8 - bpc - (bitPos & 7);
  const mask = ((1 << bpc) - 1) << shift;
  row[bytePos] = (row[bytePos] & ~mask) | ((value << shift) & mask);
}

/** TIFF predictor 2：每个样本加上同一行里前一个同色样本。 */
function filtersTiffPredictor(doc, data, colors, bpc, columns, rowBytes) {
  const supported = bpc === 1 || bpc === 2 || bpc === 4 || bpc === 8 || bpc === 16;
  if (!supported) {
    filtersWarn(doc, "TIFF predictor 的 BitsPerComponent=" + bpc + " 暂不支持，已忽略 predictor");
    return data;
  }
  const rows = Math.floor(data.length / rowBytes);
  if (rows <= 0) return data;
  const samples = colors * columns;
  const mask = bpc === 16 ? 0xffff : (1 << bpc) - 1;
  const out = new Uint8Array(rows * rowBytes);
  for (let r = 0; r < rows; r++) {
    const base = r * rowBytes;
    const row = out.subarray(base, base + rowBytes);
    row.set(data.subarray(base, base + rowBytes));
    for (let s = colors; s < samples; s++) {
      const value = (filtersGetSample(row, s, bpc) + filtersGetSample(row, s - colors, bpc)) & mask;
      filtersSetSample(row, s, bpc, value);
    }
  }
  return out;
}

/** 应用 /DecodeParms 的 predictor（Flate / LZW 之后的字节级后处理）。 */
function filtersApplyPredictor(doc, parm, data) {
  const predictor = intOr(dictGet(parm, "Predictor"), 1);
  if (predictor <= 1) return data;
  const colors = Math.max(1, intOr(dictGet(parm, "Colors"), 1));
  const bpc = Math.max(1, intOr(dictGet(parm, "BitsPerComponent"), 8));
  const columns = Math.max(1, intOr(dictGet(parm, "Columns"), 1));
  const rowBytes = Math.ceil((colors * columns * bpc) / 8);
  const bytesPerPixel = Math.max(1, Math.ceil((colors * bpc) / 8));
  if (predictor === 2) return filtersTiffPredictor(doc, data, colors, bpc, columns, rowBytes);
  if (predictor >= 10 && predictor <= 15) return filtersPngPredictor(doc, data, rowBytes, bytesPerPixel);
  filtersWarn(doc, "未知的 Predictor " + predictor + "，已忽略");
  return data;
}

/**
 * 按字典里的 /Filter（单名或数组）与 /DecodeParms 解码流字节。
 * @param {object} doc PdfDocument（用到 warnings / maxDecodeBytes / resolve）
 * @param {Map|object} dict stream 字典（Map 或 {t:"dict",m:Map}）
 * @param {Uint8Array} raw 原始字节
 * @returns {Uint8Array}
 */
export function decodeStreamData(doc, dict, raw) {
  const map = dictMap(dict);
  const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw && raw.buffer ? raw : 0);
  if (!map) {
    filtersWarn(doc, "stream 缺少字典，按原始字节返回");
    return data;
  }
  const filters = nameList(resolveOr(doc, map.get("Filter"), undefined));
  if (filters.length === 0) return data;
  const parms = resolveOr(doc, map.get("DecodeParms"), null);

  let out = data;
  for (let i = 0; i < filters.length; i++) {
    const name = filters[i];
    if (FILTER_IMAGE_NAMES[name]) {
      filtersWarn(doc, "图片滤镜 " + name + " 未解码，原样返回 " + out.length + " 字节");
      return out;
    }
    const parm = filtersGetParm(doc, parms, i);
    if (name === "FlateDecode" || name === "Fl") {
      out = filtersInflate(doc, out);
      if (parm) out = filtersApplyPredictor(doc, parm, out);
    } else if (name === "ASCIIHexDecode" || name === "AHx") {
      out = filtersDecodeAsciiHex(doc, out);
    } else if (name === "ASCII85Decode" || name === "A85") {
      out = filtersDecodeAscii85(doc, out);
    } else if (name === "RunLengthDecode" || name === "RL") {
      out = filtersDecodeRunLength(doc, out);
    } else if (name === "LZWDecode" || name === "LZW") {
      out = filtersDecodeLzw(doc, out, parm);
      if (parm) out = filtersApplyPredictor(doc, parm, out);
    } else if (name === "Crypt") {
      const cryptName = parm ? (dictGet(parm, "Name") || {}).v : "Identity";
      if (cryptName && cryptName !== "Identity") {
        filtersWarn(doc, "Crypt 滤镜（" + cryptName + "）本期不做解密，按 Identity 处理");
      }
    } else {
      throw pdfError("unsupported", "不支持的流滤镜：" + name);
    }
  }
  return out;
}

/** 预测器/滤镜小工具（供测试或 pdf-text 复用，名字带前缀避免拼接重名）。 */
export function filtersPredictorSupported(predictor) {
  return predictor === 1 || predictor === 2 || (predictor >= 10 && predictor <= 15);
}