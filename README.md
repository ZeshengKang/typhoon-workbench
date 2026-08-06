# 路人王老康 BG5VJM 台风云图分析工具 · GitHub Pages 网页版

桌面版（exe）的网页版移植。纯静态站点，托管在 GitHub Pages，无需本地服务，也不产生本地缓存：每次打开都是全新页面，关闭浏览器即结束，不会在后台残留进程。

## 功能

- 核心卫星观测：AI‑VIS 可见光、IR‑BW 红外、红外增强、BD 增强云图、CMA 强度曲线
- Himawari‑9 全圆盘监测（真可见光 / B13 红外，24 小时 8 帧动图）
- 路径与模式预报：ECMWF 集合、GEFS（GFS 集合）、JTWC 正式路径
- 环境场诊断：云导风、海温、深层垂直风切变、总可降水量、850 hPa 涡度
- 时间轴回看历史（按天），CMA 数值随时间轴联动；不支持历史的区域自动隐藏
- 台风资料中心、术语与德沃夏克速查

下载图片 / 合成视频 / FFmpeg 等本地功能在网页版不可用（也不需要）。

## 数据来源与更新机制

浏览器直连（来源站已开启 CORS）：

- Dapiya API：当前风暴列表、帧列表、时间轴（实时）
- 中央气象台 typhoon.nmc.cn：最大风力、强度等级、位置、气压、历史路径（实时）
- 各类云图与环境场图片：直接以 `<img>` 加载，不依赖跨域许可

浏览器无法直接 fetch、由 GitHub Actions 每 15 分钟快照：

- `data/storms.json`：Tropical Tidbits 风暴卡、Weathernerds 模式图、CIMSS ADT、AI‑VIS 帧列表
- `data/himawari.json`：葵花 9 号全圆盘最新观测时次
- `data/sst.json` + `data/sst.png`：OSPO 混合海温图（OSPO 会拦截浏览器直连，所以由快照下载为本地静态图片）

快照文件都很小（合计约 35 KB）。就算 Actions 暂时没跑，页面也能正常显示 Dapiya 云图与 CMA 数值；没有快照时，ADT 显示“暂无分析”、AI‑VIS 只显示最新单帧。

## 部署到 GitHub Pages

### 方式一：GitHub 网页操作（推荐，无需命令行）

1. 在 GitHub 新建仓库（例如 `typhoon-workbench`），公开仓库才能免费使用 Pages。
2. 把本目录下所有文件（`index.html`、`app.js`、`style.css`、`assets/`、`data/`、`tools/`、`.github/`）上传到仓库默认分支（`main`）。
3. 仓库 Settings → Pages → Build and deployment → Source 选择 “GitHub Actions” 或 “Deploy from a branch”（main / root）。
4. 仓库 Actions 标签页会自动出现 `Refresh data snapshots` 工作流，先手动运行一次，之后每 15 分钟自动运行。
5. 等待约 1 分钟，访问 `https://<你的用户名>.github.io/<仓库名>/` 即可。

### 方式二：本地 Git 推送

```bash
git init
git add .
git commit -m "feat: 台风云图分析工具网页版 v3.8"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

推送后在仓库 Settings → Pages 选择从 main 分支部署。

## 版本与缓存

- 页面版本显示 v3.8（与桌面版一致），`style.css` / `app.js` 带 `?v=web1.35` 版本参数。
- 网页由浏览器缓存静态资源以加速再次访问；不会在本地写入任何程序缓存，关闭标签页即结束。

## 常见问题

- **部分图片加载慢 / 不显示**：云图来自境外数据站（CIMSS、Weathernerds、NICT），网络环境不同会有差异；环境场产品没有历史接口，时间轴回看时会自动隐藏。
- **ADT / TT 数值最多延迟 15 分钟**：这些资料来自 Actions 快照，与桌面版“读取当时”相比会略旧。
- **时间均为 UTC**：北京时间 = UTC + 8 小时。

## 版权说明

本工具仅展示公开来源站的资料。图像版权与再发布规则以 Dapiya、各原始卫星数据提供方及当地法律为准。
