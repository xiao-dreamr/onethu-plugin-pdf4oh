/**
 * pdf4oh · 内容流层：tokenize + 文本状态机，产出"带页面坐标的文本片段"。
 *
 * 职责与边界（why）：
 *   - PDF 的内容流是逆波兰式绘图指令，文本位置由 Tm/Td/TD/T* 与 Tj/TJ 逐步累积，
 *     字体又有自己的字节宽度。文本抽取要把这些累加还原成"每个字符串从哪儿开始、
 *     多宽、多大字号"，否则排版层无法判断换行与空格。所以本模块输出的是
 *     `items: [{ text, x, y, w, fontSize, tm }]`，坐标已折算到"显示空间"
 *     （左上原点、y 向下、已含 /Rotate 的 0/90/180/270 变换），排版全部交给 text.js。
 *   - 只依赖契约 §4 的 doc 接口与字体对象（fonts.js），不解析对象结构、不做行聚合。
 *   - Form XObject 按规范递归（深度上限 8，带自己的 /Matrix 与 /Resources）：课件里
 *     图表、公式、页眉常被塞进 Form，不递归会整段丢字。
 *   - 内联图片 BI…ID…EI 里的二进制可能包含任意字节，必须跳过且不当作指令执行，
 *     否则会把图片数据误读成文本；跳过的图片计入 imageCount，供"扫描件"判定使用。
 */

import { dictGet, isDict, isName, isStream, nameOf, numArray, numOr, resolveOr } from "./util.js";
import { loadFont } from "./fonts.js";

/** Form XObject 递归深度上限：防御自引用/环形 Form 导致死循环。 */
const CONTENT_MAX_FORM_DEPTH = 8;

/** 单个内容流最多执行多少条指令（防御损坏文件造成的死循环式扫描）。 */
const CONTENT_MAX_OPS = 400000;

/** 单页最多保留多少个文本片段（超出后只计数不保留，避免内存爆）。 */
const CONTENT_MAX_ITEMS = 200000;

const CONTENT_IDENTITY = [1, 0, 0, 1, 0, 0];

/** 显示空间几何：MediaBox 归一化 + /Rotate 归一化到 0/90/180/270。 */
function CONTENT_pageGeometry(page) {
  let box = page && Array.isArray(page.mediaBox) && page.mediaBox.length === 4 ? page.mediaBox : null;
  if (!box || box.some((v) => typeof v !== "number" || !Number.isFinite(v))) box = [0, 0, 612, 792];
  const x0 = Math.min(box[0], box[2]);
  const x1 = Math.max(box[0], box[2]);
  const y0 = Math.min(box[1], box[3]);
  const y1 = Math.max(box[1], box[3]);
  let rotate = numOr(page && page.rotate, 0);
  rotate = ((Math.round(rotate / 90) * 90) % 360 + 360) % 360;
  if (rotate !== 0 && rotate !== 90 && rotate !== 180 && rotate !== 270) rotate = 0;
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, rotate };
}

/**
 * 页面用户坐标 → 显示坐标（左上原点、y 向下）。
 * 推导：先按顺时针 rotate 旋转用户空间，再平移到显示框、翻转 y。
 * 0: (x-x0, y1-y) / 90: (y-y0, x-x0) / 180: (x1-x, y-y0) / 270: (y1-y, x1-x)
 */
function CONTENT_toDisplay(geom, x, y) {
  switch (geom.rotate) {
    case 90:
      return [y - geom.y0, x - geom.x0];
    case 180:
      return [geom.x1 - x, y - geom.y0];
    case 270:
      return [geom.y1 - y, geom.x1 - x];
    default:
      return [x - geom.x0, geom.y1 - y];
  }
}

