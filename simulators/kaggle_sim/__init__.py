"""Kaggle Kernel, GPU Accelerator, Secrets, and Magic Execution Simulator."""

from .runtime import (
    ACCELERATOR_PROFILES,
    KaggleRuntimeSimulator,
    get_kaggle_runtime,
)
from .magic_parser import (
    KaggleCell,
    cells_to_ipynb,
    cells_to_python_module,
    ipynb_to_cells,
    parse_kaggle_paste,
)
from .executor import KaggleCodeExecutor

__all__ = [
    "ACCELERATOR_PROFILES",
    "KaggleRuntimeSimulator",
    "get_kaggle_runtime",
    "KaggleCell",
    "parse_kaggle_paste",
    "cells_to_ipynb",
    "cells_to_python_module",
    "ipynb_to_cells",
    "KaggleCodeExecutor",
]
