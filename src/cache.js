/**
 * pdf4oh · 进程内文档缓存（LRU，按字节粗估）。
 *
 * 为什么需要：OH 读一份 PDF 经常分多次（先 info 看页数，再 read 1-6，再 read 7-12，
 * 再 search）。每次重新下载 + 重新解析 40MB 的课件既慢又可能撞上宿主 60 秒桥超时。
 * 这里把「已解析文档 + 已抽取页文本」留在内存里，第二次起只做纯 CPU 的按页抽取。
 *
 * 边界：
 *   - 只用内存，不写 storage（课件正文体积远超 storage 的合理用量，且属隐私数据）；
 *   - 预算默认 24MB（设置可改），只按「原始字节 + 文本 2 倍」粗估，不做精确 GC；
 *   - 超过预算时允许保留**一份**超预算文档（否则 40MB 课件永远缓存不上，每次重下），
 *     从第二份开始淘汰最久未用的条目；
 *   - 插件停用时 dispose 调 clear()，不改动任何持久化状态。
 */

const CACHE_MAX_ENTRIES = 8;

/** 单份文档条目：{ key, name, size, doc, pages: Map<number, PageText>, used, bytesLen } */
export class PdfDocCache {
  constructor(budgetMB) {
    const mb = Number(budgetMB);
    this.budgetBytes = Math.max(4, Number.isFinite(mb) ? mb : 24) * 1024 * 1024;
    /** @type {Map<string, object>} */
    this.entries = new Map();
    this.bytes = 0;
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    entry.used = Date.now();
    // Map 保序：删了再插 = 移到队尾（最近使用）
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits++;
    return entry;
  }

  set(key, entry) {
    if (this.entries.has(key)) this.remove(key);
    entry.used = Date.now();
    this.entries.set(key, entry);
    this.bytes += cacheEntryBytes(entry);
    this.evict();
    return entry;
  }

  /** 取某页文本（没有则调用 producer 抽一次并挂到条目上）。 */
  pageText(entry, page, producer) {
    const cached = entry.pages.get(page);
    if (cached) return cached;
    const text = producer();
    entry.pages.set(page, text);
    this.bytes += cacheTextBytes(text);
    this.evict();
    return text;
  }

  /** 丢弃某条目（例如解析失败或文件更新）。 */
  remove(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.bytes -= cacheEntryBytes(entry);
    return true;
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }

  info() {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      budgetBytes: this.budgetBytes,
      hits: this.hits,
      misses: this.misses,
    };
  }

  evict() {
    while (this.entries.size > 1 && (this.bytes > this.budgetBytes || this.entries.size > CACHE_MAX_ENTRIES)) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }
}

function cacheEntryBytes(entry) {
  // 原始 PDF 字节 + 已抽文本（UTF-16 近似 2 字节/字符）+ 固定开销
  let bytes = (entry.bytesLen || 0) + 64 * 1024;
  for (const pageText of entry.pages.values()) bytes += cacheTextBytes(pageText);
  return bytes;
}

function cacheTextBytes(pageText) {
  return pageText && typeof pageText.text === "string" ? pageText.text.length * 2 + 256 : 256;
}