/**
 * content.js 单测：内容流 tokenizer + 文本状态机 + 坐标换算。
 *
 * 为什么断言坐标而不是只断言文字：排版层的行/空格判断完全依赖 item 的
 * x/y/w/fontSize。这里用"已知字宽 500/1000 em、字号 12"的字体，把每个指令的
 * 位移算死，任何一处矩阵/字距算错都会让后续行聚合错乱。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runContentStream } from "../../src/pdf/content.js";
import {
  bytes,
  dict,
  makeDoc,
  makePage,
  makeResources,
  makeSimpleFont,
  name,
  ref,
  stream,
} from "./fixtures.mjs";

/** 500/1000 em 宽度、字号 12 → 每字符 6pt；页面 600×800，坐标原点在左下。 */
function fixture(content, opts = {}) {
  const font = opts.font || makeSimpleFont();
  const xobjects = opts.xobjects || {};
  const resources = makeResources({ F1: font, ...(opts.fonts || {}) }, xobjects);
  const page = makePage(content, { resources, rotate: opts.rotate || 0, mediaBox: opts.mediaBox });
  const doc = makeDoc([page], { objects: opts.objects || new Map() });
  return { doc, page, out: runContentStream(doc, page, page._content, { resources }) };
}

/** 常用断言：item = {text, x, y, w, fontSize} 的子集。 */
function pick(out) {
  return out.items.map((item) => ({
    text: item.text,
    x: Math.round(item.x * 100) / 100,
    y: Math.round(item.y * 100) / 100,
    w: Math.round(item.w * 100) / 100,
    fs: Math.round(item.fontSize * 100) / 100,
  }));
}

test("Tj + Td：文字位置与宽度（y 已翻转为向下）", () => {
  const { out } = fixture("BT /F1 12 Tf 10 700 Td (Hi) Tj ET");
  assert.deepEqual(pick(out), [{ text: "Hi", x: 10, y: 100, w: 12, fs: 12 }]);
});

test("Td 的位移相对行起点（Tlm），不是当前笔位", () => {
  const { out } = fixture("BT /F1 12 Tf 10 700 Td (A) Tj 20 0 Td (B) Tj ET");
  assert.deepEqual(
    pick(out).map((i) => [i.text, i.x]),
    [
      ["A", 10],
      ["B", 30], // Td(20) 从行起点 10 起算，而不是从 A 结束的 16
    ],
  );
});

test("T* / TL / TD：换行与字距（leading）", () => {
  const { out } = fixture("BT /F1 12 Tf 20 TL 10 700 Td (A) Tj T* (B) Tj 0 -14 TD (C) Tj T* (D) Tj ET");
  assert.deepEqual(
    pick(out).map((i) => [i.text, i.y]),
    [
      ["A", 100],
      ["B", 120],
      ["C", 134], // TD 先换行再设 leading
      ["D", 148],
    ],
  );
});

test("' 与 \" 操作符：换行后显示，\" 还设置词距/字距", () => {
  const { out } = fixture("BT /F1 12 Tf 14 TL 10 700 Td (A) Tj (B) ' ET");
  assert.deepEqual(
    pick(out).map((i) => [i.text, i.y]),
    [
      ["A", 100],
      ["B", 114],
    ],
  );
  const quoted = fixture('BT /F1 12 Tf 14 TL 10 700 Td 2 1 (C) " ET');
  assert.deepEqual(pick(quoted.out).map((i) => i.text), ["C"]);
});

test("Tm 直接设定文本矩阵（绝对位置）", () => {
  const { out } = fixture("BT /F1 12 Tf 1 0 0 1 30 640 Tm (At) Tj ET");
  assert.deepEqual(pick(out), [{ text: "At", x: 30, y: 160, w: 12, fs: 12 }]);
});

test("TJ：负数位移把后续文字推远（词间空格候选）", () => {
  const { out } = fixture("BT /F1 12 Tf 10 700 Td [(A) -500 (B)] TJ ET");
  assert.deepEqual(
    pick(out).map((i) => [i.text, i.x, i.w]),
    [
      ["A", 10, 6],
      ["B", 22, 6], // A 宽 6 + TJ 位移 6
    ],
  );
});

