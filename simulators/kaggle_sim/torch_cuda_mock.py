"""
NumPy & Librosa-backed Virtual PyTorch + Torchaudio + CUDA Simulator for Kaggle Voice Cloning.

Allows Kaggle voice cloning scripts (`import torch`, `import torchaudio`, `.to('cuda')`,
`nn.Conv1d`, `nn.TransformerEncoder`, `torchaudio.load`, `MelSpectrogram`, `autocast`, etc.)
to execute dry-runs, shape verification, and real audio I/O seamlessly inside a lightweight
CPU sandbox while simulating Kaggle T4x2 / P100 / H100 GPU environments.
"""

from __future__ import annotations

import contextlib
import math
import os
import pickle
import sys
import types
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple, Union

import librosa
import numpy as np
import soundfile as sf
from scipy import signal

from .runtime import ACCELERATOR_PROFILES, get_kaggle_runtime


class DType:
    def __init__(self, name: str, np_dtype: Any, is_floating: bool = True) -> None:
        self.name = name
        self.np_dtype = np.dtype(np_dtype)
        self.is_floating_point = is_floating

    def __repr__(self) -> str:
        return f"torch.{self.name}"


float32 = DType("float32", np.float32, True)
float16 = DType("float16", np.float16, True)
bfloat16 = DType("bfloat16", np.float32, True)
float64 = DType("float64", np.float64, True)
int64 = DType("int64", np.int64, False)
int32 = DType("int32", np.int32, False)
int16 = DType("int16", np.int16, False)
uint8 = DType("uint8", np.uint8, False)
bool_dtype = DType("bool", np.bool_, False)

_NP_TO_TORCH_DTYPE = {
    np.dtype(np.float32): float32,
    np.dtype(np.float16): float16,
    np.dtype(np.float64): float64,
    np.dtype(np.int64): int64,
    np.dtype(np.int32): int32,
    np.dtype(np.int16): int16,
    np.dtype(np.uint8): uint8,
    np.dtype(np.bool_): bool_dtype,
}


class device:
    def __init__(self, dev: Union[str, "device", int] = "cpu", index: Optional[int] = None) -> None:
        if isinstance(dev, device):
            self.type = dev.type
            self.index = dev.index
        elif isinstance(dev, int):
            self.type = "cuda"
            self.index = dev
        elif ":" in str(dev):
            parts = str(dev).split(":", 1)
            self.type = parts[0]
            self.index = int(parts[1])
        else:
            self.type = str(dev)
            self.index = index if index is not None else (0 if self.type == "cuda" else None)

    def __repr__(self) -> str:
        if self.index is not None and self.type == "cuda":
            return f"device(type='{self.type}', index={self.index})"
        return f"device(type='{self.type}')"

    def __str__(self) -> str:
        return f"{self.type}:{self.index}" if (self.type == "cuda" and self.index is not None) else self.type

    def __eq__(self, other: Any) -> bool:
        if isinstance(other, str):
            other = device(other)
        if not isinstance(other, device):
            return False
        return self.type == other.type


class Size(tuple):
    def numel(self) -> int:
        res = 1
        for s in self:
            res *= int(s)
        return res

    def __repr__(self) -> str:
        return f"torch.Size({list(self)})"


_ALLOCATED_VRAM_BYTES: int = 0


def _resolve_np_dtype(dtype: Any) -> np.dtype:
    if dtype is None:
        return np.dtype(np.float32)
    if isinstance(dtype, DType):
        return dtype.np_dtype
    return np.dtype(dtype)


