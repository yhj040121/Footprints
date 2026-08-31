// mock 种子数据：首次进入 mock 模式时注入一批示例足迹（覆盖多日期/有图/无图/有坐标/无坐标）
// 照片 key 形如 travel/YYYY/MM/DD/mockNN.jpg，mock sign 会映射到本地 assets/mock/ 图片
const seed = [
  { date: '2026-08-29', place: '无锡·鼋头渚', lat: 31.54, lng: 120.28, note: '雨天苔滑，但荷花开了。', tags: ['山水', '初秋'], photos: ['mock01', 'mock02'] },
  { date: '2026-08-29', place: '无锡·惠山古镇', lat: 31.58, lng: 120.26, note: '傍晚的祠堂街很安静。', tags: ['古镇'], photos: ['mock03'] },
  { date: '2026-08-21', place: '苏州·平江路', lat: 31.31, lng: 120.63, note: '溪水潺潺，古桥横卧，炊烟袅袅起。', tags: ['古镇', '晴天'], photos: ['mock04'] },
  { date: '2026-08-12', place: '杭州·西湖', lat: 30.25, lng: 120.15, note: '湖光潋滟，柳色轻拂，一叶扁舟过。', tags: ['山水', '人文'], photos: ['mock05', 'mock06'] },
  { date: '2026-08-03', place: '公司楼下', note: '一条纯文字记录：今天加班到晚霞。', tags: [], photos: [] },
  { date: '2026-07-19', place: '安徽·黄山', lat: 30.13, lng: 118.16, note: '云海翻涌，奇松怪石，登高望远。', tags: ['徒步', '山水'], photos: ['mock07'] },
  { date: '2026-07-02', place: '南京·玄武湖', lat: 32.07, lng: 118.79, note: '荷风送香气。', tags: ['晴天'], photos: ['mock08'] },
  { date: '2026-06-15', place: '江西·婺源', lat: 29.25, lng: 117.86, note: '油菜花已过季，田野依旧金黄。', tags: ['人文'], photos: ['mock01'] },
  { date: '2026-05-18', place: '浙江·楠溪江', lat: 28.36, lng: 120.69, note: '溪水潺潺，烟雨朦胧，小桥人家。', tags: ['山水', '古镇'], photos: ['mock02', 'mock03', 'mock04'] },
  { date: '2026-04-03', place: '山西·平遥', lat: 37.2, lng: 112.17, note: '古城深巷，晋商遗风。', tags: ['古镇', '人文'], photos: ['mock05'] },
  { date: '2026-03-12', place: '福建·东山岛', lat: 23.7, lng: 117.43, note: '海风拂面，落日熔金。', tags: ['晴天'], photos: ['mock06'] },
  { date: '2025-12-01', place: '北京·颐和园', lat: 39.99, lng: 116.27, note: '补记：冬日昆明湖结了薄冰。', tags: ['人文'], photos: ['mock07'] }
];


// 地点关键词 → 行政地区（V1.3：与真实记录地区口径一致）
const REGION_RULES = [
  ['无锡', '江苏省', '无锡市', '滨湖区'],
  ['苏州', '江苏省', '苏州市', '姑苏区'],
  ['杭州', '浙江省', '杭州市', '西湖区'],
  ['黄山', '安徽省', '黄山市', '黄山区'],
  ['南京', '江苏省', '南京市', '玄武区'],
  ['婺源', '江西省', '上饶市', '婺源县'],
  ['楠溪江', '浙江省', '温州市', '永嘉县'],
  ['平遥', '山西省', '晋中市', '平遥县'],
  ['东山岛', '福建省', '漳州市', '东山县'],
  ['北京', '北京市', '北京市', '海淀区']
];

function regionFor(place) {
  const hit = REGION_RULES.find((r) => place.indexOf(r[0]) >= 0);
  if (!hit) return { address: '', province: '', city: '', district: '', adcode: '', cityLabel: '', locationSource: 'legacy' };
  return {
    address: hit[1] + hit[2] + hit[3] + place,
    province: hit[1],
    city: hit[2],
    district: hit[3],
    adcode: '',
    cityLabel: hit[2].replace(/市$/, ''),
    locationSource: 'legacy'
  };
}


function buildSeed() {
  const base = Date.now();
  return seed.map((s, i) => Object.assign({
    _id: 'mock_fp_' + (i + 1),
    date: s.date,
    place: s.place,
    lat: typeof s.lat === 'number' ? s.lat : null,
    lng: typeof s.lng === 'number' ? s.lng : null,
    note: s.note || '',
    tags: s.tags || [],
    photos: (s.photos || []).map((name) => ({
      key: 'travel/' + s.date.replace(/-/g, '/') + '/' + name + '.jpg'
    })),
    // createdAt 递减，保证同日多条有稳定先后（后建的排前）
    createdAt: base - i * 60000
  }, regionFor(s.place)));
}

module.exports = { buildSeed };
