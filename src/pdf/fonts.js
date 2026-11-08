/**
 * pdf4oh · 字体层：把内容流里的"字节码"解成 Unicode 文本，并提供字宽。
 *
 * 职责与边界（why）：
 *   - PDF 文本抽取的成败几乎全在字体：同一串字节，在 Identity-H 的 CID 字体里
 *     是 2 字节 CID，在 WinAnsi 简单字体里是 1 字节字形号。这里统一成
 *     `font.show(bytes) → { text, width, codes, spaces }`，content.js 只关心
 *     文本与"按 1/1000 em 的宽度"。
 *   - 优先级（契约 §5）：ToUnicode 永远最可信；简单字体退 /Encoding（含
 *     /Differences 字形名，走 glyphs.js 的 AGL 子集）；再退 WinAnsi。Type0 在没有
 *     ToUnicode 时无法从 CIDToGIDMap 反推 Unicode（那只是字形索引，不是字符），
 *     因此输出 U+FFFD 并记一条 warning——整页丢字比乱码更难排查，宁可留替代符。
 *   - 不解析内嵌"编码 CMap"（code→CID）：抽文本不需要 CID，宽度按 code 近似并
 *     在 warnings 里说明。字体对象本身按 doc 缓存（doc._fontCache，键为字体 ref），
 *     避免一页多字体时重复解析 ToUnicode（几十 KB 的 CMap 很贵）。
 *   - 这里不碰内容流、不碰页面坐标（content.js 的事），也不做任何排版。
 */

import { dictGet, intOr, isDict, isName, isStream, latin1, nameOf, numOr, resolveOr } from "./util.js";
import { glyphEncodingTable, glyphNameToUnicode } from "./glyphs.js";
import { parseCMap } from "./cmap.js";
import { embeddedGlyphTable, fontFamilyKey } from "./fontmatch.js";

/** 简单字体缺 /Widths 时的经验字宽（半角约 500/1000 em），只为 spacing 不失真。 */
const FONT_DEFAULT_SIMPLE_WIDTH = 500;

/** CID 字体的 /DW 缺省值（PDF 规范：1000）。 */
const FONT_DEFAULT_CID_WIDTH = 1000;

/** W 数组展开上限，防御损坏文件里 first..last 巨大的情况。 */
const FONT_MAX_W_EXPAND = 65536;

/** 无 ref 的字体字典（同一对象身份）缓存；有 ref 的走 doc._fontCache。 */
const FONT_WEAK_CACHE = new WeakMap();

/** 字体字典解析入口：返回值见 CONTRACT §5（decode/widthOf/isComposite/warnings）。 */
export function loadFont(doc, fontValue) {
  const fontDict = resolveOr(doc, fontValue, null);
  if (!isDict(fontDict)) {
    return FONT_fallbackFont("字体字典缺失或无法解引用（页面 /Resources /Font 有问题）");
  }

  const cacheKey = isRefLike(fontValue) ? `ref:${fontValue.n}:${fontValue.g}` : null;
  const docCache = FONT_docCache(doc);
  if (cacheKey && docCache) {
    const hit = docCache.get(cacheKey);
    if (hit) return hit;
  }
  if (!cacheKey) {
    const hit = FONT_WEAK_CACHE.get(fontDict);
    if (hit) return hit;
  }

  let font;
  try {
    font = FONT_parse(doc, fontDict);
  } catch (e) {
    // 单个字体坏了不能让整页炸掉：降级成 Latin-1 直读并说明原因
    font = FONT_fallbackFont("字体解析失败：" + (e && e.message ? e.message : String(e)));
  }

  if (cacheKey && docCache) docCache.set(cacheKey, font);
  else FONT_WEAK_CACHE.set(fontDict, font);
  return font;
}

/** 判断是否是 ref（不能用 util 的 isRef 是因为要防 undefined）。 */
function isRefLike(v) {
  return !!v && typeof v === "object" && v.t === "ref" && typeof v.n === "number";
}

/** 取/建 doc._fontCache；doc 被冻结等异常时返回 null（只是没缓存，不影响正确性）。 */
function FONT_docCache(doc) {
  if (!doc || typeof doc !== "object") return null;
  const existing = doc._fontCache;
  if (existing instanceof Map) return existing;
  try {
    const cache = new Map();
    doc._fontCache = cache;
    return cache;
  } catch (e) {
    return null;
  }
}

