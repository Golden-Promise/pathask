"""STREAM RRTMIL（baselines_raw）MIL 推理——run_mil 工具的真实后端。

特征协议：STREAM h5 特征 = CONCH `encode_image(normalize=False,
proj_contrast=False)` 的 ln_contrast 池化（行范数≈√512≈22.65、全局 mean≈0/std≈1）。
在线对任意 WSI 用同一 CONCH + 256×256 patch 抽特征喂 RRTMIL 权重，分布才对齐。
训练 patch 从 level0 直接切 256（STREAM h5 的 coords 是 level0 像素坐标）。

能力库注册表在 data/capability_registry.json（单一事实来源，TS 侧同样读取）。
本模块不 import server.py（避免循环依赖）：server 在 /mil handler 里延迟 import 并传入
slide 对象 + 组织掩膜。
"""
import json
import os
import os
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import openslide
import torch

import conch_embed  # 同目录，CONCH 未归一化特征提取

ROOT = Path(__file__).resolve().parent.parent
REGISTRY_PATH = ROOT / "data" / "capability_registry.json"
FEATURE_DIR = ROOT / "data" / "features"
# STREAM 模型根目录（含 models.mil_classifiers）。环境变量注入；未设置时运行时给出清晰错误，避免空路径污染 sys.path。
STREAM = os.environ.get('PATHASK_STREAM_ROOT', '').rstrip('/')

BATCH_SIZE = 16          # CONCH 单次 batch patch 数
TISSUE_FRAC_MIN = 0.3    # patch 组织占比阈值（与 build_similar_case_index 一致）
PATCH_SIZE = 256         # level0 直切 256×256（STREAM 训练规格）
DEFAULT_MAX_PATCHES = 1024  # 等距采样 patch 数
N_WORKERS = 8            # 并行抽特征 worker 数（每 worker 6 线程）
N_THREADS = 6            # 每 worker torch 线程上限（不限则线程风暴互相争抢）

# 常驻进程池：CONCH-224 + slide 句柄按 worker 懒加载，首抽付一次性加载成本，之后复用
_pool = None
_worker_slides = {}  # worker 进程内的 slide 句柄缓存（键=svs 绝对路径）

_models: dict[str, torch.nn.Module] = {}
_registry: dict | None = None


def load_registry() -> dict:
    global _registry
    if _registry is None:
        _registry = json.loads(REGISTRY_PATH.read_text())
    return _registry


def get_capability(cap_id: str) -> dict:
    for c in load_registry()["capabilities"]:
        if c["id"] == cap_id:
            return c
    raise KeyError(f"能力库无 {cap_id}")


def get_model(cap: dict) -> torch.nn.Module:
    """懒加载 RRTMIL 权重（按 capability_id 缓存）。超参=工厂默认。"""
    cap_id = cap["id"]
    if cap_id in _models:
        return _models[cap_id]
    if not STREAM:
        raise RuntimeError('PATHASK_STREAM_ROOT 未设置（STREAM 模型目录），无法加载 RRTMIL 分类器')
    import sys
    sys.path.insert(0, STREAM)
    from models.mil_classifiers import get_mil_classifier  # 依赖 nystrom-attention

    cfg = {
        "data": {"feature_dim": cap["feature_dim"]},
        "task": {"num_classes": cap["num_classes"]},
        "model": {"classifier": {"name": cap["model_arch"]}},
    }
    model = get_mil_classifier(cfg)
    # capability_registry.json 存 STREAM 相对路径；加载时拼 STREAM 根
    model_path = cap["model_path"]
    if not os.path.isabs(model_path):
        model_path = os.path.join(STREAM, model_path)
    if not os.path.exists(model_path):
        raise RuntimeError(f'MIL 权重不存在: {model_path}（PATHASK_STREAM_ROOT 或 capability 路径是否正确）')
    model.load_state_dict(
        torch.load(model_path, map_location="cpu", weights_only=True), strict=True
    )
    model.eval()
    _models[cap_id] = model
    print(f"[mil] 加载 {cap_id} ← {Path(model_path).name}")
    return model


