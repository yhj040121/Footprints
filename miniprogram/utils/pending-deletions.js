// 乐观删除占位：确认删除后立即从各列表隐藏，云函数在后台完成两阶段删除。
// 仅保存短期 pending 状态；进程意外中断时会自动过期，避免记录永久被本地隐藏。
const STORAGE_KEY = 'footprints_pending_deletions_v1';
const MAX_PENDING_MS = 3 * 60 * 1000;

function owner() {
  try {
    const app = getApp();
    return (app && app.globalData && app.globalData.openid) || '';
  } catch (e) {
    return '';
  }
}

function read() {
  const currentOwner = owner();
  let state = { owner: currentOwner, entries: {} };
  try {
    const stored = wx.getStorageSync(STORAGE_KEY);
    if (stored && stored.owner === currentOwner && stored.entries) state = stored;
  } catch (e) { /* storage 不可用时降级为空状态 */ }
  const now = Date.now();
  let changed = false;
  Object.keys(state.entries).forEach((id) => {
    if (!state.entries[id] || now - state.entries[id] > MAX_PENDING_MS) {
      delete state.entries[id];
      changed = true;
    }
  });
  if (changed) write(state);
  return state;
}

function write(state) {
  try {
    wx.setStorageSync(STORAGE_KEY, state);
  } catch (e) { /* ignore */ }
}

function mark(id) {
  if (!id) return;
  const state = read();
  state.owner = owner();
  state.entries[id] = Date.now();
  write(state);
}

function clear(id) {
  if (!id) return;
  const state = read();
  delete state.entries[id];
  write(state);
}

function isPending(id) {
  return !!(id && read().entries[id]);
}

function filter(list) {
  const entries = read().entries;
  return (list || []).filter((item) => item && !entries[item._id]);
}

module.exports = { mark, clear, isPending, filter };
