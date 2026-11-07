/**
 * pdf4oh 单元测试用的最小 PDF 构造器。
 *
 * 这里不是测试文件（不以 .test.mjs 结尾）：只提供「手写 PDF 语法」的 helper，
 * 让 core 测试不依赖仓库外的真实语料。只用 node:zlib 生成 deflate 数据。
 */

import { deflateSync } from "node:zlib";

/** 字符串 → Latin-1 字节（PDF 语法层用；不要用 UTF-8，否则多字节会破坏结构）。 */
export function latin1(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** string | Uint8Array | number[] | 它们的数组 → Uint8Array。 */
export function toBytes(value) {
  if (typeof value === "string") return latin1(value);
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) {
    const parts = value.map(toBytes);
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
  throw new Error("toBytes: 不支持的类型 " + typeof value);
}

export function concatBytes(...parts) {
  return toBytes(parts);
}

/** 十进制左补零（xref 偏移/代数格式）。 */
export function pad10(value) {
  return String(value).padStart(10, "0");
}

export function pad5(value) {
  return String(value).padStart(5, "0");
}

/** trailer 字典文本：值一律按 PDF 语法原样拼（"1 0 R" / 数字 / 名字）。 */
export function dictText(entries) {
  const parts = [];
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === null) continue;
    parts.push("/" + key + " " + String(value));
  }
  return parts.join(" ");
}

/** 构造 stream 对象的 body：[字典文本, "stream\n", 数据, "\nendstream"]。 */
export function streamBody(data, opts = {}) {
  const bytes = toBytes(data);
  const dict = { Length: bytes.length, ...(opts.dict || {}) };
  const filter = opts.filter;
  const parms = opts.parms;
  if (filter) dict.Filter = typeof filter === "string" ? "/" + filter : filter;
  if (parms) dict.DecodeParms = parms;
  return [latin1("<< " + dictText(dict) + " >>\nstream\n"), bytes, latin1("\nendstream")];
}

/** 找最后一个 startxref 后面的数字（增量更新用）。 */
export function findLastStartxref(bytes) {
  const text = Buffer.from(bytes).toString("latin1");
  const at = text.lastIndexOf("startxref");
  if (at < 0) return null;
  const match = /startxref\s+(\d+)/.exec(text.slice(at));
  return match ? Number(match[1]) : null;
}

/**
 * 经典 xref 表 + trailer 的 PDF。
 * @param {Array<[number, any]>} objects  [对象号, body]（body 可为字符串/字节/数组）
 * @param {{header?: string, root?: string, trailer?: object, size?: number, junkBefore?: string}} [opts]
 */
export function makePdf(objects, opts = {}) {
  const parts = [];
  let pos = 0;
  const push = (value) => {
    const bytes = toBytes(value);
    parts.push(bytes);
    pos += bytes.length;
  };
  if (opts.junkBefore) push(opts.junkBefore);
  push(opts.header || "%PDF-1.7\n");
  const offsets = new Map();
  let maxNum = 1;
  for (const [num, body] of objects) {
    offsets.set(num, pos);
    maxNum = Math.max(maxNum, num);
    push(`${num} 0 obj\n`);
    push(body);
    push("\nendobj\n");
  }
  const root = opts.root || "1 0 R";
  const size = opts.size || maxNum + 1;
  const xrefPos = pos;
  push(`xref\n0 1\n${pad10(0)} ${pad5(65535)} f \n`);
  for (const num of [...offsets.keys()].sort((a, b) => a - b)) {
    push(`${num} 1\n${pad10(offsets.get(num))} ${pad5(0)} n \n`);
  }
  const trailer = dictText({ Size: size, Root: root, ...(opts.trailer || {}) });
  push(`trailer\n<< ${trailer} >>\nstartxref\n${xrefPos}\n%%EOF\n`);
  return concatBytes(parts);
}

/** 把第 n 个对象的 body 换掉（重建一份新 PDF），用于「增量更新」测试的底座。 */
export function withObjectBody(objects, num, body) {
  return objects.map(([n, b]) => [n, n === num ? body : b]);
}

