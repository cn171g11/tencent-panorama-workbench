# 腾讯街景工作台 · tencent-panorama-workbench

腾讯 / 百度街景**元数据**的采集、校验、整理与可视化。仓库只保存文本类元数据，不保存任何街景图片；
线上主体是一个可按需加载的全国街景查看器。

> **v2.46.0 先选择视图，再加载街景**：首次打开只显示空地图与提示，不请求街景网格、点位、隐藏合集或搜索索引；选择全国、省份或城市并点击“加载所选视图”后才加载。全国 **59,436,440** 点及原始数据不变；详见 [按需启动说明](<docs/viewer-on-demand-start-20261115.md>)。Brotli发布历史见 [编码说明](<docs/brotli-publication-20261115.md>)。
>
> 项目使用 `tencent-panorama-workbench` 新名称与地址；旧名 `panorama-workbench` 的迁移记录见 [迁移说明](docs/project-rename-20261109.md)。

| 入口 | 地址 |
|---|---|
| 城市查看器 | <https://cn171g11.github.io/tencent-panorama-workbench/city-viewer/> |
| 数据报告 | <https://cn171g11.github.io/tencent-panorama-workbench/city-viewer/report.html>（各省市常规/隐藏街景数量） |
| 仓库根路径 | <https://cn171g11.github.io/tencent-panorama-workbench/>（自动跳转到查看器） |
| 结构说明 | [docs/repository-layout.md](docs/repository-layout.md) |
| 数据目录 | [docs/data-catalog.md](docs/data-catalog.md) |
| 运维手册 | [docs/operations.md](docs/operations.md) |

> 街景图片版权归腾讯 / 百度所有。本仓库仅收录元数据（panoid、坐标、路名、采集时间、朝向），仅供研究与个人使用。

---

## 1. 数据规模

| 指标 | 数值 |
|---|---|
| 街景点总数 | **59,436,440**（含独立游戏15点） |
| 数据分片 | 523个点位 `data_*.js`（不含meta/districts），921个集合键（含398个隐藏集合） |
| 省级行政区 | 32 个（不计独立游戏集合） |
| 区县边界 | 2,564 个（覆盖 297 个地级/城市键；7 个特殊管理单元无独立区县边界） |
| 腾讯隐藏街景 / 时光机 | **583,446** 点（397个地理隐藏集合，另含独立游戏15点） |
| 腾讯常规补充集合 | 854 点（不含已归并进城市层的常规街景） |

> 2026-11-02 的历史批次曾按 svid 内嵌日期回填采集时间，当时覆盖约99%；这不是当前全库覆盖率。四川与山东常规批次按原始JSON保留源日期空值，不新增回填或改写字段，详情面板展示已有采集时间。
> **v2.31.0 常规街景支持二级行政区筛选**：通过 297 个城市、2,564 个二级行政区边界提供省→市→区县查看；特殊管理单元无独立县级边界时保留城市级“全部”。全局搜索与无损发布继续保留原始数据；现行发布迁移为Brotli v2清单，浏览器逐文件校验大小／两层SHA，旧gzip v1仍兼容。详见 [区县筛选说明](<docs/district-filter-20261108.md>)、[Brotli发布说明](<docs/brotli-publication-20261115.md>) 与 [历史gzip记录](<docs/gzip-publication-20261107.md>)。

点位最多的省级行政区：

| 省级行政区 | 街景点 |
|---|---|
| 江苏省 | 6,483,703 |
| 浙江省 | 5,340,826 |
| 山东省 | 4,490,319 |
| 上海市 | 3,772,298 |
| 北京市 | 3,411,158 |
| 河北省 | 2,679,008 |
| 辽宁省 | 2,511,943 |
| 河南省 | 2,396,825 |
| 四川省 | 2,352,737 |
| 湖北省 | 2,301,337 |
| 天津市 | 1,926,295 |
| 山西省 | 1,891,076 |
| 安徽省 | 1,776,640 |
| 福建省 | 1,734,494 |
| 内蒙古自治区 | 1,663,260 |
| 湖南省 | 1,601,430 |
| 黑龙江省 | 1,485,864 |
| 江西省 | 1,392,617 |
| 陕西省 | 1,317,188 |
| 吉林省 | 1,173,471 |
| 广西壮族自治区 | 1,053,235 |
| 云南省 | 1,037,299 |
| 重庆市 | 901,747 |
| 新疆维吾尔自治区 | 819,031 |
| 甘肃省 | 802,367 |
| 海南省 | 783,222 |
| 贵州省 | 595,630 |
| 宁夏回族自治区 | 538,540 |
| 西藏自治区 | 474,740 |
| 香港特别行政区 | 374,779 |
| 青海省 | 308,070 |
| 广东省 | 45,276 |

