#!/usr/bin/env python3
"""Snapshot generator for the GitHub Pages edition.

The web app can talk to Dapiya and CMA directly in the browser (CORS enabled),
and every image host works via <img>. This script snapshots the remaining data
that browsers cannot fetch cross-origin:

  * data/storms.json  - Tropical Tidbits storm cards, Weathernerds model URLs,
                        CIMSS ADT analysis and Dapiya AI-VIS frame lists
  * data/himawari.json- latest Himawari full-disk observation times
  * data/sst.json     - resolved OSPO blended SST image URL

Run locally (python tools/snapshot.py) or automatically via GitHub Actions.
Only the Python standard library is used.
"""

from __future__ import annotations

import datetime as dt
import html
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")

UA = "BG5VJM-TyphoonWorkbench/1.0 (+GitHub Pages snapshot)"

DAPIYA_API = "https://api.dapiya.top"
DAPIYA_DATA = "https://data.dapiya.top"
TT_STORMS = "https://www.tropicaltidbits.com/storminfo/stormhtml.json"
TT_STORM_PAGE = "https://www.tropicaltidbits.com/storminfo/"
WEATHERNERDS_GUIDANCE = "https://www.weathernerds.org/tc_guidance/"
CIMSS_ADT_BASE = "https://tropic.ssec.wisc.edu/real-time/adt/"
AI_VIS_FILELIST = "https://ai-vis.dapiya.cn/php/filelist.php"
HIMAWARI_LATEST = "https://jh190005-4.kudpc.kyoto-u.ac.jp/himawari/img/D531106/latest.json"
OSPO_SST_NAMES = {"bno": "NIGHT-ONLY", "bdn": "DAY-NIGHT", "bdc": "DA-ONLY"}


def get(url: str, timeout: int = 25) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace").strip()


def try_get(url: str, timeout: int = 25) -> str | None:
    try:
        return get(url, timeout=timeout)
    except Exception:  # noqa: BLE001
        return None


def head_ok(url: str, timeout: int = 15) -> bool:
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except Exception:  # noqa: BLE001
        return False


def _match(pattern: str, text: str, default: str = "") -> str:
    match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
    return html.unescape(match.group(1)).strip() if match else default


def _number(pattern: str, text: str) -> float | None:
    value = _match(pattern, text)
    if not value or value.upper() == "N/A":
        return None
    try:
        return float(value)
    except ValueError:
        return None


def parse_wp_storm(storm_id: str, fragment: str) -> dict | None:
    plain = re.sub(r"<[^>]+>", " ", fragment)
    plain = re.sub(r"\s+", " ", html.unescape(plain))
    name = _match(r'class=["\']storm-name["\'][^>]*>(.*?)</span>', fragment, storm_id)
    timestamp = _match(r'class=["\']timestamp["\'][^>]*>(.*?)</span>', fragment)
    latitude = _number(r"Location:\s*([0-9.]+)&deg;[NS]", fragment)
    longitude = _number(r"Location:\s*[0-9.]+&deg;[NS]\s*([0-9.]+)&deg;[EW]", fragment)
    lat_hemi = _match(r"Location:\s*[0-9.]+&deg;([NS])", fragment, "N").upper()
    lon_hemi = _match(r"Location:\s*[0-9.]+&deg;[NS]\s*[0-9.]+&deg;([EW])", fragment, "E").upper()
    if latitude is not None and lat_hemi == "S":
        latitude = -latitude
    if longitude is not None and lon_hemi == "W":
        longitude = -longitude
    wind = _number(r"Maximum Winds:\s*([0-9.]+|N/A)\s*kt", plain)
    pressure = _number(r"Minimum Central Pressure:\s*([0-9.]+|N/A)\s*mb", plain)
    rmw = _number(r"Radius of Maximum wind:\s*([0-9.]+|N/A)\s*nm", plain)
    satellite = _match(r'<img[^>]+src=["\']([^"\']+)["\'][^>]+alt=["\']IR Satellite Image', fragment)
    official = _match(r'<img[^>]+src=["\']([^"\']+)["\'][^>]+alt=["\']Official Forecast', fragment)
    if not name and not wind and not pressure:
        return None
    short_name = re.sub(
        r"^(?:Tropical Cyclone|Typhoon|Tropical Storm|Tropical Depression|Invest)\s+",
        "",
        name,
        flags=re.I,
    )
    return {
        "id": storm_id,
        "name": short_name or storm_id,
        "display_name": name,
        "timestamp": timestamp,
        "wind_kt": int(wind) if wind is not None else None,
        "pressure_hpa": int(pressure) if pressure is not None else None,
        "rmw_nm": int(rmw) if rmw is not None else None,
        "latitude": latitude,
        "longitude": longitude,
        "is_invest": bool(re.fullmatch(r"9[0-9]W", storm_id)),
        "products": {
            "page": f"{WEATHERNERDS_GUIDANCE}WP{storm_id[:2]}.html",
            "satellite": satellite,
            "official_forecast": official,
            "tropical_tidbits": f"{TT_STORM_PAGE}#{storm_id}",
        },
    }


