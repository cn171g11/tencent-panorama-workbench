# 原始数据保留、gzip 发布与搜索恢复（v2.28.0）

> 本文记录2026-11-07的历史gzip架构与实测，不是最新容量或唯一编码要求。2026-11-15全量发布已迁移为Brotli v2清单并完成线上验收，加载器保留gzip v1兼容；现行方案与完成证据见 [Brotli发布说明](<brotli-publication-20261115.md>)。

## 发布架构

- Git 仓库继续保留原始点位 [分片目录](../city-viewer/)；经纬度、道路、日期、方向、标志和 SID 不舍入、不转换。搜索索引为可再生文件，生成后忽略入库。
- [Pages 工作流](../.github/workflows/pages.yml) 从原始分片重建网格与搜索索引，运行全部校验，使用 [构建器](../tools/build_gzip_site.py) 生成独立 `dist/pages`。
- 发布目录仅含必要前端、小元数据、资源清单和 `.js.gz`。不复制大型原始 JS、工具、原始审核证据、本地交接文档或浏览器测试目录。
- [加载器](../city-viewer/asset-loader.js) 按需下载 gzip，检查压缩与解压长度/SHA-256，再以原始字节 BlobScript 装载。识别 HTTP 已解压响应以避免二次解压；最多两个完整管线同时运行，失败可重试，无永久成功缓存。
- 启动只加载全国网格和隐藏数据。搜索索引到第一次查询才加载，候选城市分片逐个扫描、释放并可再加载。地图/城市/区县/道路与隐藏红色标记保留。
- 源码检出中的 [清单文件](../city-viewer/asset-manifest.js) 为 null，可本地读取原始 JS；正式发布时构建器替换为真实清单。有清单却缺条目时禁止回退到原始文件。
- 使用 HTTPS/localhost 与支持 DecompressionStream、Blob、Web Crypto 的现代浏览器。旧 WebView 不能解压时明确提示升级；不虚构零命中或静默跳过损坏的搜索分片。

## 全库无损实测

最终发布构建（含恢复的游戏记录）全部 **475/475** 个资源通过逐块原始字节比较和 SHA-256/完整长度校验：

| 指标 | 实测 |
|---|---:|
| 原始数据/派生资源字节 | 4,311,001,504 |
| gzip 数据字节 | 840,467,147 |
| 节省 | 80.5041% |
| 包含前端/清单/报告的整个站点字节 | 846,158,610 |
| 常规点位源分片 | 472 |
| 压缩资源文件（点位+隐藏+网格+搜索） | 475 |
| 最终点位总数 | 40,870,386 |
| 集合键 | 703 |
| 隐藏集合/点位（含游戏） | 231 / 349,899 |

这是全库测量，不是先前 8 文件样本外推。gzip9 固定时间戳/空 filename；只有验证完全部文件才写出成功清单。输出目录不可覆盖，失败后选择新目录重试。生产数量来自元数据清单动态推导，缺/多任意源分片都拒绝构建；`--expected-files` 可附加精确数量门禁。

工作流还核对发布目录不超过保守的 1,000,000,000 字节预算；超过后报错，不允许为绕过门禁删数据。

## 浏览器与源数据验证

- 重新索引：40,870,386 条、703 键、839,340 格。
- 全库准确 `PANO_CITY` SID：40,870,386 条，唯一 40,870,386，重复 0。保留旧南京八字段记录，不因格式不同漏计。
- hidden-grid：231 集合、349,899 点、146,668 格；额外核对注册游戏 SID 清单，防止以后再丢。
- display-mode / search 回归通过；Node 测试 48/48，Python 测试 36/36。
- 本地真实 Edge 对 gzip-only 产物测试通过：启动不加载搜索索引；panoid 与完整 `@` 条件实际命中；点位数值与源数据精确相同；15 个游戏散点保留红色标记；560/705/1280/1440 宽度布局无搜索框溢出。
- 浏览器测试观测到 5 次 gzip 请求（网格、隐藏、搜索、城市分片两次），无大型原始 `.js` 请求，无运行时异常。测试使用同版本 Leaflet 的本地镜像，并屏蔽底图瓦片网络以保证回归确定性；这不是底图连通性测试。线上必须另行验证。
- [实际浏览器测试工具](../tools/check_gzip_browser.js) 使用独立配置及临时端口，结束即关闭预览，不替代 DSH GUI。

## 恢复历史遗漏的 15 个游戏点

本次真实浏览器校验发现：当前基线 `5f5da93` / `f891c0f` 的所有点位分片中均找不到 [注册游戏 SID 清单](../tools/data/tencent-game-exceptions.json) 中的 15 个 ID，隐藏文件也没有 `hidden_game`。此前交接文档和 README 的“含游戏15点”说法不符合真实源数据。gzip 解压与源文件完全一致，因此不是本次压缩造成丢失。

历史提交 `26646f6`（以及 `7251516`）仍完整保存该集合。恢复直接复制 `26646f6` 中原始 `PANO_CITY["hidden_game"]` 数组字节、元数据、计数与网格，核对恰好等于全部15个注册ID；不重新采集，不舍入游戏坐标，不把虚构坐标归入地级市。恢复时既有隐藏数据的原始前缀字节全部保留。

- 原始缺失前缀 SHA-256：`74ea23e71cfe9dbd1eeb069df8feb1202859e0e47c984407a701174abf33eccb`。
- 恢复的游戏数组赋值（含标记/换行）SHA-256：`ceefd55fde56cce7957605504794f493a5a28c25f734615f800d24e36e5d0e24`。
- 各城市新增/删除点位 0；仅补回历史游戏点 15。
- 总量 40,870,371 → 40,870,386；702 → 703 集合；349,884 → 349,899 隐藏/游戏点。
- 游戏仍可独立选择、全局搜索；不计入全国地理视图，后者仍为 40,870,371 个真实地理点位，避免虚构坐标改变地图范围。

## 构建与回滚

```powershell
node --max-old-space-size=768 --expose-gc tools/build_viewer_index.js --with-search
node tools/check_viewer_hidden_grid.js
node tools/check_viewer_display_mode.js
node tools/check_viewer_search.js
python tools/check_viewer_sid_unique.py
node --test tools/tests/asset-loader.test.js tools/tests/pano-mobility.test.js
python -m unittest discover -s tools/tests
python tools/build_gzip_site.py --output dist/pages --workers 4
```

本机只有约8GiB内存，索引构建与四千万 SID 扫描应顺序执行，不要并行。SID CLI 在完成所有检查并刷新输出后让操作系统直接释放巨大只读堆，避免低内存机器在 Python 对象析构时反复换页；API/错误分支仍保留校验，相关成功/失败回归均测试。

先验证本地 gzip 产物，再切 Pages `build_type` 到 workflow 并推送。发布成功必须以对应 commit 的 Actions deploy 与线上版本、清单、gzip 字节校验及实际搜索为准。若工作流失败，保留旧线上站点和原始源数据，修复构建/加载器后再部署；不删数据或盲目重复 legacy build。