class Tensor:
    """NumPy-backed Tensor supporting common PyTorch voice cloning operations."""

    def __init__(
        self,
        data: Any,
        dtype: Optional[Any] = None,
        dev: Union[str, device] = "cpu",
        requires_grad: bool = False,
    ) -> None:
        if isinstance(data, Tensor):
            arr = data._data.copy()
            dev = dev or data.device
        elif isinstance(data, np.ndarray):
            arr = data
        elif isinstance(data, (int, float, bool, np.number)):
            arr = np.array(data)
        else:
            arr = np.asarray(data)

        if dtype is not None:
            arr = arr.astype(_resolve_np_dtype(dtype))
        elif arr.dtype == np.float64:
            arr = arr.astype(np.float32)

        self._data: np.ndarray = arr
        self.device: device = device(dev)
        self.requires_grad: bool = requires_grad
        self.grad: Optional[Tensor] = None
        if self.device.type == "cuda":
            global _ALLOCATED_VRAM_BYTES
            _ALLOCATED_VRAM_BYTES = max(0, _ALLOCATED_VRAM_BYTES + self._data.nbytes)

    @property
    def shape(self) -> Size:
        return Size(self._data.shape)

    @property
    def ndim(self) -> int:
        return self._data.ndim

    @property
    def dtype(self) -> DType:
        return _NP_TO_TORCH_DTYPE.get(self._data.dtype, float32)

    @property
    def T(self) -> "Tensor":
        return Tensor(self._data.T, dev=self.device, requires_grad=self.requires_grad)

    def size(self, dim: Optional[int] = None) -> Union[Size, int]:
        if dim is None:
            return self.shape
        return int(self._data.shape[dim])

    def dim(self) -> int:
        return self._data.ndim

    def numel(self) -> int:
        return int(self._data.size)

    def item(self) -> Union[float, int, bool]:
        return self._data.item()

    def tolist(self) -> Any:
        return self._data.tolist()

    def numpy(self) -> np.ndarray:
        return self._data

    def detach(self) -> "Tensor":
        return Tensor(self._data, dev=self.device, requires_grad=False)

    def clone(self) -> "Tensor":
        return Tensor(self._data.copy(), dev=self.device, requires_grad=self.requires_grad)

    def contiguous(self) -> "Tensor":
        return Tensor(np.ascontiguousarray(self._data), dev=self.device, requires_grad=self.requires_grad)

    def to(self, *args: Any, **kwargs: Any) -> "Tensor":
        new_dev = self.device
        new_dtype = None
        for a in args:
            if isinstance(a, (str, device)):
                s = str(a)
                if s in ("float32", "float16", "bfloat16", "int64", "int32"):
                    new_dtype = getattr(sys.modules[__name__], s)
                else:
                    new_dev = device(a)
            elif isinstance(a, DType):
                new_dtype = a
            elif isinstance(a, Tensor):
                new_dev = a.device
                new_dtype = a.dtype
        if "device" in kwargs and kwargs["device"] is not None:
            new_dev = device(kwargs["device"])
        if "dtype" in kwargs and kwargs["dtype"] is not None:
            new_dtype = kwargs["dtype"]
        if new_dev.type == "cuda" and not cuda_is_available():
            raise RuntimeError(
                "CUDA is not available under current CPU-Only Kaggle Accelerator profile. "
                "Switch Accelerator to T4x2 / P100 in Kaggle Simulator settings."
            )
        arr = self._data.astype(_resolve_np_dtype(new_dtype)) if new_dtype is not None else self._data
        return Tensor(arr, dev=new_dev, requires_grad=self.requires_grad)

    def cuda(self, dev_idx: int = 0) -> "Tensor":
        return self.to(device("cuda", dev_idx))

    def cpu(self) -> "Tensor":
        return self.to("cpu")

    def float(self) -> "Tensor":
        return self.to(float32)

    def half(self) -> "Tensor":
        return self.to(float16)

    def long(self) -> "Tensor":
        return self.to(int64)

    def int(self) -> "Tensor":
        return self.to(int32)

    def bool(self) -> "Tensor":
        return self.to(bool_dtype)

    def view(self, *shape: Any) -> "Tensor":
        if len(shape) == 1 and isinstance(shape[0], (tuple, list, Size)):
            shape = tuple(shape[0])
        return Tensor(self._data.reshape(shape), dev=self.device, requires_grad=self.requires_grad)

    def reshape(self, *shape: Any) -> "Tensor":
        return self.view(*shape)

    def unsqueeze(self, dim: int) -> "Tensor":
        return Tensor(np.expand_dims(self._data, axis=dim), dev=self.device, requires_grad=self.requires_grad)

    def squeeze(self, dim: Optional[int] = None) -> "Tensor":
        if dim is not None:
            if self._data.shape[dim] != 1:
                return self
            return Tensor(np.squeeze(self._data, axis=dim), dev=self.device, requires_grad=self.requires_grad)
        return Tensor(np.squeeze(self._data), dev=self.device, requires_grad=self.requires_grad)

    def transpose(self, dim0: int, dim1: int) -> "Tensor":
        axes = list(range(self._data.ndim))
        axes[dim0], axes[dim1] = axes[dim1], axes[dim0]
        return Tensor(np.transpose(self._data, axes), dev=self.device, requires_grad=self.requires_grad)

    def permute(self, *dims: Any) -> "Tensor":
        if len(dims) == 1 and isinstance(dims[0], (tuple, list)):
            dims = tuple(dims[0])
        return Tensor(np.transpose(self._data, dims), dev=self.device, requires_grad=self.requires_grad)

    def flatten(self, start_dim: int = 0, end_dim: int = -1) -> "Tensor":
        ndim = self._data.ndim
        if start_dim < 0:
            start_dim += ndim
        if end_dim < 0:
            end_dim += ndim
        new_shape = list(self._data.shape[:start_dim]) + [-1] + list(self._data.shape[end_dim + 1 :])
        return self.reshape(*new_shape)

    def expand(self, *sizes: Any) -> "Tensor":
        if len(sizes) == 1 and isinstance(sizes[0], (tuple, list, Size)):
            sizes = tuple(sizes[0])
        target = [self._data.shape[i] if s == -1 else s for i, s in enumerate(sizes)]
        return Tensor(np.broadcast_to(self._data, target).copy(), dev=self.device, requires_grad=self.requires_grad)

    def repeat(self, *repeats: Any) -> "Tensor":
        if len(repeats) == 1 and isinstance(repeats[0], (tuple, list)):
            repeats = tuple(repeats[0])
        return Tensor(np.tile(self._data, repeats), dev=self.device, requires_grad=self.requires_grad)

    def clamp(self, min: Optional[float] = None, max: Optional[float] = None) -> "Tensor":
        return Tensor(np.clip(self._data, min, max), dev=self.device, requires_grad=self.requires_grad)

    def abs(self) -> "Tensor":
        return Tensor(np.abs(self._data), dev=self.device, requires_grad=self.requires_grad)

    def pow(self, exponent: float) -> "Tensor":
        return Tensor(np.power(self._data, exponent), dev=self.device, requires_grad=self.requires_grad)

    def sqrt(self) -> "Tensor":
        return Tensor(np.sqrt(self._data), dev=self.device, requires_grad=self.requires_grad)

    def exp(self) -> "Tensor":
        return Tensor(np.exp(self._data), dev=self.device, requires_grad=self.requires_grad)

    def log(self) -> "Tensor":
        return Tensor(np.log(self._data), dev=self.device, requires_grad=self.requires_grad)

    def sin(self) -> "Tensor":
        return Tensor(np.sin(self._data), dev=self.device, requires_grad=self.requires_grad)

    def cos(self) -> "Tensor":
        return Tensor(np.cos(self._data), dev=self.device, requires_grad=self.requires_grad)

    def tanh(self) -> "Tensor":
        return Tensor(np.tanh(self._data), dev=self.device, requires_grad=self.requires_grad)

    def sigmoid(self) -> "Tensor":
        return Tensor(1.0 / (1.0 + np.exp(-self._data)), dev=self.device, requires_grad=self.requires_grad)

    def mean(self, dim: Optional[Any] = None, keepdim: bool = False) -> "Tensor":
        return Tensor(np.mean(self._data, axis=dim, keepdims=keepdim), dev=self.device, requires_grad=self.requires_grad)

    def sum(self, dim: Optional[Any] = None, keepdim: bool = False) -> "Tensor":
        return Tensor(np.sum(self._data, axis=dim, keepdims=keepdim), dev=self.device, requires_grad=self.requires_grad)

    def std(self, dim: Optional[Any] = None, keepdim: bool = False) -> "Tensor":
        return Tensor(np.std(self._data, axis=dim, keepdims=keepdim), dev=self.device, requires_grad=self.requires_grad)

    def norm(self, p: float = 2, dim: Optional[int] = None, keepdim: bool = False) -> "Tensor":
        return Tensor(
            np.linalg.norm(self._data, ord=p, axis=dim, keepdims=keepdim),
            dev=self.device,
            requires_grad=self.requires_grad,
        )

    def max(self, dim: Optional[int] = None, keepdim: bool = False) -> Any:
        if dim is None:
            return Tensor(np.max(self._data), dev=self.device)
        vals = Tensor(np.max(self._data, axis=dim, keepdims=keepdim), dev=self.device)
        idxs = Tensor(np.argmax(self._data, axis=dim), dtype=int64, dev=self.device)
        return vals, idxs

    def min(self, dim: Optional[int] = None, keepdim: bool = False) -> Any:
        if dim is None:
            return Tensor(np.min(self._data), dev=self.device)
        vals = Tensor(np.min(self._data, axis=dim, keepdims=keepdim), dev=self.device)
        idxs = Tensor(np.argmin(self._data, axis=dim), dtype=int64, dev=self.device)
        return vals, idxs

    def argmax(self, dim: Optional[int] = None, keepdim: bool = False) -> "Tensor":
        res = np.argmax(self._data, axis=dim)
        if keepdim and dim is not None:
            res = np.expand_dims(res, axis=dim)
        return Tensor(res, dtype=int64, dev=self.device)

    def masked_fill(self, mask: "Tensor", value: float) -> "Tensor":
        out = self._data.copy()
        m = mask._data.astype(bool)
        out[np.broadcast_to(m, out.shape)] = value
        return Tensor(out, dev=self.device, requires_grad=self.requires_grad)

    def backward(self, gradient: Optional["Tensor"] = None) -> None:
        # Simulated backward pass for dry-run training loops in Kaggle simulator
        self.grad = gradient if gradient is not None else Tensor(np.ones_like(self._data), dev=self.device)
        for p in _REGISTERED_PARAMETERS:
            if p.requires_grad and p.grad is None:
                rng = np.random.default_rng(42)
                p.grad = Tensor(
                    rng.normal(0.0, 0.01, size=p._data.shape).astype(p._data.dtype),
                    dev=p.device,
                )

    # Operators
    @staticmethod
    def _unwrap(other: Any) -> Any:
        return other._data if isinstance(other, Tensor) else other

    def __add__(self, other: Any) -> "Tensor":
        return Tensor(self._data + self._unwrap(other), dev=self.device, requires_grad=self.requires_grad)

    def __radd__(self, other: Any) -> "Tensor":
        return Tensor(self._unwrap(other) + self._data, dev=self.device, requires_grad=self.requires_grad)

    def __sub__(self, other: Any) -> "Tensor":
        return Tensor(self._data - self._unwrap(other), dev=self.device, requires_grad=self.requires_grad)

    def __rsub__(self, other: Any) -> "Tensor":
        return Tensor(self._unwrap(other) - self._data, dev=self.device, requires_grad=self.requires_grad)

    def __mul__(self, other: Any) -> "Tensor":
        return Tensor(self._data * self._unwrap(other), dev=self.device, requires_grad=self.requires_grad)

    def __rmul__(self, other: Any) -> "Tensor":
        return Tensor(self._unwrap(other) * self._data, dev=self.device, requires_grad=self.requires_grad)

    def __truediv__(self, other: Any) -> "Tensor":
        return Tensor(self._data / self._unwrap(other), dev=self.device, requires_grad=self.requires_grad)

    def __rtruediv__(self, other: Any) -> "Tensor":
        return Tensor(self._unwrap(other) / self._data, dev=self.device, requires_grad=self.requires_grad)

    def __floordiv__(self, other: Any) -> "Tensor":
        return Tensor(self._data // self._unwrap(other), dev=self.device, requires_grad=self.requires_grad)

    def __pow__(self, other: Any) -> "Tensor":
        return Tensor(self._data ** self._unwrap(other), dev=self.device, requires_grad=self.requires_grad)

    def __neg__(self) -> "Tensor":
        return Tensor(-self._data, dev=self.device, requires_grad=self.requires_grad)

    def __matmul__(self, other: Any) -> "Tensor":
        return Tensor(np.matmul(self._data, self._unwrap(other)), dev=self.device, requires_grad=self.requires_grad)

    def __gt__(self, other: Any) -> "Tensor":
        return Tensor(self._data > self._unwrap(other), dtype=bool_dtype, dev=self.device)

    def __ge__(self, other: Any) -> "Tensor":
        return Tensor(self._data >= self._unwrap(other), dtype=bool_dtype, dev=self.device)

    def __lt__(self, other: Any) -> "Tensor":
        return Tensor(self._data < self._unwrap(other), dtype=bool_dtype, dev=self.device)

    def __le__(self, other: Any) -> "Tensor":
        return Tensor(self._data <= self._unwrap(other), dtype=bool_dtype, dev=self.device)

    def __eq__(self, other: Any) -> "Tensor":  # type: ignore[override]
        return Tensor(self._data == self._unwrap(other), dtype=bool_dtype, dev=self.device)

    def __getitem__(self, idx: Any) -> "Tensor":
        if isinstance(idx, Tensor):
            idx = idx._data
        elif isinstance(idx, tuple):
            idx = tuple(i._data if isinstance(i, Tensor) else i for i in idx)
        return Tensor(self._data[idx], dev=self.device, requires_grad=self.requires_grad)

    def __setitem__(self, idx: Any, val: Any) -> None:
        if isinstance(idx, Tensor):
            idx = idx._data
        self._data[idx] = self._unwrap(val)

    def __len__(self) -> int:
        return len(self._data)

    def __iter__(self) -> Iterator["Tensor"]:
        for row in self._data:
            yield Tensor(row, dev=self.device, requires_grad=self.requires_grad)

    def __float__(self) -> float:
        return float(self._data.item())

    def __int__(self) -> int:
        return int(self._data.item())

    def __repr__(self) -> str:
        dev_str = f", device='{self.device}'" if self.device.type != "cpu" else ""
        arr_str = np.array2string(self._data, precision=4, threshold=16, edgeitems=2)
        return f"tensor({arr_str}{dev_str})"


_REGISTERED_PARAMETERS: List["Parameter"] = []


class Parameter(Tensor):
    def __init__(self, data: Any, requires_grad: bool = True) -> None:
        super().__init__(data, requires_grad=requires_grad)
        _REGISTERED_PARAMETERS.append(self)


# ---- CUDA Subsystem ----
def _current_spec():
    accel = os.environ.get("KAGGLE_SIM_ACCELERATOR")
    if accel and accel in ACCELERATOR_PROFILES:
        return ACCELERATOR_PROFILES[accel]
    return get_kaggle_runtime().get_accelerator_spec()


def cuda_is_available() -> bool:
    return _current_spec().device_count > 0


def cuda_device_count() -> int:
    return _current_spec().device_count


def cuda_get_device_name(idx: int = 0) -> str:
    spec = _current_spec()
    if spec.device_count == 0:
        raise RuntimeError("No CUDA GPUs are available")
    return spec.gpu_name


def cuda_get_device_capability(idx: int = 0) -> Tuple[int, int]:
    return _current_spec().compute_capability


def cuda_mem_get_info(idx: int = 0) -> Tuple[int, int]:
    spec = _current_spec()
    total = spec.vram_mib_per_gpu * 1024 * 1024
    used = min(_ALLOCATED_VRAM_BYTES + 256 * 1024 * 1024, total)
    return (total - used, total)


# ---- Tensor Constructors & Ops ----
def _parse_shape(size: Tuple[Any, ...]) -> Tuple[int, ...]:
    if len(size) == 1 and isinstance(size[0], (tuple, list, Size)):
        return tuple(int(x) for x in size[0])
    return tuple(int(x) for x in size)


def tensor(data: Any, dtype: Any = None, device: Any = "cpu", requires_grad: bool = False) -> Tensor:
    return Tensor(data, dtype=dtype, dev=device, requires_grad=requires_grad)


def from_numpy(ndarray: np.ndarray) -> Tensor:
    return Tensor(ndarray)


def as_tensor(data: Any, dtype: Any = None, device: Any = "cpu") -> Tensor:
    return Tensor(data, dtype=dtype, dev=device)


def zeros(*size: Any, dtype: Any = float32, device: Any = "cpu", requires_grad: bool = False) -> Tensor:
    return Tensor(np.zeros(_parse_shape(size), dtype=_resolve_np_dtype(dtype)), dev=device, requires_grad=requires_grad)


def ones(*size: Any, dtype: Any = float32, device: Any = "cpu", requires_grad: bool = False) -> Tensor:
    return Tensor(np.ones(_parse_shape(size), dtype=_resolve_np_dtype(dtype)), dev=device, requires_grad=requires_grad)


def full(size: Sequence[int], fill_value: Any, dtype: Any = float32, device: Any = "cpu") -> Tensor:
    return Tensor(np.full(tuple(size), fill_value, dtype=_resolve_np_dtype(dtype)), dev=device)


def zeros_like(inp: Tensor, dtype: Any = None, device: Any = None) -> Tensor:
    return zeros(inp.shape, dtype=dtype or inp.dtype, device=device or inp.device)


def ones_like(inp: Tensor, dtype: Any = None, device: Any = None) -> Tensor:
    return ones(inp.shape, dtype=dtype or inp.dtype, device=device or inp.device)


def randn(*size: Any, dtype: Any = float32, device: Any = "cpu", requires_grad: bool = False) -> Tensor:
    arr = np.random.standard_normal(_parse_shape(size)).astype(_resolve_np_dtype(dtype))
    return Tensor(arr, dev=device, requires_grad=requires_grad)


def rand(*size: Any, dtype: Any = float32, device: Any = "cpu", requires_grad: bool = False) -> Tensor:
    arr = np.random.random(_parse_shape(size)).astype(_resolve_np_dtype(dtype))
    return Tensor(arr, dev=device, requires_grad=requires_grad)


def randint(low: int, high: Optional[int] = None, size: Sequence[int] = (1,), dtype: Any = int64, device: Any = "cpu") -> Tensor:
    if high is None:
        high = low
        low = 0
    arr = np.random.randint(low, high, size=tuple(size)).astype(_resolve_np_dtype(dtype))
    return Tensor(arr, dev=device)


def arange(start: float, end: Optional[float] = None, step: float = 1, dtype: Any = None, device: Any = "cpu") -> Tensor:
    if end is None:
        arr = np.arange(start)
    else:
        arr = np.arange(start, end, step)
    return Tensor(arr, dtype=dtype, dev=device)


def linspace(start: float, end: float, steps: int, dtype: Any = float32, device: Any = "cpu") -> Tensor:
    return Tensor(np.linspace(start, end, steps), dtype=dtype, dev=device)


def cat(tensors: Sequence[Tensor], dim: int = 0) -> Tensor:
    if not tensors:
        raise ValueError("torch.cat expected non-empty list of tensors")
    return Tensor(np.concatenate([t._data for t in tensors], axis=dim), dev=tensors[0].device)


def stack(tensors: Sequence[Tensor], dim: int = 0) -> Tensor:
    return Tensor(np.stack([t._data for t in tensors], axis=dim), dev=tensors[0].device)


def split(tensor_in: Tensor, split_size_or_sections: Union[int, Sequence[int]], dim: int = 0) -> List[Tensor]:
    arr = tensor_in._data
    if isinstance(split_size_or_sections, int):
        indices = list(range(split_size_or_sections, arr.shape[dim], split_size_or_sections))
    else:
        indices = list(np.cumsum(split_size_or_sections)[:-1])
    return [Tensor(chunk, dev=tensor_in.device) for chunk in np.split(arr, indices, axis=dim)]


def chunk(tensor_in: Tensor, chunks: int, dim: int = 0) -> List[Tensor]:
    return [Tensor(c, dev=tensor_in.device) for c in np.array_split(tensor_in._data, chunks, axis=dim)]


def where(condition: Tensor, x: Any, y: Any) -> Tensor:
    xv = x._data if isinstance(x, Tensor) else x
    yv = y._data if isinstance(y, Tensor) else y
    return Tensor(np.where(condition._data.astype(bool), xv, yv), dev=condition.device)


def einsum(equation: str, *operands: Tensor) -> Tensor:
    dev = operands[0].device if operands else "cpu"
    return Tensor(np.einsum(equation, *[op._data for op in operands]), dev=dev)


def bmm(input_t: Tensor, mat2: Tensor) -> Tensor:
    return Tensor(np.matmul(input_t._data, mat2._data), dev=input_t.device)


def matmul(input_t: Tensor, other: Tensor) -> Tensor:
    return Tensor(np.matmul(input_t._data, other._data), dev=input_t.device)


def stft(
    input_t: Tensor,
    n_fft: int,
    hop_length: Optional[int] = None,
    win_length: Optional[int] = None,
    window: Optional[Tensor] = None,
    center: bool = True,
    return_complex: bool = True,
    **kwargs: Any,
) -> Tensor:
    hop = hop_length or (n_fft // 4)
    win = win_length or n_fft
    arr = input_t._data
    single = arr.ndim == 1
    if single:
        arr = arr[None, :]
    specs = []
    for row in arr:
        s = librosa.stft(row.astype(np.float32), n_fft=n_fft, hop_length=hop, win_length=win, center=center)
        if not return_complex:
            s = np.stack([s.real, s.imag], axis=-1)
        specs.append(s)
    out = np.stack(specs, axis=0)
    if single:
        out = out[0]
    return Tensor(out, dev=input_t.device)


def hann_window(window_length: int, periodic: bool = True, dtype: Any = float32, device: Any = "cpu") -> Tensor:
    w = signal.windows.hann(window_length, sym=not periodic).astype(np.float32)
    return Tensor(w, dtype=dtype, dev=device)


@contextlib.contextmanager
def no_grad() -> Iterator[None]:
    yield


@contextlib.contextmanager
def inference_mode(mode: bool = True) -> Iterator[None]:
    yield


def manual_seed(seed: int) -> None:
    np.random.seed(seed % (2**32 - 1))


def save(obj: Any, f: Union[str, Path, Any]) -> None:
    path = Path(get_kaggle_runtime().translate_kaggle_path(str(f))) if isinstance(f, (str, Path)) else None
    if path is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "wb") as fp:
            pickle.dump(obj, fp)
    else:
        pickle.dump(obj, f)


def load(f: Union[str, Path, Any], map_location: Any = None, weights_only: bool = False) -> Any:
    path = Path(get_kaggle_runtime().translate_kaggle_path(str(f))) if isinstance(f, (str, Path)) else None
    if path is not None:
        with open(path, "rb") as fp:
            return pickle.load(fp)
    return pickle.load(f)


# ---- Neural Network Modules (`torch.nn` & `torch.nn.functional`) ----
def F_relu(x: Tensor, inplace: bool = False) -> Tensor:
    return Tensor(np.maximum(0.0, x._data), dev=x.device, requires_grad=x.requires_grad)


def F_leaky_relu(x: Tensor, negative_slope: float = 0.01, inplace: bool = False) -> Tensor:
    return Tensor(np.where(x._data >= 0, x._data, negative_slope * x._data), dev=x.device)


def F_gelu(x: Tensor) -> Tensor:
    arr = x._data
    out = 0.5 * arr * (1.0 + np.tanh(math.sqrt(2.0 / math.pi) * (arr + 0.044715 * np.power(arr, 3))))
    return Tensor(out, dev=x.device, requires_grad=x.requires_grad)


def F_silu(x: Tensor, inplace: bool = False) -> Tensor:
    arr = x._data
    return Tensor(arr / (1.0 + np.exp(-arr)), dev=x.device, requires_grad=x.requires_grad)


def F_softmax(x: Tensor, dim: int = -1) -> Tensor:
    shifted = x._data - np.max(x._data, axis=dim, keepdims=True)
    exps = np.exp(shifted)
    return Tensor(exps / np.sum(exps, axis=dim, keepdims=True), dev=x.device)


def F_log_softmax(x: Tensor, dim: int = -1) -> Tensor:
    return F_softmax(x, dim=dim).log()


def F_pad(x: Tensor, pad: Sequence[int], mode: str = "constant", value: float = 0.0) -> Tensor:
    ndim = x._data.ndim
    np_pad = [(0, 0)] * ndim
    num_pairs = len(pad) // 2
    for i in range(num_pairs):
        left, right = pad[2 * i], pad[2 * i + 1]
        np_pad[ndim - 1 - i] = (left, right)
    np_mode = "constant" if mode == "constant" else ("reflect" if mode == "reflect" else "edge")
    kwargs = {"constant_values": value} if np_mode == "constant" else {}
    return Tensor(np.pad(x._data, np_pad, mode=np_mode, **kwargs), dev=x.device)


def F_cosine_similarity(x1: Tensor, x2: Tensor, dim: int = 1, eps: float = 1e-8) -> Tensor:
    a, b = x1._data, x2._data
    num = np.sum(a * b, axis=dim)
    den = np.maximum(np.linalg.norm(a, axis=dim) * np.linalg.norm(b, axis=dim), eps)
    return Tensor(num / den, dev=x1.device)


def F_l1_loss(inp: Tensor, target: Tensor, reduction: str = "mean") -> Tensor:
    diff = np.abs(inp._data - target._data)
    val = np.mean(diff) if reduction == "mean" else (np.sum(diff) if reduction == "sum" else diff)
    return Tensor(val, dev=inp.device, requires_grad=True)


def F_mse_loss(inp: Tensor, target: Tensor, reduction: str = "mean") -> Tensor:
    diff = np.square(inp._data - target._data)
    val = np.mean(diff) if reduction == "mean" else (np.sum(diff) if reduction == "sum" else diff)
    return Tensor(val, dev=inp.device, requires_grad=True)


def F_cross_entropy(inp: Tensor, target: Tensor, ignore_index: int = -100, reduction: str = "mean") -> Tensor:
    probs = F_log_softmax(inp, dim=-1)._data
    tgt = target._data.astype(np.int64)
    flat_probs = probs.reshape(-1, probs.shape[-1])
    flat_tgt = tgt.reshape(-1)
    valid = flat_tgt != ignore_index
    if not np.any(valid):
        return Tensor(0.0, dev=inp.device, requires_grad=True)
    picked = -flat_probs[np.arange(len(flat_tgt))[valid], np.clip(flat_tgt[valid], 0, flat_probs.shape[-1] - 1)]
    val = float(np.mean(picked)) if reduction == "mean" else float(np.sum(picked))
    return Tensor(val, dev=inp.device, requires_grad=True)


def F_interpolate(
    inp: Tensor,
    size: Optional[Union[int, Tuple[int, ...]]] = None,
    scale_factor: Optional[float] = None,
    mode: str = "nearest",
    align_corners: Optional[bool] = None,
) -> Tensor:
    arr = inp._data
    orig_len = arr.shape[-1]
    target_len = int(size if isinstance(size, int) else (size[-1] if size else round(orig_len * (scale_factor or 1.0))))
    idx = np.linspace(0, orig_len - 1, target_len)
    if mode == "nearest":
        out = np.take(arr, np.round(idx).astype(int), axis=-1)
    else:
        flat = arr.reshape(-1, orig_len)
        x_old = np.arange(orig_len)
        interp = np.stack([np.interp(idx, x_old, row) for row in flat], axis=0)
        out = interp.reshape(*arr.shape[:-1], target_len).astype(arr.dtype)
    return Tensor(out, dev=inp.device)


class Module:
    def __init__(self) -> None:
        self.training: bool = True
        self._modules: Dict[str, "Module"] = {}
        self._parameters: Dict[str, Parameter] = {}
        self._buffers: Dict[str, Tensor] = {}

    def __setattr__(self, name: str, value: Any) -> None:
        if isinstance(value, Parameter):
            if "_parameters" in self.__dict__:
                self._parameters[name] = value
        elif isinstance(value, Module):
            if "_modules" in self.__dict__:
                self._modules[name] = value
        object.__setattr__(self, name, value)

    def register_buffer(self, name: str, tensor_val: Optional[Tensor], persistent: bool = True) -> None:
        if tensor_val is not None:
            self._buffers[name] = tensor_val
        object.__setattr__(self, name, tensor_val)

    def parameters(self, recurse: bool = True) -> Iterator[Parameter]:
        for p in self._parameters.values():
            yield p
        if recurse:
            for m in self._modules.values():
                yield from m.parameters(recurse=True)

    def named_parameters(self, prefix: str = "", recurse: bool = True) -> Iterator[Tuple[str, Parameter]]:
        for k, p in self._parameters.items():
            yield (f"{prefix}.{k}" if prefix else k), p
        if recurse:
            for mk, m in self._modules.items():
                sub = f"{prefix}.{mk}" if prefix else mk
                yield from m.named_parameters(prefix=sub, recurse=True)

    def train(self, mode: bool = True) -> "Module":
        self.training = mode
        for m in self._modules.values():
            m.train(mode)
        return self

    def eval(self) -> "Module":
        return self.train(False)

    def to(self, *args: Any, **kwargs: Any) -> "Module":
        for k, p in self._parameters.items():
            moved = p.to(*args, **kwargs)
            p._data = moved._data
            p.device = moved.device
        for k, b in self._buffers.items():
            self._buffers[k] = b.to(*args, **kwargs)
            object.__setattr__(self, k, self._buffers[k])
        for m in self._modules.values():
            m.to(*args, **kwargs)
        return self

    def cuda(self, dev_idx: int = 0) -> "Module":
        return self.to(device("cuda", dev_idx))

    def cpu(self) -> "Module":
        return self.to("cpu")

    def half(self) -> "Module":
        return self.to(float16)

    def float(self) -> "Module":
        return self.to(float32)

    def state_dict(self) -> Dict[str, Tensor]:
        out: Dict[str, Tensor] = {}
        for name, param in self.named_parameters():
            out[name] = param.detach().clone()
        return out

    def load_state_dict(self, state_dict: Dict[str, Any], strict: bool = True) -> Tuple[List[str], List[str]]:
        own = dict(self.named_parameters())
        missing = [k for k in own if k not in state_dict]
        unexpected = [k for k in state_dict if k not in own]
        for k, v in state_dict.items():
            if k in own:
                arr = v._data if isinstance(v, Tensor) else np.asarray(v)
                if arr.shape == own[k]._data.shape:
                    own[k]._data = arr.copy()
        return missing, unexpected

    def forward(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return self.forward(*args, **kwargs)


class Linear(Module):
    def __init__(self, in_features: int, out_features: int, bias: bool = True) -> None:
        super().__init__()
        scale = 1.0 / max(1.0, math.sqrt(in_features))
        self.in_features = in_features
        self.out_features = out_features
        self.weight = Parameter(np.random.uniform(-scale, scale, (out_features, in_features)).astype(np.float32))
        self.bias = Parameter(np.zeros(out_features, dtype=np.float32)) if bias else None

    def forward(self, x: Tensor) -> Tensor:
        out = np.matmul(x._data, self.weight._data.T)
        if self.bias is not None:
            out = out + self.bias._data
        return Tensor(out, dev=x.device, requires_grad=x.requires_grad or self.weight.requires_grad)


class Embedding(Module):
    def __init__(self, num_embeddings: int, embedding_dim: int, padding_idx: Optional[int] = None) -> None:
        super().__init__()
        w = np.random.normal(0.0, 0.02, (num_embeddings, embedding_dim)).astype(np.float32)
        if padding_idx is not None:
            w[padding_idx] = 0.0
        self.weight = Parameter(w)

    def forward(self, idx: Tensor) -> Tensor:
        clipped = np.clip(idx._data.astype(np.int64), 0, self.weight._data.shape[0] - 1)
        return Tensor(self.weight._data[clipped], dev=self.weight.device)


class Conv1d(Module):
    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        kernel_size: int,
        stride: int = 1,
        padding: Union[int, str] = 0,
        dilation: int = 1,
        groups: int = 1,
        bias: bool = True,
    ) -> None:
        super().__init__()
        self.in_channels = in_channels
        self.out_channels = out_channels
        self.kernel_size = kernel_size
        self.stride = stride
        self.padding = padding
        self.dilation = dilation
        scale = 1.0 / max(1.0, math.sqrt(in_channels * kernel_size))
        self.weight = Parameter(
            np.random.uniform(-scale, scale, (out_channels, max(1, in_channels // groups), kernel_size)).astype(np.float32)
        )
        self.bias = Parameter(np.zeros(out_channels, dtype=np.float32)) if bias else None

    def forward(self, x: Tensor) -> Tensor:
        arr = x._data
        single = arr.ndim == 2
        if single:
            arr = arr[None, :, :]
        bsz, c_in, length = arr.shape
        eff_k = self.dilation * (self.kernel_size - 1) + 1
        if self.padding == "same":
            out_len = math.ceil(length / self.stride)
        else:
            pad_i = int(self.padding)
            out_len = max(1, (length + 2 * pad_i - eff_k) // self.stride + 1)
        # Fast channel projection + temporal resampling matching exact Conv1d output shape
        proj_w = self.weight._data.mean(axis=-1)  # (C_out, C_in/groups)
        if proj_w.shape[1] == c_in:
            feat = np.einsum("bct,oc->bot", arr, proj_w)
        else:
            feat = np.zeros((bsz, self.out_channels, length), dtype=arr.dtype)
        if feat.shape[-1] != out_len:
            idx = np.linspace(0, feat.shape[-1] - 1, out_len).astype(int)
            feat = feat[:, :, idx]
        if self.bias is not None:
            feat = feat + self.bias._data[None, :, None]
        if single:
            feat = feat[0]
        return Tensor(feat, dev=x.device, requires_grad=True)


class ConvTranspose1d(Module):
    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        kernel_size: int,
        stride: int = 1,
        padding: int = 0,
        output_padding: int = 0,
        bias: bool = True,
    ) -> None:
        super().__init__()
        self.in_channels = in_channels
        self.out_channels = out_channels
        self.kernel_size = kernel_size
        self.stride = stride
        self.padding = padding
        self.output_padding = output_padding
        self.weight = Parameter(np.random.normal(0.0, 0.02, (in_channels, out_channels, kernel_size)).astype(np.float32))
        self.bias = Parameter(np.zeros(out_channels, dtype=np.float32)) if bias else None

    def forward(self, x: Tensor) -> Tensor:
        arr = x._data
        single = arr.ndim == 2
        if single:
            arr = arr[None, :, :]
        bsz, _, length = arr.shape
        out_len = max(1, (length - 1) * self.stride - 2 * self.padding + self.kernel_size + self.output_padding)
        proj_w = self.weight._data.mean(axis=-1)  # (C_in, C_out)
        feat = np.einsum("bct,co->bot", arr, proj_w)
        idx = np.linspace(0, max(0, feat.shape[-1] - 1), out_len)
        flat = feat.reshape(-1, feat.shape[-1])
        upsampled = np.stack([np.interp(idx, np.arange(feat.shape[-1]), r) for r in flat], axis=0)
        out = upsampled.reshape(bsz, self.out_channels, out_len).astype(np.float32)
        if self.bias is not None:
            out = out + self.bias._data[None, :, None]
        return Tensor(out[0] if single else out, dev=x.device, requires_grad=True)


class LayerNorm(Module):
    def __init__(self, normalized_shape: Union[int, Sequence[int]], eps: float = 1e-5) -> None:
        super().__init__()
        dim = normalized_shape if isinstance(normalized_shape, int) else normalized_shape[-1]
        self.eps = eps
        self.weight = Parameter(np.ones(dim, dtype=np.float32))
        self.bias = Parameter(np.zeros(dim, dtype=np.float32))

    def forward(self, x: Tensor) -> Tensor:
        mean = np.mean(x._data, axis=-1, keepdims=True)
        var = np.var(x._data, axis=-1, keepdims=True)
        normed = (x._data - mean) / np.sqrt(var + self.eps)
        return Tensor(normed * self.weight._data + self.bias._data, dev=x.device)


class BatchNorm1d(Module):
    def __init__(self, num_features: int, eps: float = 1e-5) -> None:
        super().__init__()
        self.eps = eps
        self.weight = Parameter(np.ones(num_features, dtype=np.float32))
        self.bias = Parameter(np.zeros(num_features, dtype=np.float32))

    def forward(self, x: Tensor) -> Tensor:
        axis = (0, 2) if x._data.ndim == 3 else 0
        mean = np.mean(x._data, axis=axis, keepdims=True)
        var = np.var(x._data, axis=axis, keepdims=True)
        normed = (x._data - mean) / np.sqrt(var + self.eps)
        w = self.weight._data[None, :, None] if x._data.ndim == 3 else self.weight._data[None, :]
        b = self.bias._data[None, :, None] if x._data.ndim == 3 else self.bias._data[None, :]
        return Tensor(normed * w + b, dev=x.device)


class GroupNorm(Module):
    def __init__(self, num_groups: int, num_channels: int, eps: float = 1e-5) -> None:
        super().__init__()
        self.eps = eps
        self.weight = Parameter(np.ones(num_channels, dtype=np.float32))
        self.bias = Parameter(np.zeros(num_channels, dtype=np.float32))

    def forward(self, x: Tensor) -> Tensor:
        mean = np.mean(x._data, axis=-1, keepdims=True)
        var = np.var(x._data, axis=-1, keepdims=True)
        normed = (x._data - mean) / np.sqrt(var + self.eps)
        w = self.weight._data[None, :, None] if x._data.ndim == 3 else self.weight._data
        b = self.bias._data[None, :, None] if x._data.ndim == 3 else self.bias._data
        return Tensor(normed * w + b, dev=x.device)


class Dropout(Module):
    def __init__(self, p: float = 0.5, inplace: bool = False) -> None:
        super().__init__()
        self.p = p

    def forward(self, x: Tensor) -> Tensor:
        return x


class LSTM(Module):
    def __init__(
        self,
        input_size: int,
        hidden_size: int,
        num_layers: int = 1,
        batch_first: bool = False,
        bidirectional: bool = False,
        dropout: float = 0.0,
    ) -> None:
        super().__init__()
        self.hidden_size = hidden_size
        self.num_layers = num_layers
        self.batch_first = batch_first
        self.num_directions = 2 if bidirectional else 1
        self.proj = Linear(input_size, hidden_size * self.num_directions)

    def forward(self, x: Tensor, hx: Optional[Any] = None) -> Tuple[Tensor, Tuple[Tensor, Tensor]]:
        out = self.proj(x).tanh()
        bsz = x.shape[0] if self.batch_first else x.shape[1]
        h = zeros(self.num_layers * self.num_directions, bsz, self.hidden_size, device=x.device)
        c = zeros(self.num_layers * self.num_directions, bsz, self.hidden_size, device=x.device)
        return out, (h, c)


class GRU(LSTM):
    def forward(self, x: Tensor, hx: Optional[Any] = None) -> Tuple[Tensor, Tensor]:  # type: ignore[override]
        out, (h, _) = super().forward(x, hx)
        return out, h


class MultiheadAttention(Module):
    def __init__(self, embed_dim: int, num_heads: int, dropout: float = 0.0, batch_first: bool = False) -> None:
        super().__init__()
        self.embed_dim = embed_dim
        self.num_heads = num_heads
        self.batch_first = batch_first
        self.q_proj = Linear(embed_dim, embed_dim)
        self.k_proj = Linear(embed_dim, embed_dim)
        self.v_proj = Linear(embed_dim, embed_dim)
        self.out_proj = Linear(embed_dim, embed_dim)

    def forward(
        self, query: Tensor, key: Tensor, value: Tensor, attn_mask: Optional[Tensor] = None, **kwargs: Any
    ) -> Tuple[Tensor, Tensor]:
        q, k, v = self.q_proj(query), self.k_proj(key), self.v_proj(value)
        if not self.batch_first:
            q, k, v = q.transpose(0, 1), k.transpose(0, 1), v.transpose(0, 1)
        scores = (q @ k.transpose(-2, -1)) / math.sqrt(max(1, self.embed_dim))
        weights = F_softmax(scores, dim=-1)
        ctx = self.out_proj(weights @ v)
        if not self.batch_first:
            ctx = ctx.transpose(0, 1)
        return ctx, weights


class TransformerEncoderLayer(Module):
    def __init__(
        self,
        d_model: int,
        nhead: int,
        dim_feedforward: int = 2048,
        dropout: float = 0.1,
        batch_first: bool = False,
        **kwargs: Any,
    ) -> None:
        super().__init__()
        self.self_attn = MultiheadAttention(d_model, nhead, dropout=dropout, batch_first=batch_first)
        self.linear1 = Linear(d_model, dim_feedforward)
        self.linear2 = Linear(dim_feedforward, d_model)
        self.norm1 = LayerNorm(d_model)
        self.norm2 = LayerNorm(d_model)

    def forward(self, src: Tensor, src_mask: Optional[Tensor] = None, **kwargs: Any) -> Tensor:
        attn_out, _ = self.self_attn(src, src, src, attn_mask=src_mask)
        x = self.norm1(src + attn_out)
        ff = self.linear2(F_gelu(self.linear1(x)))
        return self.norm2(x + ff)


class TransformerEncoder(Module):
    def __init__(self, encoder_layer: Module, num_layers: int, norm: Optional[Module] = None) -> None:
        super().__init__()
        self.layers = ModuleList([encoder_layer for _ in range(num_layers)])
        self.norm = norm

    def forward(self, src: Tensor, mask: Optional[Tensor] = None, **kwargs: Any) -> Tensor:
        out = src
        for layer in self.layers:
            out = layer(out, src_mask=mask)
        return self.norm(out) if self.norm is not None else out


class Sequential(Module):
    def __init__(self, *layers: Module) -> None:
        super().__init__()
        for idx, layer in enumerate(layers):
            setattr(self, str(idx), layer)

    def forward(self, x: Tensor) -> Tensor:
        for m in self._modules.values():
            x = m(x)
        return x


class ModuleList(Module):
    def __init__(self, modules: Optional[Iterable[Module]] = None) -> None:
        super().__init__()
        self._items: List[Module] = []
        if modules is not None:
            for m in modules:
                self.append(m)

    def append(self, module: Module) -> None:
        idx = len(self._items)
        self._items.append(module)
        setattr(self, str(idx), module)

    def __iter__(self) -> Iterator[Module]:
        return iter(self._items)

    def __len__(self) -> int:
        return len(self._items)

    def __getitem__(self, idx: int) -> Module:
        return self._items[idx]


class _ActivationModule(Module):
    def __init__(self, fn: Callable[[Tensor], Tensor]) -> None:
        super().__init__()
        self._fn = fn

    def forward(self, x: Tensor) -> Tensor:
        return self._fn(x)


class ReLU(_ActivationModule):
    def __init__(self, inplace: bool = False) -> None:
        super().__init__(F_relu)


class LeakyReLU(_ActivationModule):
    def __init__(self, negative_slope: float = 0.01, inplace: bool = False) -> None:
        super().__init__(lambda x: F_leaky_relu(x, negative_slope=negative_slope))


class GELU(_ActivationModule):
    def __init__(self) -> None:
        super().__init__(F_gelu)


class SiLU(_ActivationModule):
    def __init__(self, inplace: bool = False) -> None:
        super().__init__(F_silu)


class Tanh(_ActivationModule):
    def __init__(self) -> None:
        super().__init__(lambda x: x.tanh())


class Sigmoid(_ActivationModule):
    def __init__(self) -> None:
        super().__init__(lambda x: x.sigmoid())


class L1Loss(Module):
    def forward(self, inp: Tensor, target: Tensor) -> Tensor:
        return F_l1_loss(inp, target)


class MSELoss(Module):
    def forward(self, inp: Tensor, target: Tensor) -> Tensor:
        return F_mse_loss(inp, target)


class CrossEntropyLoss(Module):
    def __init__(self, ignore_index: int = -100) -> None:
        super().__init__()
        self.ignore_index = ignore_index

    def forward(self, inp: Tensor, target: Tensor) -> Tensor:
        return F_cross_entropy(inp, target, ignore_index=self.ignore_index)


# ---- Optimizers, DataLoader, AMP ----
class Optimizer:
    def __init__(self, params: Iterable[Parameter], lr: float = 1e-3, **kwargs: Any) -> None:
        self.params = list(params)
        self.param_groups = [{"params": self.params, "lr": lr, **kwargs}]

    def zero_grad(self, set_to_none: bool = True) -> None:
        for p in self.params:
            p.grad = None

    def step(self) -> None:
        lr = float(self.param_groups[0].get("lr", 1e-3))
        for p in self.params:
            if p.grad is not None and p.grad._data.shape == p._data.shape:
                p._data = p._data - lr * p.grad._data

    def state_dict(self) -> Dict[str, Any]:
        return {"param_groups": [{"lr": g["lr"]} for g in self.param_groups]}

    def load_state_dict(self, sd: Dict[str, Any]) -> None:
        pass


class Dataset:
    def __len__(self) -> int:
        raise NotImplementedError

    def __getitem__(self, index: int) -> Any:
        raise NotImplementedError


def _default_collate(batch: List[Any]) -> Any:
    elem = batch[0]
    if isinstance(elem, Tensor):
        return stack(batch, dim=0)
    if isinstance(elem, np.ndarray):
        return Tensor(np.stack(batch, axis=0))
    if isinstance(elem, (int, float)):
        return Tensor(batch)
    if isinstance(elem, str):
        return batch
    if isinstance(elem, dict):
        return {k: _default_collate([d[k] for d in batch]) for k in elem}
    if isinstance(elem, (tuple, list)):
        return type(elem)(_default_collate([ b[i] for b in batch ]) for i in range(len(elem)))
    return batch


class DataLoader:
    def __init__(
        self,
        dataset: Any,
        batch_size: int = 1,
        shuffle: bool = False,
        collate_fn: Optional[Callable[[List[Any]], Any]] = None,
        drop_last: bool = False,
        **kwargs: Any,
    ) -> None:
        self.dataset = dataset
        self.batch_size = max(1, batch_size)
        self.shuffle = shuffle
        self.collate_fn = collate_fn or _default_collate
        self.drop_last = drop_last

    def __len__(self) -> int:
        n = len(self.dataset)
        return n // self.batch_size if self.drop_last else math.ceil(n / self.batch_size)

    def __iter__(self) -> Iterator[Any]:
        indices = list(range(len(self.dataset)))
        if self.shuffle:
            np.random.shuffle(indices)
        for start in range(0, len(indices), self.batch_size):
            chunk_idx = indices[start : start + self.batch_size]
            if self.drop_last and len(chunk_idx) < self.batch_size:
                continue
            items = [self.dataset[i] for i in chunk_idx]
            yield self.collate_fn(items)


@contextlib.contextmanager
def autocast(*args: Any, **kwargs: Any) -> Iterator[None]:
    yield


class GradScaler:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        pass

    def scale(self, loss: Tensor) -> Tensor:
        return loss

    def step(self, optimizer: Optimizer) -> None:
        optimizer.step()

    def update(self) -> None:
        pass

    def unscale_(self, optimizer: Optimizer) -> None:
        pass


# ---- Torchaudio Real DSP Implementation ----
def torchaudio_load(
    filepath: Union[str, Path],
    frame_offset: int = 0,
    num_frames: int = -1,
    normalize: bool = True,
    channels_first: bool = True,
    **kwargs: Any,
) -> Tuple[Tensor, int]:
    resolved = get_kaggle_runtime().translate_kaggle_path(str(filepath))
    frames = num_frames if num_frames > 0 else -1
    data, sr = sf.read(resolved, start=frame_offset, frames=frames, dtype="float32", always_2d=True)
    # sf.read returns (samples, channels)
    arr = data.T if channels_first else data
    return Tensor(arr), int(sr)


def torchaudio_save(
    filepath: Union[str, Path],
    src: Tensor,
    sample_rate: int,
    channels_first: bool = True,
    **kwargs: Any,
) -> None:
    resolved = Path(get_kaggle_runtime().translate_kaggle_path(str(filepath)))
    resolved.parent.mkdir(parents=True, exist_ok=True)
    arr = src.detach().cpu().numpy()
    if arr.ndim == 1:
        arr = arr[:, None]
    elif channels_first:
        arr = arr.T
    sf.write(str(resolved), np.clip(arr, -1.0, 1.0), sample_rate)


class Resample(Module):
    def __init__(self, orig_freq: int = 16000, new_freq: int = 16000, **kwargs: Any) -> None:
        super().__init__()
        self.orig_freq = orig_freq
        self.new_freq = new_freq

    def forward(self, waveform: Tensor) -> Tensor:
        if self.orig_freq == self.new_freq:
            return waveform
        arr = waveform._data.astype(np.float32)
        res = librosa.resample(arr, orig_sr=self.orig_freq, target_sr=self.new_freq, axis=-1)
        return Tensor(res, dev=waveform.device)


class MelSpectrogram(Module):
    def __init__(
        self,
        sample_rate: int = 24000,
        n_fft: int = 1024,
        win_length: Optional[int] = None,
        hop_length: Optional[int] = None,
        f_min: float = 0.0,
        f_max: Optional[float] = None,
        n_mels: int = 80,
        power: float = 2.0,
        center: bool = True,
        **kwargs: Any,
    ) -> None:
        super().__init__()
        self.sample_rate = sample_rate
        self.n_fft = n_fft
        self.win_length = win_length or n_fft
        self.hop_length = hop_length or (n_fft // 4)
        self.f_min = f_min
        self.f_max = f_max
        self.n_mels = n_mels
        self.power = power
        self.center = center

    def forward(self, waveform: Tensor) -> Tensor:
        arr = waveform._data.astype(np.float32)
        orig_shape = arr.shape
        flat = arr.reshape(-1, orig_shape[-1])
        mels = []
        for row in flat:
            m = librosa.feature.melspectrogram(
                y=row,
                sr=self.sample_rate,
                n_fft=self.n_fft,
                hop_length=self.hop_length,
                win_length=self.win_length,
                n_mels=self.n_mels,
                fmin=self.f_min,
                fmax=self.f_max,
                power=self.power,
                center=self.center,
            )
            mels.append(m)
        stacked = np.stack(mels, axis=0)
        out = stacked.reshape(*orig_shape[:-1], self.n_mels, stacked.shape[-1])
        return Tensor(out.astype(np.float32), dev=waveform.device)


class AmplitudeToDB(Module):
    def __init__(self, stype: str = "power", top_db: Optional[float] = 80.0) -> None:
        super().__init__()
        self.stype = stype
        self.top_db = top_db

    def forward(self, x: Tensor) -> Tensor:
        arr = x._data.astype(np.float32)
        db = librosa.power_to_db(arr, top_db=self.top_db) if self.stype == "power" else librosa.amplitude_to_db(arr, top_db=self.top_db)
        return Tensor(db, dev=x.device)


def install_torch_cuda_simulator(force: bool = False) -> bool:
    """
    Installs Virtual `torch` and `torchaudio` into `sys.modules` when PyTorch is absent
    or `force=True`. Returns True if simulator shim was installed.
    """
    if not force:
        try:
            import torch as _real_torch  # noqa: F401
            if not getattr(_real_torch, "__kaggle_simulator_shim__", False):
                return False
        except ImportError:
            pass

    torch_mod = types.ModuleType("torch")
    torch_mod.__kaggle_simulator_shim__ = True  # type: ignore[attr-defined]
    torch_mod.__version__ = "2.5.1+cu124.sim"  # type: ignore[attr-defined]

    # Types & DTypes
    for k, v in {
        "Tensor": Tensor,
        "FloatTensor": Tensor,
        "LongTensor": lambda d: Tensor(d, dtype=int64),
        "Size": Size,
        "device": device,
        "dtype": DType,
        "float32": float32,
        "float": float32,
        "float16": float16,
        "half": float16,
        "bfloat16": bfloat16,
        "float64": float64,
        "double": float64,
        "int64": int64,
        "long": int64,
        "int32": int32,
        "int": int32,
        "int16": int16,
        "uint8": uint8,
        "bool": bool_dtype,
        "tensor": tensor,
        "as_tensor": as_tensor,
        "from_numpy": from_numpy,
        "zeros": zeros,
        "ones": ones,
        "full": full,
        "zeros_like": zeros_like,
        "ones_like": ones_like,
        "randn": randn,
        "rand": rand,
        "randint": randint,
        "arange": arange,
        "linspace": linspace,
        "cat": cat,
        "stack": stack,
        "split": split,
        "chunk": chunk,
        "where": where,
        "einsum": einsum,
        "bmm": bmm,
        "matmul": matmul,
        "stft": stft,
        "hann_window": hann_window,
        "no_grad": no_grad,
        "inference_mode": inference_mode,
        "manual_seed": manual_seed,
        "save": save,
        "load": load,
        "clamp": lambda x, min=None, max=None: x.clamp(min, max),
        "abs": lambda x: x.abs(),
        "sin": lambda x: x.sin(),
        "cos": lambda x: x.cos(),
        "exp": lambda x: x.exp(),
        "log": lambda x: x.log(),
        "sqrt": lambda x: x.sqrt(),
        "tanh": lambda x: x.tanh(),
        "sigmoid": lambda x: x.sigmoid(),
        "mean": lambda x, dim=None, keepdim=False: x.mean(dim=dim, keepdim=keepdim),
        "sum": lambda x, dim=None, keepdim=False: x.sum(dim=dim, keepdim=keepdim),
    }.items():
        setattr(torch_mod, k, v)

    # torch.cuda
    cuda_mod = types.ModuleType("torch.cuda")
    cuda_mod.is_available = cuda_is_available  # type: ignore[attr-defined]
    cuda_mod.device_count = cuda_device_count  # type: ignore[attr-defined]
    cuda_mod.get_device_name = cuda_get_device_name  # type: ignore[attr-defined]
    cuda_mod.get_device_capability = cuda_get_device_capability  # type: ignore[attr-defined]
    cuda_mod.mem_get_info = cuda_mem_get_info  # type: ignore[attr-defined]
    cuda_mod.current_device = lambda: 0  # type: ignore[attr-defined]
    cuda_mod.set_device = lambda idx: None  # type: ignore[attr-defined]
    cuda_mod.manual_seed = manual_seed  # type: ignore[attr-defined]
    cuda_mod.manual_seed_all = manual_seed  # type: ignore[attr-defined]
    cuda_mod.memory_allocated = lambda idx=0: _ALLOCATED_VRAM_BYTES  # type: ignore[attr-defined]
    cuda_mod.max_memory_allocated = lambda idx=0: _ALLOCATED_VRAM_BYTES  # type: ignore[attr-defined]
    cuda_mod.empty_cache = lambda: None  # type: ignore[attr-defined]
    cuda_mod.synchronize = lambda: None  # type: ignore[attr-defined]
    cuda_mod.is_bf16_supported = lambda: _current_spec().compute_capability[0] >= 8  # type: ignore[attr-defined]

    amp_mod = types.ModuleType("torch.cuda.amp")
    amp_mod.autocast = autocast  # type: ignore[attr-defined]
    amp_mod.GradScaler = GradScaler  # type: ignore[attr-defined]
    cuda_mod.amp = amp_mod  # type: ignore[attr-defined]

    top_amp_mod = types.ModuleType("torch.amp")
    top_amp_mod.autocast = autocast  # type: ignore[attr-defined]
    top_amp_mod.GradScaler = GradScaler  # type: ignore[attr-defined]

    # torch.nn & torch.nn.functional
    nn_mod = types.ModuleType("torch.nn")
    f_mod = types.ModuleType("torch.nn.functional")
    for k, v in {
        "relu": F_relu,
        "leaky_relu": F_leaky_relu,
        "gelu": F_gelu,
        "silu": F_silu,
        "softmax": F_softmax,
        "log_softmax": F_log_softmax,
        "pad": F_pad,
        "cosine_similarity": F_cosine_similarity,
        "l1_loss": F_l1_loss,
        "mse_loss": F_mse_loss,
        "cross_entropy": F_cross_entropy,
        "interpolate": F_interpolate,
    }.items():
        setattr(f_mod, k, v)

    init_mod = types.ModuleType("torch.nn.init")
    init_mod.xavier_uniform_ = lambda t, gain=1.0: t  # type: ignore[attr-defined]
    init_mod.kaiming_normal_ = lambda t, **kw: t  # type: ignore[attr-defined]
    init_mod.normal_ = lambda t, mean=0.0, std=0.02: t  # type: ignore[attr-defined]
    init_mod.constant_ = lambda t, val=0.0: t  # type: ignore[attr-defined]
    init_mod.zeros_ = lambda t: t  # type: ignore[attr-defined]
    init_mod.ones_ = lambda t: t  # type: ignore[attr-defined]

    nn_utils_mod = types.ModuleType("torch.nn.utils")
    nn_utils_mod.clip_grad_norm_ = lambda params, max_norm, **kw: Tensor(0.25)  # type: ignore[attr-defined]
    nn_utils_mod.weight_norm = lambda m, **kw: m  # type: ignore[attr-defined]
    nn_utils_mod.remove_weight_norm = lambda m, **kw: m  # type: ignore[attr-defined]

    for k, v in {
        "Module": Module,
        "Parameter": Parameter,
        "Linear": Linear,
        "Embedding": Embedding,
        "Conv1d": Conv1d,
        "Conv2d": Conv1d,
        "ConvTranspose1d": ConvTranspose1d,
        "LayerNorm": LayerNorm,
        "BatchNorm1d": BatchNorm1d,
        "GroupNorm": GroupNorm,
        "Dropout": Dropout,
        "LSTM": LSTM,
        "GRU": GRU,
        "MultiheadAttention": MultiheadAttention,
        "TransformerEncoderLayer": TransformerEncoderLayer,
        "TransformerEncoder": TransformerEncoder,
        "Sequential": Sequential,
        "ModuleList": ModuleList,
        "ReLU": ReLU,
        "LeakyReLU": LeakyReLU,
        "GELU": GELU,
        "SiLU": SiLU,
        "Tanh": Tanh,
        "Sigmoid": Sigmoid,
        "L1Loss": L1Loss,
        "MSELoss": MSELoss,
        "CrossEntropyLoss": CrossEntropyLoss,
        "Identity": lambda *a, **kw: _ActivationModule(lambda x: x),
        "DataParallel": lambda m, **kw: m,
        "functional": f_mod,
        "init": init_mod,
        "utils": nn_utils_mod,
    }.items():
        setattr(nn_mod, k, v)

    # torch.optim
    optim_mod = types.ModuleType("torch.optim")
    optim_mod.Optimizer = Optimizer  # type: ignore[attr-defined]
    optim_mod.Adam = Optimizer  # type: ignore[attr-defined]
    optim_mod.AdamW = Optimizer  # type: ignore[attr-defined]
    optim_mod.SGD = Optimizer  # type: ignore[attr-defined]

    sched_mod = types.ModuleType("torch.optim.lr_scheduler")
    sched_mod.CosineAnnealingLR = lambda opt, **kw: types.SimpleNamespace(step=lambda: None, get_last_lr=lambda: [1e-4])  # type: ignore[attr-defined]
    sched_mod.ExponentialLR = sched_mod.CosineAnnealingLR  # type: ignore[attr-defined]
    sched_mod.StepLR = sched_mod.CosineAnnealingLR  # type: ignore[attr-defined]
    optim_mod.lr_scheduler = sched_mod  # type: ignore[attr-defined]

    # torch.utils.data
    utils_mod = types.ModuleType("torch.utils")
    data_mod = types.ModuleType("torch.utils.data")
    data_mod.Dataset = Dataset  # type: ignore[attr-defined]
    data_mod.DataLoader = DataLoader  # type: ignore[attr-defined]
    utils_mod.data = data_mod  # type: ignore[attr-defined]

    # torchaudio
    ta_mod = types.ModuleType("torchaudio")
    ta_mod.__version__ = "2.5.1+sim"  # type: ignore[attr-defined]
    ta_mod.load = torchaudio_load  # type: ignore[attr-defined]
    ta_mod.save = torchaudio_save  # type: ignore[attr-defined]

    ta_transforms = types.ModuleType("torchaudio.transforms")
    ta_transforms.Resample = Resample  # type: ignore[attr-defined]
    ta_transforms.MelSpectrogram = MelSpectrogram  # type: ignore[attr-defined]
    ta_transforms.AmplitudeToDB = AmplitudeToDB  # type: ignore[attr-defined]
    ta_transforms.Spectrogram = MelSpectrogram  # type: ignore[attr-defined]
    ta_mod.transforms = ta_transforms  # type: ignore[attr-defined]

    ta_func = types.ModuleType("torchaudio.functional")
    ta_func.resample = lambda w, orig_freq, new_freq, **kw: Resample(orig_freq, new_freq)(w)  # type: ignore[attr-defined]
    ta_mod.functional = ta_func  # type: ignore[attr-defined]

    torch_mod.cuda = cuda_mod  # type: ignore[attr-defined]
    torch_mod.amp = top_amp_mod  # type: ignore[attr-defined]
    torch_mod.nn = nn_mod  # type: ignore[attr-defined]
    torch_mod.optim = optim_mod  # type: ignore[attr-defined]
    torch_mod.utils = utils_mod  # type: ignore[attr-defined]

    modules_to_register = {
        "torch": torch_mod,
        "torch.cuda": cuda_mod,
        "torch.cuda.amp": amp_mod,
        "torch.amp": top_amp_mod,
        "torch.nn": nn_mod,
        "torch.nn.functional": f_mod,
        "torch.nn.init": init_mod,
        "torch.nn.utils": nn_utils_mod,
        "torch.optim": optim_mod,
        "torch.optim.lr_scheduler": sched_mod,
        "torch.utils": utils_mod,
        "torch.utils.data": data_mod,
        "torchaudio": ta_mod,
        "torchaudio.transforms": ta_transforms,
        "torchaudio.functional": ta_func,
    }
    sys.modules.update(modules_to_register)
    return True
