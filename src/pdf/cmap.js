/**
 * pdf4oh · CMap 层：解析 /ToUnicode CMap，把"字符码"还原成 Unicode 文本。
 *
 * 职责与边界（why）：
 *   - Type0/Identity-H 中文字体里，内容流里的 2 字节只是 CID，真正的 Unicode
 *     几乎只存在于 /ToUnicode 流中；没有它整页中文都是乱码。ToUnicode 是一段
 *     精简的 PostScript 语法（codespacerange / bfchar / bfrange），本模块只
 *     解析这三种段，其余（usecmap、notdefrange、字典头）忽略或告警。
 *   - 不做"编码 CMap"（code→CID）的解析：抽文本不需要 CID，宽度按 CID 近似
 *     （见 fonts.js 的说明）。这里也不构造任何 PDF 对象，只吃解码后的字节。
 *   - 码长探测：codespacerange 声明的长度决定一次取 1/2/4 字节。bfrange 的
 *     目标可以是"起始串 + 偏移"（增量式）或显式数组，两种都支持。
 *   - 映射不到时输出 U+FFFD 并累计 missing，绝不静默丢字——下游会用它判断
 *     "这份 PDF 有没有文本层/字体是否缺 ToUnicode"。
 */

/** 不可映射字符的替代符（U+FFFD），契约要求"给替代符而不是丢字"。 */
const CMAP_REPLACEMENT = "\uFFFD";

/** 单条 bfrange 最多展开多少项，防御恶意/损坏 CMap 导致的巨型数组。 */
const CMAP_MAX_RANGE = 65536;