/** 追加增量更新：新对象 + 新 xref 段（/Prev 指向旧 startxref）。 */
export function appendIncremental(base, newObjects, opts = {}) {
  const parts = [toBytes(base)];
  let pos = base.length;
  const offsets = new Map();
  for (const [num, body] of newObjects) {
    offsets.set(num, pos);
    const chunk = concatBytes(`${num} 0 obj\n`, body, "\nendobj\n");
    parts.push(chunk);
    pos += chunk.length;
  }
  const xrefPos = pos;
  const oldStart = findLastStartxref(base) || 0;
  parts.push(`xref\n0 1\n${pad10(0)} ${pad5(65535)} f \n`);
  for (const num of [...offsets.keys()].sort((a, b) => a - b)) {
    parts.push(`${num} 1\n${pad10(offsets.get(num))} ${pad5(0)} n \n`);
  }
  const trailer = dictText({
    Size: opts.size || 100,
    Root: opts.root || "1 0 R",
    Prev: oldStart,
    ...(opts.trailer || {}),
  });
  parts.push(`trailer\n<< ${trailer} >>\nstartxref\n${xrefPos}\n%%EOF\n`);
  return concatBytes(parts);
}

/** 大端写入 width 字节。 */
export function writeBigEndian(target, at, value, width) {
  for (let i = width - 1; i >= 0; i--) {
    target[at + i] = value & 0xff;
    value = Math.floor(value / 256);
  }
}

/** PNG predictor 编码（只测行过滤器 2 = Up），columns 为每行字节数。 */
export function pngEncodeRows(rows, columns) {
  const out = new Uint8Array(rows.length * (columns + 1));
  let prev = new Uint8Array(columns);
  let at = 0;
  for (const row of rows) {
    out[at++] = 2; // Up
    for (let i = 0; i < columns; i++) out[at++] = (row[i] - prev[i]) & 0xff;
    prev = row;
  }
  return out;
}

/**
 * /XRef 流形式的 PDF（所有对象都在普通对象里）。
 * @param {Array<[number, any]>} objects
 * @param {{addObjectStm?: boolean, root?: string, predictor?: boolean, extraTrailer?: string}} [opts]
 */
export function makeXrefStreamPdf(objects, opts = {}) {
  const parts = [];
  let pos = 0;
  const push = (value) => {
    const bytes = toBytes(value);
    parts.push(bytes);
    pos += bytes.length;
  };
  push(opts.header || "%PDF-1.7\n");
  const offsets = new Map();
  let maxNum = 1;
  for (const [num, body] of objects) {
    offsets.set(num, pos);
    maxNum = Math.max(maxNum, num);
    push(`${num} 0 obj\n`);
    push(body);
    push("\nendobj\n");
  }
  const xrefNum = maxNum + 1;
  const size = xrefNum + 1;
  const xrefOffset = pos;
  const W = [1, 4, 2];
  const rowBytes = W[0] + W[1] + W[2];
  const rows = [];
  const row = (type, field2, field3) => {
    const out = new Uint8Array(rowBytes);
    writeBigEndian(out, 0, type, W[0]);
    writeBigEndian(out, W[0], field2, W[1]);
    writeBigEndian(out, W[0] + W[1], field3, W[2]);
    return out;
  };
  rows.push(row(0, 0, 65535));
  for (let num = 1; num <= xrefNum; num++) {
    if (num === xrefNum) rows.push(row(1, xrefOffset, 0));
    else if (offsets.has(num)) rows.push(row(1, offsets.get(num), 0));
    else rows.push(row(0, 0, 0));
  }
  let raw = concatBytes(rows);
  let filterText = "";
  if (opts.predictor) {
    const encoded = pngEncodeRows(rows, rowBytes);
    raw = deflateSync(encoded);
    filterText = " /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns " + rowBytes + " >>";
  } else {
    raw = deflateSync(raw);
    filterText = " /Filter /FlateDecode";
  }
  push(
    `${xrefNum} 0 obj\n<< /Type /XRef /Size ${size} /W [${W.join(" ")}] /Root ${
      opts.root || "1 0 R"
    } /Length ${raw.length}${filterText}${opts.extraTrailer || ""} >>\nstream\n`,
  );
  push(raw);
  push("\nendstream\nendobj\n");
  push(`startxref\n${xrefOffset}\n%%EOF\n`);
  return concatBytes(parts);
}

/**
 * 带 /ObjStm 的 PDF：compressedNums 里的对象放进一个对象流，其余正常存放，
 * 用 /XRef 流记录 type=2 条目。
 * @param {Array<[number, any]>} objects
 * @param {Set<number>} compressedNums
 * @param {{root?: string, predictor?: boolean}} [opts]
 */
