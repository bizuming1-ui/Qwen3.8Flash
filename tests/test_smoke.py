"""零依赖冒烟测试: python3 -m unittest discover -s tests -v"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src import audio_sim, kaggle_compat as kc, kernel, store  # noqa: E402


class TestKernel(unittest.TestCase):
    def test_namespace_persists(self):
        r1 = kernel.run_cell("x = 41", "t1")
        r2 = kernel.run_cell("print(x + 1)", "t1")
        self.assertTrue(r1["ok"] and r2["ok"])
        self.assertIn("42", "".join(o["text"] for o in r2["outputs"]))

    def test_shell_and_kpath(self):
        r = kernel.run_cell("print(kpath('/kaggle/working'))\n!echo hello_from_shell", "t2")
        text = "".join(o["text"] for o in r["outputs"])
        self.assertIn("hello_from_shell", text)
        self.assertIn("working", text)


class TestStore(unittest.TestCase):
    def test_notebook_roundtrip_and_import(self):
        nb = store.import_any("# %% c1\nimport os\n# %% c2\nprint(1)", "unit_nb")
        self.assertGreaterEqual(len(nb["cells"]), 2)
        info = store.save_notebook(nb)
        self.assertTrue(Path(info["ipynb"]).exists() and Path(info["py"]).exists())
        back = store.load_notebook("unit_nb")
        self.assertIsNotNone(back)
        json.loads(Path(info["ipynb"]).read_text(encoding="utf-8"))  # 合法 ipynb JSON
        self.assertTrue(store.delete_notebook("unit_nb"))

    def test_kpath_translation(self):
        self.assertEqual(kc.kpath("/kaggle/working/a.wav"), kc.KAGGLE_WORKING / "a.wav")
        self.assertTrue(kc.to_virtual(kc.KAGGLE_INPUT / "b.wav").startswith("/kaggle/input"))


class TestAudio(unittest.TestCase):
    def test_synth_wav_spectrogram(self):
        with tempfile.TemporaryDirectory() as d:
            ref = Path(d) / "ref.wav"; out = Path(d) / "out.wav"
            audio_sim.synthesize("参考音", ref)
            rs, rsr = audio_sim.read_wav(ref)
            res = audio_sim.synthesize("你好世界", out, ref_samples=rs, ref_sr=rsr)
            samples, sr = audio_sim.read_wav(out)
            st = audio_sim.analyze(samples, sr)
            self.assertGreater(st["duration_sec"], 0.5)
            self.assertGreater(res["base_f0_hz"], 0)
            png = audio_sim.spectrogram_png(samples, sr)
            self.assertTrue(png.startswith(b"\x89PNG"))


if __name__ == "__main__":
    unittest.main()