> 江苏、上海是早年网格扫描的主体；浙江、福建、安徽、广西、宁夏是近期按地级市全量重扫的结果；
> 香港是唯一按全港序列逐条展开的批次（374,432 点），澳门无街道覆盖（见 `docs/hongkong-macao-scan-20261030.md`）；
> 海南按 1.1 km 间距播种（见 `docs/hainan-shanghai-bridge-20261031.md`）；
> 甘肃、黑龙江来自官方区县包/扫描结果合并（见 `docs/gansu-heilongjiang-import-20261103.md`）；
> 湖北来自区县包合并（见 `docs/hubei-import-20261031.md`）。

---

## 1.1 数据报告 `report.html`

查看器顶部的「数据报告」按钮会打开 `report.html`：按**省级**和**地级**两级列出常规街景与隐藏街景数量，
支持搜索、按列排序、展开到城市，并给出隐藏占比。页面只读取 `data_meta.js`（48 KB），不加载点位数组，打开即出结果。

区县点数由查看器按当前城市边界对已加载点位实时判定；报告页不预先保存区县点数。现有边界覆盖 297 个城市、2,564 个二级行政区。

---

## 2. 数据组织

查看器按**地级行政区 adcode** 拆分数据，浏览器按需加载，单次只取当前城市的分片。

| 文件 | 作用 |
|---|---|
| `data_meta.js` | `PANO_META`（名称 / 省份 / 归属地级市）、`PANO_COUNT`（各分片点数） |
| `data_districts.js` | `PANO_DISTRICTS`，区县边界多边形，供区县筛选使用 |
| `data_<adcode>.js` | `PANO_CITY[key]` 点位数组，超过 18 万点拆分为 `<adcode>_2`、`_3`… |
| `grid_all.js` | 全国网格聚合（0.004°），供总览与密度模式使用 |
| 全局点位搜索 | 已恢复；搜索索引在发布层压缩，查询时按需解压加载 |
| [asset-loader.js](<city-viewer/asset-loader.js>) | 同源Brotli/gzip解压、原始/压缩大小与SHA-256校验、并发限制及重试 |
| [brotli-decoder.js](<city-viewer/brotli-decoder.js>)、[brotli-worker.js](<city-viewer/brotli-worker.js>) | 按需原生或固定本地WASM流式解码，完成/失败释放工作线程 |
| [asset-manifest.js](city-viewer/asset-manifest.js) | 源码检出时为 null；发布构建替换为全部压缩资源清单 |
| `hidden_pano.js` | 「腾讯隐藏街景/时光机」合集（独立集合，不按城市拆分） |

点位通常为9字段，既有8字段历史行继续有效；不为编码迁移补造或重写字段，只允许在末尾追加新字段：

```text
[panoid, lng, lat, road, captured, dir, has_thumb, has_pano, source]
```

---

## 3. 腾讯隐藏街景 / 时光机（按地级市分集合）

合集收的是**无法在腾讯街景里连续移动**的孤立点位（多为历史影像帧、景区单帧），与常规覆盖区分开。
每个地级行政区一个集合键（`hidden_371300` 临沂、`hidden_340200` 芜湖…），
查看器顶部是**省份 → 地级市**两级下拉：先选省，城市下拉才会启用并列出该省有隐藏数据的城市，
选中即只看这个市的隐藏点位；确实无法归属的点（目前为 0）才留在 `hidden` 兜底集合。

省份/城市归属用 DataV GeoAtlas 的地级行政边界做**点在面内**判定（GCJ-02，与街景坐标同基准，无需投影转换）；
落在所有多边形外但距边界 120 km 内的点位（三沙岛礁、鸭绿江边）按最近行政区归属。

剑灵（Blade & Soul）游戏街景的坐标是虚构的，单独成集 `hidden_game`，在「腾讯游戏街景」分组下展示。

