# 全量无损 Brotli 发布迁移

## 背景与执行顺序

- 11.14 审计批次已先提交并推送为 `d9c89b7`，其全部37,937个新增SID／坐标／路名／隐藏常规分流及真实Edge验收通过。
- 山东常规包按用户要求免移动性审计。全库并集新增4,371,657个SID，源4,447,324条／4,447,291唯一，排除75,634已有；全国59,436,440点，原始行与固定校验通过。
- 在修改编码前，使用现行标准gzip完成全量526资源实测：原始 **6,141,623,955 B** → gzip **985,438,339 B**；完整站点 **1,006,123,246 B**，超过现行 **1,000,000,000 B** 门槛 **6,123,246 B**。
- 用户明确允许山东容量／编码失败时先迁移再推送。因此不推送已知超门槛的发布方案、不提高门槛、不删点或裁字段；本批山东数据与编码改造在无损迁移验证后发布。

数据层与压缩层分开：Brotli只编码原文件字节，不解析／重序列化点位，不改变SID、坐标数字文本、日期空值、路名、标志或8字段旧记录。蓝线试验继续回退，不属于本任务；Android／iOS／PC及8项历史保护修改不变。

## 清单 v2 与旧清单兼容

新发布目录仅有 `.js.br` 等必要压缩资源、前端、小型元数据、自托管解码器、清单和报告；不额外发布同一数据的原始JS或gzip副本，以免重复体积。

```javascript
window.PANO_ASSET_MANIFEST = {
  version: 2,
  codec: 'brotli',
  files: {
    'data_370100.js': {
      url: 'data_370100.js.br',
      bytes: 123,
      compressedBytes: 45,
      sha256: '原始完整文件SHA-256',
      compressedSha256: '压缩文件SHA-256'
    }
  },
  totals: { /* 真实构建统计 */ }
};
```

- v2 `codec: 'brotli'` 采用通用 `compressedSha256`，同源同目录严格对应文件名。
- 加载器仍兼容历史 v1 `codec: 'gzip'` 与 `gzipSha256`，旧产物可继续使用；错误版本／codec组合、缺条目或外部URL均拒绝，不静默回退原始JS。
- 源检出中的 [asset-manifest.js](<../city-viewer/asset-manifest.js>) 继续为null，直接读取本地原始JS，不初始化WebAssembly。
- 下载后的原始大小、压缩大小与两层SHA均按清单验证；HTTP已解码返回只有在原始大小和SHA精确一致时才接受，不能依赖不可信Content-Length或magic猜测Brotli。

## 压缩与无损检查

[构建器](<../tools/build_gzip_site.py>) 保留旧gzip默认API和显式参数。正式 [Pages工作流](<../.github/workflows/pages.yml>) 改为明确Brotli：

```powershell
node --max-old-space-size=768 --expose-gc tools/build_viewer_index.js --with-search
node tools/check_viewer_hidden_grid.js
node tools/check_viewer_display_mode.js
node tools/check_viewer_search.js
python tools/check_viewer_sid_unique.py
python -m unittest discover -s tools/tests -v
node --test tools/tests/*.test.js
python tools/build_gzip_site.py --output dist/pages --codec brotli --node node --workers 2 --brotli-quality 11 --brotli-lgwin 22
```

- Node原生Brotli逐流压缩；质量11、窗口22、最多2个worker，不把全国文件装进大数组。
- 每个压缩资源随后完整解压，逐块与源字节比较，再检查完整SHA／大小及输入文件签名。截断、尾随数据、错误源／错误原行、缺／多分片、进程失败都不能产出成功清单。
- 只在全部资源验证与完整目录容量门槛通过后写清单／报告。非空输出目录拒绝覆盖；失败结果保留用于诊断，不盲目重复构建。
- 临时文件、profile和本地报告用D盘。Windows使用自带Node时给 `--node` 精确路径；CI使用安装好的 `node`。

## 浏览器解码与内存

