// 临时冒烟（不入库）：验证 S6-R3 mock 的 customTag 服务端写入 + commitEdit 回读
global.wx = {
  _s: {},
  getStorageSync(k) { return this._s[k]; },
  setStorageSync(k, v) { this._s[k] = v; }
};
const mock = require('./miniprogram/utils/mock/index');
const store = require('./miniprogram/utils/mock/store');

(async () => {
  await mock.call('login', {});
  console.assert((store.getUser().customTags || []).join(',') === '沙漠', 'seed customTags: ' + JSON.stringify(store.getUser().customTags));

  // customTag 通过 → 服务端追加并返回完整数组
  const t1 = await mock.call('secCheck', { action: 'text', texts: [{ field: 'customTag', content: '星空' }] });
  console.assert(t1.code === 0, 'text ok');
  console.assert(JSON.stringify(t1.data.customTags) === JSON.stringify(['沙漠', '星空']), 'customTags returned: ' + JSON.stringify(t1.data.customTags));
  console.assert((store.getUser().customTags || []).join(',') === '沙漠,星空', 'store updated: ' + JSON.stringify(store.getUser().customTags));

  // 违规 customTag → 2001
  const t2 = await mock.call('secCheck', { action: 'text', texts: [{ field: 'customTag', content: '违规词' }] });
  console.assert(t2.code === 2001, 'rejected, got: ' + t2.code);

  // 超出 10 个 → 1001（填满到 10）
  for (const t of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) {
    const r = await mock.call('secCheck', { action: 'text', texts: [{ field: 'customTag', content: t }] });
    console.assert(r.code === 0, 'append ' + t + ' ok, got ' + r.code);
  }
  const over = await mock.call('secCheck', { action: 'text', texts: [{ field: 'customTag', content: 'zzz' }] });
  console.assert(over.code === 1001, 'over-limit 1001, got: ' + over.code);

  // commitEdit 回读：seed 记录改 place → footprintId 稳定，文档已更新
  const seed = store.getFootprints()[0];
  const edit = await mock.call('secCheck', { action: 'commitEdit', footprintId: seed._id, date: seed.date, place: '更新地点', note: '', tags: [], photos: (seed.photos || []).map((p) => ({ key: p.key })), removedKeys: [] });
  console.assert(edit.code === 0 && edit.data.footprintId === seed._id, 'commitEdit ok: ' + JSON.stringify(edit.data));
  const doc = store.getFootprints().find((f) => f._id === seed._id);
  console.assert(doc.place === '更新地点', 'doc updated: ' + doc.place);

  console.log('MOCK S6-R3 SMOKE OK');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