判定规则 `navigation-v1`（`tools/pano-mobility.js`）：实时请求 `sv.map.qq.com/sv?svid=&output=json`，
只有 `roads[].points` 的前后相邻帧、`vpoints[].link`、`all_scenes` 的相邻位才算「可移动」；
自引用、邻接为 `0,0`、坐标非法、元数据报错、`svid` 不匹配都不算。

- **能移动 = 常规街景，不得进入合集**；不能移动 = 隐藏街景。
- 剑灵（Blade & Soul）游戏街景在 `tools/data/tencent-game-exceptions.json` 登记为例外。
- 复核证据沉淀在 `tools/data/hidden-collection-verification.json`（73,320 条），
  `tools/purge_hidden_collection.py` 与导入工具默认读取它。

2026-10-24 曾据此清理过一批混入的常规街景（19,958 → 19,706），详见
[docs/hidden-cleanup-20261024.md](docs/hidden-cleanup-20261024.md)。

### 3.1 腾讯常规街景

导入的「隐藏街景」里往往混着可移动的常规点位。这类点位**不丢弃、也不放进隐藏合集**，
而是按省份单独成集（`qq_65` 新疆、`qq_37` 山东…，来源标记 `腾讯常规`），与隐藏合集并列展示。
行政区内缺区县边界数据时不做 adcode 拆分。

---

## 4. 采集与发布流程

1. **边界**：DataV GeoAtlas `areas_v3/bound/<adcode>.json`，缺失时回退锐多宝行政区划。
2. **种子**：边界内网格探测 `sv.map.qq.com/xf`（1–1.5 km 粗网格，密集区补 200 m 细网格）。
3. **扩散**：BFS 通过 `/sv` 的 `all_scenes` 扩展相邻场景，实时按边界过滤，支持断点续跑。
4. **缺口扫描**：对「整天没有记录、但前后一天有记录」的时间缺口逐日补扫，产出候选点位。
5. **移动性审计**：`tools/audit_gap_scan_mobility.mjs` 逐条核验可移动性（并发请求 + 断点续跑），
   只有不可移动的才允许进入隐藏合集；可移动的转投常规集合。
6. **合并入图**：`tools/merge_gap_scan.py` / `tools/merge_city_scan.py` 写入分片并更新 `data_meta.js`。
7. **重建派生索引**：`node --max-old-space-size=768 --expose-gc tools/build_viewer_index.js --with-search` 重算网格和完整搜索索引，原始城市点位不变。
8. **校验与无损压缩发布**：按顺序运行 hidden-grid、display-mode、search、disk-256 SID唯一性和fixtures；`python tools/build_gzip_site.py --output dist/pages --codec brotli --node node --workers 2 --brotli-quality 11 --brotli-lgwin 22`在全新目录完整逐字节回读验证，不额外发布原始大JS或重复gzip副本。
9. **上传与上线验收**：[专用 Pages 工作流](<.github/workflows/pages.yml>)只上传独立发布目录，保留1,000,000,000B门槛；同SHA部署成功后还须实际下载原始/压缩哈希并核对全批新SID和真实浏览器。旧gzip产物仍由加载器兼容；[Brotli迁移说明](<docs/brotli-publication-20261115.md>)记录参数和限制。

版本号写在 `city-viewer/index.html` 标题里，每次发布递增；按用户决定不再打包 APK 或发布 GitHub Releases。

---

## 5. 工具

