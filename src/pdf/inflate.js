/**
 * pdf4oh · DEFLATE / zlib 解压（RFC 1951 / RFC 1950，纯同步、零依赖）。
 *
 * 职责与边界：
 *   - 只负责「把压缩字节还原成原始字节」，并按 RFC 1950 校验 adler32；
 *     不做 predictor、不处理滤镜链、不碰加密（分别在 filters.js / security.js）。
 *   - 支持 stored / fixed Huffman / dynamic Huffman 三种块；自动识别有无 zlib 头
 *     （0x78 ...，即 CMF/FLG 校验通过就当 zlib）；支持 maxBytes 上限（防解压炸弹）。
 *   - 坏数据抛 PdfError("malformed")，超过上限抛 PdfError("too-large")；
 *     lenient 模式（内部用，filters.js 容错）尽量返回已解出的部分。
 *
 * 为什么自己写：插件在 webview 里执行，不能引 npm 包，且不能假设
 * DecompressionStream 存在（旧 WKWebView 没有，见 CONTRACT §0）。
 */

import { pdfError, isPdfError } from "./util.js";

/** 单条流的解压输出默认上限（64MB），可由 opts.maxBytes 覆盖。 */
const INFLATE_MAX_DEFAULT = 64 * 1024 * 1024;

/* 长度码 257..285 的基准值与额外位数。 */
const INFLATE_LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const INFLATE_LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];

/* 距离码 0..29 的基准值与额外位数。 */
const INFLATE_DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577,
];
const INFLATE_DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

/* 动态 Huffman 里「码长码」的传输顺序。 */
const INFLATE_CODELEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** 快速查表用：一次 peeking 的位数（litlen 9 位覆盖绝大多数码）。 */
const INFLATE_LOOKUP_LIT = 9;
const INFLATE_LOOKUP_DIST = 6;

/** LSB-first 位读取器：DEFLATE 的位序是「低位移出」。 */
class InflateBitReader {
  constructor(bytes, pos) {
    this.bytes = bytes;
    this.pos = pos | 0;
    this.bitBuf = 0;
    this.bitCnt = 0;
  }

  /** 尽量把 bitBuf 填到 ≥25 位（足以读 15 位码）。 */
  refill() {
    const bytes = this.bytes;
    const n = bytes.length;
    while (this.bitCnt <= 24 && this.pos < n) {
      this.bitBuf |= bytes[this.pos++] << this.bitCnt;
      this.bitCnt += 8;
    }
  }

  bits(n) {
    if (n === 0) return 0;
    if (this.bitCnt < n) {
      this.refill();
      if (this.bitCnt < n) throw inflateShortError();
    }
    const value = this.bitBuf & ((1 << n) - 1);
    this.bitBuf >>>= n;
    this.bitCnt -= n;
    return value;
  }

  /** 只看不取：必须保证 bitCnt ≥ n，否则调用方走慢路径。 */
  peek(n) {
    return this.bitBuf & ((1 << n) - 1);
  }

  drop(n) {
    this.bitBuf >>>= n;
    this.bitCnt -= n;
  }

  /** 丢到字节边界（stored 块与 adler 校验都需要）。 */
  alignToByte() {
    const drop = this.bitCnt & 7;
    this.bitBuf >>>= drop;
    this.bitCnt -= drop;
  }

  /** 字节对齐后取一个字节（bitBuf 里可能还压着整字节）。 */
  readAlignedByte() {
    if (this.bitCnt >= 8) {
      const b = this.bitBuf & 0xff;
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
      return b;
    }
    if (this.pos < this.bytes.length) return this.bytes[this.pos++];
    throw inflateShortError();
  }
}

/** 内部：数据意外结束（lenient 模式下会被吞掉，返回已解出的部分）。 */
function inflateShortError() {
  const e = new Error("deflate 数据提前结束");
  e.inflateShort = true;
  return e;
}

function inflateMalformed(message) {
  return pdfError("malformed", "Flate 数据损坏：" + message);
}

/**
 * 构造规范 Huffman 解码表。
 * lengths: 每个符号的码长（0=未使用）；count: 有效符号数。
 */
