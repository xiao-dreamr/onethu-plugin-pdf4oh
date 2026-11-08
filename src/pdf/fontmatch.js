/**
 * pdf4oh · 字体轮廓匹配：给"看得到、抽不出"的中文 PDF 找回 Unicode。
 *
 * 适用场景（真实课件）：pdfTeX 只嵌入了 KaiTi 子集，没有 /ToUnicode，字体 cmap
 * 是符号编码（0xF000+code → GID），正文只剩字形轮廓——pdftotext 也只能输出乱码。
 * 如果系统装有同款字体，就用"轮廓指纹"把每个嵌入字形对应到 Unicode。
 *
 * 工作流：
 *   1. 扫描文档所有页面的字体，找出「简单 TrueType + 无 ToUnicode + 有 FontFile2 +
 *      字体名能识别（KaiTi/SimSun/SimHei/FangSong/YaHei）」的字体；
 *   2. 通过宿主 `onethu.fonts.system(family)` 读系统字体（白名单路径，只读），
 *      解析出「轮廓指纹 → Unicode」表（模块级缓存，跨文档复用）；
 *   3. 抽取时 fonts.js 对每个命中字体：读嵌入字体 cmap 的符号 code→GID，
 *      算指纹查表，得到 code→Unicode。
 *
 * 边界：
 *   - 系统没有同款字体（或宿主太老没有 fonts API）→ 不启用，字体层继续 U+FFFD；
 *   - 只匹配简单字形；复合字形跳过（宁可漏字不猜错）；
 *   - 指纹是精确轮廓比对，不做模糊/OCR；不同字体版本可能匹配不上；
 *   - 读系统字体只经宿主白名单，插件不碰文件系统。
 */

import { dictGet, isDict, nameOf, resolveOr } from "./util.js";
import { buildGlyphHashIndex, parseSfnt, sfntGlyphHash, sfntSymbolicMap } from "./sfnt.js";

/** 字体名 → 系统字体族（供宿主白名单使用）。 */
export function fontFamilyKey(baseFont) {
  const name = String(baseFont ?? "").toLowerCase().replace(/^[a-z]{6}\+/, "").replace(/\s+/g, "");
  if (!name) return null;
  if (/kaiti|楷体|楷/.test(name)) return "kaiti";
  if (/simsun|songti|宋体|宋/.test(name)) return "simsun";
  if (/simhei|heiti|黑体|黑/.test(name)) return "simhei";
  if (/fangsong|仿宋/.test(name)) return "fangsong";
  if (/yahei|雅黑|msyh/.test(name)) return "yahei";
  return null;
}

/** 模块级系统字体索引缓存：family → Promise<{map, path} | null>。 */
const SYSTEM_INDEX_CACHE = new Map();