export function makeObjStmPdf(objects, compressedNums, opts = {}) {
  const normal = objects.filter(([num]) => !compressedNums.has(num));
  const compressed = objects.filter(([num]) => compressedNums.has(num));
  const bodies = compressed.map(([, body]) => toBytes(body));
  const pairs = [];
  let contentOffset = 0;
  for (let i = 0; i < compressed.length; i++) {
    pairs.push(`${compressed[i][0]} ${contentOffset}`);
    contentOffset += bodies[i].length + 1;
  }
  const headerText = pairs.join(" ") + "\n";
  const headerBytes = latin1(headerText);
  const dataParts = [headerBytes];
  for (let i = 0; i < bodies.length; i++) {
    dataParts.push(bodies[i]);
    dataParts.push(latin1("\n"));
  }
  const objStmData = concatBytes(dataParts);
  const first = headerBytes.length;
  const objStmRaw = deflateSync(objStmData);

  const parts = [];
  let pos = 0;
  const push = (value) => {
    const bytes = toBytes(value);
    parts.push(bytes);
    pos += bytes.length;
  };
  push(opts.header || "%PDF-1.7\n");
  const offsets = new Map();
  let maxNum = 1;
  for (const [num, body] of normal) {
    offsets.set(num, pos);
    maxNum = Math.max(maxNum, num);
    push(`${num} 0 obj\n`);
    push(body);
    push("\nendobj\n");
  }
  const objStmNum = Math.max(maxNum, ...compressed.map(([n]) => n)) + 1;
  const objStmOffset = pos;
  push(
    `${objStmNum} 0 obj\n<< /Type /ObjStm /N ${compressed.length} /First ${first} /Length ${objStmRaw.length} /Filter /FlateDecode >>\nstream\n`,
  );
  push(objStmRaw);
  push("\nendstream\nendobj\n");
  const xrefNum = objStmNum + 1;
  const xrefOffset = pos;
  const size = xrefNum + 1;
  const W = [1, 4, 2];
  const rowBytes = W[0] + W[1] + W[2];
  const makeRow = (type, field2, field3) => {
    const out = new Uint8Array(rowBytes);
    writeBigEndian(out, 0, type, W[0]);
    writeBigEndian(out, W[0], field2, W[1]);
    writeBigEndian(out, W[0] + W[1], field3, W[2]);
    return out;
  };
  const rows = [makeRow(0, 0, 65535)];
  for (let num = 1; num <= xrefNum; num++) {
    if (num === xrefNum) rows.push(makeRow(1, xrefOffset, 0));
    else if (num === objStmNum) rows.push(makeRow(1, objStmOffset, 0));
    else if (offsets.has(num)) rows.push(makeRow(1, offsets.get(num), 0));
    else {
      const idx = compressed.findIndex(([n]) => n === num);
      if (idx >= 0) rows.push(makeRow(2, objStmNum, idx));
      else rows.push(makeRow(0, 0, 0));
    }
  }
  let raw = deflateSync(concatBytes(rows));
  let filterText = " /Filter /FlateDecode";
  if (opts.predictor) {
    raw = deflateSync(pngEncodeRows(rows, rowBytes));
    filterText = " /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns " + rowBytes + " >>";
  }
  push(
    `${xrefNum} 0 obj\n<< /Type /XRef /Size ${size} /W [${W.join(" ")}] /Root ${
      opts.root || "1 0 R"
    } /Length ${raw.length}${filterText} >>\nstream\n`,
  );
  push(raw);
  push("\nendstream\nendobj\n");
  push(`startxref\n${xrefOffset}\n%%EOF\n`);
  return concatBytes(parts);
}

/**
 * 混合文件：经典 xref 只覆盖普通对象，/XRefStm 指向 xref 流补充压缩对象。
 * @param {Array<[number, any]>} objects 普通对象
 * @param {{root?: string, extraObjects?: Array<[number, any]>}} [opts]
 */
