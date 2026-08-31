/**
 * 经纬度逆地址解析。Key 只从云函数环境变量读取，不下发到小程序端。
 * 环境变量：TENCENT_MAP_KEY（腾讯位置服务 WebService API Key）
 */
const cloud = require('wx-server-sdk');
const https = require('https');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

function envelope(code, message, data) {
  return { code, message: message || '', data: data || null };
}

function validCoord(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function trimText(value, max) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function stripSuffix(value) {
  return trimText(value, 30).replace(/(特别行政区|自治州|地区|盟|市)$/u, '');
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 6000 }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          req.destroy(new Error('response too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error('http ' + res.statusCode));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(new Error('invalid json'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  if (!wxContext.OPENID) return envelope(1002, '登录状态已失效');

  const lat = Number(event && event.lat);
  const lng = Number(event && event.lng);
  if (!validCoord(lat, lng)) return envelope(1001, '位置坐标无效');

  const key = process.env.TENCENT_MAP_KEY;
  if (!key) return envelope(9000, '位置服务尚未配置，可先手动填写地区', { reason: 'MAP_KEY_MISSING' });

  const params = new URLSearchParams({
    key,
    location: lat + ',' + lng,
    get_poi: '0',
    output: 'json'
  });
  const url = 'https://apis.map.qq.com/ws/geocoder/v1/?' + params.toString();

  try {
    const body = await getJson(url);
    if (!body || body.status !== 0 || !body.result) {
      console.error('[geoResolve] upstream error:', body && body.status, body && body.message);
      return envelope(9000, '暂时无法识别该位置，可手动填写地区', {
        reason: 'UPSTREAM_' + String((body && body.status) || 'UNKNOWN')
      });
    }

    const result = body.result;
    const component = result.address_component || {};
    const adInfo = result.ad_info || {};
    const formatted = result.formatted_addresses || {};
    const refs = result.address_reference || {};
    const landmark = refs.landmark_l2 || refs.landmark_l1 || refs.famous_area || {};
    const fallbackPlace = trimText(event && event.fallbackPlace, 50);
    const place = fallbackPlace || trimText(landmark.title, 50) || trimText(formatted.recommend, 50) || trimText(result.address, 50);
    const city = trimText(component.city || adInfo.city, 30);

    return envelope(0, '', {
      place,
      address: trimText(result.address, 120),
      province: trimText(component.province || adInfo.province, 30),
      city,
      district: trimText(component.district || adInfo.district, 30),
      adcode: trimText(adInfo.adcode, 12),
      cityLabel: stripSuffix(city || adInfo.name || component.province),
      lat,
      lng
    });
  } catch (e) {
    console.error('[geoResolve] request failed:', e && e.message);
    return envelope(9000, '暂时无法识别该位置，可手动填写地区', { reason: 'NETWORK' });
  }
};
