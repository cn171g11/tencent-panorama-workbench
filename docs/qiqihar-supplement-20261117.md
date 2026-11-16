# 齐齐哈尔补包导入（v2.48.0）

源包 `D:\Downloads\齐齐哈尔补.json` 共986个唯一SID。按用户要求先做navigation-v1审计，结果为hidden986、regular0、invalid/error0；源字段`isHidden`未直接决定分类。

严格使用当前黑龙江DataV GCJ-02区县面，并以代理获取的OSM齐齐哈尔市/区县关系作为边界核验来源；OSM原始WGS-84关系先转换为GCJ-02。243点落在齐齐哈尔市230200区县面内，写入`hidden_230200`；743点实际落在黑河市231100，未写入齐齐哈尔、不近邻猜测、不丢弃，保留[范围证据](../dist/qiqihar-supplement-20261117/scope-final.json)。

导入前全库SID排除为0，243点全部新增；保留旧hidden/game15和原始行/坐标策略。当前总点数59,454,210。固定索引、隐藏网格、显示、搜索、disk-256 SID唯一和Node/Python回归均需从本轮日志确认；齐齐哈尔新增点真实Edge本地发布检查通过后再提交。

完整临时Brotli发布站点847,139,540B，低于1GB门槛；跨市743点没有任何发布或导入。OSM镇/县关系的完整代理来源与SHA记录在`dist/qiqihar-supplement-20261117/osm-boundaries.json`，不把未经审查的OSM镇面静默写入正式边界资源。