function inflateBuildHuffman(lengths, count) {
  const counts = new Int32Array(16);
  for (let i = 0; i < count; i++) {
    const len = lengths[i];
    if (len > 15) throw inflateMalformed("Huffman 码长超过 15");
    // counts[0] 必须保持 0：规范 Huffman 的 firstCode 递推从长度 1 开始，
    // 若把「未使用的符号」计进 counts[0]，所有长度的首码都会整体偏移
    // （2026-11 真实课程 PDF xref 流复现：动态 Huffman 表必然含空位）。
    if (len > 0) counts[len]++;
  }
  let maxBits = 15;
  while (maxBits > 0 && counts[maxBits] === 0) maxBits--;
  if (maxBits === 0) throw inflateMalformed("Huffman 码表为空");

  const offsets = new Int32Array(16);
  let total = 0;
  for (let len = 1; len <= 15; len++) {
    offsets[len] = total;
    total += counts[len];
  }
  const symbols = new Int32Array(total);
  const cursor = offsets.slice();
  for (let i = 0; i < count; i++) {
    const len = lengths[i];
    if (len > 0) symbols[cursor[len]++] = i;
  }
  // 规范码字（RFC 1951 §3.2.2）：注意 bl_count[0] 必须强制为 0，
  // counts[0] 只是「未使用的符号数」，不能参与 first-code 递推。
  const firstCode = new Int32Array(16);
  let code = 0;
  for (let len = 1; len <= 15; len++) {
    code = (code + (len === 1 ? 0 : counts[len - 1])) << 1;
    firstCode[len] = code;
  }
  const tableBits = Math.min(maxBits, 9);
  const table = new Int32Array(1 << tableBits);
  inflateFillHuffmanTable(table, tableBits, counts, offsets, symbols, firstCode, maxBits);
  return { counts, offsets, symbols, firstCode, maxBits, tableBits, table };
}

/** 把短码展开成查表（值 = (symbol << 4) | codeLen，0 表示需要走慢路径）。 */
function inflateFillHuffmanTable(table, tableBits, counts, offsets, symbols, firstCode, maxBits) {
  const size = 1 << tableBits;
  const limit = Math.min(maxBits, tableBits);
  for (let len = 1; len <= limit; len++) {
    const n = counts[len];
    for (let i = 0; i < n; i++) {
      const sym = symbols[offsets[len] + i];
      let code = firstCode[len] + i;
      let rev = 0;
      for (let b = 0; b < len; b++) {
        rev = (rev << 1) | (code & 1);
        code >>>= 1;
      }
      const entry = (sym << 4) | len;
      for (let j = rev; j < size; j += 1 << len) table[j] = entry;
    }
  }
}

/** 解一个 Huffman 符号：先查表，未命中再逐位比较（长码/流尾走慢路径）。 */
function inflateDecodeSymbol(reader, huff) {
  if (reader.bitCnt < huff.tableBits) reader.refill();
  if (reader.bitCnt >= huff.tableBits) {
    const entry = huff.table[reader.peek(huff.tableBits)];
    if (entry !== 0) {
      reader.drop(entry & 15);
      return entry >> 4;
    }
  }
  let code = 0;
  const counts = huff.counts;
  const first = huff.firstCode;
  for (let len = 1; len <= huff.maxBits; len++) {
    code = (code << 1) | reader.bits(1);
    const idx = code - first[len];
    if (idx >= 0 && idx < counts[len]) return huff.symbols[huff.offsets[len] + idx];
  }
  throw inflateMalformed("无效的 Huffman 编码");
}

/** 固定 Huffman 表（RFC 1951 §3.2.6），只建一次。 */
function inflateBuildFixedTables() {
  const litLens = new Uint8Array(288);
  for (let i = 0; i < 144; i++) litLens[i] = 8;
  for (let i = 144; i < 256; i++) litLens[i] = 9;
  for (let i = 256; i < 280; i++) litLens[i] = 7;
  for (let i = 280; i < 288; i++) litLens[i] = 8;
  const distLens = new Uint8Array(32);
  for (let i = 0; i < 32; i++) distLens[i] = 5;
  return {
    lit: inflateBuildHuffman(litLens, 288),
    dist: inflateBuildHuffman(distLens, 32),
  };
}

const INFLATE_FIXED_TABLES = inflateBuildFixedTables();

/** 输出缓冲：按需翻倍扩容，超过 maxBytes 立即失败（防解压炸弹）。 */
function inflateNewOutput(maxBytes, hint) {
  const cap = Math.max(256, Math.min(maxBytes, hint || 1 << 16));
  return { buf: new Uint8Array(cap), len: 0, max: maxBytes };
}