def fetch_tt_storms() -> dict[str, dict]:
    text = try_get(TT_STORMS, timeout=20)
    if not text:
        return {}
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return {}
    result: dict[str, dict] = {}
    for storm_id, fragment in payload.items():
        sid = storm_id.upper()
        if not re.fullmatch(r"[0-9]{2}W", sid):
            continue
        parsed = parse_wp_storm(sid, fragment)
        if parsed:
            result[sid] = parsed
    return result


def fetch_weathernerds_products(storm_id: str) -> dict[str, str]:
    wn_id = f"WP{storm_id[:2]}"
    page_url = f"{WEATHERNERDS_GUIDANCE}{wn_id}.html"
    products: dict[str, str] = {}
    source = try_get(page_url, timeout=12)
    if not source:
        return products
    for key, suffix in (("ecmwf_ensemble", "ECENS"), ("gefs_ensemble", "GEFS")):
        match = re.search(
            rf"src=[\"']([^\"']*{re.escape(wn_id)}_[0-9]{{10}}_{suffix}\.png)(?:\?[^\"']*)?[\"']",
            source,
            re.IGNORECASE,
        )
        if match:
            products[key] = urllib.request.urljoin(page_url, html.unescape(match.group(1)))
    return products


def fetch_adt_analysis(storm_id: str) -> dict | None:
    if re.fullmatch(r"9[0-9]W", storm_id):
        return None
    page_url = f"{CIMSS_ADT_BASE}odt{storm_id}.html"
    source = try_get(page_url, timeout=12)
    if not source:
        return None
    plain = html.unescape(re.sub(r"<[^>]+>", " ", source))
    plain = re.sub(r"\s+", " ", plain)
    ci_match = re.search(
        r"CI#\s*/Pressure/\s*Vmax\s*([0-9.]+)\s*/\s*([0-9.]+)\s*mb\s*/\s*([0-9.]+)\s*kt",
        plain,
        re.IGNORECASE,
    )
    if not ci_match:
        return None
    t_match = re.search(
        r"Final T#\s+Adj T#\s+Raw T#\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)",
        plain,
        re.IGNORECASE,
    )
    date_value = _match(r"Date\s*:\s*([0-9]{2}\s+[A-Z]{3}\s+[0-9]{4})", plain)
    time_value = _match(r"Time\s*:\s*([0-9]{6})\s*UTC", plain)
    return {
        "ci": float(ci_match.group(1)),
        "pressure_hpa": float(ci_match.group(2)),
        "vmax_kt": float(ci_match.group(3)),
        "final_t": float(t_match.group(1)) if t_match else None,
        "adjusted_t": float(t_match.group(2)) if t_match else None,
        "raw_t": float(t_match.group(3)) if t_match else None,
        "scene": _match(r"Scene Type\s*:\s*([A-Z0-9_-]+)", plain),
        "center_temp_c": _number(r"Center Temp\s*:\s*([+-]?[0-9.]+)\s*C", plain),
        "cloud_region_temp_c": _number(r"Cloud Region Temp\s*:\s*([+-]?[0-9.]+)\s*C", plain),
        "analysis_time": " ".join(item for item in (date_value, time_value and f"{time_value} UTC") if item),
        "source": page_url,
    }


def fetch_ai_vis_frames(storm_id: str, limit: int = 300) -> list[dict]:
    url = (
        AI_VIS_FILELIST
        + f"?host=ai-vis.dapiya.cn&name={urllib.parse.quote(storm_id)}&type=AI_VIS"
    )
    text = try_get(url, timeout=20)
    if not text:
        return []
    result: list[dict] = []
    for raw in text.split(","):
        item = raw.strip()
        match = re.search(r"_(\d{14})\.(?:png|jpe?g|webp)$", item, re.IGNORECASE)
        if not item or not match:
            continue
        try:
            stamp = dt.datetime.strptime(match.group(1), "%Y%m%d%H%M%S").replace(tzinfo=dt.timezone.utc)
        except ValueError:
            continue
        result.append({"url": item, "time": stamp.isoformat().replace("+00:00", "Z")})
    result.sort(key=lambda item: item["time"])
    return result[-limit:]


def fetch_latest_layer(storm_id: str, layer: str) -> str | None:
    """Latest Dapiya frame URL for a piclist layer (BD/BW/etc.)."""
    try:
        text = get(f"{DAPIYA_API}/typhoon/{storm_id}/piclist/{layer}/8", timeout=15)
    except Exception:  # noqa: BLE001
        return None
    urls: list[str] = []
    for raw in text.split(","):
        path = raw.strip()
        if path and re.search(r"_(\d{14})\.(?:png|jpe?g|webp)$", path, re.IGNORECASE):
            urls.append(f"{DAPIYA_DATA}{path}")
    return urls[-1] if urls else None