test("Tc / Tw / Tz：字距、词距、水平缩放都进宽度", () => {
  const tc = fixture("BT /F1 12 Tf 2 Tc 10 700 Td (AB) Tj ET");
  assert.equal(pick(tc.out)[0].w, 16); // 12 + 2×2

  const tw = fixture("BT /F1 12 Tf 3 Tw 10 700 Td (A B) Tj ET");
  assert.equal(pick(tw.out)[0].w, 21); // 18 + 3（只对空格码生效）

  const tz = fixture("BT /F1 12 Tf 200 Tz 10 700 Td (AB) Tj ET");
  assert.equal(pick(tz.out)[0].w, 24); // 12 × 2
});

test("Ts：文本上标（rise）改变基线位置", () => {
  const { out } = fixture("BT /F1 12 Tf 5 Ts 10 700 Td (X) Tj ET");
  assert.equal(pick(out)[0].y, 95); // 800 - (700 + 5)
});

test("q/Q + cm：图形状态保存/恢复（平移）", () => {
  const moved = fixture("q 1 0 0 1 300 500 cm BT /F1 12 Tf 0 0 Td (M) Tj ET Q");
  assert.deepEqual(pick(moved.out), [{ text: "M", x: 300, y: 300, w: 6, fs: 12 }]);

  const restored = fixture("q 1 0 0 1 300 500 cm Q BT /F1 12 Tf 10 700 Td (N) Tj ET");
  assert.equal(pick(restored.out)[0].x, 10); // Q 之后 cm 的平移必须失效
});

test("Form XObject：递归并应用自己的 /Matrix 与 /Resources", () => {
  const formFont = makeSimpleFont({ baseFont: "FormFont" });
  const formStream = stream(
    {
      Subtype: name("Form"),
      Matrix: [1, 0, 0, 1, 5, 5],
      Resources: makeResources({ FF: formFont }),
    },
    bytes("BT /FF 12 Tf 0 0 Td (FormText) Tj ET"),
  );
  const { out } = fixture("1 0 0 1 100 200 cm /Fm Do", { xobjects: { Fm: formStream } });
  assert.equal(out.formCount, 1);
  assert.deepEqual(pick(out), [{ text: "FormText", x: 105, y: 595, w: 48, fs: 12 }]);
  assert.equal(out.items[0].fontName, "FormFont");
});

test("Form XObject：自引用会撞深度上限并告警（不挂死）", () => {
  const formStream = stream(
    { Subtype: name("Form"), Resources: new Map([["XObject", new Map([["Loop", ref(10)]])]]) },
    bytes("/Loop Do"),
  );
  const objects = new Map([[10, formStream]]);
  const page = makePage("10 0 0 10 0 0 cm /Loop Do", {
    resources: new Map([["XObject", new Map([["Loop", ref(10)]])]]),
  });
  const doc = makeDoc([page], { objects });
  const out = runContentStream(doc, page, page._content, { resources: page.resources });
  assert.ok(out.formCount <= 8);
  assert.ok(out.warnings.some((w) => /递归/.test(w)));
});

test("图片：Do /Subtype /Image 与内联 BI…ID…EI 都计数且不产生文本", () => {
  const image = stream({ Subtype: name("Image"), Width: 2, Height: 2 }, new Uint8Array([0, 1, 2, 3]));
  const { out } = fixture("/Img Do BT /F1 12 Tf 10 700 Td (After) Tj ET", { xobjects: { Img: image } });
  assert.equal(out.imageCount, 1);
  assert.deepEqual(pick(out).map((i) => i.text), ["After"]);

  // 二进制数据里藏着 "EI"（但前面不是空白）也不能提前结束
  const inline = new Uint8Array([
    ...bytes("BI /W 2 /H 2 /BPC 8 /CS /G ID "),
    0x00, 0x45, 0x49, 0x01, 0x02, // 含 "EI" 的二进制
    0x20, 0x45, 0x49, 0x20, // 真正的 EI
    ...bytes(" BT /F1 12 Tf 10 700 Td (Inline) Tj ET"),
  ]);
  const page = makePage(inline, { resources: makeResources({ F1: makeSimpleFont() }) });
  const doc = makeDoc([page]);
  const out2 = runContentStream(doc, page, inline, { resources: page.resources });
  assert.equal(out2.imageCount, 1);
  assert.deepEqual(pick(out2).map((i) => i.text), ["Inline"]);
});