/** 矩阵乘法 a × b（PDF 行向量约定：[a b c d e f]）。 */
function CONTENT_matMul(a, b) {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

function CONTENT_translate(tx, ty) {
  return [1, 0, 0, 1, tx, ty];
}

/** 文本/图形状态；q/Q 只保存图形状态（含文本状态参数），不保存 Tm/Tlm。 */
function CONTENT_newState() {
  return {
    ctm: CONTENT_IDENTITY.slice(),
    font: null,
    fontSize: 0,
    tc: 0,
    tw: 0,
    th: 1,
    tl: 0,
    ts: 0,
    tm: CONTENT_IDENTITY.slice(),
    tlm: CONTENT_IDENTITY.slice(),
    stack: [],
  };
}

function CONTENT_saveState(st) {
  st.stack.push({
    ctm: st.ctm.slice(),
    font: st.font,
    fontSize: st.fontSize,
    tc: st.tc,
    tw: st.tw,
    th: st.th,
    tl: st.tl,
    ts: st.ts,
  });
}

function CONTENT_restoreState(st) {
  const saved = st.stack.pop();
  if (!saved) return;
  st.ctm = saved.ctm;
  st.font = saved.font;
  st.fontSize = saved.fontSize;
  st.tc = saved.tc;
  st.tw = saved.tw;
  st.th = saved.th;
  st.tl = saved.tl;
  st.ts = saved.ts;
}

function CONTENT_cloneState(st) {
  return {
    ctm: st.ctm.slice(),
    font: st.font,
    fontSize: st.fontSize,
    tc: st.tc,
    tw: st.tw,
    th: st.th,
    tl: st.tl,
    ts: st.ts,
    tm: st.tm.slice(),
    tlm: st.tlm.slice(),
    stack: [],
  };
}

function CONTENT_isWs(byte) {
  return byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

function CONTENT_isDelim(byte) {
  return (
    byte === 0x28 ||
    byte === 0x29 ||
    byte === 0x3c ||
    byte === 0x3e ||
    byte === 0x5b ||
    byte === 0x5d ||
    byte === 0x7b ||
    byte === 0x7d ||
    byte === 0x2f ||
    byte === 0x25
  );
}

function CONTENT_isTokenBreak(byte) {
  return byte === undefined || CONTENT_isWs(byte) || CONTENT_isDelim(byte);
}

/** 读名字 token（/F1），处理 #xx 转义。 */
function CONTENT_readName(bytes, pos) {
  let out = "";
  let i = pos + 1;
  while (i < bytes.length && !CONTENT_isWs(bytes[i]) && !CONTENT_isDelim(bytes[i])) {
    if (bytes[i] === 0x23 && i + 2 < bytes.length) {
      const code = parseInt(String.fromCharCode(bytes[i + 1], bytes[i + 2]), 16);
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

/** 读 (…) 字面串，处理转义、八进制与括号嵌套。 */
function CONTENT_readLiteral(bytes, pos) {
  const out = [];
  let i = pos + 1;
  let depth = 1;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0x5c) {
      i += 1;
      if (i >= bytes.length) break;
      const esc = bytes[i];
      if (esc === 0x6e) {
        out.push(0x0a);
        i += 1;
      } else if (esc === 0x72) {
        out.push(0x0d);
        i += 1;
      } else if (esc === 0x74) {
        out.push(0x09);
        i += 1;
      } else if (esc === 0x62) {
        out.push(0x08);
        i += 1;
      } else if (esc === 0x66) {
        out.push(0x0c);
        i += 1;
      } else if (esc === 0x28 || esc === 0x29 || esc === 0x5c) {
        out.push(esc);
        i += 1;
      } else if (esc >= 0x30 && esc <= 0x37) {
        let value = 0;
        let digits = 0;
        while (digits < 3 && i < bytes.length && bytes[i] >= 0x30 && bytes[i] <= 0x37) {
          value = value * 8 + (bytes[i] - 0x30);
          i += 1;
          digits += 1;
        }
        out.push(value & 0xff);
      } else if (esc === 0x0a) {
        i += 1;
      } else if (esc === 0x0d) {
        i += 1;
        if (bytes[i] === 0x0a) i += 1;
      } else {
        out.push(esc);
        i += 1;
      }
      continue;
    }
    if (b === 0x28) {
      depth += 1;
      out.push(b);
      i += 1;
      continue;
    }
    if (b === 0x29) {
      depth -= 1;
      i += 1;
      if (depth === 0) break;
      out.push(b);
      continue;
    }
    out.push(b);
    i += 1;
  }
  return { bytes: new Uint8Array(out), pos: i };
}

/** 读 <hex> 串。 */
function CONTENT_readHexString(bytes, pos) {
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
  for (let k = 0; k < out.length; k++) {
    out[k] = (digits[k * 2] << 4) | (digits[k * 2 + 1] === undefined ? 0 : digits[k * 2 + 1]);
  }
  return { bytes: out, pos: i + 1 };
}

/** 跳过平衡的 << … >>（内容流里只有 BDC/DP 的属性字典会用到）。 */
function CONTENT_skipDict(bytes, pos) {
  let i = pos + 2;
  let depth = 1;
  while (i < bytes.length && depth > 0) {
    if (bytes[i] === 0x3c && bytes[i + 1] === 0x3c) {
      depth += 1;
      i += 2;
    } else if (bytes[i] === 0x3e && bytes[i + 1] === 0x3e) {
      depth -= 1;
      i += 2;
    } else if (bytes[i] === 0x28) {
      i = CONTENT_readLiteral(bytes, i).pos;
    } else {
      i += 1;
    }
  }
  return i;
}

/** 读数字（含小数/正负号，兼容 1e-3 这种写法）。 */
function CONTENT_readNumber(bytes, pos) {
  let i = pos;
  let text = "";
  while (i < bytes.length && !CONTENT_isWs(bytes[i]) && !CONTENT_isDelim(bytes[i])) {
    text += String.fromCharCode(bytes[i]);
    i += 1;
  }
  const value = Number(text);
  return { value: Number.isFinite(value) ? value : 0, pos: i };
}

/** 读 [ … ] 数组（数组元素只可能是数字/字符串/名字/嵌套数组/字典）。 */
function CONTENT_readArray(bytes, pos) {
  const items = [];
  let i = pos + 1;
  while (i < bytes.length && bytes[i] !== 0x5d) {
    const b = bytes[i];
    if (CONTENT_isWs(b)) {
      i += 1;
    } else if (b === 0x25) {
      while (i < bytes.length && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i += 1;
    } else if (b === 0x2f) {
      const name = CONTENT_readName(bytes, i);
      items.push({ tok: "name", v: name.value });
      i = name.pos;
    } else if (b === 0x28) {
      const str = CONTENT_readLiteral(bytes, i);
      items.push({ tok: "str", b: str.bytes });
      i = str.pos;
    } else if (b === 0x3c) {
      if (bytes[i + 1] === 0x3c) {
        i = CONTENT_skipDict(bytes, i);
      } else {
        const hex = CONTENT_readHexString(bytes, i);
        items.push({ tok: "str", b: hex.bytes });
        i = hex.pos;
      }
    } else if (b === 0x5b) {
      const arr = CONTENT_readArray(bytes, i);
      items.push({ tok: "arr", v: arr.items });
      i = arr.pos;
    } else if (b === 0x5d) {
      i += 1;
    } else {
      const num = CONTENT_readNumber(bytes, i);
      if (num.pos === i) i += 1;
      else {
        items.push({ tok: "num", v: num.value });
        i = num.pos;
      }
    }
  }
  return { items, pos: i + 1 };
}

/** 内容流字节 → 指令流（操作符 + 操作数）的执行。 */
function CONTENT_run(ctx, bytes, state, resources, depth) {
  const operands = [];
  let pos = 0;
  while (pos < bytes.length) {
    const b = bytes[pos];
    if (CONTENT_isWs(b)) {
      pos += 1;
      continue;
    }
    if (b === 0x25) {
      while (pos < bytes.length && bytes[pos] !== 0x0a && bytes[pos] !== 0x0d) pos += 1;
      continue;
    }
    if (b === 0x2f) {
      const name = CONTENT_readName(bytes, pos);
      operands.push({ tok: "name", v: name.value });
      pos = name.pos;
      continue;
    }
    if (b === 0x28) {
      const str = CONTENT_readLiteral(bytes, pos);
      operands.push({ tok: "str", b: str.bytes });
      pos = str.pos;
      continue;
    }
    if (b === 0x3c) {
      if (bytes[pos + 1] === 0x3c) {
        pos = CONTENT_skipDict(bytes, pos);
      } else {
        const hex = CONTENT_readHexString(bytes, pos);
        operands.push({ tok: "str", b: hex.bytes });
        pos = hex.pos;
      }
      continue;
    }
    if (b === 0x5b) {
      const arr = CONTENT_readArray(bytes, pos);
      operands.push({ tok: "arr", v: arr.items });
      pos = arr.pos;
      continue;
    }
    if (b === 0x5d || b === 0x7b || b === 0x7d) {
      pos += 1;
      continue;
    }
    if ((b >= 0x30 && b <= 0x39) || b === 0x2b || b === 0x2d || b === 0x2e) {
      const num = CONTENT_readNumber(bytes, pos);
      operands.push(num.value);
      pos = num.pos;
      continue;
    }
    // 操作符：读到空白/分隔符为止（T*、'、" 都靠这个规则）
    let op = "";
    let i = pos;
    while (i < bytes.length && !CONTENT_isWs(bytes[i]) && !CONTENT_isDelim(bytes[i])) {
      op += String.fromCharCode(bytes[i]);
      i += 1;
    }
    if (i === pos) {
      pos += 1;
      continue;
    }
    pos = i;
    ctx.ops += 1;
    if (ctx.ops > CONTENT_MAX_OPS) {
      CONTENT_warn(ctx, "内容流指令数超限，已提前停止（文件可能损坏）");
      return;
    }
    if (op === "BI") {
      pos = CONTENT_skipInlineImage(ctx, bytes, pos);
      operands.length = 0;
      continue;
    }
    CONTENT_execute(ctx, state, op, operands, resources, depth);
    operands.length = 0;
  }
}

/** 执行一条指令；未知指令按规范忽略（内容流允许厂商扩展）。 */
function CONTENT_execute(ctx, st, op, operands, resources, depth) {
  switch (op) {
    case "q":
      CONTENT_saveState(st);
      return;
    case "Q":
      CONTENT_restoreState(st);
      return;
    case "cm": {
      const m = CONTENT_sixNumbers(operands);
      if (m) st.ctm = CONTENT_matMul(m, st.ctm);
      return;
    }
    case "BT":
      st.tm = CONTENT_IDENTITY.slice();
      st.tlm = CONTENT_IDENTITY.slice();
      return;
    case "ET":
      return;
    case "Tf": {
      const nameTok = operands[0];
      const size = CONTENT_numberAt(operands, 1);
      if (!nameTok || nameTok.tok !== "name" || !Number.isFinite(size)) return;
      st.font = CONTENT_fontFor(ctx, resources, nameTok.v);
      st.fontSize = size;
      return;
    }
    case "Tc":
      st.tc = CONTENT_numberAt(operands, 0);
      return;
    case "Tw":
      st.tw = CONTENT_numberAt(operands, 0);
      return;
    case "Tz": {
      const pct = CONTENT_numberAt(operands, 0);
      st.th = Number.isFinite(pct) ? pct / 100 : 1;
      return;
    }
    case "TL":
      st.tl = CONTENT_numberAt(operands, 0);
      return;
    case "Ts":
      st.ts = CONTENT_numberAt(operands, 0);
      return;
    case "Td":
    case "TD": {
      const tx = CONTENT_numberAt(operands, 0);
      const ty = CONTENT_numberAt(operands, 1);
      if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;
      if (op === "TD") st.tl = -ty;
      st.tlm = CONTENT_matMul(CONTENT_translate(tx, ty), st.tlm);
      st.tm = st.tlm;
      return;
    }
    case "Tm": {
      const m = CONTENT_sixNumbers(operands);
      if (!m) return;
      st.tm = m;
      st.tlm = m.slice();
      return;
    }
    case "T*": {
      st.tlm = CONTENT_matMul(CONTENT_translate(0, -st.tl), st.tlm);
      st.tm = st.tlm;
      return;
    }
    case "Tj": {
      const str = operands[0];
      if (str && str.tok === "str") CONTENT_show(ctx, st, str.b);
      return;
    }
    case "TJ": {
      const arr = operands[0];
      if (arr && arr.tok === "arr") CONTENT_showArray(ctx, st, arr.v);
      return;
    }
    case "'": {
      st.tlm = CONTENT_matMul(CONTENT_translate(0, -st.tl), st.tlm);
      st.tm = st.tlm;
      const str = operands[0];
      if (str && str.tok === "str") CONTENT_show(ctx, st, str.b);
      return;
    }
    case '"': {
      const aw = CONTENT_numberAt(operands, 0);
      const ac = CONTENT_numberAt(operands, 1);
      if (Number.isFinite(aw)) st.tw = aw;
      if (Number.isFinite(ac)) st.tc = ac;
      st.tlm = CONTENT_matMul(CONTENT_translate(0, -st.tl), st.tlm);
      st.tm = st.tlm;
      const str = operands[2];
      if (str && str.tok === "str") CONTENT_show(ctx, st, str.b);
      return;
    }
    case "Do": {
      const nameTok = operands[0];
      if (nameTok && nameTok.tok === "name") CONTENT_doXObject(ctx, st, resources, nameTok.v, depth);
      return;
    }
    default:
      return;
  }
}

/** 取第 idx 个操作数（要求是数字），否则 NaN。 */
function CONTENT_numberAt(operands, idx) {
  const v = operands[idx];
  return typeof v === "number" && Number.isFinite(v) ? v : NaN;
}

/** 取连续 6 个数字（cm/Tm）；不足返回 null。 */
function CONTENT_sixNumbers(operands) {
  if (operands.length < 6) return null;
  const out = [];
  for (let i = operands.length - 6; i < operands.length; i++) {
    const v = operands[i];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    out.push(v);
  }
  return out;
}

/** 取 dict/Map/stream 的字段（内容流里的 /Resources 可能是三种形态）。 */
function CONTENT_dictGet(container, key) {
  if (!container) return undefined;
  if (container instanceof Map) return container.get(key);
  if (isDict(container)) return container.m.get(key);
  if (isStream(container)) return container.dict.get(key);
  return undefined;
}

/** 按 /Resources /Font 名字取字体对象（loadFont 内部已按字体 ref 缓存）。 */
function CONTENT_fontFor(ctx, resources, fontName) {
  let byRes = ctx.fontByRes.get(resources);
  if (!byRes) {
    byRes = new Map();
    ctx.fontByRes.set(resources, byRes);
  }
  const hit = byRes.get(fontName);
  if (hit) return hit;
  const fontsDict = resolveOr(ctx.doc, CONTENT_dictGet(resources, "Font"), null);
  const fontValue = fontsDict instanceof Map ? fontsDict.get(fontName) : dictGet(fontsDict, fontName);
  if (fontValue === undefined || fontValue === null) {
    CONTENT_warn(ctx, `内容流引用了不存在的字体 /${fontName}（该段文本按 Latin-1 降级）`);
  }
  const font = loadFont(ctx.doc, fontValue);
  byRes.set(fontName, font);
  return font;
}

/** 显示一段字符串，并把位置/宽度记为 item。 */
function CONTENT_show(ctx, st, bytes) {
  if (!bytes || bytes.length === 0) return;
  if (!st.font) {
    CONTENT_warn(ctx, "文本显示时没有可用字体（缺 Tf 或字体缺失），已跳过一段文本");
    return;
  }
  const font = CONTENT_trackFont(ctx, st.font);
  const info = font.show(bytes);
  if (font.vertical) CONTENT_warn(ctx, `字体 ${font.name} 是竖排（Identity-V），暂按横排处理`);

  const m = CONTENT_matMul(st.tm, st.ctm);
  const ma = m[0];
  const mb = m[1];
  const mc = m[2];
  const md = m[3];
  const me = m[4];
  const mf = m[5];
  const rise = st.ts;
  const ux0 = mc * rise + me;
  const uy0 = md * rise + mf;

  // 字宽单位是 1/1000 em；Tc 按码计数，Tw 只对单字节空格码生效（由 font 统计）
  const tx = ((info.width / 1000) * st.fontSize + st.tc * info.codes + st.tw * info.spaces) * st.th;

  const ux1 = ux0 + tx * ma;
  const uy1 = uy0 + tx * mb;
  const d0 = CONTENT_toDisplay(ctx.geom, ux0, uy0);
  const d1 = CONTENT_toDisplay(ctx.geom, ux1, uy1);
  const w = Math.abs(d1[0] - d0[0]);
  const x = Math.min(d0[0], d1[0]);
  const fontSize = Math.abs(st.fontSize) * (Math.hypot(mc, md) || 1);

  if (info.text.length > 0 && ctx.items.length < CONTENT_MAX_ITEMS) {
    ctx.items.push({
      text: info.text,
      x,
      y: d0[1],
      w,
      fontSize,
      tm: st.tm.slice(),
      fontName: font.name,
    });
  } else if (info.text.length > 0) {
    ctx.itemsDropped += 1;
  }

  st.tm = CONTENT_matMul(CONTENT_translate(tx, 0), st.tm);
}

/** TJ 数组：字符串显示；数字是字距微调（负值把后面的字推远）。 */
function CONTENT_showArray(ctx, st, items) {
  for (const item of items) {
    // 数组元素在 tokenizer 里统一包装成 { tok }；数字是 TJ 的字距微调
    const raw = item && item.tok === "num" ? item.v : item;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      const tx = (-raw / 1000) * st.fontSize * st.th;
      st.tm = CONTENT_matMul(CONTENT_translate(tx, 0), st.tm);
    } else if (item && item.tok === "str") {
      CONTENT_show(ctx, st, item.b);
    }
  }
}

/** 跳过 BI … ID <二进制> … EI，并计数。 */
function CONTENT_skipInlineImage(ctx, bytes, pos) {
  let i = pos;
  while (i < bytes.length) {
    if (CONTENT_isWs(bytes[i])) {
      i += 1;
      continue;
    }
    if (bytes[i] === 0x49 && bytes[i + 1] === 0x44 && CONTENT_isTokenBreak(bytes[i + 2])) {
      i += 2;
      break;
    }
    i = CONTENT_skipValue(bytes, i);
  }
  if (CONTENT_isWs(bytes[i])) i += 1; // ID 后必须恰好一个空白
  while (i < bytes.length) {
    if (
      bytes[i] === 0x45 &&
      bytes[i + 1] === 0x49 &&
      CONTENT_isWs(bytes[i - 1]) &&
      CONTENT_isTokenBreak(bytes[i + 2])
    ) {
      i += 2;
      break;
    }
    i += 1;
  }
  ctx.imageCount += 1;
  return i;
}

/** 跳过一个内容流值（BI 字典里的 name/number/string/array/dict）。 */
function CONTENT_skipValue(bytes, pos) {
  const b = bytes[pos];
  if (b === 0x2f) return CONTENT_readName(bytes, pos).pos;
  if (b === 0x28) return CONTENT_readLiteral(bytes, pos).pos;
  if (b === 0x3c) return b === 0x3c && bytes[pos + 1] === 0x3c ? CONTENT_skipDict(bytes, pos) : CONTENT_readHexString(bytes, pos).pos;
  if (b === 0x5b) return CONTENT_readArray(bytes, pos).pos;
  let i = pos;
  while (i < bytes.length && !CONTENT_isWs(bytes[i]) && !CONTENT_isDelim(bytes[i])) i += 1;
  return i === pos ? pos + 1 : i;
}

/** Do：图片计数；Form 递归（带自己的 Matrix/Resources）。 */
function CONTENT_doXObject(ctx, st, resources, name, depth) {
  const xobjects = resolveOr(ctx.doc, CONTENT_dictGet(resources, "XObject"), null);
  const raw = xobjects instanceof Map ? xobjects.get(name) : dictGet(xobjects, name);
  if (raw === undefined || raw === null) {
    CONTENT_warn(ctx, `内容流引用了不存在的 XObject /${name}`);
    return;
  }
  const stream = resolveOr(ctx.doc, raw, null);
  if (!isStream(stream)) return;
  const subtype = nameOf(dictGet(stream, "Subtype"));
  if (subtype === "Image") {
    ctx.imageCount += 1;
    return;
  }
  if (subtype !== "Form") return;
  if (depth >= ctx.maxFormDepth) {
    CONTENT_warn(ctx, `Form XObject 递归超过 ${ctx.maxFormDepth} 层，已停止（可能有自引用）`);
    return;
  }
  const formBytes = CONTENT_streamBytes(ctx.doc, stream);
  if (!formBytes || formBytes.length === 0) return;
  const matrix = numArray(resolveOr(ctx.doc, dictGet(stream, "Matrix"), null), null);
  const formResources = resolveOr(ctx.doc, dictGet(stream, "Resources"), null) || resources;
  ctx.formCount += 1;
  const child = CONTENT_cloneState(st);
  if (matrix && matrix.length === 6 && matrix.every((v) => Number.isFinite(v))) {
    child.ctm = CONTENT_matMul(matrix, st.ctm);
  }
  CONTENT_run(ctx, formBytes, child, formResources, depth + 1);
}

function CONTENT_streamBytes(doc, stream) {
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
    // 落到 raw：未压缩的 Form 流即使 decode 失败也能读
  }
  return stream.raw || null;
}

/** 记录本页用到的字体（用于收尾时汇报"缺字/缺 ToUnicode"）。 */
function CONTENT_trackFont(ctx, font) {
  if (!ctx.fontBaseMissing.has(font)) {
    ctx.fontBaseMissing.set(font, typeof font.missing === "number" ? font.missing : 0);
  }
  return font;
}

function CONTENT_warn(ctx, message) {
  if (ctx.warnSeen.has(message)) return;
  ctx.warnSeen.add(message);
  if (ctx.warnings.length < 100) ctx.warnings.push(message);
}

/**
 * 解释一段内容流字节，返回文本片段与统计。
 *
 * @returns {{items: Array<{text:string,x:number,y:number,w:number,fontSize:number,tm:number[]}>,
 *            imageCount:number, formCount:number, warnings:string[]}}
 */
export function runContentStream(doc, page, bytes, opts) {
  const options = opts || {};
  const resources = options.resources || (page && page.resources ? page.resources : new Map());
  const ctx = {
    doc,
    page,
    geom: CONTENT_pageGeometry(page),
    items: [],
    itemsDropped: 0,
    imageCount: 0,
    formCount: 0,
    warnings: [],
    warnSeen: new Set(),
    fontBaseMissing: new Map(),
    fontByRes: new WeakMap(),
    ops: 0,
    maxFormDepth: numOr(options.maxFormDepth, CONTENT_MAX_FORM_DEPTH),
  };
  if (bytes && bytes.length > 0) {
    try {
      CONTENT_run(ctx, bytes, CONTENT_newState(), resources, 0);
    } catch (e) {
      CONTENT_warn(ctx, "内容流解释中断：" + (e && e.message ? e.message : String(e)));
    }
  }
  // 字体层的问题（缺 ToUnicode、缺字形）转成页面级 warning；用差值避免缓存字体跨页重复计数
  for (const entry of ctx.fontBaseMissing) {
    const font = entry[0];
    if (Array.isArray(font.warnings)) for (const note of font.warnings) CONTENT_warn(ctx, note);
    const now = typeof font.missing === "number" ? font.missing : 0;
    const delta = now - entry[1];
    if (delta > 0) CONTENT_warn(ctx, `字体 ${font.name} 有 ${delta} 个字符码无法映射到 Unicode（已用 U+FFFD 替代）`);
  }
  if (ctx.itemsDropped > 0) CONTENT_warn(ctx, `文本片段过多，已丢弃 ${ctx.itemsDropped} 个（页面可能异常）`);
  return { items: ctx.items, imageCount: ctx.imageCount, formCount: ctx.formCount, warnings: ctx.warnings };
}