/**
 * pdf4oh · 插件入口：清单 + 激活。
 *
 * 安装形态是「一段 ES 模块文本」，不能被其它文件 import，所以本文件只做接线：
 *   - 读设置（sanitize 成数字，非法值回默认）；
 *   - 注册四个命令（管理页可点，OH 经 list_plugin_cmds/run_plugin_cmd 调用）；
 *   - 注册插件功能页与作用域样式；
 *   - 返回 dispose：停用/卸载时清缓存（不持久化任何内容）。
 *
 * 权限最小集：learn:read（课程/课件只读）、net:external（旧宿主回退取字节）、
 * ui（命令结果/功能页）、storage（读设置）、css（功能页样式）。无任何写权限。
 */

import { PdfDocCache } from "./cache.js";
import { LearnIndex } from "./learn.js";
import { buildCommandList, handlePluginCommand } from "./commands.js";
import { createPdfTabRenderer, TAB_CSS } from "./tab.js";

const manifest = {
  id: "onethu.pdf4oh",
  name: "pdf4oh · 课程 PDF 阅读",
  version: "0.1.1",
  kind: "js",
  entry: "plugin.js",
  author: "xiao-dreamr",
  repo: "https://github.com/xiao-dreamr/onethu-plugin-pdf4oh",
  announce: true,
  description: "让 OH 读取网络学堂课程文件里的 PDF 正文：按课程/文件名定位课件，抽取带页码的文本，支持页码范围与页内检索。只读，不写任何课程数据；加密 PDF 与扫描件只做识别与提示。 部分 LaTeX 中文 PDF 无 /ToUnicode，会尝试用系统同款字体做字形轮廓匹配还原中文（只读系统字体白名单，需 font:read）。",
  permissions: ["learn:read", "net:external", "font:read", "ui", "storage", "css"],
  settings: [
    {
      key: "maxChars",
      label: "单次最多返回字数（默认 9000，越大越完整也越吃上下文）",
      type: "text",
      default: "9000",
    },
    {
      key: "maxFileMB",
      label: "单个 PDF 大小上限（MB，默认 40）",
      type: "text",
      default: "40",
    },
    {
      key: "cacheMB",
      label: "解析缓存预算（MB，默认 24；同一份 PDF 多次读取不必重下）",
      type: "text",
      default: "24",
    },
    {
      key: "probePages",
      label: "扫描件探测页数（默认 6；info 命令只探测前 N 页）",
      type: "text",
      default: "6",
    },
  ],
};

function pdf4ohIntSetting(raw, key, fallback, min, max) {
  const value = raw && typeof raw === "object" ? raw[key] : undefined;
  const n = Number.parseInt(String(value ?? "").replace(/[^\d]/g, ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 从宿主设置读配置；非法值回默认，保证命令实现里不用再判空。 */
function readPluginConfig(ctx) {
  let raw = {};
  try {
    const api = ctx.onethu && ctx.onethu.settings;
    raw = (api && typeof api.get === "function" ? api.get() : {}) || {};
  } catch {
    raw = {};
  }
  return {
    maxChars: pdf4ohIntSetting(raw, "maxChars", 9000, 800, 40000),
    maxFileMB: pdf4ohIntSetting(raw, "maxFileMB", 40, 1, 64),
    cacheMB: pdf4ohIntSetting(raw, "cacheMB", 24, 4, 128),
    probePages: pdf4ohIntSetting(raw, "probePages", 6, 1, 50),
  };
}

const PDF4OH_TAB_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 1.8h5.2L12.5 5v9.2H4z"/><path d="M9 1.8V5h3.4"/><path d="M6 8h4.2M6 10.4h4.2M6 12.6h2.6"/></svg>';

async function activate(ctx) {
  const cfg = readPluginConfig(ctx);
  const cache = new PdfDocCache(cfg.cacheMB);
  const index = new LearnIndex(ctx);
  const deps = { ctx, cfg, cache, index };

  for (const cmd of buildCommandList(deps)) {
    ctx.registerCommand(
      {
        id: cmd.id,
        title: cmd.title,
        inputLabel: cmd.inputLabel,
        inputPlaceholder: cmd.inputPlaceholder,
      },
      (input) => handlePluginCommand(deps, cmd.id, input),
    );
  }

  // 功能页与样式是可选增强：宿主旧版本/权限不足时不影响命令可用
  try {
    const ui = ctx.onethu && ctx.onethu.ui;
    if (ui && typeof ui.onTabReady === "function") {
      ctx.registerTab({ id: "main", title: "PDF 课件", iconSvg: PDF4OH_TAB_ICON });
      const renderer = createPdfTabRenderer(deps);
      ui.onTabReady("plugin:onethu.pdf4oh:main", (root) => {
        void renderer.render(root).catch((err) => {
          root.textContent = `pdf4oh 页面渲染失败：${err && err.message ? err.message : String(err)}`;
        });
      });
      if (typeof ctx.registerCss === "function") ctx.registerCss(TAB_CSS);
    }
  } catch (err) {
    try {
      ctx.log(`[pdf4oh] 功能页注册失败（命令不受影响）：${err && err.message ? err.message : String(err)}`);
    } catch {
      /* 日志都失败就算了，不能因为可选 UI 影响命令 */
    }
  }

  try {
    ctx.log(
      `[pdf4oh] 已激活 v${manifest.version}：maxChars=${cfg.maxChars} maxFileMB=${cfg.maxFileMB} cacheMB=${cfg.cacheMB}`,
    );
  } catch {
    /* 日志失败不影响插件 */
  }

  return {
    dispose() {
      cache.clear();
      index.reset();
    },
  };
}