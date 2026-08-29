// 全局开关与部署配置（dev/prod 双配置）
// 【发布红线】仓库内默认 ACTIVE='prod'（USE_MOCK=false），任何人检出代码即为可提审状态。
// 本地开发要切 'dev'（全部接口走 utils/mock/ 本地模拟）时，创建不入库的覆盖文件
// miniprogram/utils/config.local.js（已在 .gitignore，格式见同目录 config.local.js.example）：
//     module.exports = { ACTIVE: 'dev' };
// 防误发布守卫：USE_MOCK=true 时 app.js 启动大字 console.warn 告警 +
// 各页右上角常驻「模拟模式」角标（components/mock-badge）。
// 提审/发布前必须确认：当前环境为 prod（无 config.local.js 生效）且「模拟模式」角标不出现。
const PROFILES = {
  dev: {
    USE_MOCK: true,
    ENV_ID: 'cloud1-d0ggqrvniff8be6b6'
  },
  prod: {
    USE_MOCK: false,
    ENV_ID: 'cloud1-d0ggqrvniff8be6b6'
  }
};

// 默认 prod；仅本地覆盖文件可切 dev
let ACTIVE = 'prod';
try {
  // eslint-disable-next-line global-require
  const local = require('./config.local');
  if (local && PROFILES[local.ACTIVE]) ACTIVE = local.ACTIVE;
} catch (e) {
  // 无 config.local.js（仓库常态）或内容非法：保持 prod
}

module.exports = Object.assign({ ACTIVE_PROFILE: ACTIVE }, PROFILES[ACTIVE]);
