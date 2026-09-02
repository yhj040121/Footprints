var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// tools/secCheck-src/lib/errors.js
var require_errors = __commonJS({
  "tools/secCheck-src/lib/errors.js"(exports2, module2) {
    var CODE_MSG = {
      1001: "\u63D0\u4EA4\u5185\u5BB9\u6709\u8BEF\uFF0C\u8BF7\u91CD\u8BD5",
      1002: "\u767B\u5F55\u6001\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u8FDB\u5165\u5C0F\u7A0B\u5E8F",
      1003: "\u65E0\u6743\u64CD\u4F5C\u8BE5\u6570\u636E",
      1004: "\u8BB0\u5F55\u4E0D\u5B58\u5728\u6216\u5DF2\u88AB\u5220\u9664",
      2001: "\u6587\u5B57\u542B\u8FDD\u89C4\u5185\u5BB9\uFF0C\u8BF7\u4FEE\u6539",
      2002: "\u7167\u7247\u672A\u901A\u8FC7\u5B89\u5168\u68C0\u6D4B\uFF0C\u8BF7\u66F4\u6362",
      2003: "\u5BA1\u6838\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5",
      2004: "\u5B89\u5168\u68C0\u6D4B\u670D\u52A1\u4E0D\u53EF\u7528\uFF0C\u8BF7\u53CD\u9988\u5BA2\u670D\u5904\u7406",
      2005: "\u7167\u7247\u5BA1\u6838\u72B6\u6001\u5F02\u5E38\uFF0C\u8BF7\u91CD\u8BD5",
      3001: "\u7167\u7247\u670D\u52A1\u4E0D\u53EF\u7528\uFF0C\u8BF7\u53CD\u9988\u5BA2\u670D\u5904\u7406",
      9e3: "\u7CFB\u7EDF\u7E41\u5FD9\uFF0C\u8BF7\u53CD\u9988\u5BA2\u670D\u5904\u7406"
    };
    var BizError2 = class extends Error {
      constructor(code, data) {
        super(CODE_MSG[code] || CODE_MSG[9e3]);
        this.code = code;
        this.data = data || null;
      }
    };
    function ok2(data) {
      return { code: 0, message: "OK", data: data || null };
    }
    function fail2(code, data) {
      return { code, message: CODE_MSG[code] || CODE_MSG[9e3], data: data || null };
    }
    module2.exports = { CODE_MSG, BizError: BizError2, ok: ok2, fail: fail2 };
  }
});

// tools/secCheck-src/lib/oss.js
var require_oss = __commonJS({
  "tools/secCheck-src/lib/oss.js"(exports2, module2) {
    var OSS = require("ali-oss");
    var { BizError: BizError2 } = require_errors();
    var ENV = {
      OSS_AK_ID: process.env.OSS_AK_ID,
      OSS_AK_SECRET: process.env.OSS_AK_SECRET,
      OSS_BUCKET: process.env.OSS_BUCKET,
      OSS_REGION: process.env.OSS_REGION
    };
    function ossClient() {
      if (!ENV.OSS_AK_ID || !ENV.OSS_AK_SECRET || !ENV.OSS_BUCKET || !ENV.OSS_REGION) {
        throw new BizError2(3001);
      }
      return new OSS({
        region: ENV.OSS_REGION,
        accessKeyId: ENV.OSS_AK_ID,
        accessKeySecret: ENV.OSS_AK_SECRET,
        bucket: ENV.OSS_BUCKET,
        secure: true
        // S7-R2：签名 URL 用 https（Node 云函数侧 https 客户端拒绝 http 协议）
      });
    }
    module2.exports = { ENV, ossClient };
  }
});