def fetch_himawari() -> dict:
    payload: dict = {"generated_at": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")}
    text = try_get(HIMAWARI_LATEST, timeout=20)
    if text:
        try:
            data = json.loads(text)
            latest = dt.datetime.strptime(str(data["date"]), "%Y-%m-%d %H:%M:%S").replace(tzinfo=dt.timezone.utc)
            latest = latest.replace(minute=0, second=0, microsecond=0)
            payload["latest"] = latest.isoformat().replace("+00:00", "Z")
            payload["times"] = [
                (latest - dt.timedelta(hours=hour)).isoformat().replace("+00:00", "Z")
                for hour in range(24, -1, -1)
            ]
        except Exception:  # noqa: BLE001
            pass
    return payload


def fetch_sst() -> dict:
    payload: dict = {"generated_at": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")}
    today = dt.datetime.now(dt.timezone.utc).date()
    existing_date = ""
    existing_path = os.path.join(DATA_DIR, "sst.json")
    if os.path.isfile(existing_path):
        try:
            with open(existing_path, "r", encoding="utf-8") as fh:
                existing_date = str(json.load(fh).get("date") or "")
        except Exception:  # noqa: BLE001
            existing_date = ""
    for offset in range(0, 10):
        day = today - dt.timedelta(days=offset)
        url = (
            f"https://www.ospo.noaa.gov/data/sst/bno/daily/{day.year}/"
            f"BSST-NIGHT-ONLY-{day.isoformat()}.png"
        )
        if head_ok(url):
            payload.update({"url": url, "date": day.isoformat()})
            image_path = os.path.join(DATA_DIR, "sst.png")
            if day.isoformat() == existing_date and os.path.isfile(image_path):
                # 同一天的文件没有变化，无需重复下载
                break
            try:
                with urllib.request.urlopen(
                    urllib.request.Request(url, headers={"User-Agent": UA}),
                    timeout=45,
                ) as resp:
                    image = resp.read()
                if len(image) > 1000:
                    with open(image_path, "wb") as fh:
                        fh.write(image)
            except Exception:  # noqa: BLE001
                pass
            break
    return payload


def main() -> int:
    os.makedirs(DATA_DIR, exist_ok=True)
    now = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")

    # 1. Active storm ids from Dapiya (fast, authoritative for the tool).
    storm_ids: list[str] = []
    text = try_get(f"{DAPIYA_API}/typhoon/meso/all", timeout=15)
    if text:
        for line in text.splitlines():
            for item in line.split("|"):
                sid = item.strip()[:3].upper()
                if re.fullmatch(r"[0-9]{2}[A-Z]", sid):
                    storm_ids.append(sid)
    if not storm_ids:
        print("No active storms from Dapiya; keeping previous snapshot.", file=sys.stderr)
        return 0

    tt_storms = fetch_tt_storms()
    storms: dict[str, dict] = {}
    for sid in storm_ids:
        entry: dict = {"id": sid}
        tt = tt_storms.get(sid)
        if tt:
            entry.update(tt)
            entry["products"].update(fetch_weathernerds_products(sid))
        else:
            entry["name"] = sid
            entry["products"] = {
                "page": f"{WEATHERNERDS_GUIDANCE}WP{sid[:2]}.html",
                "tropical_tidbits": f"{TT_STORM_PAGE}#{sid}",
            }
        for layer in ("BD", "BW"):
            latest = fetch_latest_layer(sid, layer)
            if latest:
                entry["products"][layer.lower()] = latest
        adt = fetch_adt_analysis(sid)
        if adt:
            entry["adt"] = adt
        ai_vis = fetch_ai_vis_frames(sid)
        if ai_vis:
            entry["ai_vis"] = ai_vis
        entry["ai_vis_page"] = f"https://ai-vis.dapiya.cn/sat.html?stormid={sid}"
        entry["ai_vis_latest"] = f"https://data.dapiya.cn/AI-VIS/{sid}/AI_VIS/{sid}_AI_VIS.png"
        storms[sid] = entry

    storms_payload = {"generated_at": now, "storms": storms}
    with open(os.path.join(DATA_DIR, "storms.json"), "w", encoding="utf-8") as fh:
        json.dump(storms_payload, fh, ensure_ascii=False, indent=1)

    himawari = fetch_himawari()
    if himawari.get("latest"):
        with open(os.path.join(DATA_DIR, "himawari.json"), "w", encoding="utf-8") as fh:
            json.dump(himawari, fh, ensure_ascii=False, indent=1)

    sst = fetch_sst()
    if sst.get("url"):
        with open(os.path.join(DATA_DIR, "sst.json"), "w", encoding="utf-8") as fh:
            json.dump(sst, fh, ensure_ascii=False, indent=1)

    print(f"snapshot ok: storms={len(storms)} himawari={bool(himawari.get('latest'))} sst={bool(sst.get('url'))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
