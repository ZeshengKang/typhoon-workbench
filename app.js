"use strict";

const $ = id => document.getElementById(id);
const DAPIYA_API = "https://api.dapiya.top";
const DAPIYA_DATA = "https://data.dapiya.top";
const CMA_LIST_URL = "https://typhoon.nmc.cn/weatherservice/typhoon/jsons/list_default";
const CMA_VIEW_URL = id => `https://typhoon.nmc.cn/weatherservice/typhoon/jsons/view_${id}`;
const HIMAWARI_TILE_BASE = "https://jh190005-4.kudpc.kyoto-u.ac.jp/himawari/img";
const WEATHERNERDS_IMG = "https://www.weathernerds.org/tc_guidance/images";
const SNAPSHOT_STORMS = "./data/storms.json";
const SNAPSHOT_HIMAWARI = "./data/himawari.json";
const SNAPSHOT_SST = "./data/sst.json";
const STORM_RE = /^[0-9]{2}[A-Z]$/;
const FRAME_RE = /_(\d{14})\.(?:png|jpe?g|webp)$/i;
const ENVIRONMENT_PRODUCTS = [{
  id: "wavetrak",
  title: "可见光 / 红外云导风",
  subtitle: "Wavetrak · CIMSS",
  image: "https://tropic.ssec.wisc.edu/real-time/wavetrak/domains/windNWPAC.gif",
  source: "https://tropic.ssec.wisc.edu/real-time/wavetrakmainDOM.php?prod=wind&basin=NWPAC",
  shape: "full",
  animated: true
}, {
  id: "sst",
  title: "海洋表面水温",
  subtitle: "OSPO Blended 5km 海温 · 夜间",
  image: "",
  source: "https://www.ospo.noaa.gov/products/ocean/sst/blended_sst_5km.html?product=bno",
  shape: "full"
}, {
  id: "shear",
  title: "深层垂直风切变",
  subtitle: "200–850 hPa · CIMSS",
  image: "https://tropic.ssec.wisc.edu/real-time/westpac/winds/wgmsshr.GIF",
  source: "https://tropic.ssec.wisc.edu/real-time/windmain.php?basin=westpac&sat=wgms&prod=shr",
  shape: "full"
}, {
  id: "tpw",
  title: "总可降水量动画",
  subtitle: "MIMIC-TPW · 最近 24 小时",
  image: "https://tropic.ssec.wisc.edu/real-time/mtpw2/webAnims/tpw_nrl_colors/wpac/mimictpw_wpac_latest.gif",
  source: "https://tropic.ssec.wisc.edu/real-time/mtpw2/product.php?color_type=tpw_nrl_colors&prod=wpac&timespan=24hrs&anim=html5",
  shape: "full",
  animated: true
}, {
  id: "vorticity",
  title: "850 hPa 相对涡度",
  subtitle: "低层旋转环境 · CIMSS",
  image: "https://tropic.ssec.wisc.edu/real-time/westpac/winds/wgmsvor.GIF",
  source: "https://tropic.ssec.wisc.edu/real-time/windmain.php?basin=westpac&sat=wgms&prod=vor",
  shape: "full"
}];
const CMA_LEVEL_LABELS = {
  TD: "热带低压",
  TS: "热带风暴",
  STS: "强热带风暴",
  TY: "台风",
  STY: "强台风",
  SuperTY: "超强台风"
};
let wpDashboard = null;
let wpStormId = "";
let wpTimeline = null;
let wpSelectedDate = null;
let wpLoadInFlight = false;
let wpRefreshTimer = null;
let wpAnimTimers = {};
let wpAnimPlayers = {};
let snapshotStorms = null;
let snapshotHimawari = null;
let snapshotSst = null;
let frameCache = new Map();
let cmaCache = null;
const weathernerdsHistoryCache = {};
async function fetchText(url, timeout = 15000, cache = "no-store") {
  let controller = null;
  let timer = null;
  try {
    controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeout);
  } catch (error) {
    controller = null;
  }
  try {
    const options = {
      cache
    };
    if (controller) options.signal = controller.signal;
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function fetchJSON(url, timeout = 15000, cache = "no-cache") {
  const text = await fetchText(url, timeout, cache);
  return JSON.parse(text);
}
function stripJsonp(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("JSONP 包裹格式异常");
  return text.slice(start, end + 1);
}
function toIso(stamp) {
  if (!/^\d{14}$/.test(String(stamp))) return "";
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}Z`;
}
function formatDateLabel(date) {
  const pad = n => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
function formatFrameTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = n => String(n).padStart(2, "0");
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}
function displayUtc(value) {
  if (!value) return "—";
  return new Date(value).toISOString().replace("T", " ").replace(".000Z", " UTC");
}
function formatCoordinate(value, positive, negative) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return `${Math.abs(Number(value)).toFixed(1)}°${Number(value) >= 0 ? positive : negative}`;
}
function windForceFromMps(mps) {
  if (mps == null) return null;
  let force = 12;
  const thresholds = [[32.7, 12], [37.0, 13], [41.5, 14], [46.2, 15], [51.0, 16], [56.1, 17]];
  for (const [threshold, level] of thresholds) {
    if (mps >= threshold) force = level;
  }
  return force;
}
function imageExists(url, timeout = 10000) {
  return new Promise(resolve => {
    const probe = new Image();
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeout);
    probe.onload = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(true);
      }
    };
    probe.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(false);
      }
    };
    probe.src = url;
  });
}
function probeFirst(candidates, timeout = 8000) {
  return new Promise(resolve => {
    let settled = false;
    let pending = candidates.length;
    if (!pending) {
      resolve(null);
      return;
    }
    const settle = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    candidates.forEach(url => {
      imageExists(url, timeout).then(ok => {
        if (ok) settle(url);else if (--pending <= 0) settle(null);
      });
    });
  });
}
function showToast(message) {
  let toast = $("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("show"), 3500);
}
function setStageLoading(stage, active) {
  if (!stage) return;
  let overlay = stage.querySelector(".media-loading");
  if (active) {
    const img = stage.querySelector("img");
    if (img && img.naturalWidth > 0) active = false;
  }
  if (active && !overlay) {
    overlay = document.createElement("div");
    overlay.className = "media-loading";
    overlay.innerHTML = "<b>加载中<i></i><i></i><i></i></b>";
    stage.appendChild(overlay);
  }
  if (overlay) overlay.hidden = !active;
  if (overlay && !overlay._poll) {
    overlay._poll = setInterval(() => {
      const img = stage.querySelector("img");
      if (img && img.naturalWidth > 0) {
        clearInterval(overlay._poll);
        overlay._poll = null;
        overlay.hidden = true;
      }
    }, 300);
  } else if (overlay && !active && overlay._poll) {
    clearInterval(overlay._poll);
    overlay._poll = null;
  }
}
async function loadSnapshotStorms(force = false) {
  try {
    snapshotStorms = await fetchJSON(SNAPSHOT_STORMS + (force ? `?t=${Date.now()}` : ""));
  } catch (error) {
    snapshotStorms = snapshotStorms || null;
  }
  return snapshotStorms;
}
async function loadSnapshotHimawari(force = false) {
  try {
    snapshotHimawari = await fetchJSON(SNAPSHOT_HIMAWARI + (force ? `?t=${Date.now()}` : ""));
  } catch (error) {
    snapshotHimawari = snapshotHimawari || null;
  }
  return snapshotHimawari;
}
async function loadSnapshotSst(force = false) {
  try {
    snapshotSst = await fetchJSON(SNAPSHOT_SST + (force ? `?t=${Date.now()}` : ""));
  } catch (error) {
    snapshotSst = snapshotSst || null;
  }
  return snapshotSst;
}
async function fetchDapiyaStorms() {
  const text = await fetchText(`${DAPIYA_API}/typhoon/meso/all`, 15000);
  const storms = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const group = index === 0 ? "Mesoscale" : "Floater";
    for (const item of line.split("|")) {
      const trimmed = item.trim();
      const stormId = trimmed.slice(0, 3).toUpperCase();
      if (!STORM_RE.test(stormId)) continue;
      const parts = trimmed.split(".");
      storms.push({
        id: stormId,
        name: trimmed,
        displayName: parts[1] || trimmed.slice(3) || stormId,
        group
      });
    }
  });
  return storms;
}
async function fetchFrameList(storm, layer, limit) {
  const key = `${storm}:${layer}`;
  const cached = frameCache.get(key);
  if (cached && cached.limit >= limit && Date.now() - cached.fetchedAt < 10 * 60 * 1000) return cached.frames;
  const url = `${DAPIYA_API}/typhoon/${encodeURIComponent(storm)}/piclist/${encodeURIComponent(layer)}/${limit}`;
  const text = await fetchText(url, 25000);
  const frames = [];
  for (const raw of text.split(",")) {
    const path = raw.trim();
    const match = path.match(FRAME_RE);
    if (!path || !match) continue;
    const iso = toIso(match[1]);
    if (!iso) continue;
    frames.push({
      url: `${DAPIYA_DATA}${path}`,
      path,
      time: iso
    });
  }
  frames.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0);
  frameCache.set(key, {
    frames,
    limit,
    fetchedAt: Date.now()
  });
  return frames;
}
function frameNear(frames, targetIso, maxGapHours = 18) {
  if (!frames || !frames.length || !targetIso) return null;
  const target = new Date(targetIso).getTime();
  let best = null;
  let bestGap = Infinity;
  for (const frame of frames) {
    const gap = Math.abs(new Date(frame.time).getTime() - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = frame;
    }
  }
  return best && bestGap <= maxGapHours * 3600 * 1000 ? best : null;
}
function parseCmaDetail(payload) {
  const typhoon = payload && payload.typhoon;
  if (!typhoon || typhoon.length < 9) return null;
  const points = typhoon[8] || [];
  if (!points.length) return null;
  const latest = points[points.length - 1];
  if (!latest || latest.length < 12) return null;
  const track = [];
  for (const point of points) {
    if (!point || point.length < 8) continue;
    const time = String(point[1] || "");
    const level = String(point[3] || "");
    const wind = point[7] != null ? Number(point[7]) : null;
    const pressure = point[6] != null ? Number(point[6]) : null;
    const lon = point[4] != null ? Number(point[4]) : null;
    const lat = point[5] != null ? Number(point[5]) : null;
    if (time.length !== 12) continue;
    track.push({
      time: `${time.slice(4, 6)}-${time.slice(6, 8)} ${time.slice(8, 10)}:00`,
      wind_mps: wind,
      pressure: pressure,
      longitude: lon,
      latitude: lat,
      level: CMA_LEVEL_LABELS[level] || level
    });
  }
  const forecast = [];
  const forecastDict = latest[11] || {};
  const babj = Array.isArray(forecastDict.BABJ) ? forecastDict.BABJ : [];
  for (const item of babj) {
    if (!Array.isArray(item) || item.length < 8) continue;
    const itemTime = String(item[1] || "");
    const itemLon = item[2] != null ? Number(item[2]) : null;
    const itemLat = item[3] != null ? Number(item[3]) : null;
    if (itemTime.length !== 12 || itemLat == null || itemLon == null) continue;
    forecast.push({
      hour: item[0],
      time: `${itemTime.slice(4, 6)}-${itemTime.slice(6, 8)} ${itemTime.slice(8, 10)}:00`,
      longitude: itemLon,
      latitude: itemLat,
      pressure: item[4] != null ? Number(item[4]) : null,
      wind_mps: item[5] != null ? Number(item[5]) : null
    });
  }
  const levelCode = String(latest[3] || "");
  const windMps = latest[7] != null ? Number(latest[7]) : null;
  const timeRaw = String(latest[1] || "");
  let observationTime = "";
  if (timeRaw.length === 12) {
    observationTime = `${timeRaw.slice(4, 6)}月${timeRaw.slice(6, 8)}日 ${timeRaw.slice(8, 10)}:${timeRaw.slice(10, 12)} 北京时间`;
  }
  return {
    chinese_name: typhoon[2] || "",
    english_name: String(typhoon[1] || "").toUpperCase(),
    cma_no: typhoon[3] || "",
    level: CMA_LEVEL_LABELS[levelCode] || levelCode,
    wind_force: windForceFromMps(windMps),
    wind_force_label: windMps != null ? `${windForceFromMps(windMps)}级` : "",
    wind_mps: windMps,
    pressure_hpa: latest[6] != null ? Number(latest[6]) : null,
    latitude: latest[5] != null ? Number(latest[5]) : null,
    longitude: latest[4] != null ? Number(latest[4]) : null,
    observation_time: observationTime,
    track: track,
    forecast: forecast,
    source: CMA_VIEW_URL(typhoon[0])
  };
}
async function fetchCmaData() {
  try {
    const listText = await fetchText(CMA_LIST_URL, 15000);
    const listPayload = JSON.parse(stripJsonp(listText));
    const items = listPayload.typhoonList || [];
    const startIds = items.filter(item => item && item.length > 7 && item[7] === "start").map(item => item[0]);
    const details = [];
    const chunks = [];
    for (let i = 0; i < startIds.length; i += 4) chunks.push(startIds.slice(i, i + 4));
    for (const chunk of chunks) {
      const results = await Promise.allSettled(chunk.map(async id => {
        const text = await fetchText(CMA_VIEW_URL(id), 15000);
        return parseCmaDetail(JSON.parse(stripJsonp(text)));
      }));
      results.forEach(result => {
        if (result.status === "fulfilled" && result.value) details.push(result.value);
      });
    }
    const byEnglish = {};
    details.forEach(detail => {
      if (detail.english_name) byEnglish[detail.english_name] = detail;
    });
    cmaCache = byEnglish;
    return byEnglish;
  } catch (error) {
    return cmaCache || {};
  }
}
function stormLevel(windKt, isInvest) {
  if (isInvest) return "热带扰动";
  const wind = windKt || 0;
  if (wind < 34) return "热带低压";
  if (wind < 64) return "热带风暴";
  if (wind < 130) return "台风";
  return "超级台风（JTWC）";
}
function buildDashboard(dapiyaStorms, cmaByEnglish) {
  const snapMap = snapshotStorms && snapshotStorms.storms || {};
  const storms = dapiyaStorms.map(item => {
    var _snap$wind_kt, _snap$pressure_hpa, _snap$rmw_nm, _snap$latitude, _snap$longitude;
    const snap = snapMap[item.id] || {};
    const products = Object.assign({}, snap.products || {}, {
      ai_vis: snap.ai_vis_latest || `https://data.dapiya.cn/AI-VIS/${item.id}/AI_VIS/${item.id}_AI_VIS.png`,
      ai_vis_page: snap.ai_vis_page || `https://ai-vis.dapiya.cn/sat.html?stormid=${item.id}`
    });
    const cma = cmaByEnglish[item.displayName.toUpperCase()] || cmaByEnglish[item.id];
    const isInvest = /^9[0-9]W$/.test(item.id);
    const windKt = (_snap$wind_kt = snap.wind_kt) !== null && _snap$wind_kt !== void 0 ? _snap$wind_kt : null;
    return {
      id: item.id,
      name: item.displayName || item.id,
      group: item.group,
      is_invest: isInvest,
      level: stormLevel(windKt, isInvest),
      wind_kt: windKt,
      wind_conversion: windKt != null ? {
        mps: Math.round(windKt * 0.514444 * 10) / 10
      } : null,
      pressure_hpa: (_snap$pressure_hpa = snap.pressure_hpa) !== null && _snap$pressure_hpa !== void 0 ? _snap$pressure_hpa : null,
      rmw_nm: (_snap$rmw_nm = snap.rmw_nm) !== null && _snap$rmw_nm !== void 0 ? _snap$rmw_nm : null,
      latitude: (_snap$latitude = snap.latitude) !== null && _snap$latitude !== void 0 ? _snap$latitude : null,
      longitude: (_snap$longitude = snap.longitude) !== null && _snap$longitude !== void 0 ? _snap$longitude : null,
      observation_time: snap.timestamp || "",
      products: products,
      adt: snap.adt || null,
      ai_vis_frames: Array.isArray(snap.ai_vis) ? snap.ai_vis : [],
      cma: cma || null
    };
  });
  storms.sort((a, b) => {
    const norm = storm => {
      var _storm$cma;
      if (((_storm$cma = storm.cma) === null || _storm$cma === void 0 ? void 0 : _storm$cma.wind_mps) != null) return storm.cma.wind_mps;
      return storm.wind_kt != null ? storm.wind_kt * 0.514444 : 0;
    };
    const aw = norm(a);
    const bw = norm(b);
    return bw - aw || (a.id < b.id ? -1 : 1);
  });
  return {
    storms,
    generated_at: new Date().toISOString(),
    stale: false
  };
}
function currentStormObject() {
  var _wpDashboard, _wpDashboard2;
  return (((_wpDashboard = wpDashboard) === null || _wpDashboard === void 0 ? void 0 : _wpDashboard.storms) || []).find(item => item.id === wpStormId) || ((_wpDashboard2 = wpDashboard) === null || _wpDashboard2 === void 0 || (_wpDashboard2 = _wpDashboard2.storms) === null || _wpDashboard2 === void 0 ? void 0 : _wpDashboard2[0]) || null;
}
function renderStormValues(storm, selectedDate = null) {
  var _cma$wind_mps, _cma$wind_force_label, _cma$level, _cma$pressure_hpa, _cma$latitude, _cma$longitude, _cma$observation_time, _storm$wind_kt, _storm$wind_conversio, _storm$wind_conversio2, _storm$rmw_nm, _adt, _adt2, _adt3, _adt4, _adt5;
  const cma = storm.cma;
  let windMps = (_cma$wind_mps = cma === null || cma === void 0 ? void 0 : cma.wind_mps) !== null && _cma$wind_mps !== void 0 ? _cma$wind_mps : null;
  let forceLabel = (_cma$wind_force_label = cma === null || cma === void 0 ? void 0 : cma.wind_force_label) !== null && _cma$wind_force_label !== void 0 ? _cma$wind_force_label : "";
  let level = (_cma$level = cma === null || cma === void 0 ? void 0 : cma.level) !== null && _cma$level !== void 0 ? _cma$level : "";
  let pressure = (_cma$pressure_hpa = cma === null || cma === void 0 ? void 0 : cma.pressure_hpa) !== null && _cma$pressure_hpa !== void 0 ? _cma$pressure_hpa : null;
  let latitude = (_cma$latitude = cma === null || cma === void 0 ? void 0 : cma.latitude) !== null && _cma$latitude !== void 0 ? _cma$latitude : null;
  let longitude = (_cma$longitude = cma === null || cma === void 0 ? void 0 : cma.longitude) !== null && _cma$longitude !== void 0 ? _cma$longitude : null;
  let obsTime = (_cma$observation_time = cma === null || cma === void 0 ? void 0 : cma.observation_time) !== null && _cma$observation_time !== void 0 ? _cma$observation_time : "";
  let pressureSource = cma ? "hPa · CMA" : "hPa · JTWC/ATCF";
  let locationSource = cma ? "CMA" : "JTWC/ATCF";
  let jtwcWind = (_storm$wind_kt = storm.wind_kt) !== null && _storm$wind_kt !== void 0 ? _storm$wind_kt : null;
  let jtwcMps = (_storm$wind_conversio = (_storm$wind_conversio2 = storm.wind_conversion) === null || _storm$wind_conversio2 === void 0 ? void 0 : _storm$wind_conversio2.mps) !== null && _storm$wind_conversio !== void 0 ? _storm$wind_conversio : null;
  let rmw = (_storm$rmw_nm = storm.rmw_nm) !== null && _storm$rmw_nm !== void 0 ? _storm$rmw_nm : null;
  let priority = obsTime || storm.observation_time || "最新资料";
  let operationalLevel = cma ? `${cma.level} · ${cma.wind_force_label}` : storm.level;
  let adt = storm.adt;
  if (selectedDate && cma && Array.isArray(cma.track) && cma.track.length) {
    const monthDay = selectedDate.slice(5);
    let point = null;
    for (const item of cma.track) {
      if ((item.time || "").slice(0, 5) <= monthDay) point = item;else break;
    }
    if (!point) point = cma.track[0];
    if (point) {
      var _point$wind_mps, _point$pressure, _point$latitude, _point$longitude;
      windMps = (_point$wind_mps = point.wind_mps) !== null && _point$wind_mps !== void 0 ? _point$wind_mps : windMps;
      pressure = (_point$pressure = point.pressure) !== null && _point$pressure !== void 0 ? _point$pressure : pressure;
      latitude = (_point$latitude = point.latitude) !== null && _point$latitude !== void 0 ? _point$latitude : latitude;
      longitude = (_point$longitude = point.longitude) !== null && _point$longitude !== void 0 ? _point$longitude : longitude;
      level = point.level || level;
      forceLabel = point.wind_mps != null ? `${windForceFromMps(point.wind_mps)}级` : forceLabel;
      pressureSource = "hPa · CMA 历史";
      locationSource = "CMA 历史";
      jtwcWind = null;
      jtwcMps = null;
      rmw = null;
      adt = null;
      priority = `回看 ${selectedDate}`;
      operationalLevel = `${level} · ${forceLabel}`;
      const parts = String(point.time || "").split(" ");
      obsTime = parts.length === 2 ? `${parts[0].slice(0, 2)}月${parts[0].slice(3)}日 ${parts[1]} 北京时间` : "";
    }
  }
  $("wpPriority").textContent = priority;
  $("wpStormId").textContent = storm.id;
  $("wpStormName").textContent = storm.name;
  $("wpOperationalLevel").textContent = operationalLevel;
  $("wpCmaWind").textContent = windMps != null ? `${windMps} m/s` : "—";
  $("wpCmaForce").textContent = "";
  $("wpCmaForce").hidden = true;
  $("wpCmaLevel").textContent = level ? `${forceLabel} · ${level}` : "—";
  $("wpJtwcWind").textContent = jtwcWind != null ? `${jtwcWind} kt` : "—";
  $("wpJtwcWindMps").textContent = jtwcMps != null ? `${jtwcMps} m/s · 1分钟` : "";
  $("wpPressure").textContent = pressure != null ? `${pressure} hPa` : "—";
  $("wpPressureSource").textContent = pressureSource;
  $("wpLocation").textContent = `${formatCoordinate(latitude, "N", "S")}  ${formatCoordinate(longitude, "E", "W")}`;
  $("wpLocationSource").textContent = locationSource;
  $("wpRmw").textContent = rmw != null ? `${rmw} 海里` : "—";
  $("wpRmwKm").textContent = rmw != null ? `约 ${Math.round(rmw * 1.852)} 公里 · JTWC` : "";
  const decimal = (value, prefix = "") => value !== null && value !== undefined && Number.isFinite(Number(value)) ? `${prefix}${Number(value).toFixed(1)}` : "—";
  const temperature = value => {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
    const number = Number(value);
    return `${number > 0 ? "+" : ""}${number.toFixed(1)}°C`;
  };
  const sceneLabels = {
    EYE: "风眼型",
    CDO: "中心密集云区",
    SHEAR: "风切变型",
    CURVED_BAND: "弯曲云带型",
    EMBEDDED_CENTER: "嵌入中心型"
  };
  $("wpAdtCi").textContent = adt ? `CI ${decimal(adt.ci)}` : "暂无分析";
  $("wpFinalT").textContent = adt ? decimal(adt.final_t, "T") : "—";
  $("wpEyeTemp").textContent = temperature((_adt = adt) === null || _adt === void 0 ? void 0 : _adt.center_temp_c);
  $("wpCloudTemp").textContent = temperature((_adt2 = adt) === null || _adt2 === void 0 ? void 0 : _adt2.cloud_region_temp_c);
  $("wpScene").textContent = (_adt3 = adt) !== null && _adt3 !== void 0 && _adt3.scene ? `${adt.scene} · ${sceneLabels[adt.scene] || "云型分析"}` : "—";
  $("wpAdtTime").textContent = ((_adt4 = adt) === null || _adt4 === void 0 ? void 0 : _adt4.analysis_time) || "—";
  const fill = (id, text) => {
    const el = $(id);
    if (el) el.textContent = text;
  };
  fill("msWind", windMps != null ? `${windMps} m/s` : "—");
  fill("msLevel", level ? `${forceLabel} ${level}`.trim() : "—");
  fill("msPressure", pressure != null ? `${pressure} hPa` : "—");
  fill("msLocation", latitude != null ? `${formatCoordinate(latitude, "N", "S")} ${formatCoordinate(longitude, "E", "W")}` : "—");
  fill("msJtwc", jtwcWind != null ? `${jtwcWind} kt` : "—");
  fill("msAdt", ((_adt5 = adt) === null || _adt5 === void 0 ? void 0 : _adt5.ci) != null ? `CI ${Number(adt.ci).toFixed(1)}` : "—");
}
function stopWpAnim(imageId) {
  const image = $(imageId);
  if (image) image.dataset.animToken = String(Date.now() + Math.random());
  if (wpAnimPlayers[imageId]) {
    try {
      wpAnimPlayers[imageId].stop();
    } catch (error) {}
    delete wpAnimPlayers[imageId];
  }
  if (wpAnimTimers[imageId]) {
    clearInterval(wpAnimTimers[imageId]);
    delete wpAnimTimers[imageId];
  }
}
function stopAllAnims() {
  Object.keys(wpAnimTimers).forEach(stopWpAnim);
}
function createFramePlayer(image, imageId, onReady = null, interval = 400) {
  const stage = image.closest(".media-stage, .environment-stage");
  let label = null;
  if (stage) {
    label = document.createElement("span");
    label.className = "anim-time";
    stage.appendChild(label);
  }
  const state = {
    frames: [],
    index: 0,
    timer: null,
    shownUrl: image.currentSrc || ""
  };
  const absoluteUrl = url => url ? new URL(url, window.location.href).href : "";
  const showFrame = (url, time) => {
    if (state.shownUrl === absoluteUrl(url)) {
      if (label) label.textContent = formatFrameTime(time);
      return;
    }
    image.src = url;
    state.shownUrl = url;
    if (label) label.textContent = formatFrameTime(time);
  };
  const tick = () => {
    if (state.frames.length < 2) return;
    state.index = (state.index + 1) % state.frames.length;
    showFrame(state.frames[state.index].url, state.frames[state.index].time);
  };
  const addFrame = (url, time) => {
    const absolute = absoluteUrl(url);
    state.frames.push({
      url: absolute,
      time: time || ""
    });
    state.frames.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0);
    const shownIndex = state.frames.findIndex(frame => frame.url === state.shownUrl);
    state.index = shownIndex >= 0 ? shownIndex : state.frames.length - 1;
    if (shownIndex >= 0 && label) {
      label.textContent = formatFrameTime(state.frames[shownIndex].time);
    }
    if (state.frames.length >= 2 && !state.timer) {
      state.timer = setInterval(tick, interval);
      wpAnimTimers[imageId] = state.timer;
      if (onReady) onReady();
    }
  };
  const stop = () => {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
      delete wpAnimTimers[imageId];
    }
    if (label && label.parentNode) {
      label.parentNode.removeChild(label);
    }
  };
  return {
    addFrame,
    stop
  };
}
function loadPlainImage(image, fallback, url, loading) {
  const stage = image.closest(".media-stage, .environment-stage, .forecast-mini-stage");
  if (loading) loading.hidden = true;
  setStageLoading(stage, true);
  image.hidden = true;
  fallback.hidden = true;
  if (!url) {
    fallback.hidden = false;
    setStageLoading(stage, false);
    return;
  }
  image.fetchPriority = "high";
  image.dataset.retry = "0";
  setTimeout(() => {
    if (image.naturalWidth === 0 && !image.complete) {
      setStageLoading(stage, false);
      if (fallback.hidden) fallback.hidden = false;
    }
  }, 20000);
  image.onload = () => {
    image.hidden = false;
    fallback.hidden = true;
    setStageLoading(stage, false);
    if (stage) stage.classList.add("image-ready");
  };
  image.onerror = () => {
    if (image.dataset.retry === "0") {
      image.dataset.retry = "1";
      setTimeout(() => {
        image.src = url;
      }, 2000);
      return;
    }
    image.hidden = true;
    fallback.hidden = false;
    setStageLoading(stage, false);
  };
  image.src = url;
}
async function loadDapiyaAnimated(imageId, fallbackId, stormId, layer, loadingId, badgeId, staticUrl, frameSource = "api") {
  const image = $(imageId);
  const fallback = $(fallbackId);
  const loading = loadingId ? $(loadingId) : null;
  const badge = badgeId ? $(badgeId) : null;
  stopWpAnim(imageId);
  const token = String(Date.now() + Math.random());
  image.dataset.animToken = token;
  image.hidden = true;
  fallback.hidden = true;
  if (badge) badge.hidden = true;
  if (loading) loading.hidden = true;
  setStageLoading(image.closest(".media-stage"), true);
  image.fetchPriority = "high";
  const fetchFrames = async () => {
    try {
      if (frameSource === "snapshot") {
        const storm = currentStormObject();
        return ((storm === null || storm === void 0 ? void 0 : storm.ai_vis_frames) || []).slice(-8);
      }
      return (await fetchFrameList(stormId, layer, 8)).slice(-8);
    } catch (error) {
      return [];
    }
  };
  const startAnimation = frames => {
    if (image.dataset.animToken !== token || frames.length < 2) return;
    const player = createFramePlayer(image, imageId, () => {
      if (badge) badge.hidden = false;
    }, 360);
    wpAnimPlayers[imageId] = player;
    const latestUrl = image.src || frames[frames.length - 1].url;
    player.addFrame(latestUrl, frames[frames.length - 1].time || "");
    const queue = frames.slice(0, -1).reverse().map(frame => ({
      frame,
      attempts: 0
    }));
    let active = 0;
    const pump = () => {
      if (image.dataset.animToken !== token) return;
      while (active < 2 && queue.length) {
        const item = queue.shift();
        active++;
        imageExists(item.frame.url).then(ok => {
          active--;
          if (ok && image.dataset.animToken === token) {
            player.addFrame(item.frame.url, item.frame.time || "");
          } else if (item.attempts < 2 && image.dataset.animToken === token) {
            item.attempts++;
            queue.push(item);
          }
          pump();
        });
      }
    };
    pump();
  };
  const showLatest = url => {
    if (image.dataset.animToken !== token || !url) return false;
    image.onload = () => {
      image.hidden = false;
      if (loading) loading.hidden = true;
      setStageLoading(image.closest(".media-stage"), false);
    };
    image.onerror = () => {
      image.hidden = true;
      fallback.hidden = false;
      if (loading) loading.hidden = true;
      setStageLoading(image.closest(".media-stage"), false);
    };
    image.src = url;
    if (layer === "BD" && $("wpBdSource")) $("wpBdSource").href = url;
    if (layer === "BW" && $("wpBwLatestSource")) $("wpBwLatestSource").href = url;
    if (layer === "AI_VIS" && $("wpAiVisSource")) $("wpAiVisSource").href = url;
    return true;
  };
  if (staticUrl) {
    showLatest(staticUrl);
    fetchFrames().then(frames => {
      var _frames;
      const latest = (_frames = frames[frames.length - 1]) === null || _frames === void 0 ? void 0 : _frames.url;
      const stillLoading = image.getAttribute("src") && !image.complete;
      if (latest && latest !== staticUrl && !stillLoading && image.dataset.animToken === token) {
        showLatest(frames[frames.length - 1].url);
      }
      startAnimation(frames);
    });
    return;
  }
  const frames = await fetchFrames();
  if (image.dataset.animToken !== token) return;
  if (!frames.length) {
    if (loading) loading.hidden = true;
    fallback.hidden = false;
    setStageLoading(image.closest(".media-stage"), false);
    return;
  }
  showLatest(frames[frames.length - 1].url);
  startAnimation(frames);
}
async function loadHistoricalDapiyaFrame(imageId, fallbackId, stormId, layer, date, loadingId, badgeId, fallbackLayer) {
  const image = $(imageId);
  const fallback = $(fallbackId);
  const loading = loadingId ? $(loadingId) : null;
  const badge = badgeId ? $(badgeId) : null;
  stopWpAnim(imageId);
  const requestToken = String(Date.now() + Math.random());
  image.dataset.requestToken = requestToken;
  image.hidden = true;
  fallback.hidden = true;
  if (loading) loading.hidden = true;
  if (badge) badge.hidden = true;
  const empty = () => {
    image.hidden = true;
    fallback.hidden = false;
    fallback.textContent = "该时次暂无数据";
  };
  const target = `${date}T12:00:00Z`;
  try {
    let frame = null;
    if (layer === "AI_VIS") {
      const storm = currentStormObject();
      frame = frameNear((storm === null || storm === void 0 ? void 0 : storm.ai_vis_frames) || [], target);
    } else {
      const frames = await fetchFrameList(stormId, layer, 200000);
      frame = frameNear(frames, target);
    }
    if (image.dataset.requestToken !== requestToken) return;
    if (!frame && fallbackLayer) {
      const frames = await fetchFrameList(stormId, fallbackLayer, 200000);
      frame = frameNear(frames, target);
    }
    if (image.dataset.requestToken !== requestToken) return;
    if (frame && frame.url) {
      image.onload = () => {
        image.hidden = false;
        fallback.hidden = true;
      };
      image.onerror = empty;
      image.src = frame.url;
    } else {
      empty();
    }
  } catch (error) {
    if (image.dataset.requestToken !== requestToken) return;
    empty();
  }
}
function wnCandidates(stormId, date, suffix, daysBack = 3) {
  const wnId = `WP${String(stormId).slice(0, 2)}`;
  const candidates = [];
  const now = new Date();
  for (let offset = 0; offset < daysBack; offset++) {
    const day = new Date(now.getTime() - offset * 86400000);
    const ymd = `${day.getUTCFullYear()}${String(day.getUTCMonth() + 1).padStart(2, "0")}${String(day.getUTCDate()).padStart(2, "0")}`;
    for (const hour of ["18", "12", "06", "00"]) {
      candidates.push(`${WEATHERNERDS_IMG}/${wnId}_${ymd}${hour}_${suffix}.png`);
    }
  }
  if (date) {
    const ymd = date.replace(/-/g, "");
    for (const hour of ["18", "12", "06", "00"]) {
      candidates.unshift(`${WEATHERNERDS_IMG}/${wnId}_${ymd}${hour}_${suffix}.png`);
    }
  }
  return candidates;
}
function modelCycleLabel(url) {
  const match = String(url || "").match(/_(\d{8})(\d{2})_(?:ECENS|GEFS)/);
  if (!match) return "";
  return `${match[1].slice(4, 6)}-${match[1].slice(6, 8)} ${match[2]}Z`;
}
function observationTimeLabel(raw) {
  const match = String(raw || "").match(/(\d{2}):(\d{2}) UTC (\w{3}) (\d{2}), (\d{4})/);
  if (!match) return "";
  const months = {
    Jan: "01",
    Feb: "02",
    Mar: "03",
    Apr: "04",
    May: "05",
    Jun: "06",
    Jul: "07",
    Aug: "08",
    Sep: "09",
    Oct: "10",
    Nov: "11",
    Dec: "12"
  };
  const month = months[match[3]];
  if (!month) return "";
  return `${month}-${match[4]} ${match[1]}:${match[2]}Z`;
}
function frameTimeFromUrl(url) {
  const match = String(url || "").match(/_(\d{8})(\d{4})/);
  if (!match) return "";
  return `${match[1].slice(4, 6)}-${match[1].slice(6, 8)} ${match[2].slice(0, 2)}:${match[2].slice(2, 4)}Z`;
}
async function loadModelImage(imageId, fallbackId, sourceId, url) {
  const image = $(imageId);
  const fallback = $(fallbackId);
  const stage = image.closest(".forecast-mini-stage");
  stopWpAnim(imageId);
  const token = String(Date.now() + Math.random());
  image.dataset.requestToken = token;
  image.hidden = true;
  fallback.hidden = true;
  setStageLoading(stage, true);
  let settledTimer = null;
  const settle = showFallback => {
    clearTimeout(settledTimer);
    setStageLoading(stage, false);
    if (showFallback && image.naturalWidth === 0 && image.dataset.requestToken === token) fallback.hidden = false;
  };
  settledTimer = setTimeout(() => settle(true), 20000);
  if (url) {
    image.onload = () => {
      image.hidden = false;
      fallback.hidden = true;
      settle(false);
      if (stage) stage.classList.add("image-ready");
    };
    image.onerror = () => {
      image.hidden = true;
      settle(true);
    };
    image.src = url;
    return;
  }
  const storm = currentStormObject();
  const candidates = wnCandidates(storm.id, null, sourceId);
  const found = await probeFirst(candidates);
  if (image.dataset.requestToken !== token) return;
  if (found) {
    image.onload = () => {
      image.hidden = false;
      fallback.hidden = true;
      settle(false);
      if (stage) stage.classList.add("image-ready");
    };
    image.onerror = () => {
      image.hidden = true;
      settle(true);
    };
    image.src = found;
  } else {
    settle(true);
  }
}
async function loadWeathernerdsHistory(imageId, fallbackId, stormId, date, suffix) {
  const image = $(imageId);
  const fallback = $(fallbackId);
  const stage = image.closest(".forecast-mini-stage");
  stopWpAnim(imageId);
  const requestToken = String(Date.now() + Math.random());
  image.dataset.requestToken = requestToken;
  image.hidden = true;
  fallback.hidden = true;
  setStageLoading(stage, true);
  let settledTimer = null;
  const settle = showFallback => {
    clearTimeout(settledTimer);
    setStageLoading(stage, false);
    if (showFallback && image.naturalWidth === 0 && image.dataset.requestToken === requestToken) fallback.hidden = false;
  };
  settledTimer = setTimeout(() => settle(true), 20000);
  fallback.textContent = "该时次暂无数据";
  const cacheKey = `${stormId}:${date}:${suffix}`;
  const applyUrl = url => {
    if (image.dataset.requestToken !== requestToken) return;
    if (!url) {
      image.hidden = true;
      settle(true);
      return;
    }
    weathernerdsHistoryCache[cacheKey] = url;
    image.onload = () => {
      image.hidden = false;
      fallback.hidden = true;
      settle(false);
      if (stage) stage.classList.add("image-ready");
    };
    image.onerror = () => {
      image.hidden = true;
      settle(true);
    };
    image.src = url;
  };
  if (weathernerdsHistoryCache[cacheKey]) {
    applyUrl(weathernerdsHistoryCache[cacheKey]);
    return;
  }
  const candidates = wnCandidates(stormId, date, suffix, 1);
  const found = await probeFirst(candidates);
  if (image.dataset.requestToken !== requestToken) return;
  applyUrl(found);
}
const pmrCache = new Map();
async function fetchPmrFrames(stormId) {
  const key = `pmr:${stormId}`;
  if (pmrCache.has(key)) return pmrCache.get(key);
  const url = `${DAPIYA_API}/typhoon/${encodeURIComponent(stormId)}/piclist/satprod/mw_pmr/FY-3`;
  const text = await fetchText(url, 8000);
  const frames = [];
  for (const raw of text.split(",")) {
    const parts = raw.split("|");
    const path = (parts[0] || "").trim();
    const label = parts[1] || "";
    if (!path) continue;
    const match = String(label).match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    const iso = match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z` : "";
    frames.push({
      url: `${DAPIYA_DATA}/${path}`,
      time: iso || label || "",
      label: label || ""
    });
  }
  frames.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0);
  pmrCache.set(key, frames);
  return frames;
}
async function loadPmrImage(stormId, selectedDate) {
  const image = $("wpPmrImage");
  const fallback = $("wpPmrFallback");
  const meta = $("wpPmrMeta");
  const loading = $("wpPmrLoading");
  const stage = image ? image.closest(".media-stage") : null;
  if (!image || !fallback) return;
  const token = String(Date.now() + Math.random());
  image.dataset.pmrToken = token;
  if (loading) loading.hidden = true;
  image.removeAttribute("src");
  image.hidden = true;
  fallback.hidden = true;
  setStageLoading(stage, true);
  let frames = [];
  try {
    frames = await fetchPmrFrames(stormId);
  } catch (error) {
    frames = [];
  }
  if (image.dataset.pmrToken !== token) return;
  if (!frames.length) {
    fallback.hidden = false;
    setStageLoading(stage, false);
    return;
  }
  const target = selectedDate ? `${selectedDate}T12:00:00Z` : "";
  const frame = target ? frameNear(frames, target) : frames[frames.length - 1];
  if (!frame) {
    fallback.hidden = false;
    fallback.textContent = "该时次暂无 PMR";
    setStageLoading(stage, false);
    return;
  }
  image.onload = () => {
    image.hidden = false;
    fallback.hidden = true;
    setStageLoading(stage, false);
    if (stage) stage.classList.add("image-ready");
  };
  image.onerror = () => {
    image.hidden = true;
    fallback.hidden = false;
    setStageLoading(stage, false);
  };
  image.fetchPriority = "high";
  image.src = frame.url;
  if ($("wpPmrSource")) $("wpPmrSource").href = frame.url;
  if (meta) meta.textContent = frame.label || formatFrameTime(frame.time);
}
function renderIntensityChart(track, selectedDate = null) {
  const svg = $("wpIntensityChart");
  const fallback = $("wpIntensityFallback");
  if (!svg) return;
  let points = Array.isArray(track) ? track.filter(p => p && p.wind_mps != null) : [];
  if (selectedDate) {
    const monthDay = selectedDate.slice(5);
    points = points.filter(p => (p.time || "").slice(0, 5) <= monthDay);
  }
  if (points.length < 2) {
    svg.style.display = "none";
    svg.setAttribute("hidden", "");
    if (fallback) fallback.hidden = false;
    return;
  }
  svg.style.display = "block";
  svg.removeAttribute("hidden");
  if (fallback) fallback.hidden = true;
  const W = 350;
  const H = 260;
  const padL = 34;
  const padR = 36;
  const padT = 16;
  const padB = 24;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = points.length;
  const xs = i => padL + (n === 1 ? innerW / 2 : i * innerW / (n - 1));
  const winds = points.map(p => p.wind_mps);
  const windMax = Math.max(...winds, 20);
  const windMin = Math.min(...winds, 0);
  const yWind = v => padT + (windMax - v) / (windMax - windMin || 1) * innerH;
  const presses = points.map(p => p.pressure).filter(v => v != null);
  const pressMax = presses.length ? Math.max(...presses, 1010) : 1010;
  const pressMin = presses.length ? Math.min(...presses, 900) : 900;
  const yPress = v => padT + (pressMax - v) / (pressMax - pressMin || 1) * innerH;
  const windLine = points.map((p, i) => `${xs(i)},${yWind(p.wind_mps)}`).join(" ");
  const pressLine = points.map((p, i) => p.pressure != null ? `${xs(i)},${yPress(p.pressure)}` : "").filter(Boolean).join(" ");
  const grid = [0, 1, 2, 3, 4].map(g => {
    const y = padT + g * innerH / 4;
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(255,255,255,.13)" stroke-width="1"/>`;
  }).join("");
  const yTicks = [0, 1, 2].map(i => {
    const value = windMax - (windMax - windMin) * i / 2;
    const y = padT + i * innerH / 2;
    return `<text x="${padL - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="#c9d9d5">${Math.round(value)}</text>`;
  }).join("");
  const mid = Math.floor(n / 2);
  const labels = [0, mid, n - 1].map(idx => `<text x="${xs(idx)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#c9d9d5">${points[idx].time || ""}</text>`).join("");
  svg.innerHTML = `
    <rect x="0" y="0" width="${W}" height="${H}" rx="10" fill="#10272d"/>
    ${grid}
    ${yTicks}
    <polyline points="${pressLine}" fill="none" stroke="#ffb74d" stroke-width="2" opacity=".85"/>
    <polyline points="${windLine}" fill="none" stroke="#4fc3f7" stroke-width="2.4"/>
    <text x="${padL}" y="${padT + 12}" font-size="11" fill="#4fc3f7">风 m/s</text>
    <text x="${W - padR}" y="${padT + 12}" text-anchor="end" font-size="11" fill="#ffb74d">气压 hPa</text>
    ${labels}
  `;
}
function himawariTimes() {
  if (snapshotHimawari && Array.isArray(snapshotHimawari.times) && snapshotHimawari.times.length) {
    const hourly = snapshotHimawari.times.filter(t => {
      const date = new Date(t);
      return date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0;
    });
    if (hourly.length >= 2) return hourly.filter((_, index) => index % 3 === 0);
  }
  const times = [];
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  for (let hour = 24; hour >= 0; hour--) {
    times.push(new Date(now.getTime() - hour * 3600000).toISOString());
  }
  return times.filter((_, index) => index % 3 === 0);
}
function himawariTileUrls(timeIso, kind) {
  const product = kind === "natural" ? "D531106" : "FULL_24h/B13";
  const date = new Date(timeIso);
  const pad = n => String(n).padStart(2, "0");
  const stamp = `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  const base = `${HIMAWARI_TILE_BASE}/${product}/2d/550/${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}/${stamp}`;
  return [[`${base}_0_0.png`, `${base}_1_0.png`], [`${base}_0_1.png`, `${base}_1_1.png`]];
}
function renderFullDiskGrid(selectedDate = null) {
  const grid = $("wpFullDiskGrid");
  if (!grid) return;
  const products = [{
    id: "natural",
    title: "全圆盘真可见光",
    subtitle: "NICT",
    source: "https://himawari.asia/himawari8-image.htm?sI=D531106&sClC=&sTA=false&sTAT=TY&sS=3&sNx=0&sNy=0&sL=-439.86054199218734&sT=-207.6039389648438&wW=1151&wH=628"
  }, {
    id: "infrared",
    title: "全圆盘 B13 红外",
    subtitle: "NICT",
    source: "https://himawari.asia/himawari8-image.htm?sI=FULL_24h&sSI=B13&sClC=&sTA=false"
  }];
  const signature = selectedDate ? `hist:${selectedDate}` : "anim:latest";
  if (grid.dataset.signature === signature) return;
  grid.dataset.signature = signature;
  grid.innerHTML = "";
  products.forEach((product, index) => {
    const card = document.createElement("article");
    card.className = "environment-card environment-square";
    const header = document.createElement("header");
    const titleWrap = document.createElement("div");
    const title = document.createElement("strong");
    const subtitle = document.createElement("span");
    title.textContent = product.title;
    subtitle.textContent = product.subtitle;
    titleWrap.append(title, subtitle);
    const badge = document.createElement("b");
    badge.className = "anim-badge";
    badge.textContent = "动图";
    badge.hidden = true;
    header.append(titleWrap, badge);
    const link = document.createElement("a");
    link.className = "forecast-image-link";
    link.href = product.source;
    link.target = "_blank";
    link.rel = "noopener";
    link.title = "点击查看来源";
    const stage = document.createElement("div");
    stage.className = "environment-stage";
    const tileGrid = document.createElement("div");
    tileGrid.className = "himawari-tile-grid";
    const tiles = [];
    for (let i = 0; i < 4; i++) {
      const tile = document.createElement("img");
      tile.alt = `${product.title} 瓦片 ${i + 1}`;
      tile.decoding = "async";
      tile.loading = index === 0 ? "eager" : "lazy";
      tileGrid.appendChild(tile);
      tiles.push(tile);
    }
    const fallback = document.createElement("div");
    fallback.className = "mini-fallback";
    fallback.textContent = "全圆盘动图暂时无法载入";
    fallback.hidden = true;
    stage.append(tileGrid, fallback);
    link.append(stage);
    card.append(header, link);
    grid.append(card);
    if (selectedDate) {
      loadHimawariHistorical(tiles, fallback, product.id, selectedDate);
    } else if (index === 1) {
      setTimeout(() => loadProgressiveHimawari(tiles, fallback, badge, stage, product.id, index), 4000);
    } else {
      loadProgressiveHimawari(tiles, fallback, badge, stage, product.id, index);
    }
  });
}
function setTiles(tiles, timeIso, kind) {
  const rows = himawariTileUrls(timeIso, kind);
  const urls = [rows[0][0], rows[0][1], rows[1][0], rows[1][1]];
  tiles.forEach((tile, index) => {
    const target = urls[index];
    if (tile.getAttribute("src") !== target) tile.src = target;
  });
}
function preloadTiles(tiles, timeIso, kind) {
  const rows = himawariTileUrls(timeIso, kind);
  return Promise.all([rows[0][0], rows[0][1], rows[1][0], rows[1][1]].map(url => imageExists(url, 15000)));
}
async function loadHimawariHistorical(tiles, fallback, kind, date) {
  const stage = fallback.closest(".environment-stage");
  setStageLoading(stage, true);
  const timeIso = `${date}T03:00:00Z`;
  let urls = [false, false, false, false];
  for (let attempt = 0; attempt < 2; attempt++) {
    urls = await preloadTiles(tiles, timeIso, kind);
    if (urls.every(Boolean)) break;
  }
  if (urls.every(Boolean)) {
    const rows = himawariTileUrls(timeIso, kind);
    tiles[0].src = rows[0][0];
    tiles[1].src = rows[0][1];
    tiles[2].src = rows[1][0];
    tiles[3].src = rows[1][1];
    fallback.hidden = true;
    setStageLoading(stage, false);
  } else {
    fallback.hidden = false;
    setStageLoading(stage, false);
  }
}
async function loadProgressiveHimawari(tiles, fallback, badge, stage, kind, cardIndex) {
  var _tiles$3;
  const token = String(Date.now() + Math.random());
  tiles.forEach(tile => {
    tile.dataset.animToken = token;
  });
  setStageLoading(stage, true);
  let times = himawariTimes();
  times = times.slice(-6);
  const label = document.createElement("span");
  label.className = "anim-time";
  stage.appendChild(label);
  if (!times.length) {
    fallback.hidden = false;
    label.remove();
    setStageLoading(stage, false);
    return;
  }
  const player = {
    frames: [],
    index: 0,
    timer: null,
    add(time) {
      this.frames.push(time);
      this.frames.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      if (this.frames.length >= 2 && !this.timer) {
        this.timer = setInterval(() => this.tick(), 420);
        wpAnimTimers[`himawari${kind}`] = this.timer;
        if (badge) badge.hidden = false;
      }
    },
    show(time) {
      var _tiles$;
      if (((_tiles$ = tiles[0]) === null || _tiles$ === void 0 ? void 0 : _tiles$.dataset.animToken) !== token) return;
      setTiles(tiles, time, kind);
      label.textContent = formatFrameTime(time);
      this.index = this.frames.indexOf(time);
      if (this.index < 0) this.index = Math.max(0, this.frames.length - 1);
    },
    tick() {
      if (this.frames.length < 2) return;
      this.index = (this.index + 1) % this.frames.length;
      this.show(this.frames[this.index]);
    },
    stop() {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
        delete wpAnimTimers[`himawari${kind}`];
      }
      if (label && label.parentNode) {
        label.parentNode.removeChild(label);
      }
    }
  };
  wpAnimPlayers[`himawari${kind}`] = player;
  const latestTime = times[times.length - 1];
  let latestOk = [false, false, false, false];
  for (let attempt = 0; attempt < 3; attempt++) {
    var _tiles$2;
    latestOk = await preloadTiles(tiles, latestTime, kind);
    if (latestOk.every(Boolean) || ((_tiles$2 = tiles[0]) === null || _tiles$2 === void 0 ? void 0 : _tiles$2.dataset.animToken) !== token) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (((_tiles$3 = tiles[0]) === null || _tiles$3 === void 0 ? void 0 : _tiles$3.dataset.animToken) !== token) return;
  if (!latestOk.every(Boolean)) {
    fallback.hidden = false;
    label.remove();
    setStageLoading(stage, false);
    return;
  }
  player.add(latestTime);
  player.show(latestTime);
  fallback.hidden = true;
  setStageLoading(stage, false);
  const queue = times.slice(0, -1).reverse().map(time => ({
    time,
    attempts: 0
  }));
  let active = 0;
  const pump = () => {
    var _tiles$4;
    if (((_tiles$4 = tiles[0]) === null || _tiles$4 === void 0 ? void 0 : _tiles$4.dataset.animToken) !== token) return;
    while (active < 2 && queue.length) {
      const item = queue.shift();
      active++;
      preloadTiles(tiles, item.time, kind).then(ok => {
        var _tiles$5, _tiles$6;
        active--;
        if (ok.every(Boolean) && ((_tiles$5 = tiles[0]) === null || _tiles$5 === void 0 ? void 0 : _tiles$5.dataset.animToken) === token) {
          player.add(item.time);
        } else if (item.attempts < 2 && ((_tiles$6 = tiles[0]) === null || _tiles$6 === void 0 ? void 0 : _tiles$6.dataset.animToken) === token) {
          item.attempts++;
          queue.push(item);
        }
        pump();
      });
    }
  };
  pump();
}
function renderEnvironmentGrid() {
  const grid = $("wpEnvironmentGrid");
  if (!grid) return;
  if (grid.dataset.signature === "latest") return;
  grid.dataset.signature = "latest";
  grid.innerHTML = "";
  const products = ENVIRONMENT_PRODUCTS.slice();
  products.forEach(product => {
    const card = document.createElement("article");
    card.className = `environment-card environment-${product.shape || "wide"}`;
    const header = document.createElement("header");
    const titleWrap = document.createElement("div");
    const title = document.createElement("strong");
    const subtitle = document.createElement("span");
    title.textContent = product.title;
    subtitle.textContent = product.subtitle;
    titleWrap.append(title, subtitle);
    if (product.animated) {
      const badge = document.createElement("b");
      badge.textContent = "动图";
      header.append(titleWrap, badge);
    } else {
      header.append(titleWrap);
    }
    const link = document.createElement("a");
    link.className = "forecast-image-link";
    link.href = product.source || product.image || "#";
    link.target = "_blank";
    link.rel = "noopener";
    link.title = "点击查看原图";
    const stage = document.createElement("div");
    stage.className = "environment-stage";
    const image = document.createElement("img");
    image.alt = product.title;
    image.loading = "lazy";
    image.decoding = "async";
    if (product.id === "sst") image.src = "./data/sst.png";
    const fallback = document.createElement("div");
    fallback.className = "mini-fallback";
    fallback.textContent = "图片暂时无法载入";
    fallback.hidden = true;
    let io = null;
    const hideLoading = () => {
      setStageLoading(stage, false);
      if (io) io.disconnect();
    };
    if (product.id === "sst") {
      setStageLoading(stage, true);
    } else if ("IntersectionObserver" in window) {
      io = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting && !image.complete) setStageLoading(stage, true);
        });
      }, {
        rootMargin: "300px"
      });
      io.observe(stage);
    } else {
      setStageLoading(stage, true);
    }
    image.onload = () => {
      fallback.hidden = true;
      hideLoading();
      stage.classList.add("image-ready");
    };
    image.onerror = () => {
      image.hidden = true;
      fallback.hidden = false;
      hideLoading();
    };
    stage.append(image, fallback);
    link.append(stage);
    card.append(header, link);
    grid.append(card);
    if (product.id === "sst") {
      let attempt = 0;
      const loadSst = async () => {
        if (attempt >= 5) {
          image.hidden = true;
          fallback.hidden = false;
          setStageLoading(stage, false);
          return;
        }
        attempt++;
        let url = null;
        if (attempt === 1) {
          url = "./data/sst.png";
        } else if (attempt === 2) {
          var _snapshotSst;
          url = ((_snapshotSst = snapshotSst) === null || _snapshotSst === void 0 ? void 0 : _snapshotSst.url) || null;
        } else {
          url = await resolveSstUrl({
            skipSnapshot: true
          });
        }
        if (!url) {
          image.hidden = true;
          fallback.hidden = false;
          setStageLoading(stage, false);
          return;
        }
        image.onload = () => {
          fallback.hidden = true;
          setStageLoading(stage, false);
        };
        image.onerror = loadSst;
        image.src = url;
      };
      loadSst();
    } else if (product.image) {
      image.src = product.image;
    }
  });
}
async function resolveSstUrl({
  skipSnapshot = false
} = {}) {
  var _snapshotSst2;
  if (!skipSnapshot && (_snapshotSst2 = snapshotSst) !== null && _snapshotSst2 !== void 0 && _snapshotSst2.url) return snapshotSst.url;
  const candidates = [];
  const now = new Date();
  for (let offset = 0; offset < 10; offset++) {
    const day = new Date(now.getTime() - offset * 86400000);
    const iso = `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, "0")}-${String(day.getUTCDate()).padStart(2, "0")}`;
    candidates.push(`https://www.ospo.noaa.gov/data/sst/bno/daily/${day.getUTCFullYear()}/BSST-NIGHT-ONLY-${iso}.png`);
  }
  return probeFirst(candidates, 8000);
}
function setHistoryMode(active, storm, date) {
  const envSection = $("wpEnvironmentSection");
  const infraredCard = $("wpInfraredCard");
  const jtwcCard = $("wpJtwcCard");
  if (envSection) envSection.hidden = active;
  if (infraredCard) infraredCard.hidden = active;
  if (jtwcCard) jtwcCard.hidden = active;
  const hint = $("wpTimelineHint");
  if (hint) {
    hint.textContent = active ? `回看 ${date} · 无历史接口的数据源已隐藏` : "拖动时间轴回看历史资料 · 只有支持历史的数据源才会显示对应时次";
  }
}
let trackMap = null;
let trackMarker = null;
let trackLine = null;
let trackForecastLine = null;
let trackForecastLayer = null;
function initTrackMap() {
  if (trackMap || !window.L || !$("wpTrackMap")) return;
  trackMap = L.map("wpTrackMap", {
    zoomControl: true
  }).setView([20, 130], 4);
  window.__trackMap = trackMap;
  const layers = {
    amap: L.tileLayer("https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}", {
      subdomains: "1234",
      maxZoom: 18,
      attribution: "高德地图"
    }),
    esri: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 18,
      attribution: "Esri"
    }),
    osm: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "© OpenStreetMap"
    })
  };
  trackMap._tileLayers = layers;
  layers.esri.addTo(trackMap);
  document.querySelectorAll(".track-map-layers button").forEach(button => {
    button.classList.toggle("active", button.dataset.layer === "esri");
  });
  trackLine = L.polyline([], {
    color: "#4fc3f7",
    weight: 3,
    opacity: 0.9
  });
  trackForecastLine = L.polyline([], {
    color: "#ffa726",
    weight: 2,
    dashArray: "6 6",
    opacity: 0.85
  });
  trackForecastLayer = L.layerGroup();
  trackMarker = L.circleMarker([0, 0], {
    radius: 9,
    color: "#ff5252",
    weight: 2,
    fillColor: "#ff8a80",
    fillOpacity: 0.85
  });
  trackLine.addTo(trackMap);
  trackForecastLine.addTo(trackMap);
  trackForecastLayer.addTo(trackMap);
  trackMarker.addTo(trackMap);
  document.querySelectorAll(".track-map-layers button").forEach(button => {
    button.addEventListener("click", () => {
      const key = button.dataset.layer;
      document.querySelectorAll(".track-map-layers button").forEach(item => {
        item.classList.toggle("active", item === button);
      });
      Object.keys(layers).forEach(name => {
        if (trackMap.hasLayer(layers[name])) trackMap.removeLayer(layers[name]);
      });
      layers[key].addTo(trackMap);
    });
  });
  const scheduleReset = () => {
    if (trackMap._resetTimer) clearTimeout(trackMap._resetTimer);
    trackMap._resetTimer = setTimeout(() => {
      const storm = currentStormObject();
      if (!storm) return;
      trackMap._autoResetting = true;
      updateTrackMap(storm, wpSelectedDate);
      setTimeout(() => {
        trackMap._autoResetting = false;
      }, 800);
    }, 10000);
  };
  trackMap.on("dragend zoomend", () => {
    if (trackMap._autoResetting || trackMap._programmatic) return;
    scheduleReset();
  });
}
function updateTrackMap(storm, selectedDate) {
  var _storm$cma2, _storm$cma3;
  const bar = $("wpTrackMapBar");
  if (!bar) return;
  const track = storm === null || storm === void 0 || (_storm$cma2 = storm.cma) === null || _storm$cma2 === void 0 ? void 0 : _storm$cma2.track;
  if (!Array.isArray(track) || !track.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  initTrackMap();
  if (!trackMap) return;
  let points = track.filter(p => p && p.latitude != null && p.longitude != null);
  if (selectedDate) {
    const monthDay = selectedDate.slice(5);
    points = points.filter(p => (p.time || "").slice(0, 5) <= monthDay);
  }
  if (!points.length) {
    points = track.filter(p => p && p.latitude != null && p.longitude != null).slice(0, 1);
  }
  const latlngs = points.map(p => [Number(p.latitude), Number(p.longitude)]);
  trackLine.setLatLngs(latlngs);
  const last = latlngs[latlngs.length - 1];
  if (last) trackMarker.setLatLng(last);
  const forecast = ((_storm$cma3 = storm.cma) === null || _storm$cma3 === void 0 ? void 0 : _storm$cma3.forecast) || [];
  const fLatLngs = forecast.filter(p => p && p.latitude != null && p.longitude != null).map(p => [Number(p.latitude), Number(p.longitude)]);
  trackForecastLine.setLatLngs(fLatLngs);
  trackForecastLayer.clearLayers();
  forecast.forEach(p => {
    if (p.latitude == null || p.longitude == null) return;
    L.circleMarker([Number(p.latitude), Number(p.longitude)], {
      radius: 5,
      color: "#ffa726",
      weight: 1.5,
      fillColor: "#fff",
      fillOpacity: 0.7
    }).bindTooltip(`${p.time} · ${p.wind_mps != null ? p.wind_mps + " m/s" : "—"}`).addTo(trackForecastLayer);
  });
  const lastPoint = points[points.length - 1];
  if (lastPoint) {
    const bubble = [`<strong>${storm.name} · ${storm.id}</strong>`, lastPoint.time ? `时间 ${lastPoint.time}` : "", `风力 ${lastPoint.wind_mps != null ? `${lastPoint.wind_mps} m/s` : "—"}${lastPoint.level ? ` · ${lastPoint.level}` : ""}`, `气压 ${lastPoint.pressure != null ? `${lastPoint.pressure} hPa` : "—"}`, `位置 ${formatCoordinate(lastPoint.latitude, "N", "S")} ${formatCoordinate(lastPoint.longitude, "E", "W")}`].filter(Boolean).join("<br>");
    trackMarker.bindPopup(bubble).openPopup();
  }
  const meta = $("wpTrackMapMeta");
  if (meta) {
    meta.textContent = "蓝线 = CMA 实况路径 · 橙虚线 = CMA 官方预报 · 气泡为当前数值";
  }
  if (trackMap._fitTimer) clearTimeout(trackMap._fitTimer);
  if (trackMap._resetTimer) clearTimeout(trackMap._resetTimer);
  if (selectedDate) {
    trackMap._fitTimer = setTimeout(() => {
      if (!trackMap) return;
      trackMap._programmatic = true;
      if (latlngs.length >= 2) {
        trackMap.fitBounds(L.latLngBounds(latlngs).pad(0.35), {
          maxZoom: 7
        });
      } else if (last) {
        trackMap.setView(last, 5);
      }
      setTimeout(() => {
        trackMap._programmatic = false;
      }, 800);
    }, 450);
  } else if (last) {
    let zoom = 5;
    try {
      const bounds = L.latLngBounds(latlngs);
      const fit = trackMap.getBoundsZoom(bounds.pad(0.35), false);
      if (Number.isFinite(fit)) {
        zoom = Math.min(Math.max(Math.round(fit) + 1, 4), 7);
      }
    } catch (error) {
      zoom = 5;
    }
    trackMap._programmatic = true;
    trackMap.setView(last, zoom);
    setTimeout(() => {
      trackMap._programmatic = false;
    }, 800);
  }
  setTimeout(() => {
    if (trackMap) trackMap.invalidateSize();
  }, 60);
  window.__trackDebug = {
    points: latlngs.length,
    forecast: fLatLngs.length,
    marker: last ? [Number(last[0]).toFixed(1), Number(last[1]).toFixed(1)] : null
  };
}
let guideData = null;
let guideView = {
  name: "index"
};
let tutorialView = {
  name: "xband"
};
async function loadGuideData() {
  if (guideData) return guideData;
  try {
    guideData = await fetchJSON("./data/guide.json", 20000, "no-cache");
  } catch (error) {
    guideData = null;
  }
  return guideData;
}
function guideSatKey(title) {
  const m = String(title).match(/^(HINODE|Metop-\w|Meteor\s*M2-?\d|Fengyun\s*\d\w|FY-?3\w|NOAA\d+|GK2A|Elektro\s*L\d|ELektro\s*L\d|GOES-?\d*)/i);
  if (m) return m[1].toUpperCase().replace(/\s+/g, "");
  return String(title).split(/\s/)[0].replace(/[^A-Za-z0-9]/g, "");
}
function parseSatelliteName(title) {
  const t = String(title).replace(/（[^）]*）\s*$/, "").trim();
  const fm = t.match(/^(HINODE|Metop-\w|Meteor\s*M2-?\d|Fengyun\s*\d\w|FY-?3\w|NOAA\d+|GK2A|Elektro\s*L\d|ELektro\s*L\d|GOES-?\d*)/i);
  return fm ? fm[1] : t.split(/\s/)[0];
}
function parseBand(title) {
  const known = ["AHRPT", "HRPT", "HRIT", "LRIT", "UHRIT", "S-VISSR", "S-band", "X-band", "APT", "KMSS", "RDAS", "CDAS", "HRD"];
  for (const band of known) {
    if (title.toUpperCase().includes(band.toUpperCase())) return band.toUpperCase();
  }
  if (/HINODE/i.test(title)) return "S-band";
  return "下传";
}
function guideFamilies() {
  const families = [];
  if (!guideData || !guideData.sections) return families;
  for (const [section, items] of Object.entries(guideData.sections)) {
    if (/X\s*band|X波段/i.test(section)) continue;
    const cards = items.filter(it => it && it.title);
    if (!cards.length) continue;
    const groups = {};
    cards.forEach(card => {
      const key = guideSatKey(card.title);
      (groups[key] = groups[key] || []).push(card);
    });
    const sats = Object.keys(groups).map(key => {
      const cards2 = groups[key];
      const first = cards2[0].title;
      return {
        key,
        name: parseSatelliteName(first),
        country: (String(first).match(/（([^）]*)）/) || [])[1] || "",
        cards: cards2
      };
    }).sort((a, b) => satOrder(a.key) - satOrder(b.key));
    families.push({
      name: section.replace(/:$/, ""),
      sats
    });
  }
  return families;
}
function satOrder(key) {
  if (/^NOAA/.test(key)) return 0;
  if (/^METOP/.test(key)) return 1;
  if (/^METEOR/.test(key)) return 2;
  if (/^(FY|FENGYUN)/.test(key)) return 3;
  return 4;
}
function guideImg(file) {
  return `./assets/guide/img/${encodeURIComponent(file)}`;
}
function renderGuideIndex() {
  const families = guideFamilies();
  let html = `<p style="margin:0 2px;color:var(--muted);line-height:1.7">点击任一卫星图标查看它的下传波段、频率与接收图像；页面底部附完整频率总表。</p>`;
  families.forEach((family, fi) => {
    html += `<section class="guide-family"><div class="guide-family-title"><b>${String(fi + 1).padStart(2, "0")}</b><strong>${family.name}</strong></div><div class="guide-sat-grid">`;
    family.sats.forEach((sat, si) => {
      const icon = sat.cards[0].imgs[0];
      const chips = sat.cards.map(c => `<span class="guide-band-chip">${parseBand(c.title)}</span>`).join("");
      html += `<button type="button" class="guide-sat-card" data-guide="sat" data-fam="${fi}" data-sat="${si}">` + (icon ? `<img class="guide-sat-icon" src="${guideImg(icon)}" alt="${sat.name}" loading="lazy">` : `<div class="guide-sat-icon"></div>`) + `<strong>${sat.name}</strong>` + `<div class="guide-band-chips">${chips}</div></button>`;
    });
    html += `</div></section>`;
  });
  if (guideData && Array.isArray(guideData.tables)) {
    html += `<section class="guide-family"><div class="guide-family-title"><b>✚</b><strong>卫星频率总表</strong></div><div class="guide-tables">`;
    guideData.tables.forEach((rows, ti) => {
      html += `<div class="guide-table-wrap"><h4>${ti === 0 ? "L 波段 / S 波段" : "X 波段"}</h4><div class="guide-table-scroll"><table class="guide-table"><thead>`;
      let headerDone = false;
      rows.forEach(row => {
        const first = (row[0] || "").trim();
        const allSame = row.every(c => c === first);
        if (allSame) return;
        if (!headerDone) {
          html += `<tr>${row.map(c => `<th>${c}</th>`).join("")}</tr></thead><tbody>`;
          headerDone = true;
        } else {
          html += `<tr>${row.map(c => `<td>${c}</td>`).join("")}</tr>`;
        }
      });
      html += `</tbody></table></div></div>`;
    });
    html += `</div></section>`;
  }
  $("guideContent").innerHTML = html;
}
function renderGuideSatellite(famIdx, satIdx) {
  const families = guideFamilies();
  const family = families[Number(famIdx)];
  const sat = family && family.sats[Number(satIdx)];
  if (!sat) {
    renderGuideIndex();
    return;
  }
  let html = `<button type="button" class="guide-back" data-guide="index">← 返回指南首页</button>`;
  html += `<section class="guide-sat-detail">`;
  sat.cards.forEach(card => {
    const band = parseBand(card.title);
    const fm = String(card.title).match(/([\d.]+)\s*Mhz/i);
    const note = (String(card.title).match(/（([^）]*)）/) || [])[1] || "";
    html += `<div class="guide-band-block"><h3>${sat.name} · ${band}${fm ? " · " + fm[1] + " MHz" : ""}</h3>`;
    if (note) html += `<p style="margin:4px 0 0;color:var(--orange);font-weight:700">${note}</p>`;
    if (card.lines && card.lines.length) html += `<div class="guide-band-meta">${card.lines.map(l => `<span>${l}</span>`).join("")}</div>`;
    if (card.imgs && card.imgs.length) {
      html += `<div class="guide-img-grid">${card.imgs.map(im => `<figure><img src="${guideImg(im)}" alt="${sat.name} ${band}" loading="lazy"></figure>`).join("")}</div>`;
    }
    html += `</div>`;
  });
  html += `</section>`;
  $("guideContent").innerHTML = html;
}
function isGuideHeading(text) {
  if (!text) return false;
  if (text.length > 22) return false;
  if (/[。！？：]$/.test(text) && !/：$/.test(text)) return false;
  return !/^http|^【淘宝】|^https/.test(text);
}
function renderGuideXbandTo(container) {
  let items = [];
  if (guideData && guideData.sections) {
    for (const [section, list] of Object.entries(guideData.sections)) {
      if (/X\s*band|X波段/i.test(section)) {
        items = list;
        break;
      }
    }
  }
  let html = `<div class="guide-article">`;
  items.forEach(item => {
    const text = (item.text || "").trim();
    const imgs = item.imgs || [];
    if (text) {
      if (isGuideHeading(text) && text.length <= 18) {
        html += `<h3>${text}</h3>`;
      } else if (/bladeRF-cli|^#|^\$\s|set frequency|set samplerate|set gain|set correction|rx config|tx config|rx start|tx start/.test(text)) {
        html += `<pre>${text.replace(/</g, "&lt;")}</pre>`;
      } else {
        html += `<p>${text}</p>`;
      }
    }
    imgs.forEach(im => {
      html += `<img src="${guideImg(im)}" alt="" loading="lazy">`;
    });
  });
  html += `</div>`;
  container.innerHTML = html;
}
function renderTutorial() {
  if (!guideData) {
    $("tutorialContent").innerHTML = `<div class="notice warning-note"><strong>加载失败</strong><span>教程数据未能加载。</span></div>`;
    return;
  }
  renderGuideXbandTo($("tutorialContent"));
}
function renderGuide() {
  if (!guideData) {
    $("guideContent").innerHTML = `<div class="notice warning-note"><strong>加载失败</strong><span>指南数据未能加载，请稍后重试。</span></div>`;
    return;
  }
  if (guideView.name === "sat") renderGuideSatellite(guideView.fam, guideView.sat);else renderGuideIndex();
  const heading = guideView.name === "sat" ? "气象卫星接收数据 · 卫星详情" : "气象卫星接收数据";
  const h = document.querySelector(".guide-head h2");
  if (h) h.textContent = heading;
}
function buildGuideMenu() {
  const menu = $("guideSubMenu");
  if (!menu || menu.dataset.built || !guideData) return;
  menu.dataset.built = "1";
  const families = guideFamilies();
  let html = `<a href="#" data-guide="index" class="active">数据总览</a>`;
  families.forEach((family, fi) => {
    html += `<span class="guide-menu-label">${family.name}</span>`;
    family.sats.forEach((sat, si) => {
      html += `<a href="#" data-guide="sat" data-fam="${fi}" data-sat="${si}">${sat.name}</a>`;
    });
  });
  menu.innerHTML = html;
}
function buildTutorialMenu() {
  const menu = $("tutorialSubMenu");
  if (!menu || menu.dataset.built) return;
  menu.dataset.built = "1";
  menu.innerHTML = `<a href="#" data-tutorial="xband" class="active">X波段接收教程</a>`;
}
function renderWpMedia(storm, selectedDate = null) {
  var _storm$cma4;
  const products = storm.products || {};
  const setMeta = (id, base, extra) => {
    const el = $(id);
    if (el) el.textContent = extra ? `${base} · ${extra}` : base;
  };
  setMeta("wpEcmwfMeta", "EPS · Weathernerds", modelCycleLabel(products.ecmwf_ensemble));
  setMeta("wpGefsMeta", "GEFS · Weathernerds", modelCycleLabel(products.gefs_ensemble));
  setMeta("wpJtwcMeta", "Official Forecast", observationTimeLabel(storm.observation_time));
  setMeta("wpSatelliteMeta", "Himawari‑9 · Tropical Tidbits", frameTimeFromUrl(products.satellite));
  $("wpAiVisSource").href = products.ai_vis || products.ai_vis_page || "#";
  $("wpSatelliteSource").href = products.satellite || products.tropical_tidbits || "https://www.tropicaltidbits.com/storminfo/";
  $("wpBdSource").href = products.bd || products.page || "#";
  $("wpBwLatestSource").href = products.bw || products.ai_vis_page || "#";
  $("wpEcmwfSource").href = products.ecmwf_ensemble || products.page || "#";
  $("wpGefsSource").href = products.gefs_ensemble || products.page || "#";
  $("wpJtwcSource").href = products.official_forecast || products.tropical_tidbits || "#";
  setHistoryMode(Boolean(selectedDate), storm, selectedDate);
  renderIntensityChart(((_storm$cma4 = storm.cma) === null || _storm$cma4 === void 0 ? void 0 : _storm$cma4.track) || [], selectedDate);
  updateTrackMap(storm, selectedDate);
  if (selectedDate) {
    setMeta("wpEcmwfMeta", "EPS · Weathernerds", `${selectedDate.slice(5)} 回看`);
    setMeta("wpGefsMeta", "GEFS · Weathernerds", `${selectedDate.slice(5)} 回看`);
    loadHistoricalDapiyaFrame("wpAiVisImage", "wpAiVisFallback", storm.id, "AI_VIS", selectedDate, "wpAiVisLoading", "wpAiVisAnimBadge", "VIS");
    loadHistoricalDapiyaFrame("wpBwLatestImage", "wpBwLatestFallback", storm.id, "BW", selectedDate, "wpBwLatestLoading", "wpBwLatestAnimBadge");
    loadHistoricalDapiyaFrame("wpBdImage", "wpBdFallback", storm.id, "BD", selectedDate, "wpBdLoading", "wpBdAnimBadge");
    loadPmrImage(storm.id, selectedDate);
    loadWeathernerdsHistory("wpEcmwfImage", "wpEcmwfFallback", storm.id, selectedDate, "ECENS");
    loadWeathernerdsHistory("wpGefsImage", "wpGefsFallback", storm.id, selectedDate, "GEFS");
    renderFullDiskGrid(selectedDate);
    return;
  }
  loadDapiyaAnimated("wpAiVisImage", "wpAiVisFallback", storm.id, "AI_VIS", "wpAiVisLoading", "wpAiVisAnimBadge", products.ai_vis, "snapshot");
  loadPlainImage($("wpSatelliteImage"), $("wpSatelliteFallback"), products.satellite, $("wpSatelliteLoading"));
  loadDapiyaAnimated("wpBdImage", "wpBdFallback", storm.id, "BD", "wpBdLoading", "wpBdAnimBadge", products.bd);
  loadDapiyaAnimated("wpBwLatestImage", "wpBwLatestFallback", storm.id, "BW", "wpBwLatestLoading", "wpBwLatestAnimBadge", products.bw);
  loadPmrImage(storm.id, null);
  loadModelImage("wpEcmwfImage", "wpEcmwfFallback", "ECENS", products.ecmwf_ensemble);
  loadModelImage("wpGefsImage", "wpGefsFallback", "GEFS", products.gefs_ensemble);
  loadPlainImage($("wpJtwcImage"), $("wpJtwcFallback"), products.official_forecast);
  renderFullDiskGrid();
  renderEnvironmentGrid();
}
function renderWpStorm(stormId, preserveDate = false) {
  var _wpDashboard3, _storm$products;
  if (!((_wpDashboard3 = wpDashboard) !== null && _wpDashboard3 !== void 0 && (_wpDashboard3 = _wpDashboard3.storms) !== null && _wpDashboard3 !== void 0 && _wpDashboard3.length)) return;
  const storm = wpDashboard.storms.find(item => item.id === stormId) || wpDashboard.storms[0];
  if (!preserveDate || wpStormId !== storm.id) {
    wpSelectedDate = null;
    try {
      stopAllAnims();
    } catch (error) {}
  }
  wpStormId = storm.id;
  document.querySelectorAll(".storm-rank-card").forEach(card => {
    card.classList.toggle("active", card.dataset.stormId === storm.id);
  });
  renderStormValues(storm, wpSelectedDate);
  $("openWpSource").href = ((_storm$products = storm.products) === null || _storm$products === void 0 ? void 0 : _storm$products.tropical_tidbits) || "https://www.tropicaltidbits.com/storminfo/";
  if ($("wpSourceMini")) $("wpSourceMini").href = $("openWpSource").href;
  renderWpMedia(storm, wpSelectedDate);
  loadTimeline(storm.id);
}
async function loadTimeline(stormId) {
  const layers = ["VIS", "BD", "BW"];
  const ranges = [];
  await Promise.allSettled(layers.map(async layer => {
    try {
      const frames = await fetchFrameList(stormId, layer, 200000);
      if (frames.length) ranges.push({
        layer,
        start: frames[0].time,
        end: frames[frames.length - 1].time
      });
    } catch (error) {}
  }));
  const storm = currentStormObject();
  const aiFrames = (storm === null || storm === void 0 ? void 0 : storm.ai_vis_frames) || [];
  if (aiFrames.length) ranges.push({
    layer: "AI_VIS",
    start: aiFrames[0].time,
    end: aiFrames[aiFrames.length - 1].time
  });
  wpTimeline = ranges.length ? {
    storm: stormId,
    start: ranges.map(r => r.start).sort()[0],
    end: ranges.map(r => r.end).sort().slice(-1)[0]
  } : null;
  renderTimeline();
}
function renderTimeline() {
  const bar = $("wpTimelineBar");
  const slider = $("wpTimelineSlider");
  if (!wpTimeline || !wpTimeline.start || !wpTimeline.end) {
    if (bar) bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const start = new Date(wpTimeline.start);
  const end = new Date(wpTimeline.end);
  const totalDays = Math.max(0, Math.round((end - start) / 86400000));
  slider.min = "0";
  slider.max = String(totalDays);
  if (wpSelectedDate) {
    const target = new Date(wpSelectedDate + "T00:00:00Z");
    const offset = Math.max(0, Math.min(totalDays, Math.round((target - start) / 86400000)));
    slider.value = String(offset);
  } else {
    slider.value = String(totalDays);
  }
  $("wpTimelineStart").textContent = formatDateLabel(start);
  $("wpTimelineEnd").textContent = formatDateLabel(end);
  const ticks = $("wpTimelineTicks");
  if (ticks) {
    ticks.innerHTML = "";
    for (let i = 0; i <= totalDays; i++) {
      const tick = document.createElement("span");
      tick.title = formatDateLabel(new Date(start.getTime() + i * 86400000));
      ticks.append(tick);
    }
  }
  updateTimelineLabel();
}
function updateTimelineLabel() {
  const slider = $("wpTimelineSlider");
  const label = $("wpTimelineLabel");
  if (!wpTimeline) {
    if (label) label.textContent = "最新";
    return;
  }
  const value = Number(slider.value);
  const max = Number(slider.max);
  if (!slider.max || value >= max || !wpSelectedDate) {
    label.textContent = "最新";
  } else {
    label.textContent = wpSelectedDate;
  }
}
function applyTimelineValue() {
  const slider = $("wpTimelineSlider");
  const max = Number(slider.max);
  const value = Number(slider.value);
  if (!wpTimeline || max <= 0 || value >= max) {
    wpSelectedDate = null;
  } else {
    const target = new Date(new Date(wpTimeline.start).getTime() + value * 86400000);
    wpSelectedDate = formatDateLabel(target);
  }
  updateTimelineLabel();
  const storm = currentStormObject();
  if (storm) {
    renderStormValues(storm, wpSelectedDate);
    renderWpMedia(storm, wpSelectedDate);
  }
}
function renderWpDashboard(data) {
  wpDashboard = data;
  const storms = data.storms || [];
  const tabs = $("wpStormTabs");
  tabs.innerHTML = "";
  storms.forEach((storm, index) => {
    var _cma$pressure_hpa2, _storm$wind_kt2, _storm$pressure_hpa;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.stormId = storm.id;
    button.className = "storm-rank-card";
    const rank = document.createElement("b");
    rank.textContent = String(index + 1).padStart(2, "0");
    const identity = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = storm.name;
    const cma = storm.cma;
    const meta = document.createElement("small");
    meta.textContent = `${storm.id} · ${(cma === null || cma === void 0 ? void 0 : cma.level) || storm.level}`;
    identity.append(name, meta);
    const intensity = document.createElement("em");
    intensity.textContent = cma ? `${cma.wind_mps} m/s · ${cma.wind_force_label} · ${(_cma$pressure_hpa2 = cma.pressure_hpa) !== null && _cma$pressure_hpa2 !== void 0 ? _cma$pressure_hpa2 : "—"} hPa` : `${(_storm$wind_kt2 = storm.wind_kt) !== null && _storm$wind_kt2 !== void 0 ? _storm$wind_kt2 : "—"} kt · ${(_storm$pressure_hpa = storm.pressure_hpa) !== null && _storm$pressure_hpa !== void 0 ? _storm$pressure_hpa : "—"} hPa`;
    button.append(rank, identity, intensity);
    tabs.appendChild(button);
  });
  $("wpSituationEmpty").hidden = Boolean(storms.length);
  $("wpSituationBody").hidden = !storms.length;
  if (!storms.length) {
    $("wpSituationEmpty").querySelector("strong").textContent = "当前未检出活动的西太平洋热带系统";
    $("wpSituationEmpty").querySelector("span").textContent = "工具仍会每 2 分钟自动检查来源站。";
  } else {
    renderWpStorm(storms.some(item => item.id === wpStormId) ? wpStormId : storms[0].id, true);
  }
  const refreshed = data.generated_at ? new Date(data.generated_at) : null;
  $("wpUpdatedAt").textContent = refreshed && !Number.isNaN(refreshed.getTime()) ? `本地刷新 ${refreshed.toLocaleString("zh-CN", {
    hour12: false
  })}` : "刷新时间未知";
  $("wpLiveState").classList.toggle("stale", Boolean(data.stale));
  $("wpLiveState").lastChild.textContent = data.stale ? " 使用上次成功资料" : " 实时资料已同步";
}
async function loadWpSituation({
  force = false
} = {}) {
  if (wpLoadInFlight || document.hidden) return;
  wpLoadInFlight = true;
  $("refreshWpSituation").disabled = true;
  try {
    const stormsPromise = fetchDapiyaStorms().catch(() => []);
    const cmaPromise = fetchCmaData().catch(() => ({}));
    const snapshotsPromise = Promise.allSettled([force ? loadSnapshotStorms(true) : loadSnapshotStorms(), force ? loadSnapshotHimawari(true) : loadSnapshotHimawari(), force ? loadSnapshotSst(true) : loadSnapshotSst()]);
    if (force) {
      const envGrid = $("wpEnvironmentGrid");
      if (envGrid) envGrid.dataset.signature = "";
    }
    const storms = await stormsPromise;
    if (!storms.length) {
      $("wpLiveState").classList.add("stale");
      $("wpLiveState").lastChild.textContent = " 暂时无法更新";
      $("wpSituationEmpty").querySelector("strong").textContent = "西太平洋热带气旋资料读取失败";
      const scriptError = (window.__webErrors || [])[0];
      $("wpSituationEmpty").querySelector("span").textContent = scriptError ? `脚本提示：${scriptError}` : "请检查网络后稍后自动重试。";
    } else {
      await snapshotsPromise;
      renderWpDashboard(buildDashboard(storms, {}));
      const stormSelect = $("storm");
      if (stormSelect && storms.length) {
        stormSelect.innerHTML = "";
        for (const groupName of ["Mesoscale", "Floater"]) {
          const list = storms.filter(item => item.group === groupName);
          if (!list.length) continue;
          const group = document.createElement("optgroup");
          group.label = groupName;
          list.forEach(item => {
            const option = document.createElement("option");
            option.value = item.id;
            option.textContent = item.name;
            group.appendChild(option);
          });
          stormSelect.appendChild(group);
        }
      }
      const cma = await cmaPromise;
      wpDashboard = buildDashboard(storms, cma);
      document.querySelectorAll(".storm-rank-card").forEach(card => {
        var _storm$cma5;
        const storm = wpDashboard.storms.find(item => item.id === card.dataset.stormId);
        if (!storm) return;
        const meta = card.querySelector("small");
        if (meta) meta.textContent = `${storm.id} · ${((_storm$cma5 = storm.cma) === null || _storm$cma5 === void 0 ? void 0 : _storm$cma5.level) || storm.level}`;
        const em = card.querySelector("em");
        if (em) {
          var _storm$cma$pressure_h, _storm$wind_kt3, _storm$pressure_hpa2;
          em.textContent = storm.cma ? `${storm.cma.wind_mps} m/s · ${storm.cma.wind_force_label} · ${(_storm$cma$pressure_h = storm.cma.pressure_hpa) !== null && _storm$cma$pressure_h !== void 0 ? _storm$cma$pressure_h : "—"} hPa` : `${(_storm$wind_kt3 = storm.wind_kt) !== null && _storm$wind_kt3 !== void 0 ? _storm$wind_kt3 : "—"} kt · ${(_storm$pressure_hpa2 = storm.pressure_hpa) !== null && _storm$pressure_hpa2 !== void 0 ? _storm$pressure_hpa2 : "—"} hPa`;
        }
      });
      const current = currentStormObject();
      if (current) {
        var _current$cma;
        renderStormValues(current, wpSelectedDate);
        renderIntensityChart(((_current$cma = current.cma) === null || _current$cma === void 0 ? void 0 : _current$cma.track) || [], wpSelectedDate);
        updateTrackMap(current, wpSelectedDate);
      }
    }
  } catch (error) {
    $("wpLiveState").classList.add("stale");
    $("wpLiveState").lastChild.textContent = " 暂时无法更新";
  } finally {
    wpLoadInFlight = false;
    $("refreshWpSituation").disabled = false;
    clearTimeout(wpRefreshTimer);
    wpRefreshTimer = setTimeout(() => loadWpSituation(), 120000);
  }
}
function showPage(page) {
  const pageTitles = {
    home: "路人王老康 BG5VJM 的博客",
    analysis: "台风云图实时分析 · BG5VJM",
    resources: "台风资料中心 · BG5VJM",
    glossary: "术语与德沃夏克 · BG5VJM",
    download: "本地软件 · BG5VJM",
    guide: "气象卫星接收数据 · BG5VJM",
    tutorial: "气象卫星接收教程 · BG5VJM"
  };
  if (pageTitles[page]) document.title = pageTitles[page];
  const toolTabs = document.querySelector(".app-tabs");
  if (toolTabs) toolTabs.hidden = !["analysis", "resources", "glossary", "download"].includes(page);
  document.querySelectorAll(".page-panel").forEach(panel => {
    panel.hidden = !panel.classList.contains(`page-${page}`);
  });
  document.querySelectorAll(".app-tab").forEach(button => {
    button.classList.toggle("active", button.dataset.page === page);
  });
  document.querySelectorAll(".side-menu a[data-page]").forEach(link => {
    link.classList.toggle("active", link.dataset.page === page);
  });
  if (page === "resources") {
    updateResourceStorm();
    const selectedTool = document.querySelector(".resource-tool.active");
    if (selectedTool) activateResource(selectedTool);
  }
  if (page === "analysis" && trackMap) {
    setTimeout(() => {
      if (!trackMap) return;
      trackMap.invalidateSize();
      const storm = currentStormObject();
      if (storm) updateTrackMap(storm, wpSelectedDate);
    }, 100);
  }
  if (page === "guide") {
    renderGuide();
    buildGuideMenu();
  }
  if (page === "tutorial") {
    renderTutorial();
    buildTutorialMenu();
  }
  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });
}
function updateResourceStorm() {
  const storm = currentStormObject();
  $("resourceStorm").textContent = storm ? `${storm.name} · ${storm.id}` : "尚未选择风暴";
  if (storm) {
    const match = storm.id.match(/^(\d{2})([A-Z])$/);
    const basins = {
      W: "wp",
      E: "ep",
      C: "cp",
      L: "al",
      A: "io",
      B: "io"
    };
    if (match && basins[match[2]]) {
      const identifier = `${basins[match[2]]}${match[1]}${new Date().getUTCFullYear()}`;
      $("rammbStormLink").href = `https://rammb-data.cira.colostate.edu/tc_realtime/storm.asp?storm_identifier=${identifier}`;
      $("rammbStormDescription").textContent = `当前入口：${identifier.toUpperCase()}`;
      return;
    }
  }
  $("rammbStormLink").href = "https://rammb-data.cira.colostate.edu/tc_realtime/";
  $("rammbStormDescription").textContent = "按当前选择风暴进入产品页";
}
function activateResource(button) {
  const url = button.dataset.url || "";
  const siteUrl = button.dataset.siteUrl || url;
  if (!/^https:\/\//i.test(url)) return;
  document.querySelectorAll(".resource-tool").forEach(item => {
    const selected = item === button;
    item.classList.toggle("active", selected);
    item.setAttribute("aria-selected", String(selected));
  });
  $("resourcePlaceholder").hidden = true;
  $("resourceFrame").hidden = false;
  if ($("resourceFrame").getAttribute("src") !== url) $("resourceFrame").src = url;
  $("openResource").disabled = false;
}
function openSelectedResource() {
  const button = document.querySelector(".resource-tool.active");
  const siteUrl = (button === null || button === void 0 ? void 0 : button.dataset.siteUrl) || "";
  if (!/^https:\/\//i.test(siteUrl)) return alert("当前没有可打开的官方网站");
  window.open(siteUrl, "_blank", "noopener");
}
function getFavorites() {
  try {
    return JSON.parse(localStorage.getItem("tc-resource-favorites") || "[]");
  } catch (_unused) {
    return [];
  }
}
function renderFavorites() {
  const container = $("favoriteList");
  container.innerHTML = "";
  const favorites = getFavorites();
  if (!favorites.length) {
    container.innerHTML = "<p>尚未保存地点或网址。</p>";
    return;
  }
  favorites.forEach((favorite, index) => {
    const row = document.createElement("div");
    row.className = "favorite-row";
    const label = document.createElement("strong");
    label.textContent = favorite.label;
    const url = document.createElement("span");
    url.textContent = favorite.url;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "button ghost";
    open.textContent = "打开";
    open.addEventListener("click", () => window.open(favorite.url, "_blank", "noopener"));
    const embed = document.createElement("button");
    embed.type = "button";
    embed.className = "button ghost";
    embed.textContent = "窗口查看";
    embed.addEventListener("click", () => {
      $("resourcePlaceholder").hidden = true;
      $("resourceFrame").hidden = false;
      $("resourceFrame").src = favorite.url;
      window.scrollTo({
        top: $("resourceFrame").getBoundingClientRect().top + window.scrollY - 100,
        behavior: "smooth"
      });
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button danger";
    remove.textContent = "删除";
    remove.addEventListener("click", () => {
      favorites.splice(index, 1);
      localStorage.setItem("tc-resource-favorites", JSON.stringify(favorites));
      renderFavorites();
    });
    row.append(label, url, embed, open, remove);
    container.appendChild(row);
  });
}
function saveFavorite() {
  const label = $("favoriteLabel").value.trim();
  const url = $("favoriteUrl").value.trim();
  if (!label) return alert("请输入名称");
  if (!/^https:\/\//i.test(url)) return alert("请输入以 https:// 开头的网址");
  const favorites = getFavorites();
  favorites.push({
    label,
    url
  });
  localStorage.setItem("tc-resource-favorites", JSON.stringify(favorites.slice(-50)));
  $("favoriteLabel").value = "";
  $("favoriteUrl").value = "";
  renderFavorites();
}
const glossaryTerms = [["NRL", "Naval Research Laboratory", "美国海军研究实验室"], ["FNMOC", "Fleet Numerical Meteorology and Oceanography Center", "美国舰队数值气象与海洋中心"], ["JTWC", "Joint Typhoon Warning Center", "联合台风警报中心"], ["JMA", "Japan Meteorological Agency", "日本气象厅"], ["RSMC", "Regional Specialized Meteorological Centre", "区域专业气象中心"], ["TCWC", "Tropical Cyclone Warning Centre", "热带气旋警报中心"], ["CMA", "China Meteorological Administration", "中国气象局"], ["CWA", "Central Weather Administration", "交通部中央气象署；台湾地区气象业务机构（原 CWB）"], ["KMA", "Korea Meteorological Administration", "韩国气象厅"], ["HKO", "Hong Kong Observatory", "香港天文台"], ["NHC", "National Hurricane Center", "美国国家飓风中心"], ["CPHC", "Central Pacific Hurricane Center", "中太平洋飓风中心"], ["ECMWF", "European Centre for Medium-Range Weather Forecasts", "欧洲中期天气预报中心"], ["NOAA", "National Oceanic and Atmospheric Administration", "美国国家海洋和大气管理局"], ["CIMSS", "Cooperative Institute for Meteorological Satellite Studies", "威斯康星大学合作气象卫星研究所"], ["TCFA", "Tropical Cyclone Formation Alert", "热带气旋形成警报"], ["LLCC", "Low-Level Circulation Center", "低层环流中心；可见光与微波分析中的重要定位依据"], ["ITCZ", "Intertropical Convergence Zone", "热带辐合带"], ["TUTT", "Tropical Upper-Tropospheric Trough", "热带对流层上部槽"], ["SST", "Sea Surface Temperature", "海表温度"], ["VWS", "Vertical Wind Shear", "垂直风切变"], ["STR", "Subtropical Ridge", "副热带高压脊"], ["CAPE", "Convective Available Potential Energy", "对流有效位能"], ["MJO", "Madden–Julian Oscillation", "马登－朱利安振荡"], ["ENSO", "El Niño–Southern Oscillation", "厄尔尼诺－南方涛动"], ["MCC", "Mesoscale Convective Complex", "中尺度对流复合体"], ["MCS", "Mesoscale Convective System", "中尺度对流系统"], ["LCL", "Lifting Condensation Level", "抬升凝结高度"], ["CTT", "Cloud Top Temperature", "云顶温度"], ["CTH", "Cloud Top Height", "云顶高度"], ["TD / TS / STS", "Tropical Depression / Tropical Storm / Severe Tropical Storm", "热带低压 / 热带风暴 / 强热带风暴"], ["TY / STY / SuperTY", "Typhoon / Severe Typhoon / Super Typhoon", "台风 / 强台风 / 超强台风；不同机构风速门槛并不完全一致"], ["T-number", "Dvorak T-number", "德沃夏克卫星分析强度指数，通常从 T1.0 到 T8.0"], ["DT / MET / PT", "Data / Model Expected / Pattern T-number", "德沃夏克分析中的资料型、模式期望型与云型 T 数"], ["WMG", "Warm Medium Grey", "暖中灰；BD 色阶中约高于 +9°C"], ["OW", "Off White", "灰白；BD 色阶中约 +9 至 -31°C"], ["DG / MG / LG", "Dark / Medium / Light Grey", "深灰 / 中灰 / 浅灰色阶"], ["B / W", "Black / White", "BD 色阶中的黑与白，约 -64 至 -76°C"], ["CMG", "Cold Medium Grey", "冷中灰；约 -76 至 -81°C"], ["CDG", "Cold Dark Grey", "冷深灰；约低于 -81°C，代表极冷且很高的强对流云顶"]];
const glossaryCategories = [{
  id: "environment",
  icon: "≋",
  title: "环流结构与环境参数",
  subtitle: "Structure & Environmental Parameters",
  terms: new Set(["LLCC", "ITCZ", "TUTT", "SST", "VWS", "STR", "CAPE", "MJO", "ENSO", "MCC", "MCS", "LCL", "CTT", "CTH"])
}, {
  id: "agencies",
  icon: "⚑",
  title: "业务机构与数据中心",
  subtitle: "Agencies & Data Centers",
  terms: new Set(["NRL", "FNMOC", "JTWC", "JMA", "RSMC", "TCWC", "CMA", "CWA", "KMA", "HKO", "NHC", "CPHC", "ECMWF", "NOAA", "CIMSS"])
}, {
  id: "operations",
  icon: "◈",
  title: "警报、等级与业务用语",
  subtitle: "Warnings, Classification & Operations",
  terms: new Set(["TCFA", "TD / TS / STS", "TY / STY / SuperTY"])
}, {
  id: "dvorak",
  icon: "D",
  title: "德沃夏克与 IR-BD 色阶",
  subtitle: "Dvorak Technique & IR-BD Enhancement",
  terms: new Set(["T-number", "DT / MET / PT", "WMG", "OW", "DG / MG / LG", "B / W", "CMG", "CDG"])
}];
const termLinks = {
  "NRL": ["https://www.nrl.navy.mil/", "访问机构官网"],
  "FNMOC": ["https://www.fnmoc.navy.mil/", "访问机构官网"],
  "JTWC": ["https://www.metoc.navy.mil/jtwc/jtwc.html?tropical", "访问机构官网"],
  "JMA": ["https://www.jma.go.jp/jma/indexe.html", "访问机构官网"],
  "RSMC": ["https://community.wmo.int/en/activity-areas/tropical-cyclones", "查看 WMO 说明"],
  "TCWC": ["https://community.wmo.int/en/activity-areas/tropical-cyclones", "查看 WMO 说明"],
  "CMA": ["https://www.cma.gov.cn/en/", "访问机构官网"],
  "CWA": ["https://www.cwa.gov.tw/", "访问机构官网"],
  "KMA": ["https://www.kma.go.kr/neng/index.do", "访问机构官网"],
  "HKO": ["https://www.hko.gov.hk/", "访问机构官网"],
  "NHC": ["https://www.nhc.noaa.gov/", "访问机构官网"],
  "CPHC": ["https://www.nhc.noaa.gov/?cpac", "访问机构官网"],
  "ECMWF": ["https://www.ecmwf.int/", "访问机构官网"],
  "NOAA": ["https://www.noaa.gov/", "访问机构官网"],
  "CIMSS": ["https://cimss.ssec.wisc.edu/", "访问机构官网"],
  "TCFA": ["https://en.wikipedia.org/wiki/Tropical_Cyclone_Formation_Alert", "查看术语解释"],
  "LLCC": ["https://en.wikipedia.org/wiki/Low-level_circulation_center", "查看术语解释"],
  "ITCZ": ["https://en.wikipedia.org/wiki/Intertropical_Convergence_Zone", "查看术语解释"],
  "TUTT": ["https://www.aoml.noaa.gov/hrd/tcfaq/D9.html", "查看 NOAA 专业说明"],
  "SST": ["https://en.wikipedia.org/wiki/Sea_surface_temperature", "查看术语解释"],
  "VWS": ["https://www.aoml.noaa.gov/behind-the-2015-atlantic-hurricane-season-wind-shear-tropical-cyclones/", "查看 NOAA 专业说明"],
  "STR": ["https://en.wikipedia.org/wiki/Subtropical_ridge", "查看术语解释"],
  "CAPE": ["https://en.wikipedia.org/wiki/Convective_available_potential_energy", "查看术语解释"],
  "MJO": ["https://en.wikipedia.org/wiki/Madden%E2%80%93Julian_oscillation", "查看术语解释"],
  "ENSO": ["https://en.wikipedia.org/wiki/El_Ni%C3%B1o%E2%80%93Southern_Oscillation", "查看术语解释"],
  "MCC": ["https://en.wikipedia.org/wiki/Mesoscale_convective_complex", "查看术语解释"],
  "MCS": ["https://en.wikipedia.org/wiki/Mesoscale_convective_system", "查看术语解释"],
  "LCL": ["https://en.wikipedia.org/wiki/Lifting_condensation_level", "查看术语解释"],
  "CTT": ["https://en.wikipedia.org/wiki/Special:Search?search=cloud+top+temperature", "查看术语解释"],
  "CTH": ["https://en.wikipedia.org/wiki/Special:Search?search=cloud+top+height", "查看术语解释"],
  "TD / TS / STS": ["https://www.nhc.noaa.gov/aboutgloss.shtml", "查看 NHC 业务术语"],
  "TY / STY / SuperTY": ["https://en.wikipedia.org/wiki/Tropical_cyclone_scales", "查看分级标准"],
  "T-number": ["https://tropic.ssec.wisc.edu/misc/adt/info.html", "查看 CIMSS 专业说明"],
  "DT / MET / PT": ["https://tropic.ssec.wisc.edu/misc/adt/info-goespg.html", "查看 CIMSS 专业说明"],
  "WMG": ["https://tropic.ssec.wisc.edu/misc/adt/info-goespg.html", "查看 EIR 色阶说明"],
  "OW": ["https://tropic.ssec.wisc.edu/misc/adt/info-goespg.html", "查看 EIR 色阶说明"],
  "DG / MG / LG": ["https://tropic.ssec.wisc.edu/misc/adt/info-goespg.html", "查看 EIR 色阶说明"],
  "B / W": ["https://tropic.ssec.wisc.edu/misc/adt/info-goespg.html", "查看 EIR 色阶说明"],
  "CMG": ["https://tropic.ssec.wisc.edu/misc/adt/info-goespg.html", "查看 EIR 色阶说明"],
  "CDG": ["https://tropic.ssec.wisc.edu/misc/adt/info-goespg.html", "查看 EIR 色阶说明"]
};
function renderGlossary(query = "") {
  const needle = query.trim().toLowerCase();
  const container = $("glossaryGrid");
  container.innerHTML = "";
  glossaryCategories.forEach(category => {
    const terms = glossaryTerms.filter(term => category.terms.has(term[0]) && term.join(" ").toLowerCase().includes(needle));
    if (!terms.length) return;
    const section = document.createElement("section");
    section.className = `glossary-category glossary-${category.id}`;
    const header = document.createElement("header");
    header.innerHTML = `<span>${category.icon}</span><div><h3>${category.title}</h3><p>${category.subtitle} · ${terms.length} 项</p></div>`;
    const grid = document.createElement("div");
    grid.className = "glossary-grid";
    terms.forEach(([abbr, english, chinese]) => {
      const card = document.createElement("article");
      card.className = "term-card";
      const heading = document.createElement("h3");
      heading.textContent = abbr;
      const en = document.createElement("p");
      en.className = "term-en";
      en.textContent = english;
      const zh = document.createElement("p");
      zh.textContent = chinese;
      card.append(heading, en, zh);
      const linkData = termLinks[abbr];
      if (linkData) {
        const link = document.createElement("a");
        link.className = "term-link";
        link.href = linkData[0];
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = `${linkData[1]} ↗`;
        card.appendChild(link);
      }
      grid.appendChild(card);
    });
    section.append(header, grid);
    container.appendChild(section);
  });
  if (!container.children.length) container.innerHTML = "<p class='empty-result'>没有匹配的术语。</p>";
}
function bindEvents() {
  document.querySelectorAll(".side-menu-sub-toggle").forEach(subToggle => {
    subToggle.addEventListener("click", () => {
      const group = subToggle.closest(".side-menu-group");
      const collapsed = group.classList.toggle("collapsed");
      subToggle.setAttribute("aria-expanded", String(!collapsed));
    });
  });
  const homePage = $("homePage");
  if (homePage) {
    homePage.addEventListener("click", event => {
      const card = event.target.closest("[data-page]");
      if (card && card.dataset.page) showPage(card.dataset.page);
    });
  }
  const guideContent = $("guideContent");
  if (guideContent) {
    guideContent.addEventListener("click", event => {
      const target = event.target.closest("[data-guide]");
      if (!target) return;
      if (target.dataset.guide === "sat") {
        guideView = {
          name: "sat",
          fam: target.dataset.fam,
          sat: target.dataset.sat
        };
      } else {
        guideView = {
          name: "index"
        };
      }
      renderGuide();
      window.scrollTo({
        top: 0,
        behavior: "smooth"
      });
    });
  }
  const guideSubMenu = $("guideSubMenu");
  if (guideSubMenu) {
    guideSubMenu.addEventListener("click", event => {
      const target = event.target.closest("[data-guide]");
      if (!target) return;
      if (target.dataset.guide === "sat") {
        guideView = {
          name: "sat",
          fam: target.dataset.fam,
          sat: target.dataset.sat
        };
      } else {
        guideView = {
          name: "index"
        };
      }
      document.querySelectorAll("#guideSubMenu [data-guide]").forEach(a => {
        a.classList.toggle("active", a === target);
      });
      renderGuide();
      closeMenu();
      showPage("guide");
    });
  }
  const tutorialSubMenu = $("tutorialSubMenu");
  if (tutorialSubMenu) {
    tutorialSubMenu.addEventListener("click", event => {
      const target = event.target.closest("[data-tutorial]");
      if (!target) return;
      tutorialView = {
        name: target.dataset.tutorial || "xband"
      };
      document.querySelectorAll("#tutorialSubMenu [data-tutorial]").forEach(a => {
        a.classList.toggle("active", a === target);
      });
      renderTutorial();
      closeMenu();
      showPage("tutorial");
    });
  }
  const menuToggle = $("menuToggle");
  const sideMenu = $("sideMenu");
  const overlay = $("sideMenuOverlay");
  const openMenu = () => {
    if (!sideMenu) return;
    sideMenu.classList.add("open");
    if (overlay) overlay.classList.add("open");
    if (menuToggle) menuToggle.setAttribute("aria-expanded", "true");
  };
  const closeMenu = () => {
    if (!sideMenu) return;
    sideMenu.classList.remove("open");
    if (overlay) overlay.classList.remove("open");
    if (menuToggle) menuToggle.setAttribute("aria-expanded", "false");
  };
  if (menuToggle && sideMenu && overlay) {
    menuToggle.addEventListener("click", () => {
      if (sideMenu.classList.contains("open")) closeMenu();else openMenu();
    });
    overlay.addEventListener("click", closeMenu);
    if ($("menuClose")) $("menuClose").addEventListener("click", closeMenu);
    sideMenu.addEventListener("click", event => {
      const link = event.target.closest("a[data-page]");
      if (link) {
        showPage(link.dataset.page);
        closeMenu();
      }
    });
  }
  const downloadPage = $("downloadPage");
  if (downloadPage) {
    downloadPage.addEventListener("click", event => {
      if (event.target.closest(".banner-download")) return;
      const control = event.target.closest("button");
      if (control) {
        event.preventDefault();
        showToast("网页版仅展示界面：下载、预览与视频合成请使用本地软件，见上方公告下载链接。");
      }
    });
  }
  $("refreshWpSituation").addEventListener("click", () => loadWpSituation({
    force: true
  }));
  const stormTabs = $("wpStormTabs");
  if (stormTabs) {
    stormTabs.addEventListener("click", event => {
      const card = event.target.closest(".storm-rank-card");
      if (card && card.dataset.stormId) renderWpStorm(card.dataset.stormId);
    });
  }
  $("wpTimelineSlider").addEventListener("input", applyTimelineValue);
  $("wpTimelineLatest").addEventListener("click", () => {
    $("wpTimelineSlider").value = $("wpTimelineSlider").max;
    applyTimelineValue();
  });
  const expandToggle = $("wpExpandToggle");
  const dataDetails = $("wpDataDetails");
  if (expandToggle && dataDetails) {
    const summaryEl = dataDetails.querySelector("summary");
    if (summaryEl) {
      summaryEl.addEventListener("click", event => event.preventDefault());
    }
    const sync = () => {
      expandToggle.textContent = dataDetails.open ? "收起 ▴" : "展开全部 ▾";
    };
    expandToggle.addEventListener("click", () => {
      dataDetails.open = !dataDetails.open;
      sync();
    });
    dataDetails.addEventListener("toggle", sync);
    sync();
  }
  document.querySelectorAll(".app-tab").forEach(button => {
    button.addEventListener("click", () => showPage(button.dataset.page));
  });
  document.querySelectorAll(".resource-tool").forEach(button => {
    button.addEventListener("click", () => activateResource(button));
  });
  $("openResource").addEventListener("click", openSelectedResource);
  $("saveFavorite").addEventListener("click", saveFavorite);
  $("glossarySearch").addEventListener("input", () => renderGlossary($("glossarySearch").value));
}
function boot() {
  window.__webErrors = [];
  window.addEventListener("error", event => {
    if (window.__webErrors.length < 5) {
      window.__webErrors.push(event.message || String(event.error || "脚本错误"));
    }
  });
  bindEvents();
  const dataDetails = $("wpDataDetails");
  if (dataDetails && window.matchMedia("(max-width: 760px)").matches) {
    dataDetails.open = false;
  }
  renderFavorites();
  renderGlossary();
  $("openResource").disabled = true;
  showPage("home");
  loadWpSituation();
  loadGuideData().then(() => {
    buildGuideMenu();
    buildTutorialMenu();
    if ($("guidePage") && !$("guidePage").hidden) renderGuide();
    if ($("tutorialPage") && !$("tutorialPage").hidden) renderTutorial();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) loadWpSituation();
  });
}
boot();