/** 读流字节：优先 core 的容错解码，再退 decodeStream，最后退原始字节。 */
function FONT_streamBytes(doc, stream) {
  if (!isStream(stream)) return null;
  try {
    if (doc && typeof doc.tryDecodeStream === "function") {
      const bytes = doc.tryDecodeStream(stream);
      if (bytes && bytes.length > 0) return bytes;
    }
    if (doc && typeof doc.decodeStream === "function") {
      const bytes = doc.decodeStream(stream);
      if (bytes && bytes.length > 0) return bytes;
    }
  } catch (e) {
    // 落到 raw：有些 ToUnicode 本身就是明文，decode 失败不代表字节不可用
  }
  return stream.raw || null;
}

/** 解析 /ToUnicode；失败返回 null 并往 warnings 里说明。 */
function FONT_loadToUnicode(doc, fontDict, warnings) {
  const value = resolveOr(doc, dictGet(fontDict, "ToUnicode"), null);
  if (!value) return null;
  const bytes = FONT_streamBytes(doc, value);
  if (!bytes || bytes.length === 0) {
    warnings.push("ToUnicode 流为空或无法解码，改用 /Encoding 兜底");
    return null;
  }
  let cmap = null;
  try {
    cmap = parseCMap(bytes);
  } catch (e) {
    warnings.push("ToUnicode CMap 解析失败，改用 /Encoding 兜底");
    return null;
  }
  if (cmap.kind === "unknown") {
    warnings.push("ToUnicode CMap 内容为空，改用 /Encoding 兜底");
    return null;
  }
  for (const note of cmap.warnings) warnings.push(note);
  return cmap;
}

/** 解析简单字体（Type1/TrueType/MMType1/Type3 共用）。 */
function FONT_parse(doc, fontDict) {
  const subtype = nameOf(dictGet(fontDict, "Subtype")) || "Type1";
  const baseFont = nameOf(dictGet(fontDict, "BaseFont")) || "(未命名)";
  const warnings = [];
  const descriptor = resolveOr(doc, dictGet(fontDict, "FontDescriptor"), null);
  const missingWidth = numOr(dictGet(descriptor, "MissingWidth"), 0);
  const cmap = FONT_loadToUnicode(doc, fontDict, warnings);

  if (subtype === "Type0") return FONT_buildComposite(doc, fontDict, baseFont, warnings, cmap, descriptor, missingWidth);
  if (subtype === "Type3") warnings.push("Type3 字体：字宽按 /Widths 原值近似（未应用 FontMatrix）");
  return FONT_buildSimple(doc, fontDict, subtype, baseFont, warnings, cmap, descriptor, missingWidth);
}

/** 同一文档同类问题只提示一次，避免 31 个楷体子集刷 31 条相同 warning。 */
function FONT_noteOnce(doc, key, warnings, text) {
  try {
    if (!(doc._glyphNotes instanceof Set)) doc._glyphNotes = new Set();
    if (doc._glyphNotes.has(key)) return;
    doc._glyphNotes.add(key);
  } catch {
    /* doc 不可写也不影响文字本身 */
  }
  warnings.push(text);
}

/** 从内嵌 Type1 字体程序里读 builtin encoding（dup code /glyphname put）。 */
function FONT_type1BuiltinTable(doc, descriptor) {
  if (!isDict(descriptor)) return null;
  const file = resolveOr(doc, dictGet(descriptor, "FontFile"), null);
  if (!isStream(file)) return null;
  let text;
  try {
    const bytes = doc.tryDecodeStream ? doc.tryDecodeStream(file) : null;
    if (!bytes || !bytes.length) return null;
    text = latin1(bytes);
  } catch {
    return null;
  }
  const at = text.indexOf("/Encoding");
  if (at < 0) return null;
  /* 只看 /Encoding 附近：Type1 的 Private 区也可能有 dup，但不会在编码表之后这么密集。 */
  const region = text.slice(at, Math.min(text.length, at + 24000));
  const re = /dup\s+(\d+)\s+\/([^\s/{}()<>[\]]+)\s+put/g;
  const table = new Array(256).fill(null);
  let mapped = 0;
  let total = 0;
  let m;
  while ((m = re.exec(region))) {
    const code = Number(m[1]);
    if (!Number.isFinite(code) || code < 0 || code > 255) continue;
    total += 1;
    const uni = glyphNameToUnicode(m[2]);
    if (uni !== null) {
      table[code] = uni;
      mapped += 1;
    }
  }
  return total > 0 ? { table, mapped, total } : null;
}

