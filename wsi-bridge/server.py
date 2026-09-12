"""PathAsk WSI bridge —— OpenSlide 切片服务。

TS agent（pi-agent-core）无法直接调 OpenSlide（Python 库），此服务把 WSI
读取暴露成 HTTP 接口，作为 TS↔Python 的薄桥。每个 slide_id 对应
data/wsilist.json 里的一条登记（真实 WSI 原片路径）。

启动：
    PATHASK_WSI_REGISTRY=../data/wsilist.json python server.py
    # 默认 http://127.0.0.1:8787
"""
import base64
import io
import json
import os
import re
import threading
import time
from pathlib import Path

import numpy as np
import openslide
import uvicorn
from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel

import embed as embed_mod  # PLIP 编码器（懒加载，wsi-bridge 目录在 sys.path）
import conch_embed as conch_mod  # CONCH 编码器（懒加载，detect_roi 检索首选）

ROOT = Path(__file__).resolve().parent.parent  # path-ask/
REGISTRY_PATH = Path(os.environ.get("PATHASK_WSI_REGISTRY", ROOT / "data" / "wsilist.json"))
HOST = os.environ.get("PATHASK_BRIDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("PATHASK_BRIDGE_PORT", "8787"))
MASK_DIR = Path(os.environ.get("PATHASK_BRIDGE_MASK_DIR", str(REGISTRY_PATH.parent / "masks")))  # 掩膜落盘

app = FastAPI(title="PathAsk WSI bridge")

_registry: dict[str, dict] = {}
_slides: dict[str, openslide.OpenSlide] = {}
_locks: dict[str, threading.Lock] = {}

# 组织掩膜缓存：key=(slide_id, max_dim, sat_threshold)。tissue_mask/scan_overview 每次
# 都重算 2048×2048 饱和度阈值掩膜（读全图）→ 首次计算后 O(1) 命中。
# 单例掩膜 ~2048×2048 bool ≈ 4MB；用 lock 保 double-check 原子性。
# 缓存值升级为 (mask, nuclear) 元组：nuclear=核密度布尔掩膜（深紫核），供 sampling 按核密度重排（治 tissue_fraction 偏良性间质）。
# 磁盘兼容：旧 npz 无 nuclear 字段 → KeyError → 走重算（一次性）；新写盘含 nuclear。
_mask_cache: dict[tuple, tuple[np.ndarray, np.ndarray, float]] = {}
_mask_cache_lock = threading.Lock()


def load_registry() -> None:
    if not REGISTRY_PATH.exists():
        raise RuntimeError(f"registry 不存在: {REGISTRY_PATH}（先按 data/README.md 转移 WSI）")
    data = json.loads(REGISTRY_PATH.read_text())
    base = REGISTRY_PATH.parent
    for s in data.get("slides", []):
        abs_path = str((base / s["path"]).resolve())
        if not Path(abs_path).exists():
            print(f"[warn] slide 文件缺失: {abs_path}")
            continue
        _registry[s["id"]] = {**s, "abs_path": abs_path}


def _resolve(slide_id: str) -> str:
    """归一化 slide_id：精确命中注册表即返回；LLM 常剥掉扩展名（slide_00001_01.tiff → slide_00001_01），
    查不到时按「去扩展名」回退，返回注册表里的真实 id。TS 端 ensureWsi 已做同样归一化，此兜底双保险。
    追加 basename 兜底：TS 端 WsiClient 会剥目录前缀再进 URL（histai/HISTAI-mixed/case_00001 → case_00001，
    否则 / 在 URL path 段让 Starlette 解码后 {slide_id} 被截成 histai → 404），此处在注册表里按 basename
    反查带目录前缀的真实键（如 case_00001 → histai/HISTAI-mixed/case_00001）。"""
    if slide_id in _registry:
        return slide_id
    stripped = slide_id.rsplit(".", 1)[0] if "." in slide_id.rsplit("/", 1)[-1] else slide_id
    if stripped in _registry:
        return stripped
    base = slide_id.rsplit("/", 1)[-1]  # 剥目录前缀（basename）
    if not base:
        return slide_id
    # 注册表键可能带目录前缀，按 basename（允许带 .tiff）反查
    for k in _registry:
        kbase = k.rsplit("/", 1)[-1]
        kextless = kbase.rsplit(".", 1)[0] if "." in kbase else kbase
        if kbase == base or kextless == base:
            return k
    return slide_id


def get_slide(slide_id: str) -> openslide.OpenSlide:
    slid = _resolve(slide_id)
    if slid not in _registry:
        raise HTTPException(404, f"unknown slide {slide_id}")
    if slid not in _slides:
        try:
            _slides[slid] = openslide.OpenSlide(_registry[slid]["abs_path"])
        except Exception as e:  # noqa: BLE001
            raise HTTPException(500, f"openslide open failed: {e}") from e
    _locks.setdefault(slid, threading.Lock())
    return _slides[slid]


def _png_b64(img: Image.Image) -> str:
    # 剔除 OpenSlide 从 tiff 读回时残留的巨型元数据（超大 ICC/私有 tag/description 等），
    # 否则会被 Pillow 写进 PNG 的 TEXT/iTXt chunk，下游 Image.open() 时超 PngImagePlugin.MAX_TEXT_CHUNK
    # 抛 "Decompressed data too large"（detect_roi conch_embed / describe_patch VLM / retrieve_similar_case
    # 全炸 → 该 slide 降级 mock）。清空 info 后 save 不再带任何 chunk。
    img = img.copy()
    img.info.clear()
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _pick_level(slide: openslide.OpenSlide, max_dim: int) -> int:
    """宽度不超过 max_dim 的最高分辨率层级（0 = 全分辨率）。"""
    for i in range(slide.level_count):
        if slide.level_dimensions[i][0] <= max_dim:
            return i
    return slide.level_count - 1


def _mask_path(slide_id: str, max_dim: int, sat_threshold: float) -> Path:
    """掩膜落盘路径：data/masks/{slide_id}__d{max_dim}__s{sat_threshold}.npz。slide_id 做 fs 安全化。"""
    safe_id = re.sub(r"[^A-Za-z0-9_.()-]", "_", slide_id)
    return MASK_DIR / f"{safe_id}__d{max_dim}__s{sat_threshold:g}.npz"


def _file_fingerprint(abs_path: str) -> tuple[float, int] | None:
    """slide 文件指纹（mtime + size）。文件缺失返回 None（无盘掩膜可用）。"""
    try:
        st = Path(abs_path).stat()
    except OSError:
        return None
    return st.st_mtime, st.st_size


def _nuclear_mask(r: np.ndarray, g: np.ndarray, b: np.ndarray, sat: np.ndarray) -> np.ndarray:
    """核密度代理布尔：深紫/暗蓝核（hematoxylin）。核=低亮度 + 中饱和 + 偏蓝（b≥r−bias），
    排除粉红嗜酸间质（r高b低）、边缘空白（高亮度）、暗红出血（r高b低）。参数 env 可调。
    lum 阈值抓"暗"，sat 排除灰白，b≥r 排掉嗜酸粉。"""
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    nuc_lum = float(os.environ.get("PATHASK_NUC_LUM", 0.55))
    nuc_sat = float(os.environ.get("PATHASK_NUC_SAT", 0.10))
    nuc_bias = float(os.environ.get("PATHASK_NUC_BBIAS", 0.02))
    return (lum < nuc_lum) & (sat > nuc_sat) & (b >= r - nuc_bias)


def _overview_scale(slide: openslide.OpenSlide, mask_w: int) -> float:
    """mask 层坐标 → 原生 level-0 坐标的缩放因子（native 宽 / mask 宽）。对任何 mask（多级层/单级概览）
    都成立：多级层 mask 宽=该层级宽 → 得 level_downsamples；单级概览 mask 宽=概览宽 → 得 native/概览。"""
    return (slide.level_dimensions[0][0] / mask_w) if mask_w else 1.0


def _overview(slide: openslide.OpenSlide, max_dim: int) -> tuple[np.ndarray, float]:
    """≤max_dim 概览 (RGB uint8) + 概览→原生缩放因子。
    ⚠️ 单层 slide (level_count=1) 无 ≤max_dim 层级，_pick_level 落 level-0=原生巨图，read_region 会整读
    native 像素。get_thumbnail 对任何 slide
    给 ≤max_dim 概览（经 OpenSlide 最优层级+缩放），mean-fraction 对分辨率稳定，仅采样/校准用。"""
    native_w = slide.level_dimensions[0][0]
    img = np.array(slide.get_thumbnail((max_dim, max_dim)).convert("RGB"))
    return img, _overview_scale(slide, img.shape[1])


def _tissue_mask_array(slide_id: str, slide: openslide.OpenSlide, max_dim: int, sat_threshold: float) -> tuple[np.ndarray, np.ndarray, float]:
    """组织掩膜三级缓存：内存 LRU → 磁盘 npz（指纹校验）→ 计算并落盘。返回 (mask, nuclear, scale)。
    nuclear=核密度布尔（采样重排用），由同一份 RGB/饱和度顺手算出，不额外读图。
    scale=mask 层坐标→原生 level-0 坐标缩放（native 宽 / mask 宽），见 _overview_scale。"""
    key = (slide_id, max_dim, sat_threshold)
    with _mask_cache_lock:
        if key in _mask_cache:
            return _mask_cache[key]  # (mask, nuclear, scale) 已含 scale

    entry = _registry.get(slide_id)
    disk_path = _mask_path(slide_id, max_dim, sat_threshold)
    if entry and disk_path.exists():
        fp = _file_fingerprint(entry["abs_path"])
        try:
            with np.load(disk_path) as z:
                disk_mask = z["mask"]
                disk_nuclear = z["nuclear"] if "nuclear" in z else None  # 旧缓存无 nuclear → 重算
                disk_mtime, disk_size = float(z["mtime"]), int(z["size"])
            if fp is not None and (disk_mtime, disk_size) == fp and disk_nuclear is not None:
                d_scale = _overview_scale(slide, disk_mask.shape[1])
                with _mask_cache_lock:
                    _mask_cache[key] = (disk_mask, disk_nuclear, d_scale)  # 写回内存，后续 O(1)
                print(f"[mask] 磁盘命中 {disk_path.name}（{disk_mask.shape}）")
                return disk_mask, disk_nuclear, d_scale
            print(f"[mask] 指纹不一致/缺nuclear，重算 {disk_path.name}")
        except Exception as e:  # noqa: BLE001
            print(f"[mask] 磁盘缓存失效（{e}），重算")

    # 计算（长计算期间不持锁，沿用 double-check 允许并发重算）
    lvl = _pick_level(slide, max_dim)
    lvl_w, _lvl_h = slide.level_dimensions[lvl]
    if lvl_w <= max_dim:
        # 多级 slide 标准路径：读真·金字塔层级（≤max_dim 宽）。
        with _locks[slide_id]:
            rgb = np.array(slide.read_region((0, 0), lvl, (lvl_w, _lvl_h)).convert("RGB"))
        scale = _overview_scale(slide, lvl_w)
    else:
        # 单层 slide（无 ≤max_dim 层级）：_pick_level 落 level-0=原生巨图 → 改用 get_thumbnail 概览，避免整读 native OOM。
        rgb, scale = _overview(slide, max_dim)
    r = rgb[..., 0].astype(np.float32) / 255
    g = rgb[..., 1].astype(np.float32) / 255
    b = rgb[..., 2].astype(np.float32) / 255
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    mask = sat > sat_threshold
    nuclear = _nuclear_mask(r, g, b, sat)
    with _mask_cache_lock:
        _mask_cache[key] = (mask, nuclear, scale)  # 计算完写回（double-check；长计算期间不持锁）

    # 落盘（原子写：.tmp → replace；失败仅 warn，不影响在线）
    if entry:
        fp = _file_fingerprint(entry["abs_path"])
        if fp is not None:
            try:
                MASK_DIR.mkdir(parents=True, exist_ok=True)
                tmp_path = disk_path.with_name(disk_path.stem + ".tmp.npz")  # 显式 .npz 结尾，避免 savez 二次追加后缀
                np.savez_compressed(tmp_path, mask=mask, nuclear=nuclear, mtime=fp[0], size=fp[1])
                os.replace(tmp_path, disk_path)
                print(f"[mask] 计算并落盘 {disk_path.name}")
            except Exception as e:  # noqa: BLE001
                print(f"[warn] 掩膜写盘失败（{e}），仅内存缓存")
                try:
                    tmp_path.unlink(missing_ok=True)
                except OSError:
                    pass
    return mask, nuclear, scale


@app.get("/health")
def health():
    return {"status": "ok", "slides": len(_registry)}


@app.get("/slides")
def list_slides():
    return {
        "slides": [
            {"id": k, "cancer": v["cancer"], "case_id": v.get("case_id"), "path": v["abs_path"]}
            for k, v in _registry.items()
        ]
    }


@app.get("/slides/{slide_id}/info")
def slide_info(slide_id: str):
    s = get_slide(slide_id)
    return {
        "width": s.dimensions[0],
        "height": s.dimensions[1],
        "levels": s.level_count,
        "level_dimensions": [list(d) for d in s.level_dimensions],
        "level_downsamples": [float(d) for d in s.level_downsamples],
        "objective_power": getattr(s, "objective_power", None),
        "vendor": s.properties.get(openslide.PROPERTY_NAME_VENDOR),
    }


@app.get("/slides/{slide_id}/thumbnail")
def thumbnail(slide_id: str, max_dim: int = 1024):
    slide_id = _resolve(slide_id)  # 统一为注册表真实键（含目录前缀 id），get_slide 把锁登记在该键下
    s = get_slide(slide_id)
    lvl = _pick_level(s, max_dim)
    lvl_w, _lvl_h = s.level_dimensions[lvl]
    if lvl_w <= max_dim:
        with _locks[slide_id]:
            img = s.read_region((0, 0), lvl, (lvl_w, _lvl_h)).convert("RGB")
    else:
        # 单层 slide 无 ≤max_dim 层级 → get_thumbnail 概览，避免整读 native 巨图
        img = s.get_thumbnail((max_dim, max_dim)).convert("RGB")
    return {"png_base64": _png_b64(img), "level": lvl, "size": list(img.size)}


@app.get("/slides/{slide_id}/tissue-mask")
def tissue_mask(slide_id: str, max_dim: int = 2048, sat_threshold: float = 0.08, min_coverage: float = 0.02):
    slide_id = _resolve(slide_id)
    s = get_slide(slide_id)
    lvl = _pick_level(s, max_dim)
    mask, nuclear, scale = _tissue_mask_array(slide_id, s, max_dim, sat_threshold)
    h, w = mask.shape[:2]  # w,h = mask 层实际宽高（多级=该层级宽；单级=get_thumbnail 概览宽，scale 已给正确换算）
    coverage = float(mask.mean())
    ys, xs = np.where(mask)
    bbox = [int(xs.min()), int(ys.min()), int(xs.max() - xs.min()), int(ys.max() - ys.min())] if xs.size else None
    # 粗网格候选细胞（供 detect_roi 组织掩膜 baseline）。tissue_fraction=任何染色组织占比（偏良性间质）；
    # nuclear_fraction=深紫核占比（核密度，治偏良性）——采样层按后者重排（PATHASK_ROI_SCORE）。
    gw, gh = 16, 16
    cw, ch = max(w // gw, 1), max(h // gh, 1)
    cells = []
    for i in range(gw):
        for j in range(gh):
            cell = mask[j * ch : min((j + 1) * ch, h), i * cw : min((i + 1) * cw, w)]
            ncell = nuclear[j * ch : min((j + 1) * ch, h), i * cw : min((i + 1) * cw, w)]
            frac = float(cell.mean())
            if frac > min_coverage:
                cells.append({"x": i * cw, "y": j * ch, "w": cw, "h": ch, "tissue_fraction": frac, "nuclear_fraction": float(ncell.mean())})
    cells.sort(key=lambda c: -c["tissue_fraction"])
    return {"level": lvl, "size": [w, h], "scale": scale, "coverage": coverage, "bbox": bbox, "cells": cells[:64], "cell_count": len(cells)}


@app.get("/slides/{slide_id}/region")
def read_region(slide_id: str, x: int, y: int, w: int, h: int, level: int = 0):
    slide_id = _resolve(slide_id)
    s = get_slide(slide_id)
    if level < 0 or level >= s.level_count:
        raise HTTPException(400, f"bad level {level}")
    with _locks[slide_id]:
        img = s.read_region((x, y), level, (w, h)).convert("RGB")
    return {"png_base64": _png_b64(img), "level": level, "size": [img.width, img.height]}


class EmbedReq(BaseModel):
    images: list[str] = []  # 本地路径或 data-uri/base64
    texts: list[str] = []


@app.post("/embed")
def embed(req: EmbedReq):
    """PLIP 编码：图片/文本 → 归一化向量（detect_roi 检索用）。首次调用懒加载模型 ~20s。"""
    out: dict = {}
    if req.images:
        try:
            vecs = embed_mod.embed_images(req.images)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(500, f"embed images failed: {e}") from e
        out["image_vectors"] = vecs
    if req.texts:
        try:
            vecs = embed_mod.embed_texts(req.texts)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(500, f"embed texts failed: {e}") from e
        out["text_vectors"] = vecs
    return out


@app.post("/conch-embed")
def conch_embed(req: EmbedReq):
    """CONCH 编码：图片/文本 → 归一化向量（detect_roi 检索首选，病理专用双塔）。首次调用懒加载 ~25s。"""
    out: dict = {}
    if req.images:
        try:
            vecs = conch_mod.embed_images(req.images)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(500, f"conch embed images failed: {e}") from e
        out["image_vectors"] = vecs
    if req.texts:
        try:
            vecs = conch_mod.embed_texts(req.texts)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(500, f"conch embed texts failed: {e}") from e
        out["text_vectors"] = vecs
    return out


@app.post("/conch-embed-raw")
def conch_embed_raw(req: EmbedReq):
    """CONCH 未归一化特征（STREAM MIL 训练特征协议，ln_contrast 池化）。run_mil 特征抽取用。"""
    if not req.images:
        return {"image_vectors": []}
    try:
        vecs = conch_mod.embed_images_raw(req.images)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"conch embed raw failed: {e}") from e
    return {"image_vectors": vecs}


class MilReq(BaseModel):
    slide_id: str
    capability_id: str
    max_patches: int | None = None


@app.post("/mil")
def mil_infer(req: MilReq):
    """run_mil 后端：在线抽 STREAM 规格特征 → RRTMIL 权重 → slide 级预测。

    复用组织掩膜缓存 + CONCH（未归一化 ln_contrast 特征）。首抽分钟级并落盘
    data/features/{slide_id}.npz，缓存命中秒级。capability 来自 data/capability_registry.json。
    """
    import mil_inference  # 延迟 import，避免循环依赖

    slid = _resolve(req.slide_id)  # 归一化：get_slide 内部也会解析，这里保证后续 entry/mask/features 用同一 id
    s = get_slide(slid)
    entry = _registry.get(slid)
    mask, _nuc, _scale = _tissue_mask_array(slid, s, 2048, 0.08)
    try:
        cap = mil_inference.get_capability(req.capability_id)
    except KeyError as e:
        raise HTTPException(400, str(e)) from e

    abs_path = entry["abs_path"] if entry else None
    max_patches = req.max_patches or mil_inference.DEFAULT_MAX_PATCHES
    features, coords, total_cand = mil_inference.get_or_build_features(
        slid, s, mask, abs_path, max_patches
    )
    if features is None:
        raise HTTPException(400, f"{req.slide_id} 无可抽组织 patch（掩膜覆盖率过低）")

    t0 = time.time()
    pred = mil_inference.predict(cap, features, coords)
    pred["elapsed_ms"] = int((time.time() - t0) * 1000)
    pred["total_candidates"] = int(total_cand)
    pred["capability_id"] = req.capability_id
    return pred


def _warmup_models() -> None:
    """启动后台预热 CONCH（detect_roi 检索首选编码器，首次懒加载 ~25s）。

    启动即预热 → 首次 detect_roi 无加载开销。
    run_mil 的 CONCH-224 在 CPU worker 进程内（独立 fork，无法从此预热），由特征缓存覆盖。
    预热失败不阻塞启动（请求侧仍走懒加载）。
    """
    try:
        t0 = time.time()
        conch_mod.get_conch()  # CONCH-448（detect_roi /conch-embed）
        # nohup 下 stdout 全缓冲，print 不显式 flush 会一直留在缓冲区（重启后看不到预热日志）
        print(f"[warmup] CONCH-448 预热完成 ({time.time() - t0:.1f}s)", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[warmup] CONCH-448 预热失败（请求时懒加载兜底）: {e}")


if __name__ == "__main__":
    load_registry()
    threading.Thread(target=_warmup_models, daemon=True).start()
    uvicorn.run(app, host=HOST, port=PORT)
