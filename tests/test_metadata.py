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
        # The panel deliberately shows no icon, so this is the only reference
        # left; without it icons/icon-symbolic.svg would be dead weight.
        self.assertEqual(metadata["icon"], "icon-symbolic")

    def test_required_settings(self):
        settings = load_json("ai-usage@voccer/settings-schema.json")
        self.assertEqual(settings["update-interval"]["default"], 5)
        self.assertEqual(
            settings["claude-credentials-path"]["default"],
            "~/.claude/.credentials.json",
        )
        self.assertIn("codex-executable-path", settings)
        self.assertIn("codex-home-path", settings)

    def test_providers_can_be_toggled_independently(self):
        settings = load_json("ai-usage@voccer/settings-schema.json")
        for key in ("enable-claude", "enable-codex"):
            with self.subTest(key=key):
                self.assertEqual(settings[key]["type"], "checkbox")
                self.assertIs(settings[key]["default"], True)

    def test_desktop_entries_are_configurable(self):
        settings = load_json("ai-usage@voccer/settings-schema.json")
        self.assertEqual(
            settings["claude-desktop-entry"]["default"],
            "com.anthropic.Claude.desktop",
        )
        self.assertEqual(
            settings["codex-desktop-entry"]["default"],
            "codex-desktop.desktop",
        )

    def test_no_default_hardcodes_one_machine(self):
        settings = load_json("ai-usage@voccer/settings-schema.json")
        for key, definition in settings.items():
            default = definition.get("default")
            if not isinstance(default, str):
                continue
            with self.subTest(key=key):
                # "/home/<someone>/..." only ever works on the machine it was
                # written on; "~/..." is expanded by the applet at read time.
                self.assertFalse(
                    default.startswith("/home/"),
                    f"{key} default is tied to one user's home directory",
                )

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