export function makeHybridPdf(objects, opts = {}) {
  const parts = [];
  let pos = 0;
  const push = (value) => {
    const bytes = toBytes(value);
    parts.push(bytes);
    pos += bytes.length;
  };
  push("%PDF-1.7\n");
  const offsets = new Map();
  let maxNum = 1;
  for (const [num, body] of objects) {
    offsets.set(num, pos);
    maxNum = Math.max(maxNum, num);
    push(`${num} 0 obj\n`);
    push(body);
    push("\nendobj\n");
  }
  // 额外对象（例如对象流里的对象 9）只通过 /XRefStm 登记
  const extraObjects = opts.extraObjects || [];
  const extraOffsets = new Map();
  for (const [num, body] of extraObjects) {
    extraOffsets.set(num, pos);
    maxNum = Math.max(maxNum, num);
    push(`${num} 0 obj\n`);
    push(body);
    push("\nendobj\n");
  }
  const xrefStmNum = maxNum + 1;
  const xrefStmOffset = pos;
  const W = [1, 4, 2];
  const rowBytes = W[0] + W[1] + W[2];
  const makeRow = (type, field2, field3) => {
    const out = new Uint8Array(rowBytes);
    writeBigEndian(out, 0, type, W[0]);
    writeBigEndian(out, W[0], field2, W[1]);
    writeBigEndian(out, W[0] + W[1], field3, W[2]);
    return out;
  };
  const rows = [];
  for (const [num, offset] of extraOffsets) {
    const out = makeRow(1, offset, 0);
    const out2 = new Uint8Array(rowBytes);
    out2.set(out);
    rows.push([num, out2]);
  }
  // 用 /Index [num 1] 逐项登记，简单起见把 xref 流自身也写进去
  const indexPairs = [];
  const dataChunks = [];
  const sorted = [...extraOffsets.keys()].sort((a, b) => a - b);
  for (const num of sorted) {
    indexPairs.push(num, 1);
    dataChunks.push(makeRow(1, extraOffsets.get(num), 0));
  }
  indexPairs.push(xrefStmNum, 1);
  dataChunks.push(makeRow(1, xrefStmOffset, 0));
  const raw = deflateSync(concatBytes(dataChunks));
  push(
    `${xrefStmNum} 0 obj\n<< /Type /XRef /Size ${xrefStmNum + 1} /W [${W.join(" ")}] /Index [${indexPairs.join(
      " ",
    )}] /Root ${opts.root || "1 0 R"} /Length ${raw.length} /Filter /FlateDecode >>\nstream\n`,
  );
  push(raw);
  push("\nendstream\nendobj\n");
  const xrefPos = pos;
  push(`xref\n0 1\n${pad10(0)} ${pad5(65535)} f \n`);
  for (const num of [...offsets.keys()].sort((a, b) => a - b)) {
    push(`${num} 1\n${pad10(offsets.get(num))} ${pad5(0)} n \n`);
  }
  push(
    `trailer\n<< /Size ${xrefStmNum + 1} /Root ${opts.root || "1 0 R"} /XRefStm ${xrefStmOffset} >>\nstartxref\n${xrefPos}\n%%EOF\n`,
  );
  return concatBytes(parts);
}

/** 把 startxref 的数字改坏（用于重建测试）。 */
export function corruptStartxref(bytes) {
  const copy = new Uint8Array(bytes);
  const text = Buffer.from(copy).toString("latin1");
  const at = text.lastIndexOf("startxref");
  const match = /startxref\s+(\d+)/.exec(text.slice(at));
  const numberAt = at + "startxref".length + (text.slice(at + 9).match(/^\s+/) || [""])[0].length;
  const replacement = String(999999999);
  const padded = replacement.padEnd(match[1].length, " ").slice(0, match[1].length);
  for (let i = 0; i < padded.length; i++) copy[numberAt + i] = padded.charCodeAt(i);
  return copy;
}

/** 带 /Encrypt 的最小 PDF（v1 只要求能识别并拒绝）。 */
export function makeEncryptedPdf() {
  return makePdf(
    [
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
      [3, "<< /Type /Page /Parent 2 0 R >>"],
      [4, "<< /Filter /Standard /V 1 /R 2 /Length 40 /O <00> /U <00> /P -4 >>"],
    ],
    { trailer: { Encrypt: "4 0 R", ID: "[<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]" } },
  );
}

/** 一份含 1 页、内容流为 Flate 的简单 PDF。 */
export function makeSimplePdf(content = "BT (hello) Tj ET") {
  const data = deflateSync(toBytes(content));
  return makePdf([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 200 100] >>"],
    [3, "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"],
    [4, streamBody(data, { filter: "FlateDecode" })],
    [5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
  ]);
}