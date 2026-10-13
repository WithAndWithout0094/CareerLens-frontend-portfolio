"""Guest engine discovery with real backend imports and no provider/DB calls."""

from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import sys
import unittest
from unittest.mock import Mock, patch

from backend_location import resolve_backend_root
import guest_analysis_engine as engine


class BackendLocationTests(unittest.TestCase):
    def test_monorepo_backend_takes_precedence_over_a_legacy_sibling(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            for backend in (root, root / "CareerLens-backend"):
                (backend / "app").mkdir(parents=True)
                (backend / "app" / "__init__.py").touch()
            self.assertEqual(resolve_backend_root(root / "frontend"), root.resolve())

    def test_split_repository_layout_remains_supported(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            backend = root / "CareerLens-backend"
            (backend / "app").mkdir(parents=True)
            (backend / "app" / "__init__.py").touch()
            self.assertEqual(
                resolve_backend_root(root / "CareerLens-frontend"), backend.resolve()
            )


class MonorepoEngineTests(unittest.TestCase):
    def setUp(self):
        engine._load_backend.cache_clear()
        self.addCleanup(engine._load_backend.cache_clear)

    def test_actual_engine_and_settings_use_the_monorepo_backend(self):
        backend = engine._load_backend()
        from app.core.config import ROOT, Settings
        from app.agent.graphs.matching import EvaluationEngine
        from app.application.parsing import parse_document

        expected_root = Path(__file__).resolve().parents[2]
        self.assertEqual(engine._BACKEND_ROOT, expected_root)
        self.assertEqual(ROOT, expected_root)
        self.assertEqual(Settings.model_config["env_file"], expected_root / ".env")
        self.assertIs(backend.engine, EvaluationEngine)
        self.assertIs(backend.parse_document, parse_document)
        self.assertEqual(len(backend.criteria), 12)

    def test_missing_backend_fails_closed_without_importing_another_app(self):
        with TemporaryDirectory() as directory, \
                patch.object(engine, "_BACKEND_ROOT", Path(directory)), \
                patch.object(engine.importlib, "import_module") as import_module:
            self.assertFalse(engine.engine_available())
            import_module.assert_not_called()

    def test_an_already_imported_unrelated_app_is_rejected(self):
        unrelated = SimpleNamespace(__file__=str(Path(__file__).resolve()))
        with patch.dict(sys.modules, {"app": unrelated}), \
                patch.object(engine.importlib, "import_module") as import_module:
            self.assertFalse(engine.engine_available())
            import_module.assert_not_called()

    def test_capability_check_uses_synthetic_settings_without_creating_an_llm(self):
        backend = engine._load_backend()
        from app.core.config import Settings

        synthetic = Settings(
            _env_file=None, openai_api_key="synthetic-not-a-key", embedding_dimensions=1536
        )
        guarded = SimpleNamespace(**vars(backend))
        guarded.settings = Mock(return_value=synthetic)
        guarded.llm = Mock(side_effect=AssertionError("Provider construction is forbidden"))
        guarded.parse_document = Mock(side_effect=AssertionError("Parsing is forbidden"))
        guarded.engine = Mock(side_effect=AssertionError("Analysis is forbidden"))
        with patch.object(engine, "_load_backend", return_value=guarded):
            self.assertTrue(engine.engine_available())
        guarded.settings.assert_called_once_with()
        guarded.llm.assert_not_called()
        guarded.parse_document.assert_not_called()
        guarded.engine.assert_not_called()

    def test_missing_key_or_unsupported_dimensions_disable_capability(self):
        from app.core.config import Settings

        for key, dimensions in (("", 1536), ("synthetic-not-a-key", 3072)):
            with self.subTest(dimensions=dimensions, key_present=bool(key)):
                settings = Settings(
                    _env_file=None, openai_api_key=key, embedding_dimensions=dimensions
                )
                backend = SimpleNamespace(settings=lambda: settings)
                with patch.object(engine, "_load_backend", return_value=backend):
                    self.assertFalse(engine.engine_available())


if __name__ == "__main__":
    unittest.main()
