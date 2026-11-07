/**
 * pdf4oh · 字形层：字形名 → Unicode，以及三种单字节编码表。
 *
 * 职责与边界（why）：
 *   - 这是文本抽取的最后一道"认字"关口。PDF 里一个字节只是"字形编号"，
 *     真正的字符语义要靠 /Encoding 字形名或 /ToUnicode 才能确定。中文字体
 *     常见 Type0/Identity-H + ToUnicode（走 cmap.js），但简单字体（TrueType/
 *     Type1/Type3）里的中文往往藏在 /Encoding /Differences 的字形名里，形状
 *     是 uni4E2D 之类；没有这张表就只能整页丢字，所以必须自带 AGL 子集。
 *   - 本模块只做"名字 → 字符"的纯查表，不解析任何 PDF 结构（那是 fonts.js
 *     的事）。表是常量，模块加载时构建一次。
 *   - 只收录常用子集：拉丁/标点/希腊/数学/连字。CJK 基本区靠 uniXXXX 命名
 *     覆盖，不逐字列表（那会是几万字）。
 *   - 单字节编码表直接用"码 → Unicode"数组，而不是"码 → 名字"：抽取场景只
 *     关心字符，少一层查表更不容易错；/Differences 才需要名字，走 AGL。
 */

/* ───── Adobe Glyph List 子集 ───── */

