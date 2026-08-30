// 草稿存储（S8 乐观保存）：点保存即落本地 storage，用户立即看到「已保存」；
// 完整审核/入库链路在后台异步推进（add 页 tab 不销毁，链路跨页面继续跑）：
//   - 成功 -> 删草稿，正式记录出现在时间线
//   - 失败 -> 草稿标记 failed + 原因，时间线显示「未同步」徽标，点击恢复进表单可改可重试
//   - 小程序被杀/切后台挂起 -> 链路中断，草稿留 syncing，时间线 sweep 超过 90s 的 syncing 标 failed
// 照片：tempFilePath 跨会话可能失效（恢复后显示占位，可删可换）；photoId 沿用可续跑断点
// （隔离区对象 12h 内有孤儿清理保护，断点续跑上传/审核状态均保留在草稿快照里）。
const KEY = 'footprint_drafts_v1';

function loadAll() {
  try {
    const v = wx.getStorageSync(KEY);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

function saveAll(list) {
  try {
    wx.setStorageSync(KEY, list);
  } catch (e) { /* storage 不可用时降级为内存态（本次会话内仍可用） */ }
}

function upsert(draft) {
  const list = loadAll();
  const i = list.findIndex((d) => d.id === draft.id);
  if (i >= 0) list[i] = draft;
  else list.push(draft);
  saveAll(list);
  return draft;
}

function get(id) {
  return loadAll().find((d) => d.id === id) || null;
}

function remove(id) {
  saveAll(loadAll().filter((d) => d.id !== id));
}

function listAll() {
  return loadAll();
}

module.exports = { upsert, get, remove, listAll, saveAll };
