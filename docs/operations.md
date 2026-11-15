# tencent-panorama-workbench · 运维手册

## 1. 源数据与发布数据分离

[city-viewer](<../city-viewer/>) 中的点位原始JavaScript仍保留在Git；坐标、SID字符串、路名、日期空值与标志不在压缩时改写。派生搜索源码仅生成，不逐版入库。正式 [Pages工作流](<../.github/workflows/pages.yml>) 上传独立 `dist/pages`，不上传工具、原始审计/采集断点、本地交接、浏览器profile或原始大JS副本。

现行迁移使用Brotli清单v2，旧gzip清单v1仍由 [加载器](<../city-viewer/asset-loader.js>)兼容。编码和来源说明见 [Brotli发布](<brotli-publication-20261115.md>)；[历史gzip记录](<gzip-publication-20261107.md>)里的旧规模/参数不是当前全量指标。

## 2. 本地运行

源码模式 [asset-manifest](<../city-viewer/asset-manifest.js>)为null，可以从HTTP读取原始文件。现代浏览器需支持Streams、Web Crypto、Blob；Brotli fallback还需WebAssembly及module Worker。

```powershell
python -m http.server 8000 --directory .
```

打开 `http://127.0.0.1:8000/city-viewer/`；首次只显示空地图和“先选择视图”提示。选择全国、省份或城市后点击“加载所选视图”，才读取街景网格；明细/隐藏/搜索数据继续按需读取。见 [按需启动说明](<viewer-on-demand-start-20261115.md>)。测试发布产物时，将 `--directory`指定为实际构建输出。不要替换DeepSeek Harness GUI或启动另一个伪装为当前GUI的服务器。

必要前端包含查看器/报告、小型metadata/districts、asset-loader、asset-manifest、brotli-decoder/worker以及 [固定WASM库](<../city-viewer/vendor/brotli-wasm/NOTICE.md>)。Brotli资源以`.js.br`下载，压缩响应不要求服务器自动设置Content-Encoding；加载器验证两层哈希后主动解码。

## 3. 低内存导入与固定检查

约8GiB主机上，API审计、全库并集/SQLite、索引重建、SID校验和全量压缩必须按阶段串行，不建全国SID大字典。用户明确常规包免移动性审计；要求审计的缺口先排除已有SID再按navigation-v1审新增，不能信源isHidden。所有临时和批次产物使用D盘路径。

点位导入采用原行并集和备份，冻结完整源SHA，验证新增/旧原行与注册game15；不能整包替换删旧点。原行保留与date-empty策略按批次明确记录，不将历史“99%回填”当当前覆盖率。

```powershell
node --max-old-space-size=768 --expose-gc tools/build_viewer_index.js --with-search
node tools/check_viewer_hidden_grid.js
node tools/check_viewer_display_mode.js
node tools/check_viewer_search.js
python tools/check_viewer_sid_unique.py
python -m unittest discover -s tools/tests -v
node --test tools/tests/*.test.js
```

已完成且源未变的检查不重复执行；编码迁移新增fixture和实际解码验收，不用重新扫描全国SID替代。区县点数不按面积猜分；常规采集上传完成也不是“全省已扫全”的证明。

## 4. 无损Brotli构建

```powershell
python tools/build_gzip_site.py --output dist/pages-NEW --codec brotli --node node --workers 2 --brotli-quality 11 --brotli-lgwin 22
```

- 历史构建器文件名保留；Brotli使用现有Node原生流式编码，质量11/窗口22、最多两个worker；可给`--node`精确可执行路径，不执行npm安装脚本。
- 构建必须逐文件完整解压与源逐字节一致，原始/压缩两层SHA、大小、源签名、源清单与静态复制一致；结果文件全部验证完才发布成功清单。
- 非空输出拒绝覆盖。完整输出包括前端、WASM、报告与清单仍须 **≤1,000,000,000 B**。超过不得偷偷放宽、删点、减少字段/精度；保留源与已完成证据，调整经授权的编码或托管方案。
- 构建进行时不改任何点源、metadata、前端或worker文件，否则输入签名和SHA应拒绝构建。大型压缩失败后先检查具体资源日志，不能盲目重复整个运行。

## 5. 浏览器与线上验收

```powershell
node tools/check_gzip_browser.js --site-root dist/pages-NEW --result-dir dist/browser-check-NEW --expected-codec brotli --target-sample D:/batch/browser-sample.json --force-brotli-worker
```

工具文件名保持兼容，但接受gzip/Brotli和本批真实新增SID fixture。结果目录必须新建；强制WASM分支验证：worker真正创建和终止、解码精确、panoid/@定位命中、原坐标相等、game15红点、多宽度搜索布局通过，无原始大JS请求/运行时异常。测试屏蔽底图，不能以此声称OSM或六面图片已验收。

发布后用相同参数改 `--url` 指向现有线上站点，再下载实际压缩资源检查两层SHA和完整新点原始行。manifest条目、HTTP200、旧文山样本或Actions绿灯不能单独代替全批新增数据验收。CSP自定义时需同源worker、WebAssembly许可及既有Blob脚本许可。

## 6. Git与发布顺序

接手先看真实HEAD、远端与worktree；保留8项历史保护修改和本地AGENT/history。严格白名单提交，不 `git add .`、不强推、不绕过交接门禁，也不把已否决蓝线stash恢复。

```powershell
git status --short
git diff --cached --name-only
git diff --cached --check
node tools/check_handoff_docs.js
```

使用现有部署密钥做正常fast-forward推送，凭据不写入文档/脚本/日志。PAT文件若为Markdown，只在内存提取单个token，不把整文件当Authorization。

工作流仅上传独立目录；当前Brotli配置build180分钟/deploy15分钟，`pages`并发组、不取消健康运行。一个同SHA运行配一个观察任务，查当前attempt jobs；无新事实不循环轮询、cancel/rerun/dispatch。完成必须核对实际SHA、线上版本/总数/新点/codec/资源数。

本次用户顺序：11.14先推送；山东gzip全量实测超限6,123,246B后，按明确授权先Brotli迁移再推送山东；最后更新仓库说明及本地交接。所有等待状态如实标注，不把已完成脚本重新当待办。

## 7. 发布边界

Android/iOS/PC私有工程、shared和签名/交付物不随网页更新。线上主体仅元数据，不发布街景图片或APK/Releases；其他私用交付必须另有明确授权。历史资料/旧站迁移路径及存储兼容键不随本次编码改变。
