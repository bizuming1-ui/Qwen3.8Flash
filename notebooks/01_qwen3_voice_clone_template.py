# 01_qwen3_voice_clone_template  (由 Qwen3.8Flash Kaggle 模拟器导出)
# 在 VS Code / Jupyter 中以 # %% 分格运行; 在 Kaggle 里逐格粘贴即可。

# %% [markdown] cell 1
# # 🎙️ Qwen3 语音克隆 · Kaggle Notebook 模板
# 本模板在【浏览器 Kaggle 模拟器】和【真实 Kaggle】两种环境都能运行:
# - 模拟器(无 GPU): 自动走 `src/audio_sim.py` DSP 管线模拟, 跑通 保存→分析→实验 全流程;
# - 真实 Kaggle(GPU + 模型): 把第 6 格 [真实模型区] 的注释打开并换成你的推理代码即可。
# 路径约定: 输入 `/kaggle/input`, 输出 `/kaggle/working`(模拟器自动翻译到项目真实目录)。

# %% cell 2
import os, sys, platform
print("Python:", sys.version.split()[0], "| OS:", platform.system())
print("CWD(Kaggle 默认 = /kaggle/working):", os.getcwd())
try:
    import torch
    print("torch:", torch.__version__, "| CUDA:", torch.cuda.is_available(),
          torch.cuda.get_device_name(0) if torch.cuda.is_available() else "")
except ImportError:
    print("torch 未安装 -> 当前处于【模拟器模式】, 真实 Kaggle 请确认开启 GPU 并预装 torch")

# %% cell 3
# [依赖] 在真实 Kaggle 需要时取消注释执行(模拟器同样真实执行 pip, 只是装到本地环境)
# !pip install -q transformers accelerate soundfile librosa
# 路径兼容: kpath() 由模拟器内核预先注入; 在真实 Kaggle 上路径本来就是 /kaggle/..., 直写即可
K = kpath if 'kpath' in dir() else (lambda p: p)
INPUT, WORKING = str(K("/kaggle/input")), str(K("/kaggle/working"))
print("INPUT  ->", INPUT)
print("WORKING->", WORKING)
!ls -la /kaggle/input /kaggle/working

# %% cell 4
# [参数] 与浏览器「语音克隆实验室」面板一致, 方便互相对照复现实验
CONFIG = dict(
    model_id="Qwen/Qwen3-TTS(在此换成你的语音克隆模型/权重路径)",
    ref_audio="/kaggle/input/sample-ref.wav",   # 3~10 秒目标说话人录音
    ref_text="大家好,这是我的参考录音,用来克隆我的声音。",
    text="你好,我是 Qwen 三点八 Flash 语音克隆系统,这段声音由我的声音克隆生成。",
    language="zh", temperature=0.8, top_p=0.9, similarity=0.85, speed=1.0,
)
CONFIG

# %% cell 5
# [参考音频检查] 真实 DSP 分析: 时长/音量/音高(帮助挑参考录音)
import sys
sys.path.insert(0, "..")
try:
    from src import audio_sim
    samples, sr = audio_sim.read_wav(K(CONFIG["ref_audio"]))
    print(audio_sim.analyze(samples, sr))
except Exception as e:
    print("暂读不到参考音频:", e, "\n-> 把一段 wav 上传到左侧「上传数据集到 /kaggle/input」即可")

# %% cell 6
# [克隆推理] ===== 真实模型区(示例伪代码, 按你的模型改) =====
# from transformers import AutoProcessor, AutoModel
# model = AutoModel.from_pretrained(CONFIG["model_id"]).cuda().eval()
# wav = model.voice_clone(text=CONFIG["text"], ref_audio=CONFIG["ref_audio"],
#                         ref_text=CONFIG["ref_text"], language=CONFIG["language"],
#                         temperature=CONFIG["temperature"], top_p=CONFIG["top_p"])
# import soundfile as sf; sf.write("/kaggle/working/cloned_real.wav", wav, 22050)
# ===== 无 GPU 时的模拟管线(当前默认执行, 保证任何地方跑得通) =====
from src import audio_sim
ref_samples = ref_sr = None
try:
    ref_samples, ref_sr = audio_sim.read_wav(K(CONFIG["ref_audio"]))
except Exception:
    pass
out = str(K("/kaggle/working/cloned.wav"))
res = audio_sim.synthesize(CONFIG["text"], out, ref_samples=ref_samples, ref_sr=ref_sr or 22050,
                           language=CONFIG["language"], similarity=CONFIG["similarity"],
                           temperature=CONFIG["temperature"], speed=CONFIG["speed"])
print("已生成:", out)
print(res)

# %% cell 7
# [自检 + 指标] 对模型输出做真实分析; SIM/MOS/WER 真指标在 Kaggle 上用
# ECAPA-TDNN(speaker embedding 余弦相似度) / UTMOS / Whisper(ASR 转写算 WER) 计算
s2, sr2 = audio_sim.read_wav(out)
print("输出音频真实指标:", audio_sim.analyze(s2, sr2))
print("模拟器伪指标(仅跑通记录流程):", audio_sim.simulator_metrics(CONFIG["text"], CONFIG, has_ref=ref_samples is not None))

# %% [markdown] cell 8
# ✅ 收尾(重要: 不要把成果只留在 Kaggle 里!)
# 1. 在浏览器模拟器点顶部 **💾 提交到项目 → ⬆️ 推送 GitHub**, Notebook/音频/实验随 Git 持久保存;
# 2. 若在真实 Kaggle: 点 Output 下载 `cloned.wav`, 或 `!git clone` 本仓库到 Kaggle 后 commit & push(需 Kaggle Secrets 配 GitHub token);
# 3. Kaggle 会话 12 小时后销毁, 只有进了 Git 的东西才真的还在。