/** 简单字体：ToUnicode → /Encoding(+Differences) → WinAnsi → U+FFFD。 */
function FONT_buildSimple(doc, fontDict, subtype, baseFont, warnings, cmap, descriptor, missingWidth) {
  const encodingValue = resolveOr(doc, dictGet(fontDict, "Encoding"), null);
  let encodingName = "";
  let baseTable = null;
  let differences = null;
  if (isName(encodingValue)) {
    encodingName = nameOf(encodingValue);
    baseTable = glyphEncodingTable(encodingName);
  } else if (isDict(encodingValue)) {
    encodingName = nameOf(dictGet(encodingValue, "BaseEncoding"));
    baseTable = glyphEncodingTable(encodingName);
    differences = resolveOr(doc, dictGet(encodingValue, "Differences"), null);
  }

  // 码 → Unicode（0..255 的静态表；ToUnicode 命中时优先 ToUnicode）
  const table = new Array(256).fill(null);
  if (baseTable) {
    for (let code = 0; code < 256; code++) table[code] = baseTable[code];
  }
  const unknownNames = [];
  // /Differences 显式点名但映射不到 Unicode 的码：不能再被 ASCII 兜底"猜成字母"
  // （g123 很可能是某个汉字字形，猜成 "k" 比 U+FFFD 更误导）。
  const blocked = new Set();
  if (Array.isArray(differences)) {
    let code = 0;
    for (const item of differences) {
      if (typeof item === "number" && Number.isFinite(item)) {
        code = Math.trunc(item);
      } else if (isName(item)) {
        if (code >= 0 && code < 256) {
          const uni = glyphNameToUnicode(item.v);
          if (uni !== null) {
            table[code] = uni;
            blocked.delete(code);
          } else {
            table[code] = null;
            blocked.add(code);
            unknownNames.push(item.v);
          }
        }
        code += 1;
      }
    }
  }
  /* ── 无 ToUnicode 的补救（2026-11，真实课件场景）──────────────────────────
     Type1：字体程序里通常带一份内嵌编码（/Encoding ... dup N /name put），
            按字形名还原，Computer Modern 的正文/数学符号都能读出来；
     TrueType 符号字体：pdfTeX 的楷体子集用 0xF000+code 的符号 cmap，
            没有 Unicode 信息，只能拿系统同款字体做"轮廓指纹"匹配（见 fontmatch.js）。
     两者都失败才退回 WinAnsi 的 ASCII 近似。 */
  let recoveredBy = "";
  if (!cmap && table.some((ch) => ch === null)) {
    if (subtype === "Type1") {
      const type1 = FONT_type1BuiltinTable(doc, descriptor);
      if (type1 && type1.mapped > 0) {
        for (let code = 0; code < 256; code++) {
          if (table[code] === null && type1.table[code] !== null) table[code] = type1.table[code];
        }
        recoveredBy = "type1";
        FONT_noteOnce(doc, `type1:${baseFont}`, warnings, `字体 ${baseFont} 的 /Encoding 未声明，已从内嵌 Type1 编码还原 ${type1.mapped} 个字形`);
      }
    } else if (subtype === "TrueType") {
      const family = fontFamilyKey(baseFont);
      const match = embeddedGlyphTable(doc, fontDict, family);
      if (match && match.matched > 0) {
        for (let code = 0; code < 256; code++) {
          if (table[code] === null && match.table[code] !== null) table[code] = match.table[code];
        }
        recoveredBy = "glyph";
        FONT_noteOnce(doc, `glyph-ok:${family}`, warnings, `字体族 ${family} 无 /ToUnicode，已用系统字体轮廓匹配还原（如 ${baseFont} ${match.matched}/${match.total} 个字形）`);
      } else if (family) {
        FONT_noteOnce(doc, `glyph-miss:${family}`, warnings, `字体族 ${family} 无 /ToUnicode，且未找到可匹配的系统字体；中文无法还原`);
      }
    }
  }
  // 最终兜底 WinAnsi：只在没有别的还原途径时，至少 ASCII 是对的
  if (!recoveredBy && table.some((ch, code) => ch === null && code >= 0x20 && code <= 0x7e && !blocked.has(code))) {
    for (let code = 0x20; code <= 0x7e; code++) {
      if (table[code] === null && !blocked.has(code)) table[code] = String.fromCharCode(code);
    }
  }
  if (!recoveredBy && (encodingName === "Builtin" || (!baseTable && !isName(encodingValue) && !isDict(encodingValue)))) {
    warnings.push(`字体 ${baseFont} 的 /Encoding 未声明或为内嵌编码，已按 WinAnsi 近似`);
  }
  if (unknownNames.length > 0) {
    warnings.push(`字体 ${baseFont} 有 ${unknownNames.length} 个 /Differences 字形名无法映射 Unicode（如 ${unknownNames[0]}）`);
  }

  // 字宽：/Widths 从 /FirstChar 起
  const firstChar = intOr(dictGet(fontDict, "FirstChar"), 0);
  const widthsValue = resolveOr(doc, dictGet(fontDict, "Widths"), null);
  const widths = Array.isArray(widthsValue) ? widthsValue : null;

  const codeLength = cmap && cmap.codeLength ? cmap.codeLength : 1;
  const state = { missing: 0 };
  if (cmap && cmap.codeLength > 1) {
    warnings.push(`字体 ${baseFont} 的 ToUnicode 声明了 ${cmap.codeLength} 字节码，与简单字体不符，已按该长度解码`);
  }

  /** code → Unicode 字符；命不中返回 null（调用方补 U+FFFD）。 */
  function unicodeOf(code) {
    if (cmap) {
      const hit = cmap.lookup(code, codeLength);
      if (hit !== null) return hit;
    }
    if (code >= 0 && code < 256 && table[code] !== null) return table[code];
    return null;
  }

  function widthOf(code) {
    if (widths) {
      const index = code - firstChar;
      if (index >= 0 && index < widths.length) {
        const w = numOr(widths[index], NaN);
        if (Number.isFinite(w)) return w;
      }
    }
    if (missingWidth > 0) return missingWidth;
    return FONT_DEFAULT_SIMPLE_WIDTH;
  }

  function show(bytes) {
    let text = "";
    let width = 0;
    let codes = 0;
    let spaces = 0;
    for (let pos = 0; pos + codeLength <= bytes.length; pos += codeLength) {
      let code = 0;
      for (let i = 0; i < codeLength; i++) code = code * 256 + bytes[pos + i];
      codes += 1;
      const ch = unicodeOf(code);
      if (ch === null) {
        state.missing += 1;
        text += "\uFFFD";
      } else {
        text += ch;
      }
      width += widthOf(code);
      if (codeLength === 1 && code === 0x20) spaces += 1;
    }
    if (bytes.length % codeLength !== 0) {
      // 尾部残缺码：记替代符，避免静默少字
      state.missing += 1;
      text += "\uFFFD";
    }
    return { text, width, codes, spaces };
  }

  return {
    name: baseFont,
    subtype,
    isComposite: false,
    encoding: encodingName || (baseTable ? "预设编码" : "WinAnsi(近似)"),
    vertical: false,
    codeLength,
    show,
    decode(bytes) {
      return show(bytes).text;
    },
    widthOf,
    warnings,
    get missing() {
      return state.missing;
    },
  };
}

