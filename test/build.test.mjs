/**
 * pdf4oh · 构建产物守门。
 *
 * 检查的是「用户实际安装的那段文本」，不是 src：
 *   1) plugin.js 必须与 src 同步（build.mjs --check）；
 *   2) plugin.js 必须是自包含 ES 模块（无 import/require/动态 import、可被 Node import）；
 *   3) manifest 与 manifest.json 一致、权限最小集、命令可注册、dispose 可调用；
 *   4) 激活过程不得依赖 DOM（用纯对象假 ctx 激活，Node 里没 document）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN_JS = join(ROOT, "plugin.js");
const MANIFEST_JSON = join(ROOT, "manifest.json");

const ALLOWED_PERMISSIONS = new Set(["learn:read", "net:external", "ui", "storage", "css", "font:read"]);

function fakeCtx(commands, tabs, css) {
  const ctx = {
    log() {},
    registerCommand(cmd, run) {
      commands.push({ cmd, run });
    },
    registerTab(tab) {
      tabs.push(tab);
    },
    registerCss(text) {
      css.push(text);
    },
    registerAtom() {},
    registerWidget() {},
    onethu: {
      settings: { get: () => ({}) },
      ui: {
        onTabReady() {
          return () => {};
        },
        toast() {},
      },
      learn: {
        courses: async () => ({ semester: "s", courses: [] }),
        files: async () => [],
        fileContent: async () => {
          throw new Error("no files in build test");
        },
      },
      net: { fetch: async () => new Response("", { status: 404 }) },
    },
  };
  return ctx;
}

test("build.mjs --check：plugin.js 与 src 同步", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "build.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, `构建产物不同步：\n${r.stdout}\n${r.stderr}`);
});

test("plugin.js 存在且是自包含 ES 模块", () => {
  assert.ok(existsSync(PLUGIN_JS), "plugin.js 不存在：先运行 node plugins/pdf4oh/build.mjs");
  const code = readFileSync(PLUGIN_JS, "utf8");
  assert.ok(code.length > 1000, "plugin.js 太小，构建可能失败");
  assert.ok(code.length < 600 * 1024, "plugin.js 过大（>600KB），检查是否误打包了别的东西");
  assert.doesNotMatch(code, /(^|[^.\w])import\s*\(/m, "不得有动态 import()");
  assert.doesNotMatch(code, /\brequire\s*\(/, "不得 require()");
  assert.doesNotMatch(code, /^\s*import\s+/m, "单文件产物不得有 ESM import");
  assert.match(code, /export\s*\{\s*manifest\s*\}/, "必须导出 manifest");
  assert.match(code, /export\s+default\s+activate/, "必须默认导出 activate");
});

test("plugin.js 可被 Node import 且 manifest 与 manifest.json 一致", async () => {
  assert.ok(existsSync(PLUGIN_JS));
  const mod = await import(pathToFileURL(PLUGIN_JS).href);
  assert.equal(typeof mod.default, "function");
  assert.ok(mod.manifest && typeof mod.manifest === "object");
  const disk = JSON.parse(readFileSync(MANIFEST_JSON, "utf8"));
  assert.deepEqual(mod.manifest, disk, "manifest.json 与 plugin.js 内的 manifest 不一致");
});

test("权限最小集", async () => {
  assert.ok(existsSync(PLUGIN_JS));
  const mod = await import(pathToFileURL(PLUGIN_JS).href);
  for (const permission of mod.manifest.permissions) {
    assert.ok(ALLOWED_PERMISSIONS.has(permission), `多余权限：${permission}`);
  }
  for (const required of ["learn:read", "ui"]) {
    assert.ok(mod.manifest.permissions.includes(required), `缺少必需权限：${required}`);
  }
});

test("activate：注册四命令 + 功能页，dispose 可调用", async () => {
  assert.ok(existsSync(PLUGIN_JS));
  const mod = await import(pathToFileURL(PLUGIN_JS).href);
  const commands = [];
  const tabs = [];
  const css = [];
  const disposable = await mod.default(fakeCtx(commands, tabs, css));
  assert.deepEqual(
    commands.map((row) => row.cmd.id).sort(),
    ["files", "info", "read", "search"],
  );
  for (const row of commands) {
    assert.ok(row.cmd.title && row.cmd.title.length >= 6, `${row.cmd.id} 的 title 太短，OH 看不懂`);
    assert.equal(typeof row.run, "function");
  }
  assert.equal(tabs.length, 1, "应注册一个功能页");
  assert.equal(tabs[0].title, "PDF 课件");
  assert.ok(css.length >= 1, "功能页样式应通过 registerCss 注入");
  assert.match(css[0], /\[data-plg="pdf4oh"\]/);
  assert.equal(typeof disposable.dispose, "function");
  disposable.dispose();
});

test("无课程时命令仍返回人话而不是抛错", async () => {
  assert.ok(existsSync(PLUGIN_JS));
  const mod = await import(pathToFileURL(PLUGIN_JS).href);
  const commands = [];
  await mod.default(fakeCtx(commands, [], []));
  const filesCmd = commands.find((row) => row.cmd.id === "files");
  const out = await filesCmd.run("");
  assert.equal(typeof out, "string");
  assert.match(out, /【pdf4oh】/);
});