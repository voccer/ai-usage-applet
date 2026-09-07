import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
APPLET = ROOT / "ai-usage@voccer"


def load_json(relative_path: str):
    with (ROOT / relative_path).open(encoding="utf-8") as handle:
        return json.load(handle)


class MetadataTests(unittest.TestCase):
    def test_metadata_identity(self):
        metadata = load_json("ai-usage@voccer/metadata.json")
        self.assertEqual(metadata["uuid"], "ai-usage@voccer")
        self.assertEqual(metadata["name"], "AI Usage")
        self.assertEqual(metadata["version"], "1.0.0")

    def test_required_settings(self):
        settings = load_json("ai-usage@voccer/settings-schema.json")
        self.assertEqual(settings["update-interval"]["default"], 5)
        self.assertEqual(
            settings["claude-credentials-path"]["default"],
            "~/.claude/.credentials.json",
        )
        self.assertIn("codex-executable-path", settings)
        self.assertIn("codex-home-path", settings)

    def test_required_runtime_files_exist(self):
        for relative_path in (
            "applet.js",
            "stylesheet.css",
            "icons/icon-symbolic.svg",
            "codex_usage.py",
            "lib/usage.js",
        ):
            with self.subTest(path=relative_path):
                self.assertTrue((APPLET / relative_path).is_file())


if __name__ == "__main__":
    unittest.main()