def _mask_grid(mask: np.ndarray, lvl_w: int, lvl_h: int):
    """把 2048×2048 组织掩膜降采样到 256 网格分辨率，返回 tissue_fraction 网格。

    网格单元 (grid_h, grid_w) 对应 level0 上 (256,256) patch；patch 中心覆盖掩膜
    的块做平均。返回 float 数组 [grid_h, grid_w]，值=该 patch 的组织占比。
    """
    grid_w = max((lvl_w - PATCH_SIZE) // PATCH_SIZE + 1, 1)
    grid_h = max((lvl_h - PATCH_SIZE) // PATCH_SIZE + 1, 1)
    mh, mw = mask.shape
    ch, cw = mh // grid_h, mw // grid_w
    if ch < 1 or cw < 1:
        return np.full((grid_h, grid_w), float(mask.mean()))
    grid = mask[: grid_h * ch, : grid_w * cw].reshape(grid_h, ch, grid_w, cw).mean(axis=(1, 3))
    return grid


def _worker_init(threads: int):
    """worker 进程初始化：限 torch 线程 + 懒加载 CONCH-224（每 worker 一份，~25s 一次性）。"""
    global _w_model, _w_pre
    torch.set_num_threads(threads)
    _w_model, _w_pre, _, _ = conch_embed.get_conch224()


def _worker_extract(svs_path: str, coords: list[tuple[int, int]]):
    """worker 内：读 patch → CONCH-224 raw 特征。slide 句柄按路径缓存（worker 进程私有）。"""
    global _w_model, _w_pre
    if svs_path not in _worker_slides:
        _worker_slides[svs_path] = openslide.OpenSlide(svs_path)
    slide = _worker_slides[svs_path]
    xs = [_w_pre(slide.read_region((x, y), 0, (PATCH_SIZE, PATCH_SIZE)).convert("RGB")) for x, y in coords]
    with torch.no_grad():
        vecs = _w_model.encode_image(torch.stack(xs), normalize=False, proj_contrast=False)
    return vecs.numpy().astype(np.float32), np.array(coords, dtype=np.int64)


def _get_pool():
    global _pool
    if _pool is None:
        _pool = ProcessPoolExecutor(N_WORKERS, initializer=_worker_init, initargs=(N_THREADS,))
    return _pool


def extract_features(slide, mask: np.ndarray, max_patches: int = DEFAULT_MAX_PATCHES,
                     abs_path: str | None = None):
    """对 WSI 抽 STREAM 规格特征：level0 直切 256×256 组织 patch → CONCH raw。

    返回 (features (N,512) float32, coords (N,2) int64[左上角 level0 坐标], 组织候选数)。
    候选保持网格空间序，max_patches 用**等距采样**覆盖全片。
    有 abs_path 时走常驻进程池并行（每 worker 限 N_THREADS 线程）；无则主进程串行兜底。
    """
    lvl_w, lvl_h = slide.level_dimensions[0]
    grid = _mask_grid(mask, lvl_w, lvl_h)
    grid_h, grid_w = grid.shape

    # 候选 patch（组织占比 > 阈值），保持 (gy,gx) 空间扫描序
    cands = []
    for gy in range(grid_h):
        for gx in range(grid_w):
            if float(grid[gy, gx]) > TISSUE_FRAC_MIN:
                cands.append((gx * PATCH_SIZE, gy * PATCH_SIZE))
    total_cand = len(cands)
    if max_patches and total_cand > max_patches:
        idx = np.linspace(0, total_cand - 1, max_patches).astype(int)  # 空间序上等距
        cands = [cands[i] for i in idx]

    if not cands:
        return None, None, 0

    if abs_path:
        # 并行：分片给常驻 worker 池（每 worker 自带 slide 句柄 + CONCH-224）
        n = min(N_WORKERS, len(cands))
        chunks = np.array_split(np.arange(len(cands)), n)
        pool = _get_pool()
        results = list(pool.map(_worker_extract, [abs_path] * n, [[cands[i] for i in c] for c in chunks]))
    else:
        # 兜底：无文件路径时 worker 无法打开 slide，主进程串行
        model, pre, _, _ = conch_embed.get_conch224()
        results = []
        for i in range(0, len(cands), BATCH_SIZE):
            batch = cands[i : i + BATCH_SIZE]
            xs = [pre(slide.read_region((x, y), 0, (PATCH_SIZE, PATCH_SIZE)).convert("RGB")) for x, y in batch]
            with torch.no_grad():
                vecs = model.encode_image(torch.stack(xs), normalize=False, proj_contrast=False)
            results.append((vecs.numpy().astype(np.float32), np.array(batch, dtype=np.int64)))

    feats_list = [r[0] for r in results]
    coords_list = [r[1] for r in results]
    features = np.concatenate(feats_list, axis=0).astype(np.float32)
    coords = np.concatenate(coords_list, axis=0)
    return features, coords, total_cand


def _file_fingerprint(abs_path: str) -> tuple[float, int] | None:
    try:
        st = Path(abs_path).stat()
    except OSError:
        return None
    return st.st_mtime, st.st_size


def get_or_build_features(slide_id: str, slide, mask: np.ndarray, abs_path: str | None = None,
                          max_patches: int = DEFAULT_MAX_PATCHES):
    """特征缓存：磁盘 npz(指纹校验) → 在线抽取并落盘。abs_path 来自 server registry（slide 指纹）。"""
    FEATURE_DIR.mkdir(parents=True, exist_ok=True)
    safe = slide_id.replace("/", "_")
    disk_path = FEATURE_DIR / f"{safe}.npz"

    fp = _file_fingerprint(abs_path) if abs_path else None

    if disk_path.exists():
        try:
            with np.load(disk_path) as z:
                disk_feats = z["features"]
                if "mtime" in z and fp is not None and (float(z["mtime"]), int(z["size"])) == fp:
                    print(f"[mil] 特征缓存命中 {disk_path.name}（{disk_feats.shape[0]} patch）")
                    return disk_feats, z["coords"], int(z.get("total_cand", -1))
        except Exception as e:  # noqa: BLE001
            print(f"[mil] 特征缓存失效（{e}），重抽")

    t0 = time.time()
    features, coords, total_cand = extract_features(slide, mask, max_patches, abs_path)
    if features is None:
        return None, None, 0
    print(f"[mil] {slide_id} 抽取 {features.shape[0]}/{total_cand} 组织 patch 特征，耗时 {time.time()-t0:.1f}s")

    if fp is not None:
        try:
            tmp = disk_path.with_name(disk_path.stem + ".tmp.npz")
            np.savez_compressed(tmp, features=features, coords=coords, mtime=fp[0], size=fp[1], total_cand=total_cand)
            os.replace(tmp, disk_path)
        except Exception as e:  # noqa: BLE001
            print(f"[warn] 特征写盘失败（{e}）")
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
    return features, coords, total_cand


@torch.no_grad()
def predict(cap: dict, features: np.ndarray, coords: np.ndarray):
    """喂 RRTMIL → softmax → label/conf + attention 热点（top-3 patch 坐标）。"""
    model = get_model(cap)
    x = torch.from_numpy(features).float().unsqueeze(0)  # (1,N,512)
    logits, attn, _ = model(x, label=None, instance_eval=False)
    probs = torch.softmax(logits, dim=1)[0]
    top = int(probs.argmax().item())
    a = attn[0].numpy()  # (N,)

    # attention 热点：按 attn 排序的 top-3 patch 坐标
    hot_idx = np.argsort(-a)[:3]
    hotspots = [
        {"x": int(coords[i, 0]), "y": int(coords[i, 1]), "attn": float(a[i])}
        for i in hot_idx
        if i < len(coords)
    ]
    return {
        "label": cap["labels"][top],
        "confidence": float(probs[top]),
        "probs": {lbl: float(p) for lbl, p in zip(cap["labels"], probs.tolist())},
        "num_patches": int(features.shape[0]),
        "attention_hotspots": hotspots,
        "model_arch": cap["model_arch"],
    }