/** ASCII 标点/数字/字母的字形名（PDF 生成器几乎必用）。 */
const GLYPH_AGL_ASCII = {
  space: " ",
  exclam: "!",
  quotedbl: '"',
  numbersign: "#",
  dollar: "$",
  percent: "%",
  ampersand: "&",
  quotesingle: "'",
  quoteright: "\u2019",
  quoteleft: "\u2018",
  parenleft: "(",
  parenright: ")",
  asterisk: "*",
  plus: "+",
  comma: ",",
  hyphen: "-",
  period: ".",
  slash: "/",
  colon: ":",
  semicolon: ";",
  less: "<",
  equal: "=",
  greater: ">",
  question: "?",
  at: "@",
  bracketleft: "[",
  backslash: "\\",
  bracketright: "]",
  asciicircum: "^",
  underscore: "_",
  grave: "`",
  braceleft: "{",
  bar: "|",
  braceright: "}",
  asciitilde: "~",
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

/** Latin-1 补充区（U+00A0–U+00FF），PDF 西文子集字体的主力。 */
const GLYPH_AGL_LATIN1 = {
  nbspace: "\u00A0",
  nonbreakingspace: "\u00A0",
  exclamdown: "\u00A1",
  cent: "\u00A2",
  sterling: "\u00A3",
  currency: "\u00A4",
  yen: "\u00A5",
  brokenbar: "\u00A6",
  section: "\u00A7",
  dieresis: "\u00A8",
  copyright: "\u00A9",
  ordfeminine: "\u00AA",
  guillemotleft: "\u00AB",
  logicalnot: "\u00AC",
  sfthyphen: "\u00AD",
  registered: "\u00AE",
  macron: "\u00AF",
  degree: "\u00B0",
  plusminus: "\u00B1",
  twosuperior: "\u00B2",
  threesuperior: "\u00B3",
  acute: "\u00B4",
  mu: "\u00B5",
  paragraph: "\u00B6",
  periodcentered: "\u00B7",
  cedilla: "\u00B8",
  onesuperior: "\u00B9",
  ordmasculine: "\u00BA",
  guillemotright: "\u00BB",
  onequarter: "\u00BC",
  onehalf: "\u00BD",
  threequarters: "\u00BE",
  questiondown: "\u00BF",
  Agrave: "\u00C0",
  Aacute: "\u00C1",
  Acircumflex: "\u00C2",
  Atilde: "\u00C3",
  Adieresis: "\u00C4",
  Aring: "\u00C5",
  AE: "\u00C6",
  Ccedilla: "\u00C7",
  Egrave: "\u00C8",
  Eacute: "\u00C9",
  Ecircumflex: "\u00CA",
  Edieresis: "\u00CB",
  Igrave: "\u00CC",
  Iacute: "\u00CD",
  Icircumflex: "\u00CE",
  Idieresis: "\u00CF",
  Eth: "\u00D0",
  Ntilde: "\u00D1",
  Ograve: "\u00D2",
  Oacute: "\u00D3",
  Ocircumflex: "\u00D4",
  Otilde: "\u00D5",
  Odieresis: "\u00D6",
  multiply: "\u00D7",
  Oslash: "\u00D8",
  Ugrave: "\u00D9",
  Uacute: "\u00DA",
  Ucircumflex: "\u00DB",
  Udieresis: "\u00DC",
  Yacute: "\u00DD",
  Thorn: "\u00DE",
  germandbls: "\u00DF",
  agrave: "\u00E0",
  aacute: "\u00E1",
  acircumflex: "\u00E2",
  atilde: "\u00E3",
  adieresis: "\u00E4",
  aring: "\u00E5",
  ae: "\u00E6",
  ccedilla: "\u00E7",
  egrave: "\u00E8",
  eacute: "\u00E9",
  ecircumflex: "\u00EA",
  edieresis: "\u00EB",
  igrave: "\u00EC",
  iacute: "\u00ED",
  icircumflex: "\u00EE",
  idieresis: "\u00EF",
  eth: "\u00F0",
  ntilde: "\u00F1",
  ograve: "\u00F2",
  oacute: "\u00F3",
  ocircumflex: "\u00F4",
  otilde: "\u00F5",
  odieresis: "\u00F6",
  divide: "\u00F7",
  oslash: "\u00F8",
  ugrave: "\u00F9",
  uacute: "\u00FA",
  ucircumflex: "\u00FB",
  udieresis: "\u00FC",
  yacute: "\u00FD",
  thorn: "\u00FE",
  ydieresis: "\u00FF",
  OE: "\u0152",
  oe: "\u0153",
  Scaron: "\u0160",
  scaron: "\u0161",
  Zcaron: "\u017D",
  zcaron: "\u017E",
  Ydieresis: "\u0178",
  florin: "\u0192",
  Lslash: "\u0141",
  lslash: "\u0142",
  dotlessi: "\u0131",
  dotlessj: "\u0237",
  ij: "\u0133",
  IJ: "\u0132",
  napostrophe: "\u0149",
  Eng: "\u014A",
  eng: "\u014B",
  Dcroat: "\u0110",
  dcroat: "\u0111",
};

/** 标点、货币、数学与杂项符号。 */
const GLYPH_AGL_SYMBOL = {
  endash: "\u2013",
  emdash: "\u2014",
  figuredash: "\u2012",
  bullet: "\u2022",
  ellipsis: "\u2026",
  dagger: "\u2020",
  daggerdbl: "\u2021",
  perthousand: "\u2030",
  trademark: "\u2122",
  quoteleft: "\u2018",
  quoteright: "\u2019",
  quotedblleft: "\u201C",
  quotedblright: "\u201D",
  quotesinglbase: "\u201A",
  quotedblbase: "\u201E",
  guilsinglleft: "\u2039",
  guilsinglright: "\u203A",
  fraction: "\u2044",
  Euro: "\u20AC",
  euro: "\u20AC",
  minus: "\u2212",
  lessequal: "\u2264",
  greaterequal: "\u2265",
  notequal: "\u2260",
  approxequal: "\u2248",
  equivalence: "\u2261",
  congruent: "\u2245",
  similar: "\u223C",
  infinity: "\u221E",
  summation: "\u2211",
  product: "\u220F",
  integral: "\u222B",
  radical: "\u221A",
  partialdiff: "\u2202",
  Delta: "\u2206",
  increment: "\u2206",
  gradient: "\u2207",
  nabla: "\u2207",
  Omega: "\u2126",
  lozenge: "\u25CA",
  dotmath: "\u22C5",
  element: "\u2208",
  notelement: "\u2209",
  intersection: "\u2229",
  union: "\u222A",
  propersubset: "\u2282",
  propersuperset: "\u2283",
  reflexsubset: "\u2286",
  reflexsuperset: "\u2287",
  perpendicular: "\u22A5",
  universal: "\u2200",
  existential: "\u2203",
  emptyset: "\u2205",
  angle: "\u2220",
  therefore: "\u2234",
  suchthat: "\u220B",
  angleleft: "\u2329",
  angleright: "\u232A",
  circleplus: "\u2295",
  circlemultiply: "\u2297",
  arrowleft: "\u2190",
  arrowup: "\u2191",
  arrowright: "\u2192",
  arrowdown: "\u2193",
  arrowboth: "\u2194",
  arrowupdn: "\u2195",
  arrowdblleft: "\u21D0",
  arrowdblright: "\u21D2",
  arrowdblboth: "\u21D4",
  carriagereturn: "\u21B5",
  weierstrass: "\u2118",
  Ifraktur: "\u2111",
  Rfraktur: "\u211C",
  aleph: "\u2135",
  club: "\u2663",
  diamond: "\u2666",
  heart: "\u2665",
  spade: "\u2660",
  checkmark: "\u2713",
  dotlessjmath: "\u0237",
  openbullet: "\u25E6",
  amp: "&",
  asteriskmath: "\u2217",
  prime: "\u2032",
  second: "\u2033",
  commaaccent: "\u0326",
  breve: "\u02D8",
  dotaccent: "\u02D9",
  ring: "\u02DA",
  hungarumlaut: "\u02DD",
  ogonek: "\u02DB",
  caron: "\u02C7",
  circumflex: "\u02C6",
  tilde: "\u02DC",
  cedilla: "\u00B8",
  periodcentered: "\u00B7",
  suppressed: " ",
  figuredashalt: "\u2012",
};

/** 希腊字母（Symbol 系字体 / 数学字体常用）。 */
const GLYPH_AGL_GREEK = {
  Alpha: "\u0391",
  Beta: "\u0392",
  Gamma: "\u0393",
  Deltagreek: "\u0394",
  Epsilon: "\u0395",
  Zeta: "\u0396",
  Eta: "\u0397",
  Theta: "\u0398",
  Iota: "\u0399",
  Kappa: "\u039A",
  Lambda: "\u039B",
  Mu: "\u039C",
  Nu: "\u039D",
  Xi: "\u039E",
  Omicron: "\u039F",
  Pi: "\u03A0",
  Rho: "\u03A1",
  Sigma: "\u03A3",
  Tau: "\u03A4",
  Upsilon: "\u03A5",
  Phi: "\u03A6",
  Chi: "\u03A7",
  Psi: "\u03A8",
  Omegagreek: "\u03A9",
  alpha: "\u03B1",
  beta: "\u03B2",
  gamma: "\u03B3",
  delta: "\u03B4",
  epsilon: "\u03B5",
  zeta: "\u03B6",
  eta: "\u03B7",
  theta: "\u03B8",
  iota: "\u03B9",
  kappa: "\u03BA",
  lambda: "\u03BB",
  mugreek: "\u03BC",
  nu: "\u03BD",
  xi: "\u03BE",
  omicron: "\u03BF",
  pi: "\u03C0",
  rho: "\u03C1",
  sigma: "\u03C3",
  sigma1: "\u03C2",
  tau: "\u03C4",
  upsilon: "\u03C5",
  phi: "\u03C6",
  chi: "\u03C7",
  psi: "\u03C8",
  omega: "\u03C9",
  theta1: "\u03D1",
  Upsilon1: "\u03D2",
  phi1: "\u03D5",
  omega1: "\u03D6",
  sigma1math: "\u03C2",
  epsilon1: "\u03F5",
};

/** 连字（fi/fl 在 PDF 里是单字形，抽取时应还原成两个字母）。 */
const GLYPH_AGL_LIGATURE = {
  ff: "ff",
  fi: "fi",
  fl: "fl",
  ffi: "ffi",
  ffl: "ffl",
  st: "st",
};

/**
 * 合并成一张表；Object.assign 只跑一次，属模块初始化。
 * 单字母字形名（"A"…"Z"、"a"…"z"）在 PDF 里就是字母本身，逐条写太吵，这里生成。
 */
const GLYPH_AGL = (() => {
  const table = Object.assign(
    Object.create(null),
    GLYPH_AGL_ASCII,
    GLYPH_AGL_LATIN1,
    GLYPH_AGL_SYMBOL,
    GLYPH_AGL_GREEK,
    GLYPH_AGL_LIGATURE,
  );
  for (let i = 0; i < 26; i++) {
    const upper = String.fromCharCode(65 + i);
    const lower = String.fromCharCode(97 + i);
    table[upper] = upper;
    table[lower] = lower;
  }
  return table;
})();

/* ───── 单字节编码表（码 → Unicode） ───── */

/** Windows-1252 的 0x80–0x9F 区（其余与 Latin-1 相同）。 */
const GLYPH_CP1252_HIGH = {
  0x80: "\u20AC",
  0x82: "\u201A",
  0x83: "\u0192",
  0x84: "\u201E",
  0x85: "\u2026",
  0x86: "\u2020",
  0x87: "\u2021",
  0x88: "\u02C6",
  0x89: "\u2030",
  0x8A: "\u0160",
  0x8B: "\u2039",
  0x8C: "\u0152",
  0x8E: "\u017D",
  0x91: "\u2018",
  0x92: "\u2019",
  0x93: "\u201C",
  0x94: "\u201D",
  0x95: "\u2022",
  0x96: "\u2013",
  0x97: "\u2014",
  0x98: "\u02DC",
  0x99: "\u2122",
  0x9A: "\u0161",
  0x9B: "\u203A",
  0x9C: "\u0153",
  0x9E: "\u017E",
  0x9F: "\u0178",
};

/**
 * WinAnsiEncoding：0xA0–0xFF 与 Latin-1 一致，0x20–0x7E 与 ASCII 一致，只有
 * 0x80–0x9F 是 CP1252 特殊区。0xA0 取普通空格（而非 NBSP）——课件正文里
 * NBSP 只会让下游匹配变难。
 */
const GLYPH_WIN_ANSI = (() => {
  const table = new Array(256).fill(null);
  for (let code = 0x20; code <= 0x7e; code++) table[code] = String.fromCharCode(code);
  for (let code = 0xa0; code <= 0xff; code++) table[code] = String.fromCharCode(code);
  for (const key of Object.keys(GLYPH_CP1252_HIGH)) table[Number(key)] = GLYPH_CP1252_HIGH[key];
  table[0xa0] = " ";
  table[0xad] = "-";
  return table;
})();

/** MacRomanEncoding 0x80–0xFF 的 Unicode 码点（32–126 同 ASCII）。 */
const GLYPH_MAC_ROMAN_HIGH_CODEPOINTS = [
  0x00c4, 0x00c5, 0x00c7, 0x00c9, 0x00d1, 0x00d6, 0x00dc, 0x00e1,
  0x00e0, 0x00e2, 0x00e4, 0x00e3, 0x00e5, 0x00e7, 0x00e9, 0x00e8,
  0x00ea, 0x00eb, 0x00ed, 0x00ec, 0x00ee, 0x00ef, 0x00f1, 0x00f3,
  0x00f2, 0x00f4, 0x00f6, 0x00f5, 0x00fa, 0x00f9, 0x00fb, 0x00fc,
  0x2020, 0x00b0, 0x00a2, 0x00a3, 0x00a7, 0x2022, 0x00b6, 0x00df,
  0x00ae, 0x00a9, 0x2122, 0x00b4, 0x00a8, 0x2260, 0x00c6, 0x00d8,
  0x221e, 0x00b1, 0x2264, 0x2265, 0x00a5, 0x00b5, 0x2202, 0x2211,
  0x220f, 0x03c0, 0x222b, 0x00aa, 0x00ba, 0x03a9, 0x00e6, 0x00f8,
  0x00bf, 0x00a1, 0x00ac, 0x221a, 0x0192, 0x2248, 0x2206, 0x00ab,
  0x00bb, 0x2026, 0x00a0, 0x00c0, 0x00c3, 0x00d5, 0x0152, 0x0153,
  0x2013, 0x2014, 0x201c, 0x201d, 0x2018, 0x2019, 0x00f7, 0x25ca,
  0x00ff, 0x0178, 0x2044, 0x20ac, 0x2039, 0x203a, 0xfb01, 0xfb02,
  0x2021, 0x00b7, 0x201a, 0x201e, 0x2030, 0x00c2, 0x00ca, 0x00c1,
  0x00cb, 0x00c8, 0x00cd, 0x00ce, 0x00cf, 0x00cc, 0x00d3, 0x00d4,
  0xf8ff, 0x00d2, 0x00da, 0x00db, 0x00d9, 0x0131, 0x02c6, 0x02dc,
  0x00af, 0x02d8, 0x02d9, 0x02da, 0x00b8, 0x02dd, 0x02db, 0x02c7,
];

const GLYPH_MAC_ROMAN = (() => {
  const table = new Array(256).fill(null);
  for (let code = 0x20; code <= 0x7e; code++) table[code] = String.fromCharCode(code);
  for (let i = 0; i < GLYPH_MAC_ROMAN_HIGH_CODEPOINTS.length; i++) {
    table[0x80 + i] = String.fromCharCode(GLYPH_MAC_ROMAN_HIGH_CODEPOINTS[i]);
  }
  return table;
})();

/** StandardEncoding 的 0xA1–0xFB 特殊位（其余 0x20–0x7E 同 ASCII）。 */
const GLYPH_STANDARD_SPECIAL = {
  0xa1: "\u00A1",
  0xa2: "\u00A2",
  0xa3: "\u00A3",
  0xa4: "\u2044",
  0xa5: "\u00A5",
  0xa6: "\u0192",
  0xa7: "\u00A7",
  0xa8: "\u00A4",
  0xa9: "'",
  0xaa: "\u201C",
  0xab: "\u00AB",
  0xac: "\u2039",
  0xad: "\u203A",
  0xae: "fi",
  0xaf: "fl",
  0xb1: "\u2013",
  0xb2: "\u2020",
  0xb3: "\u2021",
  0xb4: "\u00B7",
  0xb6: "\u00B6",
  0xb7: "\u2022",
  0xb8: "\u201A",
  0xb9: "\u201E",
  0xba: "\u201D",
  0xbb: "\u00BB",
  0xbc: "\u2026",
  0xbd: "\u2030",
  0xbf: "\u00BF",
  0xc1: "`",
  0xc2: "\u00B4",
  0xc3: "\u02C6",
  0xc4: "\u02DC",
  0xc5: "\u00AF",
  0xc6: "\u02D8",
  0xc7: "\u02D9",
  0xc8: "\u00A8",
  0xca: "\u02DA",
  0xcb: "\u00B8",
  0xcd: "\u02DD",
  0xce: "\u02DB",
  0xcf: "\u02C7",
  0xd0: "\u2014",
  0xe1: "\u00C6",
  0xe3: "\u00AA",
  0xe8: "\u0141",
  0xe9: "\u00D8",
  0xea: "\u0152",
  0xeb: "\u00BA",
  0xf1: "\u00E6",
  0xf5: "\u0131",
  0xf8: "\u0142",
  0xf9: "\u00F8",
  0xfa: "\u0153",
  0xfb: "\u00DF",
};

const GLYPH_STANDARD = (() => {
  const table = new Array(256).fill(null);
  for (let code = 0x20; code <= 0x7e; code++) table[code] = String.fromCharCode(code);
  table[0x27] = "\u2019"; // StandardEncoding 的 0x27 是 quoteright（撇号）
  table[0x60] = "\u2018"; // 0x60 是 quoteleft
  for (const key of Object.keys(GLYPH_STANDARD_SPECIAL)) table[Number(key)] = GLYPH_STANDARD_SPECIAL[key];
  return table;
})();

/* ───── 对外函数 ───── */

/**
 * 字形名 → Unicode 字符串（可能多字符，如连字 fi；不可映射返回 null）。
 * 支持 AGL 名、uniXXXX / uniXXXXXXXX、uXXXX–uXXXXXX、gNN（无 Unicode 语义）。
 * 返回值是 string|null，调用方负责把 null 换成 U+FFFD 并计数。
 */
export function glyphNameToUnicode(name) {
  if (typeof name !== "string" || name.length === 0) return null;
  const direct = GLYPH_AGL[name];
  if (direct !== undefined) return direct;

  // uni 前缀：4 位一组，可重复（uni4E2D、uni00410042）
  if (name.length >= 7 && name.slice(0, 3) === "uni") {
    const m = /^uni((?:[0-9A-Fa-f]{4})+)(?:[._].*)?$/.exec(name);
    if (m) {
      const hex = m[1];
      let out = "";
      for (let i = 0; i < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
      return out;
    }
  }
  // u 前缀：4–6 位十六进制（u4E2D、u1F600）
  if (name.length >= 5 && (name[0] === "u" || name[0] === "U")) {
    const m = /^[uU]([0-9A-Fa-f]{4,6})(?:[._].*)?$/.exec(name);
    if (m) {
      const cp = parseInt(m[1], 16);
      if (cp <= 0x10ffff) return String.fromCodePoint(cp);
    }
  }
  // 连字/组合名：f_f_i、uni4E2D_uni4E00
  if (name.indexOf("_") > 0) {
    const parts = name.split("_");
    let out = "";
    for (const part of parts) {
      const ch = glyphNameToUnicode(part);
      if (ch === null) return null;
      out += ch;
    }
    return out;
  }
  // 变体后缀：a.sc、one.oldstyle、zero.slash
  const dot = name.indexOf(".");
  if (dot > 0) {
    const base = GLYPH_AGL[name.slice(0, dot)];
    if (base !== undefined) return base;
  }
  // gNN / cidNN / glyphNN / indexNN 是"字形槽位"，没有 Unicode 语义
  return null;
}

/** 编码名 → 256 项"码 → 字符"表；不认识的编码返回 null（调用方退 WinAnsi）。 */
export function glyphEncodingTable(encodingName) {
  if (typeof encodingName !== "string") return null;
  const name = encodingName
    .trim()
    .replace(/^[A-Za-z]+\//, "") // 少数文件写成 "PDF/StandardEncoding"
    .replace(/Encoding$/, "");
  if (name === "WinAnsi" || name === "WinAnsiEncoding" || name === "cp1252") return GLYPH_WIN_ANSI;
  if (name === "MacRoman" || name === "MacRomanEncoding") return GLYPH_MAC_ROMAN;
  if (name === "Standard" || name === "StandardEncoding") return GLYPH_STANDARD;
  return null;
}

const GLYPH_CJK_RE =
  /[\u1100-\u11ff\u2e80-\u303f\u3040-\u30ff\u3100-\u312f\u3130-\u318f\u31a0-\u31bf\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\u{20000}-\u{2fa1f}]/u;

/** 是否 CJK/全角字符：决定行内相邻两段之间要不要补空格。 */
export function glyphIsCjk(ch) {
  if (!ch) return false;
  return GLYPH_CJK_RE.test(ch);
}

/** 是否"视觉上算空格"的字符（含 NBSP、全角空格、零宽空格）。 */
export function glyphIsSpace(ch) {
  return ch === " " || ch === "\u00A0" || ch === "\u3000" || ch === "\u200b" || ch === "\t" || ch === "\n" || ch === "\r";
}

export { GLYPH_AGL, GLYPH_WIN_ANSI, GLYPH_MAC_ROMAN, GLYPH_STANDARD };