/** Type0/CID 字体：ToUnicode 优先，无则 U+FFFD + warning（不抛）。 */
function FONT_buildComposite(doc, fontDict, baseFont, warnings, cmap, descriptor, missingWidth) {
  const encodingValue = resolveOr(doc, dictGet(fontDict, "Encoding"), null);
  let encodingName = "";
  let codeLength = 2; // Identity-H 是 2 字节；内嵌 CMap 也按 2 字节近似
  if (isName(encodingValue)) {
    encodingName = nameOf(encodingValue);
  } else if (isStream(encodingValue)) {
    encodingName = "(内嵌编码 CMap)";
    warnings.push(`字体 ${baseFont} 使用内嵌编码 CMap：未解析 code→CID 映射，宽度按 code 近似`);
  }

  const descendantsValue = resolveOr(doc, dictGet(fontDict, "DescendantFonts"), null);
  const descendant = Array.isArray(descendantsValue) ? resolveOr(doc, descendantsValue[0], null) : null;
  const descSubtype = nameOf(dictGet(descendant, "Subtype")) || "(未知 CIDFont 子类型)";
  const descDescriptor = resolveOr(doc, dictGet(descendant, "FontDescriptor"), descriptor);
  const cidMissingWidth = numOr(dictGet(descDescriptor, "MissingWidth"), missingWidth) || 0;
  const defaultWidth = numOr(dictGet(descendant, "DW"), FONT_DEFAULT_CID_WIDTH);
  const wArray = resolveOr(doc, dictGet(descendant, "W"), null);
  const cidWidths = FONT_parseWArray(wArray);
  const cidToGid = resolveOr(doc, dictGet(descendant, "CIDToGIDMap"), null);

  if (!cmap) {
    // 这是中文课件最常见的"看得到字、抽不出字"场景：必须讲清楚为什么。
    let note = `Type0 字体 ${baseFont} 缺少可用的 /ToUnicode，CID 无法还原 Unicode，输出 U+FFFD`;
    if (isStream(cidToGid)) note += "（/CIDToGIDMap 是字形索引映射，不含字符语义）";
    else if (isName(cidToGid) && nameOf(cidToGid) === "Identity") note += "（/CIDToGIDMap=/Identity 同样不含字符语义）";
    warnings.push(note);
  } else if (cmap.codeLength && cmap.codeLength !== codeLength) {
    // 极少数 ToUnicode 会声明 1 字节码（伪 Type0）；以 ToUnicode 为准更安全
    warnings.push(`字体 ${baseFont} 的 ToUnicode 声明码长 ${cmap.codeLength}，与 Type0 默认 2 冲突，已按 ToUnicode`);
    codeLength = cmap.codeLength;
  }

  const state = { missing: 0 };

  function unicodeOf(code) {
    if (!cmap) return null;
    return cmap.lookup(code, codeLength);
  }

  function widthOf(code) {
    const hit = cidWidths.get(code);
    if (hit !== undefined) return hit;
    if (cidMissingWidth > 0) return cidMissingWidth;
    return defaultWidth;
  }

  function show(bytes) {
    let text = "";
    let width = 0;
    let codes = 0;
    for (let pos = 0; pos + codeLength <= bytes.length; pos += codeLength) {
      let code = 0;
      for (let i = 0; i < codeLength; i++) code = code * 256 + bytes[pos + i];
      codes += 1;
      const ch = unicodeOf(code);
      if (ch === null) {
        state.missing += 1;
        text += "\uFFFD";
      } else {
        text += ch;
      }
      width += widthOf(code);
    }
    if (bytes.length % codeLength !== 0) {
      state.missing += 1;
      text += "\uFFFD";
    }
    // Type0 的 Tw（词距）规范上只作用于单字节码 32，2 字节码没有词距
    return { text, width, codes, spaces: 0 };
  }

  return {
    name: baseFont,
    subtype: "Type0",
    descendantSubtype: descSubtype,
    isComposite: true,
    encoding: encodingName || "Identity",
    vertical: /-V$/.test(encodingName),
    codeLength,
    show,
    decode(bytes) {
      return show(bytes).text;
    },
    widthOf,
    warnings,
    get missing() {
      return state.missing;
    },
  };
}

