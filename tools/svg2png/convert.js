// 把 pic/ 下的 6 个 tab SVG 预渲染成 PNG（微信 image 组件不支持 SVG，
// 且源文件带 feTurbulence/feDisplacementMap 水墨滤镜，须由支持滤镜的渲染器栅格化）
const { Resvg } = require('@resvg/resvg-js');
const fs = require('fs');
const path = require('path');

const srcDir = path.resolve(__dirname, '../../pic');
const outDir = path.resolve(__dirname, '../../miniprogram/assets/tabbar');
fs.mkdirSync(outDir, { recursive: true });

const jobs = [
  { file: '01_timeline_时间轴.svg', out: 'timeline.png', width: 384 },
  { file: '02_calendar_日历.svg', out: 'calendar.png', width: 384 },
  { file: '03_add_加号.svg', out: 'add.png', width: 384 },
  { file: '04_map_地图.svg', out: 'map.png', width: 384 },
  { file: '05_profile_我的.svg', out: 'mine.png', width: 384 },
  { file: '06_nav_background_底部导航背景.svg', out: 'nav-bg.png', width: 1500 },
];

for (const j of jobs) {
  const svg = fs.readFileSync(path.join(srcDir, j.file), 'utf8');
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: j.width },
    background: 'rgba(0,0,0,0)',
  });
  const png = r.render().asPng();
  fs.writeFileSync(path.join(outDir, j.out), png);
  console.log(j.out, png.length, 'bytes');
}
