"""PLIP/病理编码器（懒加载）——给 wsi-bridge 的 /embed 端点用。

模型权重在 PLIP_PATH（环境变量指定）。
CLIP 式 image/text 双塔：图片和文本进同一空间，余弦相似度做检索。
"""
import base64
import io
import os

import numpy as np
from PIL import Image

PLIP_PATH = os.environ.get('PLIP_PATH', '')  # 模型权重路径走环境变量；空时懒加载抛清晰错误
_model = None
_processor = None


def get_plip():
    """懒加载 PLIP（首次 /embed 调用时 ~20s）。"""
    global _model, _processor
    if _model is None:
        import torch
        from transformers import CLIPModel, CLIPProcessor

        if not PLIP_PATH:
            raise RuntimeError('PLIP_PATH 未设置（PLIP 模型目录），无法编码文本/图像')
        _model = CLIPModel.from_pretrained(PLIP_PATH, local_files_only=True)
        _model.eval()
        _processor = CLIPProcessor.from_pretrained(PLIP_PATH, local_files_only=True)
    return _model, _processor


def _load_image(src: str) -> Image.Image:
    """支持本地路径或 data-uri/base64 字符串。"""
    if "," in src and (src.startswith("data:") or src.startswith("iVBOR") or src.startswith("/9j/")):
        raw = src.split(",", 1)[1]
        return Image.open(io.BytesIO(base64.b64decode(raw))).convert("RGB")
    return Image.open(src).convert("RGB")


def _pooled(feats):
    """transformers 5.x 的 get_*_features 返回 BaseModelOutputWithPooling，取 pooler_output；旧版返回张量。"""
    return feats.pooler_output if hasattr(feats, "pooler_output") else feats


def embed_images(sources: list[str]) -> list[list[float]]:
    import torch

    model, processor = get_plip()
    images = [_load_image(s) for s in sources]
    inputs = processor(images=images, return_tensors="pt")
    with torch.no_grad():
        feats = _pooled(model.get_image_features(**inputs))
    feats = feats / feats.norm(dim=-1, keepdim=True)
    return feats.numpy().tolist()


def embed_texts(texts: list[str]) -> list[list[float]]:
    import torch

    model, processor = get_plip()
    inputs = processor(text=texts, return_tensors="pt", padding=True)
    with torch.no_grad():
        feats = _pooled(model.get_text_features(**inputs))
    feats = feats / feats.norm(dim=-1, keepdim=True)
    return feats.numpy().tolist()


def cosine_matrix(image_vectors: np.ndarray, text_vectors: np.ndarray) -> np.ndarray:
    return image_vectors @ text_vectors.T  # (n_img, n_text)，均已归一化