function inflateEnsureOutput(out, extra) {
  const need = out.len + extra;
  if (need > out.max) {
    throw pdfError("too-large", "解压后数据超过上限（" + out.max + " 字节）");
  }
  if (need <= out.buf.length) return;
  let cap = out.buf.length;
  while (cap < need) cap *= 2;
  if (cap > out.max) cap = out.max;
  if (cap < need) cap = need;
  const next = new Uint8Array(cap);
  next.set(out.buf.subarray(0, out.len));
  out.buf = next;
}

function inflatePutByte(out, byte) {
  if (out.len >= out.buf.length) inflateEnsureOutput(out, 1);
  out.buf[out.len++] = byte;
}

/** LZ77 回溯复制：dist < len 时必须逐字节（重叠部分来自刚写入的数据）。 */
function inflateCopyMatch(out, dist, len) {
  inflateEnsureOutput(out, len);
  const buf = out.buf;
  const from = out.len - dist;
  const to = out.len;
  if (dist >= len) {
    buf.copyWithin(to, from, from + len);
  } else {
    for (let k = 0; k < len; k++) buf[to + k] = buf[from + k];
  }
  out.len += len;
}

function inflateStoredBlock(reader, out) {
  reader.alignToByte();
  const len = reader.readAlignedByte() | (reader.readAlignedByte() << 8);
  const nlen = reader.readAlignedByte() | (reader.readAlignedByte() << 8);
  if (((len ^ 0xffff) & 0xffff) !== nlen) throw inflateMalformed("stored 块 LEN/NLEN 不匹配");
  inflateEnsureOutput(out, len);
  let remaining = len;
  while (remaining > 0 && reader.bitCnt >= 8) {
    out.buf[out.len++] = reader.readAlignedByte();
    remaining--;
  }
  if (remaining > 0) {
    const avail = reader.bytes.length - reader.pos;
    if (avail < remaining) {
      // 尽量复制已有的，再交给外层按 lenient/strict 处理
      const take = Math.max(0, avail);
      out.buf.set(reader.bytes.subarray(reader.pos, reader.pos + take), out.len);
      out.len += take;
      reader.pos += take;
      throw inflateShortError();
    }
    out.buf.set(reader.bytes.subarray(reader.pos, reader.pos + remaining), out.len);
    out.len += remaining;
    reader.pos += remaining;
  }
}

function inflateHuffmanBlock(reader, out, lit, dist) {
  for (;;) {
    const sym = inflateDecodeSymbol(reader, lit);
    if (sym < 256) {
      inflatePutByte(out, sym);
      continue;
    }
    if (sym === 256) return;
    const li = sym - 257;
    if (li < 0 || li >= 29) throw inflateMalformed("非法的长度码 " + sym);
    const len = INFLATE_LEN_BASE[li] + (INFLATE_LEN_EXTRA[li] ? reader.bits(INFLATE_LEN_EXTRA[li]) : 0);
    const dsym = inflateDecodeSymbol(reader, dist);
    if (dsym >= 30) throw inflateMalformed("非法的距离码 " + dsym);
    const back = INFLATE_DIST_BASE[dsym] + (INFLATE_DIST_EXTRA[dsym] ? reader.bits(INFLATE_DIST_EXTRA[dsym]) : 0);
    if (back > out.len) throw inflateMalformed("回溯距离超出已输出数据");
    inflateCopyMatch(out, back, len);
  }
}

function inflateReadDynamicTables(reader) {
  const hlit = reader.bits(5) + 257;
  const hdist = reader.bits(5) + 1;
  const hclen = reader.bits(4) + 4;
  if (hlit > 288) throw inflateMalformed("HLIT 超出上限");
  if (hdist > 32) throw inflateMalformed("HDIST 超出上限");

  const clenLens = new Uint8Array(19);
  for (let i = 0; i < hclen; i++) clenLens[INFLATE_CODELEN_ORDER[i]] = reader.bits(3);
  const clenHuff = inflateBuildHuffman(clenLens, 19);

  const total = hlit + hdist;
  const lens = new Uint8Array(total);
  let i = 0;
  while (i < total) {
    const sym = inflateDecodeSymbol(reader, clenHuff);
    if (sym < 16) {
      lens[i++] = sym;
      continue;
    }
    let repeat = 0;
    let value = 0;
    if (sym === 16) {
      if (i === 0) throw inflateMalformed("码长重复出现在开头");
      value = lens[i - 1];
      repeat = 3 + reader.bits(2);
    } else if (sym === 17) {
      repeat = 3 + reader.bits(3);
    } else if (sym === 18) {
      repeat = 11 + reader.bits(7);
    } else {
      throw inflateMalformed("非法的码长码 " + sym);
    }
    if (i + repeat > total) throw inflateMalformed("码长重复次数越界");
    while (repeat-- > 0) lens[i++] = value;
  }
  return {
    lit: inflateBuildHuffman(lens.subarray(0, hlit), hlit),
    dist: inflateBuildHuffman(lens.subarray(hlit), hdist),
  };
}

