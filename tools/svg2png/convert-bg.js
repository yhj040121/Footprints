// 把 pic/ 下的页面水墨背景 SVG 预渲染成 PNG（微信 image 组件不支持 SVG，
// 且源图带 feGaussianBlur/feTurbulence 滤镜，须由支持滤镜的渲染器栅格化）。
// 产物：miniprogram/assets/bg/ink-bg.png（透明底，纸色由页面背景提供）
// 另出 preview-bg.png（垫纸色，仅供本地目检，不入 miniprogram）。
const { Resvg } = require('@resvg/resvg-js');
const fs = require('fs');
const path = require('path');

const src = path.resolve(__dirname, '../../pic/07_page_background_水墨山水背景.svg');
const outDir = path.resolve(__dirname, '../../miniprogram/assets/bg');
fs.mkdirSync(outDir, { recursive: true });

const svg = fs.readFileSync(src, 'utf8');

const transparent = new Resvg(svg, { fitTo: { mode: 'width', value: 750 }, background: 'rgba(0,0,0,0)' });
fs.writeFileSync(path.join(outDir, 'ink-bg.png'), transparent.render().asPng());
console.log('ink-bg.png', fs.statSync(path.join(outDir, 'ink-bg.png')).size, 'bytes');

const preview = new Resvg(svg, { fitTo: { mode: 'width', value: 750 }, background: '#F6F2E9' });
fs.writeFileSync(path.join(__dirname, 'preview-bg.png'), preview.render().asPng());
console.log('preview-bg.png', fs.statSync(path.join(__dirname, 'preview-bg.png')).size, 'bytes');