| 工具 | 用途 |
|---|---|
| [tools/build_viewer_index.js](tools/build_viewer_index.js) | 重建网格；压缩发布前显式使用 `--with-search` 生成搜索索引 |
| [tools/build_gzip_site.py](<tools/build_gzip_site.py>) | 保留源字节，构建Brotli v2（兼容gzip v1）独立发布目录并逐字节/SHA验证 |
| [tools/brotli_asset_codec.cjs](<tools/brotli_asset_codec.cjs>) | 现有Node原生流式Brotli压缩／验证，拒绝截断和尾随流 |
| [tools/decode_brotli_asset.cjs](<tools/decode_brotli_asset.cjs>) | 线上下载文件的有界Brotli解压、双SHA/大小与尾随检查 |
| [tools/check_viewer_search.js](tools/check_viewer_search.js) | 回归验证搜索、地理/道路过滤与隐藏/游戏标记 |
| [tools/check_viewer_sid_unique.py](tools/check_viewer_sid_unique.py) | 全库 SID 唯一性、计数与注册游戏集合的实际源数据校验 |
| [tools/check_gzip_browser.js](tools/check_gzip_browser.js) | 实际浏览器验证压缩请求、搜索、坐标精度与多宽度布局 |
| `tools/check_viewer_hidden_grid.js` | 校验隐藏合集条数、网格与实际加载顺序一致 |
| `tools/check_viewer_display_mode.js` | 校验散点 / 密度模式在缩放与大结果集下的行为 |
| `tools/merge_city_scan.py` | 市级扫描结果合并（自动分片、更新元数据） |
| `tools/merge_gap_scan.py` | 缺口扫描候选合并，内置移动性门禁 |
| `tools/hidden_collection_rules.py` | 隐藏合集保留 / 导入判定策略 |
| `tools/pano-mobility.js` | 移动性判定实现（`navigation-v1`） |
| `tools/audit_gap_scan_mobility.mjs` | 候选点移动性审计（`navigation-v1`，16.7 点/秒配额内限速，JSONL 断点续跑） |
| `tools/import_gap_scan_batch.py` | 按审计结果分流导入：隐藏 → `hidden_<地级码>`，常规 → `qq_<省码>` |
| `tools/purge_hidden_collection.py` | 按审计结果清理合集 |
| `tools/build_hidden_viewer_data.py` | 由历史合并清单重建 `hidden_pano.js` |
| `tools/city-scan/` | 早期城市扫描流水线（BFS、全景抓取、拼装） |

测试：`python -m unittest discover -s tools/tests`、`node --test tools/tests/pano-mobility.test.js`。

---

## 6. 暂存区 `staging/`

未发布、待处理的数据放这里，**不进入查看器、不参与构建**。

