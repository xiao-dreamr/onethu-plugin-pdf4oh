# pdf4oh 公告

- **v0.1.0**：首个版本。支持课程 PDF 的 `files` / `info` / `read` / `search` 四条命令，
  自带 PDF 解析（对象流、xref 流、ToUnicode、CID 字体），只读、不写课程数据。
- 使用提示：问 OH「帮我读一下《线性代数》第 3 讲，总结重点」即可；首次读大文件较慢，
  插件会缓存已解析文档，后续翻页很快。
- 已知限制：加密 PDF 只识别不解密；扫描件/图片型 PDF 没有文本层（不做 OCR）；
  TeX 数学符号字体可能缺字（中文不受影响）。
- 反馈/问题：<https://github.com/xiao-dreamr/onethu-plugin-pdf4oh/issues>