- [主加载器](<../city-viewer/asset-loader.js>) 仍最多两个完整加载管线，去重同名在途请求，失败后可重试；成功数据释放后可重新加载，无永久成功缓存。
- [Brotli桥](<../city-viewer/brotli-decoder.js>) 在首次需要时解码；优先尝试平台提供的Brotli DecompressionStream，若不可用则启用本地模块 [worker](<../city-viewer/brotli-worker.js>)。
- Worker加载固定 **brotli-wasm 3.0.1**，以64 KiB输入／输出块逐步解压，严格检测精确预期大小、终态、已消费输入、截断、尾随和无进展；对象每步free，完成／失败都终止worker释放WebAssembly内存。
- WebAssembly文件1056860字节与固定SHA先验证再初始化。库与 [许可证／来源](<../city-viewer/vendor/brotli-wasm/NOTICE.md>) 自托管，不使用运行时CDN、npm安装或浏览器压缩。
- 要求现代浏览器WebAssembly／Worker、Streams、Web Crypto和Blob；若环境缺支持则明确报错，不能把失败当零结果。自定义CSP须允许同源worker、WebAssembly及既有Blob脚本路径。

## 校验工具与测试范围

[浏览器验收工具](<../tools/check_gzip_browser.js>) 保留历史文件名但支持两种codec及真实新点fixture；[下载解码工具](<../tools/decode_brotli_asset.cjs>) 为线上逐资源双SHA/大小/完整输入消耗提供64KiB流式解压验证，拒绝截断、尾随或预存输出。

```powershell
node tools/check_gzip_browser.js --site-root dist/pages --result-dir dist/browser-check-new --expected-codec brotli --target-sample D:/path/browser-sample.json --force-brotli-worker
```

验收须证明：启动不加载搜索索引、真实新增SID和@定位命中、原坐标精确相等、game15红点、多宽度布局、无原始大JS请求或运行时异常；强制worker时实际创建并终止本地WASM工作线程。此工具屏蔽外部底图瓦片，不声称OSM或六面图片功能已通过。

源数据未再改变时不重复全库SID／索引；本次编码测试另覆盖二进制／BOM／CRLF／空数据、未知清单、损坏／截断／尾随、长度上限、队列／重试与第三方WASM完整性。线上仍须下载实际压缩资源，并逐条核对山东原始行以及11.14新增点。

## 当前实测与完成条件

全量本地构建与真实Edge验收均已完成；以下为完整526资源实测，不是样本外推。

| 指标 | 实测 |
|---|---:|
| 原始数据／派生资源字节 | 6,141,623,955 |
| Brotli压缩数据字节 | 825,194,542 |
| 完整站点字节（含前端／WASM／清单／报告） | 847,004,701 |
| 比完整旧gzip站点减少 | 159,118,545 |
| 距1GB门槛余量 | 152,995,299 |
| 逐字节／双SHA验证资源 | 526/526 |
| 总点数／集合键／常规JS | 59,436,440／921／523 |
| 回归 | 80Python／98Node通过 |

- Node原生Brotli质量11／窗口22／2worker；全量逐资源解压字节与原文件完全一致，且所有原始大小／SHA与已验证gzip输入保持一致。
- 真实Edge使用山东新增SID`22141027141011112133500`与11.14常规新SID`28061024141020144329800`串行验收，强制禁用两种native Brotli名称后实际使用本地module Worker／固定WASM；所有worker完成后终止且并发不超过2。
- 新增点搜索／完整@定位／精确原坐标／game15红点／560、705、1280、1440宽度布局通过，无原始大型JS请求或运行时异常；响应头与页面CSP事件记录在真实浏览器报告中。不扩大为OSM瓦片／六面影像验收。

### 同提交线上完成

- 发布数据提交`9c751bd80b941096a4cae6df0c93fa1298d6a76f`；[同SHA Pages工作流43634735449](<https://github.com/cn171g11/tencent-panorama-workbench/actions/runs/43634735449>)成功。
- 实际下载全部526个Brotli资源，压缩与原始大小／两层SHA及完整输入消费通过；没有只验证manifest条目或旧样本。
- 山东全部4,371,657新增与75,649既有城市原始行按SID／JSON raw／坐标文本／顺序逐条通过；11.14全部37,937新SID／精确坐标／路名／隐藏常规分类复验通过，注册game15完整。
- 线上真实Edge对上述两个新增SID强制本地WASM路径完成搜索／@定位／坐标／布局与worker释放验收。线上数据总量59,436,440、921键、526资源、codec为Brotli。

失败时保留原始点源与已经通过的证据，修复加载器／发布器后再部署；不恢复已否决蓝线、不删除数据、不放宽1GB门槛，也不循环创建工作流。