test("旋转页：90/180/270 的坐标换算", () => {
  // 0°：普通横排
  const north = fixture("BT /F1 12 Tf 100 200 Td (R) Tj ET", { rotate: 0 });
  assert.deepEqual([pick(north.out)[0].x, pick(north.out)[0].y], [100, 600]);

  // 90°：内容在用户空间里沿 +y 书写（扫描件/横版页的常见存法）
  const right = fixture("BT /F1 12 Tf 0 1 -1 0 100 200 Tm (R) Tj ET", { rotate: 90 });
  assert.deepEqual(
    [pick(right.out)[0].x, pick(right.out)[0].y, pick(right.out)[0].w],
    [200, 100, 6],
  );

  // 180°：内容倒放，视觉上向左延伸，x 取左边缘
  const half = fixture("BT /F1 12 Tf 100 200 Td (R) Tj ET", { rotate: 180 });
  assert.deepEqual(
    [pick(half.out)[0].x, pick(half.out)[0].y, pick(half.out)[0].w],
    [494, 200, 6],
  );

  // 270°：内容沿 -y 书写
  const left = fixture("BT /F1 12 Tf 0 -1 1 0 100 200 Tm (R) Tj ET", { rotate: 270 });
  assert.deepEqual(
    [pick(left.out)[0].x, pick(left.out)[0].y, pick(left.out)[0].w],
    [600, 500, 6],
  );
});

test("MediaBox 原点非零时坐标要减掉原点", () => {
  const { out } = fixture("BT /F1 12 Tf 10 700 Td (M) Tj ET", { mediaBox: [10, 20, 610, 820] });
  assert.deepEqual([pick(out)[0].x, pick(out)[0].y], [0, 120]);
});

test("字符串语法：转义括号、八进制、十六进制串", () => {
  const escaped = fixture(String.raw`BT /F1 12 Tf 10 700 Td (A\(B\)C) Tj ET`);
  assert.equal(pick(escaped.out)[0].text, "A(B)C");

  const octal = fixture(String.raw`BT /F1 12 Tf 10 700 Td (A\101B) Tj ET`);
  assert.equal(pick(octal.out)[0].text, "AAB");

  const hex = fixture("BT /F1 12 Tf 10 700 Td <48656C6C6F> Tj ET");
  assert.equal(pick(hex.out)[0].text, "Hello");
});

test("空内容流与缺失字体：不抛，给出 warning", () => {
  const empty = fixture("");
  assert.deepEqual(empty.out.items, []);
  assert.equal(empty.out.imageCount, 0);

  const missing = fixture("BT /F9 12 Tf 10 700 Td (X) Tj ET");
  assert.ok(missing.out.warnings.some((w) => /F9/.test(w)));
  assert.equal(pick(missing.out)[0].text, "X"); // 降级字体仍尽量给字符
});

test("CJK + Type0/Identity-H 走 2 字节：宽度按 CID 累加", () => {
  const toUni = stream(
    {},
    bytes(`
      begincmap
      1 begincodespacerange
      <0000> <FFFF>
      endcodespacerange
      2 beginbfchar
      <0001> <4E2D>
      <0002> <6587>
      endbfchar
      endcmap
    `),
  );
  const cjkFont = {
    t: "dict",
    m: new Map([
      ["Type", name("Font")],
      ["Subtype", name("Type0")],
      ["BaseFont", name("SimSun")],
      ["Encoding", name("Identity-H")],
      ["ToUnicode", toUni],
      [
        "DescendantFonts",
        [dict({ Type: name("Font"), Subtype: name("CIDFontType2"), DW: 1000, W: [] })],
      ],
    ]),
  };
  const page = makePage("BT /F1 12 Tf 10 700 Td <00010002> Tj ET", {
    resources: makeResources({ F1: cjkFont }),
  });
  const doc = makeDoc([page]);
  const out = runContentStream(doc, page, page._content, { resources: page.resources });
  assert.deepEqual(pick(out), [{ text: "中文", x: 10, y: 100, w: 24, fs: 12 }]);
});