"""CONCH 病理编码器（懒加载）——给 wsi-bridge 的 /conch-embed 端点用。

CONCH（Mahmood Lab，CC-BY-NC-ND，仅学术非商用）双塔 ViT-B-16，512 维 L2 归一化。
组织学专用 CLIP：相比 PLIP，对病理组织/细胞形态语义更贴合（detect_roi 检索首选）。
权重在 CONCH_WEIGHTS（环境变量指定）。
"""
import base64
import io
import os

import numpy as np
from PIL import Image

CONCH_MODEL = "conch_ViT-B-16"
CONCH_WEIGHTS = os.environ.get('CONCH_WEIGHTS', '')  # 模型权重路径走环境变量；空时懒加载抛清晰错误
_model = None
_preprocess = None
_get_tokenizer = None
_tokenize = None
_model224 = None  # CONCH-224（CLAM 生态标准输入规格，STREAM h5 特征来源，run_mil 用）
_preprocess224 = None


def get_conch():
    """懒加载 CONCH（首次调用 ~25s）。tokenize 缓存的也是 conch 的 tokenizer 工厂，须与文本塔同源。"""
    global _model, _preprocess, _get_tokenizer, _tokenize
    if _model is None:
        from conch.open_clip_custom import create_model_from_pretrained, get_tokenizer
        from conch.open_clip_custom.custom_tokenizer import tokenize

        if not CONCH_WEIGHTS:
            raise RuntimeError('CONCH_WEIGHTS 未设置（CONCH 模型权重路径），无法编码图像')
        _model, _preprocess = create_model_from_pretrained(CONCH_MODEL, CONCH_WEIGHTS)
        _model.eval()
        _get_tokenizer = get_tokenizer
        _tokenize = tokenize
    return _model, _preprocess, _get_tokenizer, _tokenize


def _load_image(src: str) -> Image.Image:
    """支持本地路径或 data-uri/base64 字符串。"""
    if "," in src and (src.startswith("data:") or src.startswith("iVBOR") or src.startswith("/9j/")):
        raw = src.split(",", 1)[1]
        return Image.open(io.BytesIO(base64.b64decode(raw))).convert("RGB")
    return Image.open(src).convert("RGB")


def embed_images(sources: list[str]) -> list[list[float]]:
    import torch

    model, pre, _, _ = get_conch()
    images = [_load_image(s) for s in sources]
    xs = torch.stack([pre(img) for img in images])  # (n, 3, 448, 448)——CONCH vision_cfg.image_size=448
    with torch.no_grad():
        feats = model.encode_image(xs)
    feats = feats / feats.norm(dim=-1, keepdim=True)
    return feats.numpy().tolist()


def get_conch224():
    """CONCH-224（CLAM 生态标准输入规格）。"""
    global _model224, _preprocess224
    if _model224 is None:
        from conch.open_clip_custom import create_model_from_pretrained

        _model224, _preprocess224 = create_model_from_pretrained(CONCH_MODEL, CONCH_WEIGHTS, force_image_size=224)
        _model224.eval()
    return _model224, _preprocess224, _get_tokenizer, _tokenize


def embed_images_raw(sources: list[str]) -> list[list[float]]:
    """未归一化 CONCH 特征——STREAM MIL 训练特征协议（CONCH-224）。

    STREAM h5 特征（(N,512) float32，行范数≈√512≈22.65、全局 mean≈0/std≈1）实测来自
    CONCH-224 的 ln_contrast 池化特征：encode_image(normalize=False, proj_contrast=False)
    （attn_pool + LayerNorm，无 proj_contrast 投影、不 L2 归一化），force_image_size=224。
    任何其他组合分布对不上，STREAM 权重会失效。
    喂给 STREAM MIL 前不得再归一化。
    """
    import torch

    model, pre, _, _ = get_conch224()
    images = [_load_image(s) for s in sources]
    xs = torch.stack([pre(img) for img in images])  # (n, 3, 224, 224)
    with torch.no_grad():
        feats = model.encode_image(xs, normalize=False, proj_contrast=False)
    return feats.numpy().tolist()


def embed_texts(texts: list[str]) -> list[list[float]]:
    import torch

    model, _, get_tokenizer, tokenize = get_conch()
    tok = get_tokenizer()
    txt = tokenize(tok, texts)
    with torch.no_grad():
        feats = model.encode_text(txt)
    feats = feats / feats.norm(dim=-1, keepdim=True)
    return feats.numpy().tolist()


def cosine_matrix(image_vectors: np.ndarray, text_vectors: np.ndarray) -> np.ndarray:
    return image_vectors @ text_vectors.T  # (n_img, n_text)，均已归一化
