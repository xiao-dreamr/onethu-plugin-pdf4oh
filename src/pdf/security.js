/**
 * pdf4oh · 加密 PDF 的识别与占位（CONTRACT §4）。
 *
 * 职责与边界：
 *   - 只做「识别 + 给出可读错误 + 预留解密入口」；本期 v1 不实现解密，也不去猜
 *     用户口令。加密判定看 trailer 是否出现 /Encrypt（间接引用也算）。
 *   - 所有函数纯同步、不抛非 PdfError；不修改文档状态。
 *
 * 为什么单独成文件：加密判定要在解析 trailer 之后、建对象表之前短路（否则读到的
 * 流字节是密文，解压会得到垃圾并刷一堆 warning），集中在这里便于以后插解密实现。
 */

import { pdfError, dictGet, isName, isDict, numOr } from "./util.js";

/** 给用户看的加密提示（命令层会原样展示，不要暴露内部细节）。 */
const SEC_ENCRYPTED_MESSAGE = "这份 PDF 已加密（需要打开密码），当前版本暂不支持解密，暂时读不到正文。";

/** trailer（Map 或 dict）里是否有 /Encrypt。 */
export function isEncryptedTrailer(trailer) {
  if (!trailer) return false;
  if (trailer instanceof Map) return trailer.has("Encrypt") && trailer.get("Encrypt") != null;
  if (isDict(trailer)) return trailer.m.has("Encrypt") && trailer.m.get("Encrypt") != null;
  return false;
}

/**
 * 从 /Encrypt 字典里抽取「足以向用户解释」的信息，不解析密钥。
 * 返回 null 表示不是加密文档。
 */
export function describeEncryption(trailer, doc) {
  if (!isEncryptedTrailer(trailer)) return null;
  const raw = trailer instanceof Map ? trailer.get("Encrypt") : trailer.m.get("Encrypt");
  const enc = doc && typeof doc.resolve === "function" ? doc.resolve(raw) : raw;
  const dict = enc instanceof Map ? enc : isDict(enc) ? enc.m : null;
  if (!dict) return { filter: null, v: null, r: null, length: null, hasCryptFilter: false };
  const filterValue = dictGet(dict, "Filter");
  const filter = isName(filterValue) ? filterValue.v : null;
  return {
    filter,
    v: numOr(dictGet(dict, "V"), null),
    r: numOr(dictGet(dict, "R"), null),
    length: numOr(dictGet(dict, "Length"), null),
    hasCryptFilter: dict.has("CryptFilter") || dict.has("CF") || dict.has("StmF"),
  };
}

/** 构造 PdfError("encrypted")，附带机器可读的 encryption 信息。 */
export function encryptionError(trailer, doc) {
  const info = describeEncryption(trailer, doc);
  let detail = "";
  if (info && info.filter) {
    detail = "（算法 " + info.filter + (info.v != null ? "，V=" + info.v : "") + "）";
  }
  const error = pdfError("encrypted", SEC_ENCRYPTED_MESSAGE + detail);
  error.encryption = info;
  return error;
}

/**
 * TODO(decrypt)：后续版本的解密入口。
 *
 * 计划：实现 Standard Security Handler（RC4 40/128 位与 AES-128/256），流程为
 *   1) 用 /Encrypt 的 /O /U /P /ID 校验用户口令（空口令是常见情况）；
 *   2) 由 /StmF /StrF 指向的 CryptFilter 生成对象级密钥；
 *   3) 对流/字符串按对象号与代数解密后再交给 filters.js。
 * 现在显式抛 unsupported，避免静默返回密文被当成正文。
 */
export function decryptPdfObject() {
  throw pdfError("unsupported", "PDF 解密尚未实现（当前版本只支持未加密文档）");
}

/** 供 loadPdf 使用的统一入口：命中 /Encrypt 就抛加密错误。 */
export function assertNotEncrypted(trailer, doc) {
  if (!isEncryptedTrailer(trailer)) return;
  if (doc) doc.encrypted = true;
  throw encryptionError(trailer, doc);
}