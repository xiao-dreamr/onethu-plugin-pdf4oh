/**
 * pdf4oh · SFNT（TrueType/OpenType/TTC）最小解析：只为"字形轮廓指纹"服务。
 *
 * 用途：部分 LaTeX 中文 PDF 的字体子集没有 /ToUnicode，cmap 还是符号编码
 * （0xF000+code → GID），正文只剩字形轮廓，任何阅读器都抽不出 Unicode。
 * 若系统装有同款字体（如 Windows 楷体 simkai.ttf），把嵌入字形和系统字体的
 * 字形轮廓做指纹比对，就能精确还原字符。
 *
 * 为什么自己写：插件是单文件、零依赖，不能引 fontkit/opentype.js；这里只需要
 *   - 表目录 + TTC 头；
 *   - cmap（格式 0/4/6/12）取 Unicode→GID 或符号 code→GID；
 *   - loca/glyf 里简单字形的轮廓点；
 *   - 一个稳定指纹（FNV-1a 64）。
 * 不处理 hinting/复合字形/可变字体：复合字形直接跳过（返回 null），宁可漏字
 * 也不猜错字；CJK 字形几乎都是简单字形。
 *
 * 所有读取都做边界检查：坏字体返回 null，不抛异常（插件侧按"无法还原"降级）。
 */

/** 读大端 u16/u32（带边界检查）。 */
function u16(bytes, dv, off) {
  return off >= 0 && off + 2 <= bytes.length ? dv.getUint16(off) : 0;
}
function u32(bytes, dv, off) {
  return off >= 0 && off + 4 <= bytes.length ? dv.getUint32(off) : 0;
}
function i16(bytes, dv, off) {
  return off >= 0 && off + 2 <= bytes.length ? dv.getInt16(off) : 0;
}

function tableAt(bytes, dv, base) {
  const numTables = u16(bytes, dv, base + 4);
  if (!numTables || numTables > 512) return null;
  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const o = base + 12 + i * 16;
    if (o + 16 > bytes.length) return null;
    const tag = String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    const offset = u32(bytes, dv, o + 8);
    const length = u32(bytes, dv, o + 12);
    if (offset + length > bytes.length) return null;
    tables.set(tag, { offset, length });
  }
  return tables;
}

/**
 * 解析字体文件（支持 TTC 的第 faceIndex 个 face）。
 * @returns {{bytes:Uint8Array, dv:DataView, tables:Map<string,{offset:number,length:number}>, numGlyphs:number}|null}
 */
export function parseSfnt(bytes, faceIndex = 0) {
  if (!bytes || bytes.length < 12) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let base = 0;
  if (u32(bytes, dv, 0) === 0x74746366) {
    // 'ttcf'：TTC 头里是各 face 的 SFNT 偏移
    const count = u32(bytes, dv, 8);
    if (!count || count > 64 || faceIndex < 0 || faceIndex >= count) return null;
    base = u32(bytes, dv, 12 + faceIndex * 4);
  } else if (u32(bytes, dv, 0) !== 0x00010000 && u32(bytes, dv, 0) !== 0x4f54544f && u32(bytes, dv, 0) !== 0x74727565) {
    return null; // 不是 TrueType/OpenType/CFF 容器
  }
  const tables = tableAt(bytes, dv, base);
  if (!tables) return null;
  const maxp = tables.get("maxp");
  const numGlyphs = maxp ? u16(bytes, dv, maxp.offset + 4) : 0;
  if (!numGlyphs) return null;
  return { bytes, dv, tables, numGlyphs };
}