function inflateBlocks(reader, out) {
  let final = 0;
  while (!final) {
    final = reader.bits(1);
    const type = reader.bits(2);
    if (type === 0) {
      inflateStoredBlock(reader, out);
    } else if (type === 1) {
      inflateHuffmanBlock(reader, out, INFLATE_FIXED_TABLES.lit, INFLATE_FIXED_TABLES.dist);
    } else if (type === 2) {
      const tables = inflateReadDynamicTables(reader);
      inflateHuffmanBlock(reader, out, tables.lit, tables.dist);
    } else {
      throw inflateMalformed("非法的块类型 BTYPE=3");
    }
  }
}

/** adler32（RFC 1950）：对 out[0, end) 求校验和。 */
function inflateAdler32(bytes, end) {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  let i = 0;
  while (i < end) {
    const stop = Math.min(i + 5552, end);
    for (; i < stop; i++) {
      a += bytes[i];
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * 解压 raw DEFLATE 或 zlib 包装的数据（自动识别）。
 * @param {Uint8Array} input
 * @param {{maxBytes?: number, lenient?: boolean}} [opts]
 * @returns {Uint8Array}
 */
export function inflateRaw(input, opts) {
  const options = opts || {};
  const maxBytes =
    typeof options.maxBytes === "number" && options.maxBytes > 0 ? Math.floor(options.maxBytes) : INFLATE_MAX_DEFAULT;
  const lenient = options.lenient === true;
  if (!input || typeof input.length !== "number") throw pdfError("malformed", "Flate 输入不是字节数组");
  if (input.length === 0) {
    if (lenient) return new Uint8Array(0);
    throw pdfError("malformed", "Flate 输入为空");
  }

  let start = 0;
  let hasAdler = false;
  if (input.length >= 2) {
    // zlib 头：CM=8（deflate）且 (CMF*256+FLG) % 31 == 0
    const cmf = input[0];
    const flg = input[1];
    if ((cmf & 0x0f) === 8 && ((cmf << 8) | flg) % 31 === 0) {
      if ((flg & 0x20) !== 0) throw pdfError("unsupported", "Flate 流使用了预置字典（FDICT），暂不支持");
      start = 2;
      hasAdler = true;
    }
  }

  const hint = Math.min(Math.max(256, input.length * 4), maxBytes);
  const out = inflateNewOutput(maxBytes, hint);
  const reader = new InflateBitReader(input, start);
  try {
    inflateBlocks(reader, out);
    reader.alignToByte();
    const end = reader.pos - (reader.bitCnt >> 3);
    if (hasAdler) {
      if (input.length - end >= 4) {
        const want =
          ((input[end] << 24) | (input[end + 1] << 16) | (input[end + 2] << 8) | input[end + 3]) >>> 0;
        const got = inflateAdler32(out.buf, out.len);
        if (want !== got) throw inflateMalformed("adler32 校验失败");
      } else if (!lenient) {
        throw inflateMalformed("缺少 zlib adler32 校验尾");
      }
    }
  } catch (e) {
    if (lenient) return out.buf.slice(0, out.len);
    if (isPdfError(e)) throw e;
    throw pdfError("malformed", "Flate 解压失败：" + (e && e.message ? e.message : String(e)));
  }
  return out.buf.length === out.len ? out.buf : out.buf.slice(0, out.len);
}

/**
 * zlib 包装解压（与 inflateRaw 等价：两者都自动识别 0x78 头与裸 deflate）。
 * 保留两个名字是为了让调用方语义清晰，也符合 CONTRACT §4。
 */
export function inflateZlib(input, opts) {
  return inflateRaw(input, opts);
}

/** 供 filters.js 判断解压错误类型时复用（内部小工具）。 */
export function inflateIsShortError(e) {
  return !!(e && e.inflateShort);
}