/**
 * pdf4oh · 插件功能页（「PDF 课件」）。
 *
 * 为什么要一个页面：OH 的命令是给模型用的；人想自己翻课件时，管理页点命令太别扭。
 * 这里是同一套取数/解析能力的只读 UI：选课程 → 选 PDF → 按页读文本/搜关键词。
 *
 * 约束：
 *   - 容器由宿主 React 布局提供，插件只在容器内渲染；注册的 CSS 一律 [data-plg="pdf4oh"] 前缀；
 *   - 渲染必须幂等：onTabReady 可能多次触发，先清空再挂；
 *   - 用户数据（课程名/文件名/PDF 正文）一律 textContent，绝不拼 innerHTML（防注入）；
 *   - 页面操作只读，不写课程数据；失败显示人话，不弹异常栈。
 */

import { loadPdf } from "./pdf/document.js";
import { extractRangeText, searchDocument } from "./pdf/text.js";
import { formatError, formatHostError } from "./format.js";
import { fetchLearnPdfBytes, isPdfLearnFile } from "./learn.js";

export const TAB_PAGE_CHUNK = 3;
export const TAB_CSS = `
[data-plg="pdf4oh"] .pdf4oh-root { display: flex; gap: 12px; height: 100%; min-height: 320px; padding: 12px; box-sizing: border-box; }
[data-plg="pdf4oh"] .pdf4oh-side { width: 260px; flex: none; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
[data-plg="pdf4oh"] .pdf4oh-main { flex: 1; display: flex; flex-direction: column; gap: 8px; min-width: 0; min-height: 0; }
[data-plg="pdf4oh"] .pdf4oh-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
[data-plg="pdf4oh"] .pdf4oh-title { font-weight: 650; font-size: 15px; color: var(--text-1); }
[data-plg="pdf4oh"] .pdf4oh-hint { font-size: 12px; color: var(--text-3); line-height: 1.5; }
[data-plg="pdf4oh"] .pdf4oh-list { flex: 1; overflow: auto; border: 1px solid var(--border); border-radius: 10px; min-height: 120px; }
[data-plg="pdf4oh"] .pdf4oh-file { display: block; width: 100%; text-align: left; padding: 8px 10px; border: 0; border-bottom: 1px solid var(--border-soft); background: transparent; color: var(--text-1); font: inherit; cursor: pointer; }
[data-plg="pdf4oh"] .pdf4oh-file:hover { background: var(--hover); }
[data-plg="pdf4oh"] .pdf4oh-file[data-active="1"] { background: var(--accent-soft, var(--hover)); }
[data-plg="pdf4oh"] .pdf4oh-file small { display: block; color: var(--text-3); font-size: 11px; margin-top: 2px; }
[data-plg="pdf4oh"] input.pdf4oh-search, [data-plg="pdf4oh"] select.pdf4oh-select { font: inherit; color: var(--text-1); background: var(--surface-2, var(--surface)); border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; min-width: 0; }
[data-plg="pdf4oh"] button.pdf4oh-btn { font: inherit; color: var(--text-1); background: var(--surface-2, var(--surface)); border: 1px solid var(--border); border-radius: 8px; padding: 5px 10px; cursor: pointer; }
[data-plg="pdf4oh"] button.pdf4oh-btn:hover { background: var(--hover); }
[data-plg="pdf4oh"] button.pdf4oh-btn:disabled { opacity: .5; cursor: default; }
[data-plg="pdf4oh"] .pdf4oh-view { flex: 1; overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; line-height: 1.65; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 10px; min-height: 160px; color: var(--text-1); }
[data-plg="pdf4oh"] .pdf4oh-error { color: var(--red, #c0392b); }
@media (max-width: 720px) {
  [data-plg="pdf4oh"] .pdf4oh-root { flex-direction: column; height: auto; }
  [data-plg="pdf4oh"] .pdf4oh-side { width: auto; }
  [data-plg="pdf4oh"] .pdf4oh-list { max-height: 180px; }
}
`;

function tabEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = String(text);
  return el;
}

