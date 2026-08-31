# 溪山行旅（Footprints）

一款纯私人的旅行足迹记录微信小程序：记录「某年某月某日，我在哪里，干了什么」，只做个人记录，不做任何分享。

> 定位语：*把走过的路，写成自己的书。*

## 技术栈

- **前端**：微信原生三件套（WXML + WXSS + JavaScript, ES6）
- **后端**：微信云开发 CloudBase 云函数（Node.js），共 5 个：`login` / `secCheck` / `ossSts` / `delFootprint` / `geoResolve`
- **数据库**：云开发 NoSQL 文档型数据库（`user` / `footprint` 两个集合；足迹时间只到日，排序用服务端写入的 `createdAt`，无 `time` 字段）
- **照片存储**：阿里云 OSS（STS 直传隔离区 → 内容安全过审后服务端转正 `travel/` + 私有读 + URL 签名临时授权）
- **内容安全**：微信官方免费接口（`mediaCheckAsync` / `msgSecCheck`）

## 目录结构

```
miniprogram/       # 小程序前端
  pages/           # timeline(时间线) calendar(日历) add(新增/编辑) map(地图) detail(详情) mine(我的)
  components/      # 自定义组件（足迹卡片 / 模拟模式角标）
  utils/           # 请求封装 / OSS 直传 / 数据库访问 / 图片工具 / 日期工具 / mock 本地模拟
cloudfunctions/    # 云函数
  login/           # wx.login code → openid，建档/复用
  secCheck/        # 内容安全检测 + 入库把关（footprint 写库唯一入口）
  ossSts/          # OSS 隔离区上传凭证签发 + 签名 URL 签发
  delFootprint/    # 删除足迹（连坐清 OSS）+ 定时孤儿清理
  geoResolve/      # 腾讯位置服务逆地址解析（Key 仅放云函数环境变量）
```

> 项目文档（需求/设计/契约）不在本仓库中，仅保留在本地 `docs/`。

## 当前状态

- **V1.3 已完成代码改造**（2026-08-31）：时间轴首页重排 + 卡片长按导出/删除、足迹地图升级（统计栏/照片 Marker/虚线连线/底部详情卡片）、记录页「获取当前位置/选择位置」双路径与地区字段（`province/city/district/adcode/cityLabel/locationSource`）、水墨竖版/横版背景素材。新增云函数 `geoResolve`（腾讯位置服务逆地址解析，Key 仅配云函数环境变量）。
- 仓库默认 prod 环境（`USE_MOCK=false`）；本地开发用不入库的 `miniprogram/utils/config.local.js` 覆盖切 dev/mock（格式见同目录 `config.local.js.example`）。提审/发布前必须确认 prod 生效且页面「模拟模式」角标不出现。
- `node tools/smoke.js`：70/70 全绿（5 个云函数契约关键路径）。
- 待办：腾讯位置服务 Key 申请与配置（部署清单 §2.5）；开发者工具 + 真机联调验证。