// tools/secCheck-src/actions/push.js
var require_push = __commonJS({
  "tools/secCheck-src/actions/push.js"(exports2, module2) {
    var { ok: ok2 } = require_errors();
    var { ossClient } = require_oss();
    function normalizeEvent(raw) {
      if (Buffer.isBuffer(raw)) {
        try {
          return JSON.parse(raw.toString("utf8"));
        } catch (e) {
          return null;
        }
      }
      if (typeof raw === "string") {
        try {
          return JSON.parse(raw);
        } catch (e) {
          return null;
        }
      }
      return raw || null;
    }
    function isPushEvent2(raw) {
      let e = normalizeEvent(raw);
      if (!e) return false;
      if (e.EventData) e = normalizeEvent(e.EventData) || e;
      if (e.Event === "wxa_media_check" || e.event === "wxa_media_check") return true;
      if (e.action !== void 0) return false;
      const trace = e.TraceId || e.trace_id || e.traceId;
      const result = e.Result || e.result;
      return !!(trace && result);
    }
    function resolveStatus(result) {
      const errcode = result.errcode !== void 0 ? result.errcode : result.errcode2 !== void 0 ? result.errcode2 : void 0;
      const suggest = result.Suggest || result.suggest;
      if (errcode !== void 0 && errcode !== 0) return "error";
      if (suggest === "pass") return "pass";
      if (suggest === "risky" || suggest === "review") return "reject";
      return "error";
    }
    async function handlePush2(raw) {
      let e = normalizeEvent(raw);
      if (!e) return;
      if (e.EventData) e = normalizeEvent(e.EventData) || e;
      const traceId = e.TraceId || e.trace_id || e.traceId;
      if (!traceId) {
        console.warn("[secCheck.push] no traceId in push event:", JSON.stringify(e).slice(0, 500));
        return;
      }
      const result = e.Result || e.result || {};
      const pushOpenid = e.Openid || e.openid || e.FromUserName || "";
      const status = resolveStatus(result);
      const client = ossClient();
      let photoId = null;
      try {
        const obj = await client.get(`sec-check/task/_trace/${traceId}.json`);
        const map = JSON.parse(obj.content.toString("utf8"));
        if (!map || !map.photoId) return;
        if (pushOpenid && map.openid && pushOpenid !== map.openid) return;
        photoId = map.photoId;
      } catch (e2) {
        console.warn(`[secCheck.push] trace reverse map not found: ${traceId}`);
        return;
      }
      try {
        const obj = await client.get(`sec-check/task/${photoId}.json`);
        const task = JSON.parse(obj.content.toString("utf8"));
        if (task && task.openid === (pushOpenid || task.openid) && task.traceId === traceId && task.status === "pending") {
          task.status = status;
          task.updatedAt = Date.now();
          await client.put(`sec-check/task/${photoId}.json`, Buffer.from(JSON.stringify(task), "utf8"), {
            headers: { "Content-Type": "application/json" }
          });
          console.log(`[secCheck.push] task updated: photoId=${photoId} status=${status}`);
        }
      } catch (e2) {
        console.warn(`[secCheck.push] task not found for photoId=${photoId}`);
      }
    }
    module2.exports = { normalizeEvent, isPushEvent: isPushEvent2, handlePush: handlePush2 };
  }
});

// tools/secCheck-src/lib/constants.js
var require_constants = __commonJS({
  "tools/secCheck-src/lib/constants.js"(exports2, module2) {
    var crypto = require("crypto");
    var FIELD_WHITELIST = ["note", "place", "address", "province", "city", "district", "cityLabel", "customTag"];
    var MAX_TEXT_CHARS = 500;
    var MAX_TEXT_BYTES = 2500;
    var MAX_CUSTOM_TAG_CHARS = 6;
    var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    var KEY_RE = /^travel\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{16}\.(jpg|jpeg|png|webp|heic)$/;
    var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    function deterministicFootprintId(openid, clientSaveId) {
      return crypto.createHash("sha256").update(`${openid}:${clientSaveId}`).digest("hex").slice(0, 32);
    }
    module2.exports = {
      FIELD_WHITELIST,
      MAX_TEXT_CHARS,
      MAX_TEXT_BYTES,
      MAX_CUSTOM_TAG_CHARS,
      UUID_RE,
      KEY_RE,
      DATE_RE,
      deterministicFootprintId
    };
  }
});