/** 读 cmap 的某个子表；返回 Map<code, gid>（失败返回空 Map）。 */
function cmapSubtable(font, subtableOffset, format) {
  const { bytes, dv } = font;
  const out = new Map();
  const b = subtableOffset;
  if (format === 0) {
    for (let c = 0; c < 256; c++) {
      const gid = bytes[b + 6 + c];
      if (gid) out.set(c, gid);
    }
    return out;
  }
  if (format === 4) {
    const segX2 = u16(bytes, dv, b + 6);
    const seg = Math.floor(segX2 / 2);
    if (!seg || seg > 1024) return out;
    const endO = b + 14;
    const startO = endO + segX2 + 2;
    const deltaO = startO + segX2;
    const rangeO = deltaO + segX2;
    for (let s = 0; s < seg; s++) {
      const end = u16(bytes, dv, endO + s * 2);
      const start = u16(bytes, dv, startO + s * 2);
      if (start === 0xffff || start > end) continue;
      const delta = i16(bytes, dv, deltaO + s * 2);
      const ro = u16(bytes, dv, rangeO + s * 2);
      for (let c = start; c <= end; c++) {
        let gid;
        if (ro === 0) {
          gid = (c + delta) & 0xffff;
        } else {
          const gi = rangeO + s * 2 + ro + (c - start) * 2;
          gid = u16(bytes, dv, gi);
          if (gid) gid = (gid + delta) & 0xffff;
        }
        if (gid) out.set(c, gid);
      }
    }
    return out;
  }
  if (format === 6) {
    const first = u16(bytes, dv, b + 6);
    const count = u16(bytes, dv, b + 8);
    for (let k = 0; k < count && k < 4096; k++) {
      const gid = u16(bytes, dv, b + 10 + k * 2);
      if (gid) out.set(first + k, gid);
    }
    return out;
  }
  if (format === 12) {
    const groups = u32(bytes, dv, b + 12);
    for (let g = 0; g < groups && g < 4096; g++) {
      const o = b + 16 + g * 12;
      const start = u32(bytes, dv, o);
      const end = u32(bytes, dv, o + 4);
      const gid0 = u32(bytes, dv, o + 8);
      const n = Math.min(end - start, 65535);
      for (let k = 0; k <= n; k++) out.set(start + k, gid0 + k);
    }
    return out;
  }
  return out;
}

/** cmap 子表列表（带 platform/encoding/format）。 */
export function sfntCmapSubtables(font) {
  const { bytes, dv, tables } = font;
  const cmap = tables.get("cmap");
  if (!cmap) return [];
  const b = cmap.offset;
  const count = u16(bytes, dv, b + 2);
  if (!count || count > 64) return [];
  const out = [];
  for (let i = 0; i < count; i++) {
    const rec = b + 4 + i * 8;
    const platform = u16(bytes, dv, rec);
    const encoding = u16(bytes, dv, rec + 2);
    const off = u32(bytes, dv, rec + 4);
    const sub = b + off;
    const format = u16(bytes, dv, sub);
    out.push({ platform, encoding, format, offset: sub, map: cmapSubtable(font, sub, format) });
  }
  return out;
}

/** 取 Unicode 映射（优先 3/10，其次 3/1，再 0/x）。 */
export function sfntUnicodeMap(font) {
  const subs = sfntCmapSubtables(font);
  const pick =
    subs.find((s) => s.platform === 3 && s.encoding === 10) ||
    subs.find((s) => s.platform === 3 && s.encoding === 1) ||
    subs.find((s) => s.platform === 0);
  return pick ? pick.map : new Map();
}

/** 取符号映射（3/0 或 1/0）：key 可能是 0xF000+code，也可能是原 code。 */
export function sfntSymbolicMap(font) {
  const subs = sfntCmapSubtables(font);
  const pick =
    subs.find((s) => s.platform === 3 && s.encoding === 0 && s.format !== 0) ||
    subs.find((s) => s.platform === 3 && s.encoding === 0) ||
    subs.find((s) => s.platform === 1 && s.encoding === 0 && s.format === 0);
  return pick ? pick.map : new Map();
}

