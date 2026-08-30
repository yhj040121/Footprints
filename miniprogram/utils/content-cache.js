// 足迹内容缓存：数据查询结果 + OSS 临时签名 URL。
// storage 跨页面、跨冷启动复用；按 openid 隔离，避免同设备切换账号时串数据。
const CONTENT_KEY = 'footprints_content_cache_v1';
const SIGNED_KEY = 'footprints_signed_url_cache_v1';
const CONTENT_TTL_MS = 15 * 60 * 1000;
const SIGN_MARGIN_MS = 60 * 1000;
const MAX_SIGNED_ITEMS = 500;

function scope() {
  try {
    const app = getApp();
    return (app && app.globalData && app.globalData.openid) || '';
  } catch (e) {
    return '';
  }
}

function readStorage(key, fallback) {
  try {
    const value = wx.getStorageSync(key);
    return value && typeof value === 'object' ? value : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    wx.setStorageSync(key, value);
  } catch (e) { /* 缓存不可写时直接降级为原网络读取流程 */ }
}

function getContent(key, maxAge) {
  const owner = scope();
  if (!owner) return { hit: false, value: null };
  const state = readStorage(CONTENT_KEY, { owner: '', entries: {} });
  if (state.owner !== owner) return { hit: false, value: null };
  const entry = state.entries && state.entries[key];
  const ttl = typeof maxAge === 'number' ? maxAge : CONTENT_TTL_MS;
  if (!entry || Date.now() - entry.savedAt > ttl) return { hit: false, value: null };
  return { hit: true, value: entry.value };
}

function setContent(key, value) {
  const owner = scope();
  if (!owner) return;
  let state = readStorage(CONTENT_KEY, { owner, entries: {} });
  if (state.owner !== owner) state = { owner, entries: {} };
  if (!state.entries || typeof state.entries !== 'object') state.entries = {};
  state.entries[key] = { savedAt: Date.now(), value };
  writeStorage(CONTENT_KEY, state);
}

function invalidateContent() {
  try {
    wx.removeStorageSync(CONTENT_KEY);
  } catch (e) { /* ignore */ }
}

function signedState() {
  const owner = scope();
  if (!owner) return { owner: '', entries: {} };
  const state = readStorage(SIGNED_KEY, { owner, entries: {} });
  if (state.owner !== owner) return { owner, entries: {} };
  if (!state.entries || typeof state.entries !== 'object') state.entries = {};
  return state;
}

function signedId(process, key) {
  return process + '\n' + key;
}

function getSigned(process, key) {
  const entry = signedState().entries[signedId(process, key)];
  if (!entry || !entry.url || entry.expireAt <= Date.now() + SIGN_MARGIN_MS) return null;
  return { url: entry.url, expireAt: entry.expireAt };
}

function getSignedMap(process) {
  const state = signedState();
  const prefix = process + '\n';
  const result = {};
  Object.keys(state.entries).forEach((id) => {
    if (id.indexOf(prefix) !== 0) return;
    const entry = state.entries[id];
    if (entry && entry.url && entry.expireAt > Date.now() + SIGN_MARGIN_MS) {
      result[id.slice(prefix.length)] = { url: entry.url, expireAt: entry.expireAt };
    }
  });
  return result;
}

function setSignedMany(process, urls) {
  const owner = scope();
  if (!owner || !Array.isArray(urls) || !urls.length) return;
  const state = signedState();
  state.owner = owner;
  const now = Date.now();
  Object.keys(state.entries).forEach((id) => {
    const entry = state.entries[id];
    if (!entry || entry.expireAt <= now + SIGN_MARGIN_MS) delete state.entries[id];
  });
  urls.forEach((item) => {
    if (!item || !item.key || !item.url || !item.expireAt) return;
    state.entries[signedId(process, item.key)] = {
      url: item.url,
      expireAt: item.expireAt
    };
  });
  const ids = Object.keys(state.entries);
  if (ids.length > MAX_SIGNED_ITEMS) {
    ids.sort((a, b) => state.entries[b].expireAt - state.entries[a].expireAt)
      .slice(MAX_SIGNED_ITEMS)
      .forEach((id) => { delete state.entries[id]; });
  }
  writeStorage(SIGNED_KEY, state);
}

module.exports = {
  getContent,
  setContent,
  invalidateContent,
  getSigned,
  getSignedMap,
  setSignedMany
};
