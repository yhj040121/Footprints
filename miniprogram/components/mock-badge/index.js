// 「模拟模式」角标（防误发布守卫）：USE_MOCK=true 时各页右上角常驻提示
// 仓库默认 prod（USE_MOCK=false）；本地开发经 utils/config.local.js（不入库）切 dev 时出现
const config = require('../../utils/config');

Component({
  data: {
    visible: !!config.USE_MOCK
  }
});