| 已迁出批次 | 内容 | 数量 | 去向 |
|---|---|---|---|
| `baidu-xinjiang-20261025` | 百度街景（新疆） | 12,986 | 已迁至[百度仓库原件目录](<https://github.com/cn171g11/baidu-panorama-workbench/tree/main/sources/baidu-xinjiang-20261025>)并[上线查看](<https://cn171g11.github.io/baidu-panorama-workbench/city-viewer/?city=650100>) |

2026-11-14 按用户要求迁移；原件 SHA-256 保持不变，百度站点已逐片核对全部12,986点。腾讯正式数据和查看器不变，详见[迁移记录](<https://github.com/cn171g11/baidu-panorama-workbench/blob/1fac152642234a8b2eee61f8dad7aedbb48d6b00/docs/xinjiang-migration-20261114.md>)。

---

## 7. 区域与线路历史资料

已完成的腾讯旧点位归并沿用[既有合并记录](<docs/gansu-heilongjiang-import-20261103.md#L27-L40>)。2026-11-15 仅整理当前仓库根目录：将 **27 份历史原件**收拢，退休 **8 个旧工作台页面与 1 张预览图**；正式查看器、点位原字节、版本与线上部署不变，不重新导入或重扫旧 SID。

- [腾讯区域与线路归档](<city-viewer/legacy/tencent/>)：7 个区域的边界与历史说明，以及 G101/G102/G103/G106/G212/G312、南京溧水的线路 GeoJSON。**溧水是腾讯资料，不是百度资料**；旧边界和线路几何不等同于正式点位数组，保留原件。
- [S341 百度原件](<city-viewer/legacy/baidu/s341/s341-baidu-panoramas.json>)：独立保留 1,718 个百度街景记录，不属于腾讯正式集合。整个[历史归档](<city-viewer/legacy/>)均不加载、不发布。
- [新林历史边界](<city-viewer/legacy/tencent/xinlin/xinlin-boundary.geojson>)的属性实际写有“漠河县 / 232723 / 2017”，与[历史说明](<city-viewer/legacy/tencent/xinlin/README.md>)所称新林区冲突；只保留并注明疑点，不据文件名修正或导入。历史“未扫描/待恢复”不自动成为当前任务。

逐文件去向、大小、哈希与可回滚依据见[归档清单](<city-viewer/legacy/inventory.json>)及[本次收拢说明](<docs/repository-cleanup-20261115.md>)。原始点位分片和扫描状态已在此前整理中退出这些旧目录；本次不改变独立旧站迁移仓库或任何其他 GitHub 仓库。

---

## 8. 说明与免责

- 数据来自街景**非官方接口**，无 SLA，可能随时变更、限流或封禁。
- 仅采集元数据，未上传任何街景图片；图片版权归腾讯 / 百度所有，仅供研究用途。
- 百度（`baidu_pano`）与腾讯（`qq_pano`）数据来源、id 体系、坐标系不同，**不得混入同一集合**。
- 底图需自备 Key（天地图等）；GitHub Pages 无法隐藏浏览器端密钥，请使用限制 Origin 的 Key。
- 历史线路 GeoJSON 自带来源与坐标说明，不因归档改写坐标；OSM 线路几何沿用原始来源标注（ODbL）。

---

## 9. 版本号规则

从 `2.0.0` 起改用语义化版本 `主版本.功能版本.修订号`，不再一路 `1.0.xx`：

| 位 | 什么时候进位 | 例子 |
|---|---|---|
| 主版本 | 数据结构或查看器架构发生不兼容变化 | `1.x → 2.0.0`（隐藏合集按地级市拆分、版本体系切换） |
| 功能版本 | 新增数据批次、新页面、新交互 | `2.0.0 → 2.1.0`（下一批城市）、`2.2.0`（报告增强） |
| 修订号 | 只修 bug、改文案、调样式 | `2.1.0 → 2.1.1` |

已规划的版本线（按触发条件进位，不按时间）：

| 版本 | 触发条件 |
|---|---|
| `2.1.0` | 下一批城市街景导入（有新城市入图）——已完成：七市缺口扫描（2026-10-29） |
| `2.2.0` | 已完成：浙江全省 + 十市补扫（2026-10-29） |
| `2.3.0` | 已完成：香港全量街景（2026-10-30） |
| `2.4.0` | 已完成：海南全省 + 上海长江大桥补扫（2026-10-31） |
| `2.5.0` | 已完成：海南补扫并集（2026-10-31） |
| `2.6.0` | 已完成：地图导出入库（2026-10-31） |
| `2.7.0` | 已完成：湖北全省（2026-10-31） |
| `2.8.0` | 已完成：阿拉善地图导出（2026-10-31） |
| `2.9.0` | 已完成：长江隧道段补齐（2026-11-01） |
| `2.10.0` | 已完成：海南/香港补采（2026-11-01） |
| `2.11.0` | 已完成：北京全量入图（2026-11-01） |
| `2.12.0` | 已完成：海南逐点 BFS 补采（2026-11-01） |
| `2.13.0` | 已完成：海南续跑（2026-11-01） |
| `2.14.0` | 已完成：海南逐点 BFS 补采第三轮、队列清空（2026-11-01） |
| `2.15.0` | 已完成：西藏全区入图（2026-11-01） |
| `2.16.0` | 已完成：榆林地图导出入库（2026-11-01） |
| `2.17.0` | 已完成：华为地图底图亮色/暗色（2026-11-02） |
| `2.18.0` | 已完成：20 城缺口扫描入库 + 采集日期全量回填（2026-11-02） |
| `2.19.0` | 已完成：甘肃/黑龙江全省入图 + 仓库数据整理（2026-11-03） |
| `2.20.0` | 已完成：阿里补充扫描入库 2,396 点（2026-11-03） |
| `2.21.0` | 已完成：吉林全省入图（2026-11-03） |
| `2.21.0` | 报告页增强：导出 CSV、隐藏占比图表、按年份筛选 |
| `2.22.0` | 隐藏街景批量复核工具（按城市重跑移动性核验） |
| `3.0.0` | 接入百度街景统一展示，或改变数据存储格式 |

每次发布的明细见 `city-viewer/report.html` 的「更新公告」板块（数据在 `city-viewer/changelog.js`）。

---

## 10. 许可证

代码以 [GNU AGPL-3.0](LICENSE) 发布（2026-11-01 起）。街景图片版权归腾讯 / 百度所有，
本仓库仅收录元数据（panoid、坐标、路名、采集时间、朝向），数据部分免责见文首说明。