/**
 * 简单字形轮廓指纹（FNV-1a 64）。复合字形/空字形返回 null。
 * 指纹覆盖：轮廓数、每个轮廓的端点、每个点的 on/off 标志与坐标。
 * 嵌入子集与系统同款字体只要坐标未被改写，指纹就一致。
 */
export function sfntGlyphHash(font, gid) {
  const { bytes, dv, tables, numGlyphs } = font;
  if (!Number.isInteger(gid) || gid < 1 || gid >= numGlyphs) return null;
  const head = tables.get("head");
  const loca = tables.get("loca");
  const glyf = tables.get("glyf");
  if (!head || !loca || !glyf) return null;
  const longLoca = i16(bytes, dv, head.offset + 50) === 1;
  const start = longLoca ? u32(bytes, dv, loca.offset + gid * 4) : u16(bytes, dv, loca.offset + gid * 2) * 2;
  const end = longLoca ? u32(bytes, dv, loca.offset + gid * 4 + 4) : u16(bytes, dv, loca.offset + gid * 2 + 2) * 2;
  if (end <= start) return null;
  const g = glyf.offset + start;
  if (g + 10 > bytes.length) return null;
  const contours = i16(bytes, dv, g);
  if (contours <= 0 || contours > 512) return null; // <=0：复合/空字形，跳过
  let p = g + 10;
  const endPts = [];
  for (let i = 0; i < contours; i++) {
    const e = u16(bytes, dv, p);
    p += 2;
    if (e < (endPts[i - 1] ?? -1)) return null;
    endPts.push(e);
  }
  const numPts = endPts.length ? endPts[endPts.length - 1] + 1 : 0;
  if (!numPts || numPts > 20000) return null;
  const instrLen = u16(bytes, dv, p);
  p += 2 + instrLen;
  const flags = [];
  while (flags.length < numPts) {
    if (p >= bytes.length) return null;
    const f = bytes[p++];
    flags.push(f);
    if (f & 8) {
      if (p >= bytes.length) return null;
      let repeat = bytes[p++];
      while (repeat-- > 0 && flags.length < numPts) flags.push(f);
    }
  }
  const xs = [];
  const ys = [];
  let x = 0;
  for (const f of flags) {
    if (f & 2) {
      if (p >= bytes.length) return null;
      const d = bytes[p++];
      x += f & 16 ? d : -d;
    } else if (!(f & 16)) {
      if (p + 2 > bytes.length) return null;
      x += dv.getInt16(p);
      p += 2;
    }
    xs.push(x);
  }
  let y = 0;
  for (const f of flags) {
    if (f & 4) {
      if (p >= bytes.length) return null;
      const d = bytes[p++];
      y += f & 32 ? d : -d;
    } else if (!(f & 32)) {
      if (p + 2 > bytes.length) return null;
      y += dv.getInt16(p);
      p += 2;
    }
    ys.push(y);
  }
  let h = 0xcbf29ce484222325n;
  const mul = 0x100000001b3n;
  const mix = (n) => {
    h ^= BigInt(n & 0xffffffff);
    h = BigInt.asUintN(64, h * mul);
    h ^= BigInt(n >>> 0);
    h = BigInt.asUintN(64, h * mul);
  };
  mix(contours);
  for (const e of endPts) mix(e);
  for (const f of flags) mix(f);
  for (const v of xs) mix(v);
  for (const v of ys) mix(v);
  return h;
}

/**
 * 系统字体：Unicode→GID 反成 指纹→Unicode。
 * @returns {Map<bigint, number>} 只含简单字形
 */
export function buildGlyphHashIndex(font, maxGlyphs = 40000) {
  const index = new Map();
  const unicode = sfntUnicodeMap(font);
  if (!unicode.size) return index;
  let seen = 0;
  for (const [cp, gid] of unicode) {
    if (seen++ > maxGlyphs) break;
    const h = sfntGlyphHash(font, gid);
    if (h === null || index.has(h)) continue;
    index.set(h, cp);
  }
  return index;
}