// tools/secCheck-src/lib/security.js
var require_security = __commonJS({
  "tools/secCheck-src/lib/security.js"(exports2, module2) {
    var cloud2 = require("wx-server-sdk");
    var crypto = require("crypto");
    var https = require("https");
    var { BizError: BizError2 } = require_errors();
    var TEXT_CACHE_MAX = 50;
    function getDb() {
      return require("wx-server-sdk").database();
    }
    function todayCN() {
      return (/* @__PURE__ */ new Date()).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
    }
    function textHash(item) {
      return crypto.createHash("sha256").update(`v1\0${item.field}\0${item.content}`, "utf8").digest("hex").slice(0, 24);
    }
    async function readTextCache(openid) {
      try {
        const got = await getDb().collection("user").doc(openid).get();
        const c = got && got.data && got.data.secTextCache;
        if (!c || c.d !== todayCN() || !Array.isArray(c.h)) return null;
        return c;
      } catch (e) {
        return null;
      }
    }
    async function writeTextCache(openid, prev, hash) {
      try {
        const today = todayCN();
        const base = prev && prev.d === today ? prev.h : [];
        const h = base.includes(hash) ? base : [...base, hash].slice(-TEXT_CACHE_MAX);
        await getDb().collection("user").doc(openid).update({ data: { secTextCache: { d: today, h } } });
      } catch (e) {
        console.error("[secCheck.security] text cache write skipped:", e && e.errMsg || e);
      }
    }
    function securityIssue(stage, source) {
      const code = source && (source.errCode || source.errcode || source.code);
      const message = source && (source.errMsg || source.errmsg || source.message);
      return {
        stage,
        // 结构化错误码（如 45009=当日配额耗尽）：前端据此映射中文提示，绝不向用户透出英文 errMsg
        reasonCode: typeof code === "number" ? code : void 0,
        reason: [code, message].filter((v) => v !== void 0 && v !== null && String(v).length).join(" ").slice(0, 120) || "UNKNOWN_RESPONSE"
      };
    }
    async function checkText(item, openid) {
      let res;
      try {
        res = await cloud2.openapi.security.msgSecCheck({ content: item.content, version: 2, scene: 2, openid });
      } catch (e) {
        console.error("[secCheck.security] msgSecCheck error:", e);
        throw new BizError2(2004, securityIssue("text", e));
      }
      const errMsg = res && res.errMsg;
      const abnormal = !res || res.errCode !== 0 || typeof errMsg === "string" && errMsg.length > 0 && !/^openapi success$|:ok$/i.test(errMsg);
      if (abnormal) {
        console.error("[secCheck.security] msgSecCheck abnormal response:", JSON.stringify(res).slice(0, 500));
        throw new BizError2(2004, securityIssue("text", res));
      }
      const suggest = res.result && res.result.suggest;
      if (suggest === "pass") return { pass: true };
      if (typeof suggest === "string" && suggest.length > 0) return { pass: false };
      console.error("[secCheck.security] msgSecCheck result invalid:", JSON.stringify(res).slice(0, 500));
      throw new BizError2(2004, { stage: "text", reason: "RESULT_MISSING" });
    }
    async function checkTextCached(item, openid) {
      const hash = textHash(item);
      const cached = await readTextCache(openid);
      if (cached && cached.h.includes(hash)) return { pass: true, cached: true };
      const r = await checkText(item, openid);
      if (r.pass) await writeTextCache(openid, cached, hash);
      return r;
    }
    async function textFinalCheck(items, openid) {
      for (const item of items) {
        if (!item.content) continue;
        const { pass } = await checkTextCached(item, openid);
        if (!pass) throw new BizError2(2001, { results: [{ field: item.field, pass: false }] });
      }
    }
    async function verifyPhotos(photos, openid, client) {
      const resolved = [];
      for (const p of photos) {
        const photoId = p.photoId;
        let task = null;
        try {
          const obj = await client.get(`sec-check/task/${photoId}.json`);
          task = JSON.parse(obj.content.toString("utf8"));
        } catch (e) {
          throw new BizError2(2005);
        }
        if (!task || task.openid !== openid || task.status !== "pass") throw new BizError2(2005);
        let bind = null;
        try {
          const obj = await client.get(`sec-check/key/${photoId}.json`);
          bind = JSON.parse(obj.content.toString("utf8"));
        } catch (e) {
          throw new BizError2(2005);
        }
        if (!bind || bind.openid !== openid || typeof bind.imgKey !== "string" || typeof bind.travelKey !== "string") {
          throw new BizError2(2005);
        }
        try {
          const head = await client.head(bind.imgKey);
          const size = head && (head.size || head.res && head.res.headers && Number(head.res.headers["content-length"]));
          if (!head || head.res.status !== 200 || !(size > 0)) throw new BizError2(2005);
        } catch (e) {
          if (e instanceof BizError2) throw e;
          if (e && (e.status === 404 || e.code === "NoSuchKey")) throw new BizError2(2005);
          console.error("[secCheck.security] HEAD failed:", e);
          throw new BizError2(3001);
        }
        resolved.push({ photoId, imgKey: bind.imgKey, travelKey: bind.travelKey });
      }
      return resolved;
    }
    async function promotePhotos(resolved, client) {
      for (const r of resolved) {
        try {
          await client.copy(r.travelKey, r.imgKey);
          const head = await client.head(r.travelKey);
          const size = head && (head.size || head.res && head.res.headers && Number(head.res.headers["content-length"]));
          if (!head || head.res.status !== 200 || !(size > 0)) throw new Error("promote head check failed");
          console.log(`[secCheck.security] promoted: ${r.imgKey} -> ${r.travelKey}`);
        } catch (e) {
          console.error(`[secCheck.security] promote failed: photoId=${r.photoId}`, e);
          throw new BizError2(3001);
        }
      }
    }
    async function checkImageSync(buffer, openid) {
      let res;
      try {
        res = await cloud2.openapi.security.imgSecCheck({
          media: { contentType: "image/jpeg", value: buffer }
        });
      } catch (e) {
        if (e && (e.errCode === 87014 || /87014|risky/i.test(String(e.errMsg || "")))) return { pass: false };
        console.error("[secCheck.security] imgSecCheck error:", e);
        throw new BizError2(2004, securityIssue("image", e));
      }
      const errMsg = res && res.errMsg;
      if (res && res.errCode === 87014) return { pass: false };
      const abnormal = !res || res.errCode !== 0 || typeof errMsg === "string" && errMsg.length > 0 && !/^openapi success$|:ok$/i.test(errMsg);
      if (abnormal) {
        console.error("[secCheck.security] imgSecCheck abnormal response:", JSON.stringify(res).slice(0, 500));
        throw new BizError2(2004, securityIssue("image", res));
      }
      return { pass: true };
    }
    function fetchBuffer(url, timeoutMs = 1e4) {
      const u = String(url).replace(/^http:\/\//, "https://");
      return new Promise((resolve, reject) => {
        const req = https.get(u, (res2) => {
          if (res2.statusCode !== 200) {
            res2.resume();
            return reject(new Error("HTTP " + res2.statusCode));
          }
          const chunks = [];
          res2.on("data", (c) => chunks.push(c));
          res2.on("end", () => resolve(Buffer.concat(chunks)));
        });
        req.on("error", reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error("download timeout")));
      });
    }
    module2.exports = { checkText, checkTextCached, textFinalCheck, verifyPhotos, promotePhotos, checkImageSync, fetchBuffer };
  }
});