function decodeB64(b64) {
  try {
    const bin = typeof atob === "function" ? atob(String(b64 ?? "")) : "";
    if (!bin) return null;
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function loadSystemIndex(ctx, family) {
  if (SYSTEM_INDEX_CACHE.has(family)) return SYSTEM_INDEX_CACHE.get(family);
  const promise = (async () => {
    try {
      const api = ctx && ctx.onethu && ctx.onethu.fonts;
      if (!api || typeof api.system !== "function") return null;
      const result = await api.system(family);
      if (!result || !result.b64) return null;
      const bytes = decodeB64(result.b64);
      if (!bytes) return null;
      const sfnt = parseSfnt(bytes, 0);
      if (!sfnt) return null;
      const map = buildGlyphHashIndex(sfnt);
      if (!map.size) return null;
      return { map, path: String(result.path ?? ""), family };
    } catch {
      return null;
    }
  })();
  SYSTEM_INDEX_CACHE.set(family, promise);
  return promise;
}

/** 清空系统字体缓存（测试/插件重载用）。 */
export function clearSystemFontIndexCache() {
  SYSTEM_INDEX_CACHE.clear();
}

/** 扫描文档字体，返回需要字形匹配的字体描述（按 ref 去重）。 */
function collectCandidates(doc) {
  const out = [];
  const seen = new Set();
  const pages = doc && Number.isInteger(doc.pageCount) ? doc.pageCount : 0;
  for (let i = 0; i < pages; i++) {
    let page;
    try {
      page = doc.getPage(i);
    } catch {
      continue;
    }
    const resources = page && page.resources;
    /* page.resources 在 document.js 里是 Map（键是资源名），不是 dict */
    const fontValue = resources instanceof Map ? resources.get("Font") : resources && isDict(resources) ? dictGet(resources, "Font") : null;
    const fonts = fontValue ? resolveOr(doc, fontValue, null) : null;
    if (!isDict(fonts) || !(fonts.m instanceof Map)) continue;
    for (const [resourceName, ref] of fonts.m) {
      if (!ref || typeof ref !== "object") continue;
      const key = `${ref.n}:${ref.g}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let fontDict;
      try {
        fontDict = doc.resolve(ref);
      } catch {
        continue;
      }
      if (!isDict(fontDict)) continue;
      const subtype = nameOf(dictGet(fontDict, "Subtype"));
      const baseFont = nameOf(dictGet(fontDict, "BaseFont")) || "";
      const family = fontFamilyKey(baseFont);
      if (!family) continue;
      if (subtype !== "TrueType") continue;
      if (dictGet(fontDict, "ToUnicode")) continue;
      const descriptor = resolveOr(doc, dictGet(fontDict, "FontDescriptor"), null);
      if (!isDict(descriptor) || !dictGet(descriptor, "FontFile2")) continue;
      out.push({ resourceName, ref, key, fontDict, baseFont, family });
    }
  }
  return out;
}

/**
 * 为文档准备字形匹配（异步；读系统字体）。
 * @returns {{needed:boolean, families:string[], ready:string[], failed:string[], recoveredFonts:number}}
 */
export async function prepareFontMatching(doc, ctx) {
  const summary = { needed: false, families: [], ready: [], failed: [], recoveredFonts: 0 };
  if (!doc || !ctx) return summary;
  const candidates = collectCandidates(doc);
  if (!candidates.length) return summary;
  summary.needed = true;
  summary.families = [...new Set(candidates.map((c) => c.family))];
  const maps = new Map();
  await Promise.all(
    summary.families.map(async (family) => {
      const index = await loadSystemIndex(ctx, family);
      if (index) {
        maps.set(family, index);
        summary.ready.push(family);
      } else {
        summary.failed.push(family);
      }
    }),
  );
  if (maps.size > 0) {
    doc._glyphMaps = maps;
    summary.recoveredFonts = candidates.filter((c) => maps.has(c.family)).length;
  }
  return summary;
}

/** 读取字体文件流（FontFile2）并解析；失败返回 null。 */
function embeddedSfnt(doc, fontDict) {
  try {
    const descriptor = resolveOr(doc, dictGet(fontDict, "FontDescriptor"), null);
    const file = descriptor && isDict(descriptor) ? resolveOr(doc, dictGet(descriptor, "FontFile2"), null) : null;
    if (!file) return null;
    const bytes = doc.tryDecodeStream ? doc.tryDecodeStream(file) : null;
    if (!bytes || !bytes.length) return null;
    return parseSfnt(bytes, 0);
  } catch {
    return null;
  }
}

const EMBEDDED_TABLE_CACHE = new WeakMap();

/**
 * 用系统字体指纹把嵌入字体的 code→Unicode 表建出来。
 * @returns {{table:Array<string|null>, matched:number, total:number}|null}
 */
export function embeddedGlyphTable(doc, fontDict, family) {
  const maps = doc && doc._glyphMaps;
  if (!maps || !family || !maps.has(family)) return null;
  const cached = EMBEDDED_TABLE_CACHE.get(fontDict);
  if (cached) return cached;
  const sfnt = embeddedSfnt(doc, fontDict);
  if (!sfnt) return null;
  const symbolic = sfntSymbolicMap(sfnt);
  if (!symbolic.size) return null;
  const system = maps.get(family);
  const table = new Array(256).fill(null);
  let matched = 0;
  for (const [key, gid] of symbolic) {
    let code = key;
    if (key >= 0xf000 && key <= 0xf0ff) code = key - 0xf000;
    else if (key > 0xff) continue;
    if (code < 0 || code > 0xff) continue;
    const hash = sfntGlyphHash(sfnt, gid);
    if (hash === null) continue;
    const cp = system.map.get(hash);
    if (cp === undefined) continue;
    table[code] = String.fromCodePoint(cp);
    matched += 1;
  }
  const result = { table, matched, total: symbolic.size };
  EMBEDDED_TABLE_CACHE.set(fontDict, result);
  return result;
}