"""Optional Hugging Face adapter implementing the strict hard-label protocol.

The underlying sequence classifier necessarily computes logits internally to
choose its winning class.  Those logits never leave :meth:`predict`: the only
public prediction value is one scalar label.  In particular, this adapter does
not expose probability, score, top-k, gradient, or logits methods.

``torch`` and ``transformers`` are imported only by :meth:`from_pretrained`.
Importing :mod:`pfe_hla.research` therefore keeps the core dependency-free.
"""

from __future__ import annotations

from collections.abc import Mapping
from importlib import import_module
from pathlib import Path
from typing import Any

from .oracle import HardLabelProtocolError, Label


class OptionalMLDependencyError(ImportError):
    """Raised when the optional Hugging Face runtime is not installed."""


class HuggingFaceAdapterError(RuntimeError):
    """Raised when a loaded classifier violates the expected HF interface."""


class HuggingFaceHardLabelModel:
    """Wrap ``AutoModelForSequenceClassification`` as ``text -> label`` only.

    Instances should be built with :meth:`from_pretrained`.  Model and tokenizer
    objects are deliberately private implementation details.  The adapter puts
    the model in evaluation mode and performs inference under
    ``torch.inference_mode()``.
    """

    def __init__(
        self,
        *,
        tokenizer: Any,
        model: Any,
        torch_module: Any,
        device: str,
        max_length: int,
        id_to_label: Mapping[int, Label],
        model_name_or_path: str,
        requested_revision: str | None,
        resolved_revision: str | None,
    ) -> None:
        self._tokenizer = tokenizer
        self._model = model
        self._torch = torch_module
        self._device = device
        self._max_length = max_length
        self._id_to_label = dict(id_to_label)
        self._model_name_or_path = model_name_or_path
        self._requested_revision = requested_revision
        self._resolved_revision = resolved_revision

    @staticmethod
    def _optional_dependencies() -> tuple[Any, Any, Any]:
        try:
            torch_module = import_module("torch")
            transformers_module = import_module("transformers")
            auto_tokenizer = transformers_module.AutoTokenizer
            auto_model = transformers_module.AutoModelForSequenceClassification
        except (AttributeError, ImportError, ModuleNotFoundError) as exc:
            raise OptionalMLDependencyError(
                "HuggingFaceHardLabelModel requires the optional 'ml' dependencies "
                "(torch and transformers)"
            ) from exc
        return torch_module, auto_tokenizer, auto_model

    @staticmethod
    def _normalize_label_map(raw_mapping: Mapping[Any, Any] | None) -> dict[int, Label]:
        if not raw_mapping:
            return {}
        normalized: dict[int, Label] = {}
        for raw_index, label in raw_mapping.items():
            try:
                index = int(raw_index)
            except (TypeError, ValueError) as exc:
                raise HuggingFaceAdapterError(
                    f"invalid class index in id2label: {raw_index!r}"
                ) from exc
            if type(label) not in (str, int):
                raise HardLabelProtocolError(
                    "id2label values must be scalar str or int labels; "
                    f"received {type(label).__name__}"
                )
            normalized[index] = label
        return normalized

    @staticmethod
    def _resolve_cached_revision(
        model_reference: str, requested_revision: str | None, config: Any
    ) -> str | None:
        configured = getattr(config, "_commit_hash", None)
        if configured:
            return str(configured)
        if Path(model_reference).exists():
            return requested_revision
        try:
            hub = import_module("huggingface_hub")
            cached = hub.try_to_load_from_cache(
                model_reference,
                "config.json",
                revision=requested_revision or "main",
            )
        except (AttributeError, ImportError, OSError, ValueError):
            return requested_revision
        if isinstance(cached, str):
            path = Path(cached)
            parts = path.parts
            if "snapshots" in parts:
                snapshot_index = parts.index("snapshots")
                if snapshot_index + 1 < len(parts):
                    return parts[snapshot_index + 1]
        return requested_revision

    @classmethod
    def from_pretrained(
        cls,
        model_name_or_path: str | Path,
        *,
        tokenizer_name_or_path: str | Path | None = None,
        device: str | None = None,
        max_length: int = 512,
        id_to_label: Mapping[int | str, Label] | None = None,
        local_files_only: bool = False,
        trust_remote_code: bool = False,
        revision: str | None = None,
        tokenizer_kwargs: Mapping[str, Any] | None = None,
        model_kwargs: Mapping[str, Any] | None = None,
    ) -> HuggingFaceHardLabelModel:
        """Load a local or Hub sequence classifier behind a label-only API.

        Set ``local_files_only=True`` for offline/reproducible execution.  No
        download occurs merely by importing this module.  ``trust_remote_code``
        defaults to ``False`` and should only be enabled for reviewed sources.
        """

        if isinstance(max_length, bool) or not isinstance(max_length, int):
            raise TypeError("max_length must be an integer")
        if max_length <= 0:
            raise ValueError("max_length must be positive")
        model_reference = str(model_name_or_path)
        if not model_reference:
            raise ValueError("model_name_or_path cannot be empty")
        tokenizer_reference = str(tokenizer_name_or_path or model_name_or_path)

        torch_module, auto_tokenizer, auto_model = cls._optional_dependencies()
        tokenizer_options = dict(tokenizer_kwargs or {})
        model_options = dict(model_kwargs or {})
        tokenizer_options.setdefault("local_files_only", local_files_only)
        tokenizer_options.setdefault("trust_remote_code", trust_remote_code)
        model_options.setdefault("local_files_only", local_files_only)
        model_options.setdefault("trust_remote_code", trust_remote_code)
        if revision is not None:
            tokenizer_options.setdefault("revision", revision)
            model_options.setdefault("revision", revision)

        tokenizer = auto_tokenizer.from_pretrained(
            tokenizer_reference,
            **tokenizer_options,
        )
        model = auto_model.from_pretrained(model_reference, **model_options)
        selected_device = device
        if selected_device is None:
            cuda = getattr(torch_module, "cuda", None)
            selected_device = (
                "cuda" if cuda is not None and bool(cuda.is_available()) else "cpu"
            )
        model.to(selected_device)
        model.eval()

        configured_mapping = getattr(getattr(model, "config", None), "id2label", None)
        selected_mapping = id_to_label if id_to_label is not None else configured_mapping
        label_map = cls._normalize_label_map(selected_mapping)
        resolved_revision = cls._resolve_cached_revision(
            model_reference, revision, getattr(model, "config", None)
        )
        return cls(
            tokenizer=tokenizer,
            model=model,
            torch_module=torch_module,
            device=str(selected_device),
            max_length=max_length,
            id_to_label=label_map,
            model_name_or_path=model_reference,
            requested_revision=revision,
            resolved_revision=resolved_revision,
        )

    @property
    def device(self) -> str:
        """Inference device, without exposing model outputs."""

        return self._device

    @property
    def model_name_or_path(self) -> str:
        """Model identifier used for experiment provenance."""

        return self._model_name_or_path

    @property
    def provenance(self) -> dict[str, str | int | None]:
        """Return reproducibility metadata without exposing model scores or internals."""

        tokenizer_name = getattr(self._tokenizer, "name_or_path", None)
        return {
            "model_name_or_path": self._model_name_or_path,
            "requested_revision": self._requested_revision,
            "model_revision": self._resolved_revision,
            "model_class": type(self._model).__name__,
            "tokenizer_name_or_path": str(tokenizer_name) if tokenizer_name else None,
            "tokenizer_class": type(self._tokenizer).__name__,
            "max_length": self._max_length,
            "device": self._device,
            "torch_version": str(getattr(self._torch, "__version__", "unknown")),
        }

    def predict(self, text: str) -> Label:
        """Return exactly one class label; logits remain local to this call."""

        if not isinstance(text, str):
            raise TypeError("text must be a string")
        encoded = self._tokenizer(
            text,
            return_tensors="pt",
            truncation=True,
            max_length=self._max_length,
        )
        if callable(getattr(encoded, "to", None)):
            encoded = encoded.to(self._device)
        elif isinstance(encoded, Mapping):
            encoded = {
                key: value.to(self._device)
                if callable(getattr(value, "to", None))
                else value
                for key, value in encoded.items()
            }
        else:
            raise HuggingFaceAdapterError("tokenizer output must be a mapping")

        with self._torch.inference_mode():
            outputs = self._model(**encoded)
            # This local variable is intentionally never returned or stored.
            logits = getattr(outputs, "logits", None)
            if logits is None:
                raise HuggingFaceAdapterError(
                    "sequence-classification model output does not contain logits"
                )
            class_index = int(logits.argmax(dim=-1).item())

        label = self._id_to_label.get(class_index, class_index)
        if type(label) not in (str, int):
            raise HardLabelProtocolError(
                "hard-label adapter must return one str or int class label"
            )
        return label