// tools/secCheck-src/actions/text.js
var require_text = __commonJS({
  "tools/secCheck-src/actions/text.js"(exports2, module2) {
    var { BizError: BizError2, ok: ok2, fail: fail2 } = require_errors();
    var { FIELD_WHITELIST, MAX_TEXT_CHARS, MAX_TEXT_BYTES, MAX_CUSTOM_TAG_CHARS } = require_constants();
    var { checkTextCached } = require_security();
    function getDb() {
      return require("wx-server-sdk").database();
    }
    async function getUserDoc(openid) {
      try {
        const got = await getDb().collection("user").doc(openid).get();
        return got && got.data ? got.data : null;
      } catch (e) {
        return null;
      }
    }
    async function appendCustomTags(openid, tagsToAdd) {
      const db = getDb();
      const merged = await db.runTransaction(async (transaction) => {
        let u = null;
        try {
          const got = await transaction.collection("user").doc(openid).get();
          u = got && got.data ? got.data : null;
        } catch (e) {
          u = null;
        }
        if (!u) throw new BizError2(9e3);
        const current = Array.isArray(u.customTags) ? u.customTags : [];
        const seen = new Set(current);
        const result = [...current];
        for (const t of tagsToAdd) {
          if (!t.length || t.length > MAX_CUSTOM_TAG_CHARS) throw new BizError2(1001);
          if (seen.has(t)) continue;
          seen.add(t);
          result.push(t);
        }
        if (result.length > 10) throw new BizError2(1001);
        await transaction.collection("user").doc(openid).update({ data: { customTags: result } });
        return result;
      });
      return merged;
    }
    async function handleText2(event, openid) {
      const texts = event.texts;
      if (!Array.isArray(texts) || texts.length < 1 || texts.length > 10) throw new BizError2(1001);
      const items = texts.map((item) => {
        const field = item && item.field;
        const content = item && item.content;
        if (!FIELD_WHITELIST.includes(field)) throw new BizError2(1001);
        if (typeof content !== "string" || content.length < 1 || content.length > MAX_TEXT_CHARS) throw new BizError2(1001);
        if (Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES) throw new BizError2(1001);
        if (field === "customTag" && content.length > MAX_CUSTOM_TAG_CHARS) throw new BizError2(1001);
        return { field, content };
      });
      const seenKeys = /* @__PURE__ */ new Set();
      for (const it of items) {
        const k = `${it.field}\0${it.content}`;
        if (seenKeys.has(k)) throw new BizError2(1001);
        seenKeys.add(k);
      }
      const results = [];
      for (const item of items) {
        const { pass } = await checkTextCached(item, openid);
        results.push({ field: item.field, pass });
      }
      let customTags = [];
      const passedCustomTags = items.filter((it, i) => it.field === "customTag" && results[i].pass).map((it) => it.content);
      if (passedCustomTags.length) {
        customTags = await appendCustomTags(openid, passedCustomTags);
      } else {
        const user = await getUserDoc(openid);
        customTags = user ? Array.isArray(user.customTags) ? user.customTags : [] : [];
      }
      const failed = results.filter((r) => !r.pass);
      if (failed.length) return fail2(2001, { pass: false, results, customTags });
      return ok2({ pass: true, results, customTags });
    }
    module2.exports = { handleText: handleText2 };
  }
});