/** 创建一个页面渲染器（状态跟着插件激活周期走，不跟 DOM 重建走）。 */
export function createPdfTabRenderer(deps) {
  const state = {
    courses: [],
    files: [],
    courseId: "",
    entry: null,
    activeFile: null,
    cursor: 1,
    busy: false,
    query: "",
    requestId: 0,
  };

  async function render(root) {
    state.requestId += 1;
    const requestId = state.requestId;
    root.replaceChildren();
    root.dataset.plg = "pdf4oh";
    const wrap = tabEl("div", "pdf4oh-root");
    root.appendChild(wrap);

    const side = tabEl("div", "pdf4oh-side");
    const main = tabEl("div", "pdf4oh-main");
    wrap.append(side, main);

    side.append(
      tabEl("div", "pdf4oh-title", "课程 PDF"),
      tabEl("div", "pdf4oh-hint", "只读浏览网络学堂课程文件里的 PDF 文本；图片/扫描件没有文本层。"),
    );

    const courseRow = tabEl("div", "pdf4oh-row");
    const courseSelect = tabEl("select", "pdf4oh-select");
    courseSelect.setAttribute("aria-label", "选择课程");
    courseRow.appendChild(courseSelect);
    const refresh = tabEl("button", "pdf4oh-btn", "刷新");
    refresh.type = "button";
    courseRow.appendChild(refresh);
    side.appendChild(courseRow);

    const list = tabEl("div", "pdf4oh-list");
    side.appendChild(list);

    const view = tabEl("div", "pdf4oh-view", "先选一门课程，再点一份 PDF。");
    main.appendChild(view);

    const actions = tabEl("div", "pdf4oh-row");
    const readMore = tabEl("button", "pdf4oh-btn", "继续读 3 页");
    readMore.type = "button";
    readMore.disabled = true;
    const searchInput = tabEl("input", "pdf4oh-search");
    searchInput.type = "search";
    searchInput.placeholder = "在本 PDF 内搜关键词…";
    const searchBtn = tabEl("button", "pdf4oh-btn", "搜索");
    searchBtn.type = "button";
    const status = tabEl("span", "pdf4oh-hint");
    actions.append(readMore, searchInput, searchBtn, status);
    main.appendChild(actions);

    function setStatus(text, isError = false) {
      status.textContent = text;
      status.classList.toggle("pdf4oh-error", isError);
    }

    function setBusy(busy) {
      state.busy = busy;
      readMore.disabled = busy || !state.entry;
      searchBtn.disabled = busy || !state.entry;
      refresh.disabled = busy;
    }

    function fillCourses() {
      const keep = state.courseId;
      courseSelect.replaceChildren();
      for (const course of state.courses) {
        const option = tabEl("option", "", course.name);
        option.value = course.id;
        courseSelect.appendChild(option);
      }
      if (keep && state.courses.some((c) => c.id === keep)) courseSelect.value = keep;
      else if (state.courses.length) courseSelect.value = state.courses[0].id;
      state.courseId = courseSelect.value;
    }

    function fillFiles() {
      list.replaceChildren();
      if (!state.files.length) {
        list.appendChild(tabEl("div", "pdf4oh-hint", "这门课没有 PDF 课件。"));
        return;
      }
      for (const file of state.files) {
        const btn = tabEl("button", "pdf4oh-file", file.title);
        btn.type = "button";
        if (state.activeFile && state.activeFile.id === file.id) btn.dataset.active = "1";
        const meta = [file.size, file.uploadTime].filter(Boolean).join(" · ");
        if (meta) btn.appendChild(tabEl("small", "", meta));
        btn.addEventListener("click", () => void openFile(file));
        list.appendChild(btn);
      }
    }

    async function loadCourses() {
      setBusy(true);
      try {
        const index = await deps.index.load(true);
        state.courses = index.courses;
        fillCourses();
        await loadFiles();
      } catch (err) {
        setStatus("课程列表加载失败：" + formatHostError(err), true);
      } finally {
        setBusy(false);
      }
    }

    async function loadFiles() {
      const courseId = courseSelect.value;
      state.courseId = courseId;
      state.activeFile = null;
      state.entry = null;
      state.cursor = 1;
      readMore.disabled = true;
      list.replaceChildren(tabEl("div", "pdf4oh-hint", "加载中…"));
      try {
        const index = await deps.index.load();
        const files = (index.byCourse.get(courseId) ?? []).filter(isPdfLearnFile);
        state.files = files;
        fillFiles();
        view.textContent = files.length ? "选一份 PDF 开始阅读。" : "这门课没有 PDF 课件。";
      } catch (err) {
        list.replaceChildren(tabEl("div", "pdf4oh-hint", "课件列表加载失败。"));
        setStatus(formatHostError(err), true);
      }
    }

    async function openFile(file) {
      state.requestId += 1;
      const requestId = state.requestId;
      state.activeFile = file;
      state.entry = null;
      state.cursor = 1;
      fillFiles();
      setBusy(true);
      setStatus("下载/解析中…");
      view.textContent = "正在下载并解析 PDF…";
      try {
        const cacheKey = `learn:${file.id}`;
        let entry = deps.cache.get(cacheKey);
        if (!entry) {
          const { bytes } = await fetchLearnPdfBytes(deps.ctx, file, {
            maxBytes: deps.cfg.maxFileMB * 1024 * 1024,
          });
          const doc = loadPdf(bytes, { maxBytes: deps.cfg.maxFileMB * 1024 * 1024 });
          entry = { key: cacheKey, name: file.title, size: bytes.length, bytesLen: bytes.length, doc, pages: new Map() };
          deps.cache.set(cacheKey, entry);
        }
        if (requestId !== state.requestId) return;
        state.entry = entry;
        setStatus(`共 ${entry.doc.pageCount} 页`);
        await readPages(1, Math.min(TAB_PAGE_CHUNK, entry.doc.pageCount));
      } catch (err) {
        if (requestId !== state.requestId) return;
        view.textContent = "";
        view.classList.add("pdf4oh-error");
        view.textContent = err && typeof err.code === "string" ? formatError(err) : formatHostError(err);
        setStatus("打开失败", true);
      } finally {
        if (requestId === state.requestId) setBusy(false);
      }
    }

    async function readPages(from, to) {
      if (!state.entry) return;
      setBusy(true);
      view.classList.remove("pdf4oh-error");
      try {
        const result = extractRangeText(state.entry.doc, { from, to, maxChars: deps.cfg.maxChars * 2 });
        for (const page of result.pages) deps.cache.pageText(state.entry, page.page, () => page);
        const lines = [];
        for (const page of result.pages) {
          lines.push(`── 第 ${page.page} 页 ──`);
          lines.push(page.text || "（本页没有可抽取的文本层）");
          lines.push("");
        }
        view.textContent = lines.join("\n");
        state.cursor = result.to + 1;
        readMore.disabled = state.cursor > state.entry.doc.pageCount;
        setStatus(`已显示第 ${result.from}–${result.to} 页 / 共 ${state.entry.doc.pageCount} 页`);
      } catch (err) {
        setStatus(formatHostError(err), true);
      } finally {
        setBusy(false);
      }
    }

    async function runSearch() {
      const query = searchInput.value.trim();
      if (!state.entry || !query) return;
      state.query = query;
      setBusy(true);
      view.classList.remove("pdf4oh-error");
      try {
        const result = searchDocument(state.entry.doc, { query, maxHits: 30, contextChars: 80 });
        if (!result.hits.length) {
          view.textContent = `没有命中「${query}」。`;
          setStatus("0 处命中");
          return;
        }
        const lines = [`检索「${query}」：${result.totalHits} 处`];
        for (const hit of result.hits) {
          lines.push("", `── 第 ${hit.page} 页 ──`, hit.text);
        }
        view.textContent = lines.join("\n");
        setStatus(`${result.totalHits} 处命中`);
      } catch (err) {
        setStatus(formatHostError(err), true);
      } finally {
        setBusy(false);
      }
    }

    courseSelect.addEventListener("change", () => void loadFiles());
    refresh.addEventListener("click", () => void loadCourses());
    readMore.addEventListener("click", () => {
      if (!state.entry) return;
      const from = state.cursor;
      const to = Math.min(from + TAB_PAGE_CHUNK - 1, state.entry.doc.pageCount);
      if (from <= state.entry.doc.pageCount) void readPages(from, to);
    });
    searchBtn.addEventListener("click", () => void runSearch());
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void runSearch();
    });

    await loadCourses();
  }

  return { render };
}