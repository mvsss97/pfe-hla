from __future__ import annotations

import sys
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from pfe_hla.research.hf_adapter import (  # noqa: E402
    HuggingFaceHardLabelModel,
    OptionalMLDependencyError,
)


class FakeTensor:
    def __init__(self) -> None:
        self.device: str | None = None

    def to(self, device: str) -> FakeTensor:
        self.device = device
        return self


class FakeLogits:
    class Result:
        @staticmethod
        def item() -> int:
            return 1

    def argmax(self, *, dim: int) -> FakeLogits.Result:
        if dim != -1:
            raise AssertionError("classification argmax must use the final dimension")
        return self.Result()


class FakeTokenizer:
    def __init__(self) -> None:
        self.last_call: dict[str, object] = {}

    def __call__(self, text: str, **kwargs: object) -> dict[str, FakeTensor]:
        self.last_call = {"text": text, **kwargs}
        return {"input_ids": FakeTensor(), "attention_mask": FakeTensor()}


class FakeModel:
    def __init__(self) -> None:
        self.config = SimpleNamespace(id2label={"0": "safe", "1": "unsafe"})
        self.device: str | None = None
        self.evaluation = False

    def to(self, device: str) -> FakeModel:
        self.device = device
        return self

    def eval(self) -> FakeModel:
        self.evaluation = True
        return self

    def __call__(self, **encoded: FakeTensor) -> SimpleNamespace:
        if any(tensor.device != self.device for tensor in encoded.values()):
            raise AssertionError("all encoded tensors must be moved to the model device")
        return SimpleNamespace(logits=FakeLogits())


class FakeAutoTokenizer:
    instance = FakeTokenizer()
    call: tuple[str, dict[str, object]] | None = None

    @classmethod
    def from_pretrained(cls, reference: str, **kwargs: object) -> FakeTokenizer:
        cls.call = (reference, kwargs)
        return cls.instance


class FakeAutoModel:
    instance = FakeModel()
    call: tuple[str, dict[str, object]] | None = None

    @classmethod
    def from_pretrained(cls, reference: str, **kwargs: object) -> FakeModel:
        cls.call = (reference, kwargs)
        return cls.instance


def fake_modules() -> dict[str, ModuleType]:
    torch_module = ModuleType("torch")
    torch_module.cuda = SimpleNamespace(is_available=lambda: False)  # type: ignore[attr-defined]
    torch_module.inference_mode = nullcontext  # type: ignore[attr-defined]
    transformers_module = ModuleType("transformers")
    transformers_module.AutoTokenizer = FakeAutoTokenizer  # type: ignore[attr-defined]
    transformers_module.AutoModelForSequenceClassification = FakeAutoModel  # type: ignore[attr-defined]
    return {"torch": torch_module, "transformers": transformers_module}


class HuggingFaceAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        FakeAutoTokenizer.instance = FakeTokenizer()
        FakeAutoTokenizer.call = None
        FakeAutoModel.instance = FakeModel()
        FakeAutoModel.call = None

    def test_lazy_mocked_adapter_returns_only_the_winning_label(self) -> None:
        with patch.dict(sys.modules, fake_modules()):
            adapter = HuggingFaceHardLabelModel.from_pretrained(
                "local-model",
                local_files_only=True,
                max_length=32,
            )
            label = adapter.predict("an unsafe sample")

        self.assertEqual(label, "unsafe")
        self.assertIs(type(label), str)
        self.assertEqual(adapter.device, "cpu")
        self.assertTrue(FakeAutoModel.instance.evaluation)
        self.assertEqual(FakeAutoTokenizer.instance.last_call["max_length"], 32)
        self.assertEqual(FakeAutoTokenizer.call, (
            "local-model",
            {"local_files_only": True, "trust_remote_code": False},
        ))
        self.assertFalse(hasattr(adapter, "predict_logits"))
        self.assertFalse(hasattr(adapter, "predict_proba"))

    def test_explicit_label_map_can_return_integer_labels(self) -> None:
        with patch.dict(sys.modules, fake_modules()):
            adapter = HuggingFaceHardLabelModel.from_pretrained(
                "local-model",
                id_to_label={0: 10, 1: 20},
            )
            self.assertEqual(adapter.predict("sample"), 20)

    def test_explicit_empty_label_map_returns_the_class_index(self) -> None:
        with patch.dict(sys.modules, fake_modules()):
            adapter = HuggingFaceHardLabelModel.from_pretrained(
                "local-model",
                id_to_label={},
            )
            self.assertEqual(adapter.predict("sample"), 1)

    def test_missing_optional_dependencies_has_actionable_error(self) -> None:
        with patch(
            "pfe_hla.research.hf_adapter.import_module",
            side_effect=ModuleNotFoundError("not installed"),
        ):
            with self.assertRaisesRegex(OptionalMLDependencyError, "optional 'ml'"):
                HuggingFaceHardLabelModel.from_pretrained("missing")

    def test_max_length_is_validated_before_optional_import(self) -> None:
        with self.assertRaises(ValueError):
            HuggingFaceHardLabelModel.from_pretrained("model", max_length=0)


if __name__ == "__main__":
    unittest.main()