// tools/secCheck-src/actions/image.js
var require_image = __commonJS({
  "tools/secCheck-src/actions/image.js"(exports2, module2) {
    var cloud2 = require("wx-server-sdk");
    var { BizError: BizError2, ok: ok2 } = require_errors();
    var { UUID_RE } = require_constants();
    var { ossClient } = require_oss();
    var { checkImageSync, fetchBuffer } = require_security();
    async function writeTaskRow(client, photoId, openid, status, traceId, err) {
      const task = { photoId, openid, status, traceId: traceId || null, createdAt: Date.now() };
      if (err) task.err = String(err).slice(0, 300);
      await client.put(`sec-check/task/${photoId}.json`, Buffer.from(JSON.stringify(task), "utf8"), {
        headers: { "Content-Type": "application/json" }
      });
      if (traceId) {
        await client.put(`sec-check/task/_trace/${traceId}.json`, Buffer.from(JSON.stringify({ photoId, openid }), "utf8"), {
          headers: { "Content-Type": "application/json" }
        });
      }
    }
    async function handleImageSubmit2(event, openid) {
      const photoId = event.photoId;
      if (typeof photoId !== "string" || !UUID_RE.test(photoId)) throw new BizError2(1001);
      const client = ossClient();
      let imgKey = null;
      try {
        const obj = await client.get(`sec-check/key/${photoId}.json`);
        const bind = JSON.parse(obj.content.toString("utf8"));
        if (bind && bind.openid === openid && typeof bind.imgKey === "string") imgKey = bind.imgKey;
      } catch (e) {
        imgKey = null;
      }
      if (!imgKey) throw new BizError2(1001);
      try {
        const head = await client.head(imgKey);
        const size = head && (head.size || head.res && head.res.headers && Number(head.res.headers["content-length"]));
        if (!head || head.res.status !== 200 || !(size > 0)) throw new BizError2(1001);
      } catch (e) {
        if (e instanceof BizError2) throw e;
        if (e && (e.status === 404 || e.code === "NoSuchKey")) throw new BizError2(1001);
        console.error("[secCheck.imageSubmit] HEAD isolated object failed:", e);
        throw new BizError2(3001);
      }
      try {
        let buffer = null;
        for (const w of [320, 480]) {
          const u = client.signatureUrl(imgKey, { expires: 600, process: "image/resize,w_" + w });
          const b = await fetchBuffer(u);
          buffer = b;
          if (b.length <= 1024 * 1024) break;
        }
        if (buffer && buffer.length <= 1024 * 1024) {
          const r = await checkImageSync(buffer, openid);
          const status = r.pass ? "pass" : "reject";
          await writeTaskRow(client, photoId, openid, status, null);
          console.log("[secCheck.imageSubmit] sync audit done:", photoId, status);
          return ok2({ checkId: photoId, status });
        }
        console.error("[secCheck.imageSubmit] resized buffer still >1MB, mark error");
        await writeTaskRow(client, photoId, openid, "error", null, "SYNC_FAIL: resize still >1MB");
        return ok2({ checkId: photoId, status: "error", err: "SYNC_FAIL: resize still >1MB" });
      } catch (e) {
        const why = e && (e.errMsg || e.message) || String(e);
        console.error("[secCheck.imageSubmit] sync audit failed:", why);
        await writeTaskRow(client, photoId, openid, "error", null, "SYNC_FAIL: " + why);
        return ok2({ checkId: photoId, status: "error", err: "SYNC_FAIL: " + why });
      }
    }
    async function handleImagePoll2(event, openid) {
      const checkIds = event.checkIds;
      if (!Array.isArray(checkIds) || checkIds.length < 1 || checkIds.length > 9) throw new BizError2(1001);
      if (checkIds.some((id) => typeof id !== "string" || !UUID_RE.test(id))) throw new BizError2(1001);
      if (new Set(checkIds).size !== checkIds.length) throw new BizError2(1001);
      const client = ossClient();
      const results = await Promise.all(
        checkIds.map(async (checkId) => {
          try {
            const obj = await client.get(`sec-check/task/${checkId}.json`);
            const task = JSON.parse(obj.content.toString("utf8"));
            if (!task || task.openid !== openid) return { checkId, status: "error" };
            const s = task.status;
            const r2 = { checkId, status: ["pending", "pass", "reject", "error"].includes(s) ? s : "pending" };
            if (task.err) r2.err = task.err;
            return r2;
          } catch (e) {
            return { checkId, status: "error" };
          }
        })
      );
      return ok2({ results });
    }
    module2.exports = { handleImageSubmit: handleImageSubmit2, handleImagePoll: handleImagePoll2 };
  }
});

