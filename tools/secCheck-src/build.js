/**
 * build.js —— 把 tools/secCheck-src/source.js 打包为单文件部署入口
 *            cloudfunctions/secCheck/index.js（esbuild，内联 lib/ 与 actions/）。
 *
 * 背景：部分部署方式会遗漏子目录，云端报 Cannot find module './lib/errors'，
 *       故部署目录只保留 index.js / package.json / config.json 三个文件。
 *
 * 用法：改动 source.js / lib / actions 后执行
 *       node tools/secCheck-src/build.js
 *       然后重新部署 secCheck，并跑 node tools/smoke.js 验证。
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const srcDir = __dirname;
const outFile = path.resolve(srcDir, '../../cloudfunctions/secCheck/index.js');

execSync(
  // wx-server-sdk / ali-oss 为云端安装依赖，本地不存在，必须 external 留给云端运行时解析
  `npx -y esbuild "${path.join(srcDir, 'source.js')}" --bundle --platform=node --target=node16` +
  ' --external:wx-server-sdk --external:ali-oss' +
  ` --outfile="${outFile}"`,
  { stdio: 'inherit' }
);

const size = fs.statSync(outFile).size;
console.log(`bundled -> ${outFile} (${(size / 1024).toFixed(1)} KB)`);
