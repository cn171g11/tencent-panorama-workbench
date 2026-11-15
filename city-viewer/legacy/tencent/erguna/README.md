# 额尔古纳市腾讯街景全量扫描数据（2026-10-10）

- 扫描方式：从市区中心种子点出发，沿 `all_scenes` 相邻采集点 BFS 爬行，额尔古纳市界多边形实时过滤
- 数据源：腾讯街景非官方接口（sv.map.qq.com /sv、sv1.map.qq.com /thumb /tile），GBK 解码
- 坐标过滤：阿里 DataV GeoAtlas `150784.json` 额尔古纳市边界

| 指标 | 数值 |
|---|---|
| 街景点（panoid）总数 | 29213 |
| 道路/路段数 | 21 |
| 采集年代 | 2013（soso 时期） |
| 经度范围 | 119.87137 ~ 120.83973 |
| 纬度范围 | 49.97947 ~ 51.49083 |
| 审图号 | GS(2018)1865号（接口返回） |

## 文件

- `erguna-panoramas.json`：全量清单（panoid/坐标/朝向/道路/采集时间）
- `erguna-panoids.json|.txt`：纯 panoid 列表
- `erguna-boundary.geojson`：额尔古纳市边界（adcode 150784）

## 说明

- 缩略图与高清全景图片体积过大（约 8GB），仅保留在本地数据目录，未上传本仓库
- `entrances` 字段已从清单剔除（会返回敏感地名），原始数据仅本地保留
- 可视化：根目录 `city-viewer/`（漠河/额尔古纳切换），或直接跳转 <https://qq-map.netlify.app/>
- 非官方接口无 SLA，随时可能变更；影像版权归腾讯，商用需解决授权