// tools/secCheck-src/lib/validate.js
var require_validate = __commonJS({
  "tools/secCheck-src/lib/validate.js"(exports2, module2) {
    var { BizError: BizError2 } = require_errors();
    var { MAX_TEXT_CHARS, MAX_CUSTOM_TAG_CHARS, UUID_RE, KEY_RE, DATE_RE } = require_constants();
    function getDb() {
      return require("wx-server-sdk").database();
    }
    function beijingToday() {
      return new Date(Date.now() + 8 * 3600 * 1e3).toISOString().slice(0, 10);
    }
    function isValidDateString(s) {
      if (typeof s !== "string" || !DATE_RE.test(s)) return false;
      const [y, m, d] = s.split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
    }
    function validateSaveInput(event, oldTags) {
      const date = event.date;
      if (typeof date !== "string" || !isValidDateString(date)) throw new BizError2(1001);
      if (date > beijingToday()) throw new BizError2(1001);
      const place = event.place;
      if (typeof place !== "string" || place.trim().length < 1 || place.length > 50) throw new BizError2(1001);
      const hasLat = event.lat !== void 0 && event.lat !== null;
      const hasLng = event.lng !== void 0 && event.lng !== null;
      if (hasLat !== hasLng) throw new BizError2(1001);
      let lat = null;
      let lng = null;
      if (hasLat) {
        if (typeof event.lat !== "number" || typeof event.lng !== "number") throw new BizError2(1001);
        if (!Number.isFinite(event.lat) || !Number.isFinite(event.lng)) throw new BizError2(1001);
        if (event.lat < -90 || event.lat > 90 || event.lng < -180 || event.lng > 180) throw new BizError2(1001);
        lat = event.lat;
        lng = event.lng;
      }
      function optionalText(field, max) {
        const value = event[field] === void 0 || event[field] === null ? "" : event[field];
        if (typeof value !== "string" || value.length > max) throw new BizError2(1001);
        return value.trim();
      }
      const address = optionalText("address", 120);
      const province = optionalText("province", 30);
      const city = optionalText("city", 30);
      const district = optionalText("district", 30);
      const cityLabel = optionalText("cityLabel", 30);
      const adcode = optionalText("adcode", 12);
      if (adcode && !/^[0-9A-Za-z-]+$/.test(adcode)) throw new BizError2(1001);
      const locationSource = optionalText("locationSource", 10);
      if (locationSource && !["current", "choose", "legacy", "manual"].includes(locationSource)) throw new BizError2(1001);
      if (oldTags == null && hasLat && (locationSource === "current" || locationSource === "choose") && ![province, city, district, adcode, cityLabel].some(Boolean)) {
        throw new BizError2(1001);
      }
      const note = event.note === void 0 || event.note === null ? "" : event.note;
      if (typeof note !== "string" || note.length > MAX_TEXT_CHARS) throw new BizError2(1001);
      const rawTags = event.tags === void 0 || event.tags === null ? [] : event.tags;
      if (!Array.isArray(rawTags)) throw new BizError2(1001);
      const oldSet = oldTags == null ? null : oldTags instanceof Set ? oldTags : new Set(oldTags);
      const evalTags = oldSet ? rawTags.filter((t) => !oldSet.has(t)) : rawTags;
      if (evalTags.length > 3) throw new BizError2(1001);
      if (evalTags.some((t) => typeof t !== "string" || t.length < 1 || t.length > MAX_CUSTOM_TAG_CHARS)) throw new BizError2(1001);
      const tags = [...new Set(rawTags)];
      const photos = event.photos === void 0 || event.photos === null ? [] : event.photos;
      if (!Array.isArray(photos) || photos.length > 9) throw new BizError2(1001);
      const pidSeen = /* @__PURE__ */ new Set();
      const keySeen = /* @__PURE__ */ new Set();
      for (const p of photos) {
        if (!p || typeof p !== "object") throw new BizError2(1001);
        const hasKey = typeof p.key === "string";
        const hasPhotoId = typeof p.photoId === "string";
        if (hasKey === hasPhotoId) throw new BizError2(1001);
        if (hasKey) {
          if (!KEY_RE.test(p.key)) throw new BizError2(1001);
          if (keySeen.has(p.key)) throw new BizError2(1001);
          keySeen.add(p.key);
        } else {
          if (!UUID_RE.test(p.photoId)) throw new BizError2(1001);
          if (pidSeen.has(p.photoId)) throw new BizError2(1001);
          pidSeen.add(p.photoId);
        }
      }
      return {
        date,
        place,
        lat,
        lng,
        address,
        province,
        city,
        district,
        adcode,
        cityLabel,
        locationSource,
        note,
        tags,
        photos
      };
    }
    async function validateTags(tags, openid) {
      const custom = new Set(await getUserCustomTags(openid));
      const invalid = tags.filter((t) => !custom.has(t));
      if (invalid.length) throw new BizError2(1001);
    }
    async function validateTagsEdit(tags, openid, oldTags) {
      const old = oldTags instanceof Set ? oldTags : new Set(oldTags || []);
      const changed = tags.filter((t) => !old.has(t));
      if (!changed.length) return;
      const custom = new Set(await getUserCustomTags(openid));
      const invalid = changed.filter((t) => !custom.has(t));
      if (invalid.length) throw new BizError2(1001);
    }
    async function getUserCustomTags(openid) {
      let got;
      try {
        got = await getDb().collection("user").where({ openid }).limit(1).get();
      } catch (e) {
        console.error("[secCheck.validate] getUserCustomTags failed:", e);
        throw new BizError2(9e3);
      }
      const u = got && got.data && got.data[0];
      return Array.isArray(u && u.customTags) ? u.customTags : [];
    }
    module2.exports = { beijingToday, isValidDateString, validateSaveInput, validateTags, validateTagsEdit, getUserCustomTags };
  }
});

