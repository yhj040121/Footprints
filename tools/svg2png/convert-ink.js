// 把 pic/ink/ 下的水墨素材 SVG 预渲染成 PNG（复用 tabbar 图标同一套 resvg 管线）。
// 输出到 miniprogram/assets/{icons,buttons,titles,map,ink}/，目录结构对齐需求文档 §10。
const { Resvg } = require('@resvg/resvg-js');
const fs = require('fs');
const path = require('path');

const srcDir = path.resolve(__dirname, '../../pic/ink');
const root = path.resolve(__dirname, '../../miniprogram/assets');

// KaiTi 优先（品牌书法标题）；Windows 字体目录显式加载，保证不同机器一致
const fontFiles = [
  'C:/Windows/Fonts/simkai.ttf',
  'C:/Windows/Fonts/STKAITI.TTF',
].filter((f) => fs.existsSync(f));

const jobs = [
  // 功能图标（单色墨灰，同一套笔触）
  { file: 'icon-export.svg', out: 'icons/export-ink.png', width: 192 },
  { file: 'icon-info.svg', out: 'icons/info-ink.png', width: 192 },
  { file: 'icon-location.svg', out: 'icons/location-ink.png', width: 192 },
  { file: 'icon-calendar.svg', out: 'icons/calendar-ink.png', width: 192 },
  { file: 'icon-city.svg', out: 'icons/city-ink.png', width: 192 },
  { file: 'icon-footprint.svg', out: 'icons/footprint-ink.png', width: 192 },
  { file: 'icon-help.svg', out: 'icons/help-ink.png', width: 192 },
  { file: 'icon-delete.svg', out: 'icons/delete-ink.png', width: 192 },
  { file: 'icon-reset.svg', out: 'icons/reset-ink.png', width: 192 },
  // 按钮 / 标题
  { file: 'brush-dark.svg', out: 'buttons/brush-dark.png', width: 720 },
  { file: 'map-title.svg', out: 'titles/map-title.png', width: 780, fonts: true },
  // 地图水墨层（透明装饰）
  { file: 'map-left.svg', out: 'map/map-left.png', width: 480 },
  { file: 'map-bottom.svg', out: 'map/map-bottom.png', width: 1125 },
  { file: 'map-birds.svg', out: 'map/map-birds.png', width: 360 },
  { file: 'locate-ink.svg', out: 'map/locate-ink.png', width: 320 },
  { file: 'marker-dot.svg', out: 'map/marker-dot.png', width: 96 },
  { file: 'marker-fallback.svg', out: 'map/marker-fallback.png', width: 192 },
  // 卡片边角淡墨
  { file: 'card-edge-right.svg', out: 'ink/card-edge-right.png', width: 440 },
];

for (const j of jobs) {
  const svg = fs.readFileSync(path.join(srcDir, j.file), 'utf8');
  const opts = {
    fitTo: { mode: 'width', value: j.width },
    background: 'rgba(0,0,0,0)',
  };
  if (j.fonts && fontFiles.length) {
    opts.font = { fontFiles, loadSystemFonts: false, defaultFontFamily: 'KaiTi' };
  }
  const r = new Resvg(svg, opts);
  const png = r.render().asPng();
  const outPath = path.join(root, j.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, png);
  console.log(j.out, png.length, 'bytes');
}
