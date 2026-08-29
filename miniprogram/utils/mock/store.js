// mock 本地数据存储（USE_MOCK=true 时替代云数据库）
// 持久化到 storage，杀进程重进数据仍在；联调切真实环境后本文件不再被引用
const STORE_KEY = 'mock_footprints_v1';
const USER_KEY = 'mock_user_v1';
const IDEMPOTENT_KEY = 'mock_commit_map_v1';

function load(key, fallback) {
  try {
    const v = wx.getStorageSync(key);
    return v || fallback;
  } catch (e) {
    return fallback;
  }
}

function save(key, value) {
  try {
    wx.setStorageSync(key, value);
  } catch (e) { /* storage 不可用时降级为内存态 */ }
}

function getFootprints() {
  return load(STORE_KEY, null) || [];
}

function saveFootprints(list) {
  save(STORE_KEY, list);
}

function getUser() {
  return load(USER_KEY, null) || {
    openid: 'mock_openid_local',
    avatarUrl: null,
    nickname: '旅人_mock',
    customTags: ['沙漠'],
    createdAt: Date.now()
  };
}

function saveUser(user) {
  save(USER_KEY, user);
}

// clientSaveId → { footprintId, createdAt }（幂等标记，契约 §5.1）
function getCommitMap() {
  return load(IDEMPOTENT_KEY, null) || {};
}

function saveCommitMap(map) {
  save(IDEMPOTENT_KEY, map);
}

module.exports = {
  getFootprints,
  saveFootprints,
  getUser,
  saveUser,
  getCommitMap,
  saveCommitMap
};