// tools/secCheck-src/actions/commit.js
var require_commit = __commonJS({
  "tools/secCheck-src/actions/commit.js"(exports2, module2) {
    var { BizError: BizError2, ok: ok2 } = require_errors();
    var { UUID_RE, KEY_RE, deterministicFootprintId } = require_constants();
    var { ossClient } = require_oss();
    var { validateSaveInput, validateTags, validateTagsEdit } = require_validate();
    var { textFinalCheck, verifyPhotos, promotePhotos } = require_security();
    function getDb() {
      return require("wx-server-sdk").database();
    }
    function isDuplicateKeyError(e) {
      if (!e) return false;
      if (e.errCode === -502001) return true;
      const msg = String(e.errMsg || e.message || "");
      return /duplicate|already exists|E11000/i.test(msg);
    }
    async function readFootprintDoc(id) {
      try {
        const got = await getDb().collection("footprint").doc(id).get();
        return got && got.data ? got.data : null;
      } catch (e) {
        return null;
      }
    }
    async function getOwnedFootprint(id, openid) {
      const doc = await readFootprintDoc(id);
      return doc && doc._openid === openid ? doc : null;
    }
    function toMs(ts) {
      if (!ts) return Date.now();
      if (typeof ts === "object" && ts.getTime) return ts.getTime();
      return Number(ts);
    }
    async function handleCommitSave2(event, openid) {
      const clientSaveId = event.clientSaveId;
      if (typeof clientSaveId !== "string" || !UUID_RE.test(clientSaveId)) throw new BizError2(1001);
      const client = ossClient();
      const commitKey = `sec-check/commit/${clientSaveId}.json`;
      const footprintId = deterministicFootprintId(openid, clientSaveId);
      let marker = null;
      try {
        const obj = await client.get(commitKey);
        marker = JSON.parse(obj.content.toString("utf8"));
      } catch (e) {
      }
      if (marker) {
        if (marker.openid === openid) {
          const existing = await getOwnedFootprint(footprintId, openid);
          if (!existing) throw new BizError2(1004);
          return ok2({ footprintId, createdAt: toMs(existing.createdAt) });
        }
        if (!marker.openid && typeof marker.footprintId === "string") {
          const doc = await readFootprintDoc(marker.footprintId);
          if (!doc) throw new BizError2(1004);
          if (doc._openid === openid) return ok2({ footprintId: marker.footprintId, createdAt: toMs(doc.createdAt) });
        }
      }
      const existingDoc = await getOwnedFootprint(footprintId, openid);
      if (existingDoc) {
        console.log(`[secCheck.commitSave] deterministic id hit: ${footprintId}`);
        return ok2({ footprintId, createdAt: toMs(existingDoc.createdAt) });
      }
      const input = validateSaveInput(event);
      await validateTags(input.tags, openid);
      const saveTexts = [
        { field: "place", content: input.place },
        { field: "note", content: input.note },
        { field: "address", content: input.address },
        { field: "province", content: input.province },
        { field: "city", content: input.city },
        { field: "district", content: input.district },
        { field: "cityLabel", content: input.cityLabel }
      ].filter((item) => item.content);
      await textFinalCheck(saveTexts.concat(input.tags.map((t) => ({ field: "customTag", content: t }))), openid);
      let resolved = [];
      if (input.photos.length) resolved = await verifyPhotos(input.photos, openid, client);
      if (resolved.length) await promotePhotos(resolved, client);
      try {
        await getDb().collection("footprint").add({
          data: {
            _id: footprintId,
            // S6-R2 修正：data 内指定确定性 _id（主幂等原子写）
            _openid: openid,
            // 云函数管理端 add 不自动带 _openid；客户端 read 规则 doc._openid==auth.openid 依赖它
            date: input.date,
            place: input.place,
            lat: input.lat,
            lng: input.lng,
            address: input.address,
            province: input.province,
            city: input.city,
            district: input.district,
            adcode: input.adcode,
            cityLabel: input.cityLabel,
            locationSource: input.locationSource,
            note: input.note,
            tags: input.tags,
            photos: resolved.map((r) => ({ key: r.travelKey })),
            // S6-R2：入库 key = 预绑定 travel key
            createdAt: getDb().serverDate()
            // 前端传的 createdAt 一律忽略
          }
        });
      } catch (e) {
        if (isDuplicateKeyError(e)) {
          const existing = await getOwnedFootprint(footprintId, openid);
          if (!existing) throw new BizError2(9e3);
          console.log(`[secCheck.commitSave] duplicate key, idempotent hit: ${footprintId}`);
          return ok2({ footprintId, createdAt: toMs(existing.createdAt) });
        }
        console.error("[secCheck.commitSave] add footprint failed:", e);
        throw new BizError2(9e3);
      }
      let createdAt = Date.now();
      const got = await getOwnedFootprint(footprintId, openid);
      if (got) createdAt = toMs(got.createdAt);
      try {
        await client.put(commitKey, Buffer.from(JSON.stringify({ footprintId, createdAt, openid }), "utf8"), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        console.error("[secCheck.commitSave] write commit marker failed, rollback doc:", e);
        try {
          await getDb().collection("footprint").doc(footprintId).remove();
        } catch (e2) {
          console.error("[secCheck.commitSave] rollback doc failed:", e2);
        }
        throw new BizError2(3001);
      }
      return ok2({ footprintId, createdAt });
    }
    async function handleCommitEdit2(event, openid) {
      const footprintId = event.footprintId;
      if (typeof footprintId !== "string" || !footprintId) throw new BizError2(1001);
      let fp;
      try {
        const res = await getDb().collection("footprint").where({ _id: footprintId, _openid: openid }).limit(1).get();
        fp = res.data[0];
      } catch (e) {
        console.error("[secCheck.commitEdit] query footprint failed:", e);
        throw new BizError2(9e3);
      }
      if (!fp) throw new BizError2(1004);
      const input = validateSaveInput(event, new Set(fp.tags || []));
      await validateTagsEdit(input.tags, openid, new Set(fp.tags || []));
      const client = ossClient();
      const oldKeys = (fp.photos || []).map((p) => p.key).filter((k) => typeof k === "string");
      const diffItems = [];
      if (input.place !== (fp.place || "")) diffItems.push({ field: "place", content: input.place });
      if (input.note !== (fp.note || "")) diffItems.push({ field: "note", content: input.note });
      ["address", "province", "city", "district", "cityLabel"].forEach((field) => {
        if (input[field] && input[field] !== (fp[field] || "")) diffItems.push({ field, content: input[field] });
      });
      const oldTags = new Set(fp.tags || []);
      for (const t of input.tags) {
        if (oldTags.has(t)) continue;
        diffItems.push({ field: "customTag", content: t });
      }
      await textFinalCheck(diffItems, openid);
      const newKeys = [];
      const newPhotoIds = [];
      for (const p of input.photos) {
        if (p.photoId) {
          newPhotoIds.push(p.photoId);
        } else {
          if (!oldKeys.includes(p.key)) throw new BizError2(1001);
          newKeys.push(p.key);
        }
      }
      let resolved = [];
      if (newPhotoIds.length) {
        resolved = await verifyPhotos(
          newPhotoIds.map((id) => ({ photoId: id })),
          openid,
          client
        );
        for (const r of resolved) newKeys.push(r.travelKey);
      }
      const removedKeys = event.removedKeys === void 0 || event.removedKeys === null ? [] : event.removedKeys;
      if (!Array.isArray(removedKeys) || removedKeys.some((k) => typeof k !== "string" || !KEY_RE.test(k))) {
        throw new BizError2(1001);
      }
      const expectedRemoved = oldKeys.filter((k) => !newKeys.includes(k));
      const removedSet = new Set(removedKeys);
      if (removedKeys.length !== expectedRemoved.length || expectedRemoved.some((k) => !removedSet.has(k))) {
        throw new BizError2(1001);
      }
      if (resolved.length) await promotePhotos(resolved, client);
      try {
        await getDb().collection("footprint").doc(footprintId).update({
          data: {
            date: input.date,
            place: input.place,
            lat: input.lat,
            lng: input.lng,
            address: input.address,
            province: input.province,
            city: input.city,
            district: input.district,
            adcode: input.adcode,
            cityLabel: input.cityLabel,
            locationSource: input.locationSource,
            note: input.note,
            tags: input.tags,
            photos: newKeys.map((k) => ({ key: k }))
          }
        });
      } catch (e) {
        console.error("[secCheck.commitEdit] update footprint failed:", e);
        throw new BizError2(9e3);
      }
      for (const k of removedKeys) {
        try {
          await client.delete(k);
        } catch (e) {
          console.error(`[secCheck.commitEdit] delete removed key failed (scan will cover): ${k}`, e);
        }
      }
      return ok2({ footprintId });
    }
    module2.exports = { handleCommitSave: handleCommitSave2, handleCommitEdit: handleCommitEdit2 };
  }
});

// tools/secCheck-src/source.js
var cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
var { ok, fail, BizError } = require_errors();
var { isPushEvent, handlePush } = require_push();
var { handleText } = require_text();
var { handleImageSubmit, handleImagePoll } = require_image();
var { handleCommitSave, handleCommitEdit } = require_commit();
exports.main = async (event, context) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;
    if (!openid && isPushEvent(event)) {
      await handlePush(event);
      return ok(null);
    }
    if (!openid) return fail(1002);
    const action = event && event.action;
    switch (action) {
      case "text":
        return await handleText(event, openid);
      case "imageSubmit":
        return await handleImageSubmit(event, openid);
      case "imagePoll":
        return await handleImagePoll(event, openid);
      case "commitSave":
        return await handleCommitSave(event, openid);
      case "commitEdit":
        return await handleCommitEdit(event, openid);
      default:
        return fail(1001);
    }
  } catch (e) {
    if (e instanceof BizError) return fail(e.code, e.data);
    console.error("[secCheck] unexpected error:", e);
    return fail(9e3);
  }
};