/** /W 数组 → Map<cid, width>；格式 [c [w…]] 或 [cFirst cLast w]。 */
function FONT_parseWArray(wArray) {
  const out = new Map();
  if (!Array.isArray(wArray)) return out;
  let i = 0;
  while (i < wArray.length) {
    const first = numOr(wArray[i], NaN);
    if (!Number.isFinite(first)) {
      i += 1;
      continue;
    }
    const next = wArray[i + 1];
    if (Array.isArray(next)) {
      const cid = Math.trunc(first);
      for (let k = 0; k < next.length && k < FONT_MAX_W_EXPAND; k++) {
        const w = numOr(next[k], NaN);
        if (Number.isFinite(w)) out.set(cid + k, w);
      }
      i += 2;
      continue;
    }
    const last = numOr(next, NaN);
    const w = numOr(wArray[i + 2], NaN);
    if (Number.isFinite(last) && Number.isFinite(w)) {
      const cidFirst = Math.trunc(first);
      const cidLast = Math.trunc(last);
      const count = Math.min(cidLast - cidFirst + 1, FONT_MAX_W_EXPAND);
      for (let k = 0; k < count; k++) out.set(cidFirst + k, w);
      i += 3;
    } else {
      i += 1;
    }
  }
  return out;
}

/** 兜底字体：不抛错、尽量给字符（Latin-1 直读），并明确告诉调用方降级原因。 */
function FONT_fallbackFont(reason) {
  const warnings = [reason];
  const state = { missing: 0 };
  function show(bytes) {
    return {
      text: latin1(bytes),
      width: bytes.length * FONT_DEFAULT_SIMPLE_WIDTH,
      codes: bytes.length,
      spaces: 0,
    };
  }
  return {
    name: "(missing)",
    subtype: "unknown",
    isComposite: false,
    encoding: "Latin-1(降级)",
    vertical: false,
    codeLength: 1,
    show,
    decode(bytes) {
      return show(bytes).text;
    },
    widthOf() {
      return FONT_DEFAULT_SIMPLE_WIDTH;
    },
    warnings,
    get missing() {
      return state.missing;
    },
  };
}

/** 供 content.js 判断字体是否可能把整段字节吐成替代符（用于 warning 节流）。 */
export function fontWarningsOf(font) {
  return font && Array.isArray(font.warnings) ? font.warnings : [];
}

/** 导出内部工具给单测用（不属于契约，但比复制粘贴一份实现好）。 */
export { FONT_parseWArray };