function CMAP_isWhite(byte) {
  return byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

function CMAP_isDelimiter(byte) {
  return (
    byte === 0x28 || // (
    byte === 0x29 || // )
    byte === 0x3c || // <
    byte === 0x3e || // >
    byte === 0x5b || // [
    byte === 0x5d || // ]
    byte === 0x7b ||
    byte === 0x7d ||
    byte === 0x2f || // /
    byte === 0x25 // %
  );
}

/** 读一个名字 token，处理 #xx 转义（CMap 里也可能出现）。 */
function CMAP_readName(bytes, pos) {
  let out = "";
  let i = pos + 1;
  while (i < bytes.length && !CMAP_isWhite(bytes[i]) && !CMAP_isDelimiter(bytes[i])) {
    if (bytes[i] === 0x23 && i + 2 < bytes.length) {
      const hex = String.fromCharCode(bytes[i + 1], bytes[i + 2]);
      const code = parseInt(hex, 16);
      if (Number.isFinite(code)) {
        out += String.fromCharCode(code);
        i += 3;
        continue;
      }
    }
    out += String.fromCharCode(bytes[i]);
    i += 1;
  }
  return { value: out, pos: i };
}

/** 读一个 <hex> 串（允许空白分隔），返回 Uint8Array 与结束位置。 */
function CMAP_readHex(bytes, pos) {
  const digits = [];
  let i = pos + 1;
  while (i < bytes.length && bytes[i] !== 0x3e) {
    const b = bytes[i];
    let v = -1;
    if (b >= 0x30 && b <= 0x39) v = b - 0x30;
    else if (b >= 0x41 && b <= 0x46) v = b - 0x41 + 10;
    else if (b >= 0x61 && b <= 0x66) v = b - 0x61 + 10;
    if (v >= 0) digits.push(v);
    i += 1;
  }
  const out = new Uint8Array(Math.ceil(digits.length / 2));
  for (let k = 0; k < out.length; k++) out[k] = (digits[k * 2] << 4) | (digits[k * 2 + 1] === undefined ? 0 : digits[k * 2 + 1]);
  return { bytes: out, pos: i + 1 };
}

/** 读数字（含小数、正负号；CMap 里主要是整数）。 */
function CMAP_readNumber(bytes, pos) {
  let i = pos;
  let text = "";
  while (i < bytes.length && !CMAP_isWhite(bytes[i]) && !CMAP_isDelimiter(bytes[i])) {
    text += String.fromCharCode(bytes[i]);
    i += 1;
  }
  const value = Number(text);
  return { value: Number.isFinite(value) ? value : 0, pos: i };
}

/** 读关键字（begincmap / endbfchar 之类）。 */
function CMAP_readKeyword(bytes, pos) {
  let i = pos;
  let text = "";
  while (i < bytes.length && !CMAP_isWhite(bytes[i]) && !CMAP_isDelimiter(bytes[i])) {
    text += String.fromCharCode(bytes[i]);
    i += 1;
  }
  return { value: text, pos: i };
}

/** 跳过一段平衡的 << >>（CMap 头部的 /CIDSystemInfo 等，不关心内容）。 */
function CMAP_skipDict(bytes, pos) {
  let i = pos + 2;
  let depth = 1;
  while (i < bytes.length && depth > 0) {
    if (bytes[i] === 0x3c && i + 1 < bytes.length && bytes[i + 1] === 0x3c) {
      depth += 1;
      i += 2;
    } else if (bytes[i] === 0x3e && i + 1 < bytes.length && bytes[i + 1] === 0x3e) {
      depth -= 1;
      i += 2;
    } else {
      i += 1;
    }
  }
  return i;
}

/** 跳过一段平衡的 [ ]（bfrange 的数组目标会在这里被单独解析，不用于跳过）。 */
function CMAP_skipArray(bytes, pos) {
  let i = pos + 1;
  while (i < bytes.length && bytes[i] !== 0x5d) {
    if (bytes[i] === 0x5b) i = CMAP_skipArray(bytes, i);
    else if (bytes[i] === 0x3c && bytes[i + 1] !== 0x3c) i = CMAP_readHex(bytes, i).pos;
    else i += 1;
  }
  return i + 1;
}

/** 取一个 token；返回 null 表示只是跳过了无意义内容。 */
function CMAP_nextToken(bytes, pos) {
  while (pos < bytes.length) {
    const b = bytes[pos];
    if (CMAP_isWhite(b)) {
      pos += 1;
      continue;
    }
    if (b === 0x25) {
      // % 注释到行尾
      while (pos < bytes.length && bytes[pos] !== 0x0a && bytes[pos] !== 0x0d) pos += 1;
      continue;
    }
    if (b === 0x3c) {
      if (bytes[pos + 1] === 0x3c) return { tok: null, pos: CMAP_skipDict(bytes, pos) };
      const hex = CMAP_readHex(bytes, pos);
      return { tok: { k: "hex", bytes: hex.bytes }, pos: hex.pos };
    }
    if (b === 0x5b) {
      // 数组：只解析其中的 hex 串（bfrange 数组形式）
      const items = [];
      let i = pos + 1;
      while (i < bytes.length && bytes[i] !== 0x5d) {
        if (CMAP_isWhite(bytes[i])) {
          i += 1;
        } else if (bytes[i] === 0x3c) {
          const hex = CMAP_readHex(bytes, i);
          items.push({ k: "hex", bytes: hex.bytes });
          i = hex.pos;
        } else {
          i += 1;
        }
      }
      return { tok: { k: "arr", items }, pos: i + 1 };
    }
    if (b === 0x2f) {
      const name = CMAP_readName(bytes, pos);
      return { tok: { k: "name", v: name.value }, pos: name.pos };
    }
    if (b === 0x28) {
      // 字面串：ToUnicode 里偶见，跳过配对括号
      let i = pos + 1;
      let depth = 1;
      while (i < bytes.length && depth > 0) {
        if (bytes[i] === 0x5c) i += 2;
        else if (bytes[i] === 0x28) {
          depth += 1;
          i += 1;
        } else if (bytes[i] === 0x29) {
          depth -= 1;
          i += 1;
        } else i += 1;
      }
      return { tok: { k: "str" }, pos: i };
    }
    if (b === 0x5d || b === 0x3e || b === 0x29) return { tok: null, pos: pos + 1 };
    if (b === 0x7b || b === 0x7d) return { tok: null, pos: pos + 1 };
    if ((b >= 0x30 && b <= 0x39) || b === 0x2b || b === 0x2d || b === 0x2e) {
      const num = CMAP_readNumber(bytes, pos);
      return { tok: { k: "num", v: num.value }, pos: num.pos };
    }
    const kw = CMAP_readKeyword(bytes, pos);
    if (kw.value.length === 0) {
      pos += 1;
      continue;
    }
    return { tok: { k: "kw", v: kw.value }, pos: kw.pos };
  }
  return { tok: null, pos };
}

/** hex 字节 → 大端数值（最多 4 字节，够覆盖所有码长）。 */
function CMAP_valueOf(hexBytes) {
  let value = 0;
  const limit = Math.min(hexBytes.length, 4);
  for (let i = 0; i < limit; i++) value = value * 256 + hexBytes[i];
  return value;
}

/** UTF-16BE 字节 → JS 字符串（保留代理对，中文常用 BMP 但也可能扩展区）。 */
function CMAP_hexToUnicodeString(hexBytes) {
  let out = "";
  for (let i = 0; i + 1 < hexBytes.length; i += 2) {
    out += String.fromCharCode((hexBytes[i] << 8) | hexBytes[i + 1]);
  }
  return out;
}

/**
 * 解析 ToUnicode CMap 字节，返回解码器对象（不改入参，纯函数）。
 *
 * 返回：
 *   { kind, codeLength, codespaceRanges, map, ranges, missing, warnings,
 *     lookup(value, len), codeLengthAt(bytes, pos), decode(bytes, forcedLength?) }
 *
 * decode 的码长优先级：显式 forcedLength > codespacerange 探测 > codeLength > 1。
 */
export function parseCMap(bytes) {
  const warnings = [];
  const map = new Map(); // "len:value" → string
  const ranges = [];
  const codespaceRanges = [];
  let sawUseCMap = false;
  let sawBfchar = false;
  let sawBfrange = false;

  const keyOf = (len, value) => `${len}:${value}`;

  function addBfchar(srcHex, dstTok) {
    const len = srcHex.length;
    const value = CMAP_valueOf(srcHex);
    let text = null;
    if (dstTok && dstTok.k === "hex") text = CMAP_hexToUnicodeString(dstTok.bytes);
    else if (dstTok && dstTok.k === "name") text = glyphNameToUnicode(dstTok.v);
    if (text === null || text === "") return;
    map.set(keyOf(len, value), text);
  }

  function addBfrange(loHex, hiHex, dstTok) {
    const len = loHex.length;
    if (len === 0) return;
    let lo = CMAP_valueOf(loHex);
    let hi = CMAP_valueOf(hiHex);
    if (hi < lo) return;
    if (hi - lo + 1 > CMAP_MAX_RANGE) hi = lo + CMAP_MAX_RANGE - 1;
    if (dstTok && dstTok.k === "hex") {
      const units = [];
      const db = dstTok.bytes;
      for (let i = 0; i + 1 < db.length; i += 2) units.push((db[i] << 8) | db[i + 1]);
      if (units.length === 0) return;
      ranges.push({ lo, hi, len, kind: "inc", units });
    } else if (dstTok && dstTok.k === "arr") {
      const list = [];
      for (const item of dstTok.items) {
        if (item.k === "hex") list.push(CMAP_hexToUnicodeString(item.bytes));
        else list.push(null);
      }
      if (list.length === 0) return;
      ranges.push({ lo, hi, len, kind: "list", list });
    }
  }

  // 一次顺序扫描：用 section 状态攒够一条记录再落表
  let pos = 0;
  let mode = "";
  const pending = [];
  while (pos < bytes.length) {
    const step = CMAP_nextToken(bytes, pos);
    pos = step.pos;
    const tok = step.tok;
    if (!tok) continue;
    if (tok.k === "kw") {
      const kw = tok.v;
      if (kw === "begincodespacerange") {
        mode = "codespace";
        pending.length = 0;
      } else if (kw === "endcodespacerange") {
        mode = "";
        pending.length = 0;
      } else if (kw === "beginbfchar") {
        mode = "bfchar";
        pending.length = 0;
      } else if (kw === "endbfchar") {
        mode = "";
        pending.length = 0;
      } else if (kw === "beginbfrange") {
        mode = "bfrange";
        pending.length = 0;
      } else if (kw === "endbfrange") {
        mode = "";
        pending.length = 0;
      } else if (kw === "usecmap") {
        sawUseCMap = true;
      }
      continue;
    }
    if (mode === "codespace") {
      if (tok.k !== "hex") continue;
      pending.push(tok);
      if (pending.length === 2) {
        const loHex = pending[0].bytes;
        const hiHex = pending[1].bytes;
        const len = loHex.length;
        if (len > 0 && hiHex.length === len) {
          codespaceRanges.push({ lo: CMAP_valueOf(loHex), hi: CMAP_valueOf(hiHex), len });
        }
        pending.length = 0;
      }
    } else if (mode === "bfchar") {
      pending.push(tok);
      if (pending.length === 2) {
        if (pending[0].k === "hex") {
          addBfchar(pending[0].bytes, pending[1]);
          sawBfchar = true;
        }
        pending.length = 0;
      }
    } else if (mode === "bfrange") {
      pending.push(tok);
      if (pending.length === 3) {
        if (pending[0].k === "hex" && pending[1].k === "hex") {
          addBfrange(pending[0].bytes, pending[1].bytes, pending[2]);
          sawBfrange = true;
        }
        pending.length = 0;
      }
    }
  }

  // 码长：所有 codespace 同长才算"固定码长"；否则交给逐码探测
  let codeLength = null;
  if (codespaceRanges.length > 0) {
    const first = codespaceRanges[0].len;
    codeLength = codespaceRanges.every((r) => r.len === first) ? first : null;
  } else if (sawBfchar || sawBfrange) {
    // 没有 codespace 时从第一条记录长度推断（Identity-H 的 ToUnicode 常见）
    const srcEntry = map.keys().next();
    if (!srcEntry.done) codeLength = Number(String(srcEntry.value).split(":")[0]) || null;
    else if (ranges.length > 0) codeLength = ranges[0].len;
  }

  if (sawUseCMap) {
    warnings.push("ToUnicode CMap 使用 usecmap 继承，未解析父 CMap（缺失映射记为 U+FFFD）");
  }

  const api = {
    kind: sawBfchar || sawBfrange || codespaceRanges.length > 0 ? "tounicode" : "unknown",
    codeLength,
    codespaceRanges,
    map,
    ranges,
    missing: 0,
    warnings,

    /** 按 (码值, 码长) 查 Unicode；命不中返回 null（不缓存 miss，避免脏表）。 */
    lookup(value, len) {
      const key = keyOf(len, value);
      const hit = map.get(key);
      if (hit !== undefined) return hit;
      for (const range of ranges) {
        if (range.len !== len || value < range.lo || value > range.hi) continue;
        let text = null;
        if (range.kind === "inc") {
          const units = range.units.slice();
          units[units.length - 1] += value - range.lo;
          text = "";
          for (const unit of units) text += String.fromCharCode(unit & 0xffff);
        } else {
          const index = value - range.lo;
          text = index < range.list.length ? range.list[index] : null;
        }
        if (text !== null) {
          if (map.size < 200000) map.set(key, text); // 给热码建缓存，防止超大 CMap 反复扫 range
          return text;
        }
      }
      return null;
    },

    /** 在 bytes[pos] 处探测码长（命中 codespace 的最短长度）。 */
    codeLengthAt(data, p) {
      if (codespaceRanges.length === 0) return codeLength || 1;
      const lengths = [];
      for (const r of codespaceRanges) if (lengths.indexOf(r.len) < 0) lengths.push(r.len);
      lengths.sort((a, b) => a - b);
      for (const len of lengths) {
        if (p + len > data.length) continue;
        let value = 0;
        for (let i = 0; i < len; i++) value = value * 256 + data[p + i];
        for (const r of codespaceRanges) {
          if (r.len === len && value >= r.lo && value <= r.hi) return len;
        }
      }
      return lengths[0] || codeLength || 1;
    },

    /** 解码整段字节；无法映射的码记 U+FFFD 并累计 missing。 */
    decode(data, forcedLength) {
      let out = "";
      let p = 0;
      const fixed = typeof forcedLength === "number" && forcedLength > 0 ? forcedLength : 0;
      while (p < data.length) {
        const len = fixed || api.codeLengthAt(data, p);
        if (p + len > data.length) {
          // 尾部残缺码：不猜，记替代符
          api.missing += 1;
          out += CMAP_REPLACEMENT;
          break;
        }
        let value = 0;
        for (let i = 0; i < len; i++) value = value * 256 + data[p + i];
        const text = api.lookup(value, len);
        if (text === null) {
          api.missing += 1;
          out += CMAP_REPLACEMENT;
        } else {
          out += text;
        }
        p += len;
      }
      return out;
    },
  };
  return api;
}