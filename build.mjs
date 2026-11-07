#!/usr/bin/env node
/**
 * pdf4oh 单文件构建器（零依赖）。
 *
 * 为什么需要它：OneTHU 的 JS 插件安装形态是「一段 ES 模块文本」（blob import），
 * 不能相对 import、不能引 npm 包。开发时把 PDF 解析拆成多个模块更好维护，发布时
 * 必须合成一个自包含文件。这里只做「去 import / 去 export / 按固定顺序拼接」，
 * 不做作用域改写——因此源码约定（见 CONTRACT.md §2）：
 *
 *   - 只允许单行具名 import：import { a, b } from "./x.js";
 *   - 只允许具名 export（export function/const/class/async function 或 export { a, b };）
 *   - 顶层声明名全局唯一（本脚本静态检查）
 *   - 跨模块调用只发生在函数体/类体/activate 内（拼接后顺序执行，顶层求值不保证顺序）
 *
 * 用法：
 *   node plugins/pdf4oh/build.mjs           # 生成 plugins/pdf4oh/plugin.js
 *   node plugins/pdf4oh/build.mjs --check   # 只校验生成物是否与源码同步（CI/测试用）
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
/** 拼接顺序 = 依赖顺序（被依赖的在前）。新增模块必须登记在这里。 */
const MODULES = [
  // ── PDF 对象层（pdf-core）
  "src/pdf/util.js",
  "src/pdf/inflate.js",
  "src/pdf/filters.js",
  "src/pdf/security.js",
  "src/pdf/lexer.js",
  "src/pdf/xref.js",
  "src/pdf/document.js",
  // ── PDF 文本层（pdf-text）
  "src/pdf/glyphs.js",
  "src/pdf/cmap.js",
  "src/pdf/fonts.js",
  "src/pdf/content.js",
  "src/pdf/text.js",
  // ── 插件层（plugin-shell）
  "src/cache.js",
  "src/learn.js",
  "src/args.js",
  "src/format.js",
  "src/commands.js",
  "src/tab.js",
  "src/index.js",
];

const OUT = "plugin.js";

/** 顶层声明（function/class/const/let/var）名，用来做全局唯一性检查。 */
const DECL_RE = /^(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;
const IMPORT_RE = /^import\s+\{[\s\S]*\}\s+from\s+"[^"]+";?$/;
const EXPORT_BRACE_RE = /^export\s*\{[^}]*\};?\s*$/;
const EXPORT_DECL_RE = /^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/;

function fail(message) {
  console.error(`[build] ${message}`);
  process.exit(1);
}

function stripModule(source, file) {
  const lines = source.split(/\r?\n/);
  const out = [];
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];
    let trimmed = line.trim();
    // 具名 import 允许跨行：把从 import 到 from "..." 的整块拼起来再校验/丢弃
    if (/^import\b/.test(trimmed)) {
      let block = trimmed;
      while (!/from\s+"[^"]+";?\s*$/.test(block) && li + 1 < lines.length) {
        li++;
        block += " " + lines[li].trim();
      }
      const m = /^import\s+\{([\s\S]*?)\}\s+from\s+"([^"]+)"\s*;?$/.exec(block);
      if (!m) fail(`${file}: 只允许具名 import（import { a, b } from "./x.js"），见 CONTRACT.md §2`);
      if (/\bas\b/.test(m[1])) fail(`${file}: 禁止 import 重命名（as）`);
      if (/^import\s+type\b/.test(block)) fail(`${file}: 禁止 import type`);
      continue;
    }
    if (!trimmed) {
      out.push("");
      continue;
    }
    if (EXPORT_BRACE_RE.test(trimmed)) continue;
    if (/^export\s+default\b/.test(trimmed)) fail(`${file}: 禁止 export default（manifest/activate 由构建尾部导出）`);
    if (/\bimport\s*\(/.test(trimmed)) fail(`${file}: 禁止动态 import()`);
    if (/\brequire\s*\(/.test(trimmed)) fail(`${file}: 禁止 require()`);
    out.push(EXPORT_DECL_RE.test(trimmed) ? line.replace(EXPORT_DECL_RE, "") : line);
  }
  return out.join("\n").replace(/^\s+|\s+$/g, "");
}

function collectDeclarations(source, file, seen) {
  for (const line of source.split(/\r?\n/)) {
    if (/^\s/.test(line)) continue; // 只看顶层（不缩进）声明
    const m = DECL_RE.exec(line.trim());
    if (!m) continue;
    const name = m[1];
    if (seen.has(name)) fail(`顶层声明重名：${name}（${seen.get(name)} 与 ${file}）`);
    seen.set(name, file);
  }
}

function build() {
  const seen = new Map();
  const parts = [];
  for (const mod of MODULES) {
    const abs = join(ROOT, mod);
    if (!existsSync(abs)) fail(`缺少模块文件：${mod}（登记在 build.mjs MODULES 里就必须存在）`);
    const raw = readFileSync(abs, "utf8");
    const body = stripModule(raw, mod);
    collectDeclarations(body, mod, seen);
    parts.push(`/* ═══════════ ${mod} ═══════════ */\n${body}`);
  }
  // 必需符号存在性检查（防止模块改名后到运行时才炸）
  for (const required of ["manifest", "activate", "loadPdf", "extractRangeText"]) {
    if (!seen.has(required)) fail(`构建产物缺少必需的顶层声明：${required}`);
  }
  const banner = [
    "/**",
    " * pdf4oh — OneTHU Harness 的课程 PDF 阅读插件（单文件构建产物）",
    " *",
    " * 本文件由 plugins/pdf4oh/build.mjs 从 src/ 生成，请勿手改。",
    " * 源码：plugins/pdf4oh/src/ · 契约：plugins/pdf4oh/CONTRACT.md",
    " * 安装：设置 → 插件 → 安装插件 → 粘贴本文件内容（或从仓库以 plugin.js 安装）。",
    " */",
    `/* 模块顺序：${MODULES.map((m) => relative("src", m.replace(/^src\//, ""))).join(" → ")} */`,
  ].join("\n");
  return `${banner}\n\n${parts.join("\n\n")}\n\nexport { manifest };\nexport default activate;\n`;
}

const next = build();
const outPath = join(ROOT, OUT);
if (process.argv.includes("--check")) {
  if (!existsSync(outPath)) fail(`${OUT} 不存在：先运行 node plugins/pdf4oh/build.mjs`);
  const current = readFileSync(outPath, "utf8");
  if (current !== next) fail(`${OUT} 与 src/ 不同步：运行 node plugins/pdf4oh/build.mjs 重新生成`);
  console.log(`[build] ${OUT} 与源码同步（${next.length} bytes）`);
} else {
  writeFileSync(outPath, next);
  console.log(`[build] 已生成 ${relative(process.cwd(), outPath)}（${next.length} bytes，${MODULES.length} 个模块）`);
}