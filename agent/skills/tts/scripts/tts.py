#!/usr/bin/env python3
"""
Qwen3-TTS local speech synthesis for pi.

Wraps mlx-audio + Qwen3-TTS (0.6B/1.7B base) on Apple Silicon.
All processing is local/offline via Metal (GPU).

Usage:
  tts.py "text to speak"                        # default model, plays audio, saves to ~/tts_output/tts_<ts>.wav
  tts.py "text" --no-play                        # generate without playing
  tts.py "text" --out /path/to/file.wav          # explicit output
  tts.py "text" --ref-audio ref.wav --ref-text "transcript of ref"   # zero-shot voice clone
  tts.py --lang it "testo in italiano"           # language hint
  tts.py --model 1.7b "text"                     # 1.7B model (larger download ~4.4 GB)
  echo "piped text" | tts.py --no-play           # read text from stdin

Warm daemon (avoid the ~3.5s model load on every call):
  tts.py --daemon "text"                         # cold run, then keep the model warm in a detached daemon
  tts.py "text"                                  # later calls with the same --model/--voice hit the warm daemon (~1s)
  tts.py --shutdown                              # stop any warm daemon(s) now (they also self-exit after idle)
  tts.py --idle-timeout N                        # idle seconds before the warm daemon exits (default 120)
"""
import argparse
import glob
import json
import logging
import os
import signal
import socket
import subprocess
import sys
import time

os.environ.setdefault("MLX_GPU_MEMORY_MODE", "unified")  # no-op on unified memory macs
# Silence third-party noise on stderr (HF cache re-verification + transformers advisories)
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")  # no "Fetching N files" progress bars
os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")  # no model-type mismatch advisories
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")  # hard floor: no [transformers] warnings
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

logging.getLogger("transformers").setLevel(logging.ERROR)
logging.getLogger("mlx_audio").setLevel(logging.ERROR)
logging.getLogger("huggingface_hub").setLevel(logging.ERROR)

import mlx.core as mx
from mlx_audio.audio_io import write as audio_write
from mlx_audio.tts.utils import load_model

# Keep mlx pinned to 0.31.2: mlx >= 0.32 JIT-compiles NAX steel_gemm kernels that
# fail on M5 + macOS 26 ("unsupported deferred-static-alloca-size"). See SKILL.md.

MODELS = {
    "0.6b": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
    "1.7b": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
}
DEFAULT_MODEL = "0.6b"
DEFAULT_OUT_DIR = os.path.expanduser("~/tts_output")
VALID_LANGS = {"auto", "en", "zh", "es", "it", "pt", "de", "fr", "ja", "ko", "ru"}
SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS_DIR = os.path.join(SKILL_DIR, "assets")
VOICES_FILE = os.path.join(ASSETS_DIR, "voices.json")
DEFAULT_TEMPERATURE = 0.8

DAEMON_DIR = os.path.expanduser("~/.tts")
DAEMON_IDLE_SECONDS = 120


def load_voices() -> dict:
    """Load named voice presets from assets/voices.json."""
    try:
        with open(VOICES_FILE) as f:
            return json.load(f).get("voices", {})
    except Exception as e:
        print(f"[tts] warning: could not load voices.json ({e})")
        return {}


def resolve_preset(voice_name, voices):
    """Return (preset | None, is_preset). 'none' or unknown names are not presets."""
    if not voice_name or voice_name == "none":
        return None, False
    preset = voices.get(voice_name)
    return preset, preset is not None


def resolve_model(model_arg: str) -> str:
    if "/" in model_arg:  # full repo id
        return model_arg
    key = model_arg.lower()
    if key not in MODELS:
        sys.exit(f"Unknown model '{model_arg}'. Use one of: {', '.join(MODELS)} or a full HF repo id.")
    return MODELS[key]


def synthesize(model, out_path, text, temperature, max_tokens, lang, repetition_penalty=None,
               ref_audio=None, ref_text=None, voice=None, instruct=None):
    """Run generation, write the wav, return (duration_s, sample_rate, peak_gb)."""
    gen_args = dict(
        text=text,
        temperature=temperature,
        max_tokens=max_tokens,
        lang_code=lang,
        verbose=False,
    )
    if repetition_penalty is not None:
        gen_args["repetition_penalty"] = repetition_penalty
    if ref_audio:
        gen_args["ref_audio"] = os.path.expanduser(ref_audio)
        gen_args["ref_text"] = ref_text
    if voice:
        gen_args["voice"] = voice
    if instruct:
        gen_args["instruct"] = instruct

    results = list(model.generate(**gen_args))
    if not results:
        raise RuntimeError("generation returned no audio")

    audio = mx.concatenate([r.audio for r in results], axis=0)
    sr = results[0].sample_rate
    dur = sum(r.samples for r in results) / sr
    audio_write(out_path, audio, sr)
    peak = max(r.peak_memory_usage for r in results)
    return dur, sr, peak


def play_audio(path: str) -> None:
    os.system(f"afplay '{path}' &")


# ---------------------------------------------------------------------------
# Warm daemon: a detached child (--serve) keeps the model loaded in RAM and
# serves later calls over a Unix socket. It exits by itself after
# DAEMON_IDLE_SECONDS of inactivity, so nothing persists in the background.
# One daemon per (model, voice) combination; files live in ~/.tts/.
# ---------------------------------------------------------------------------

def daemon_slug(repo: str, voice: str) -> str:
    model_part = repo.rsplit("/", 1)[-1].lower()
    return f"tts-{model_part}-{voice or 'none'}"


def daemon_sock_path(repo: str, voice: str) -> str:
    return os.path.join(DAEMON_DIR, daemon_slug(repo, voice) + ".sock")


def daemon_pid_path(repo: str, voice: str) -> str:
    return os.path.join(DAEMON_DIR, daemon_slug(repo, voice) + ".pid")


def daemon_log_path(repo: str, voice: str) -> str:
    return os.path.join(DAEMON_DIR, daemon_slug(repo, voice) + ".log")


def daemon_alive(sock_path: str, timeout: float = 0.4) -> bool:
    if not os.path.exists(sock_path):
        return False
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect(sock_path)
        s.close()
        return True
    except OSError:
        return False


def daemon_request(sock_path: str, req: dict, read_timeout: float = 600.0) -> dict:
    """Send one JSON request to a daemon and return its response dict."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(read_timeout)
    try:
        s.connect(sock_path)
        s.sendall((json.dumps(req) + "\n").encode("utf-8"))
        buf = b""
        while not buf.endswith(b"\n"):
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
            if len(buf) > (1 << 20):
                raise RuntimeError("daemon response too large")
        if not buf:
            raise RuntimeError("daemon closed the connection")
        resp = json.loads(buf.decode("utf-8").strip())
        if not resp.get("ok"):
            raise RuntimeError(resp.get("error", "daemon error"))
        return resp
    finally:
        s.close()


def cleanup_files(*paths) -> None:
    for p in paths:
        try:
            os.unlink(p)
        except OSError:
            pass


def spawn_warm_daemon(repo: str, voice: str, idle_seconds: float) -> None:
    os.makedirs(DAEMON_DIR, exist_ok=True)
    log_path = daemon_log_path(repo, voice)
    cmd = [sys.executable, os.path.abspath(__file__), "--serve", "--model", repo]
    if voice:
        cmd += ["--voice", voice]
    cmd += ["--idle-timeout", str(int(idle_seconds))]
    with open(log_path, "a") as logf:
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=logf, stderr=logf,
                                start_new_session=True, close_fds=True)
    print(f"[tts] warm daemon spawned (pid {proc.pid}, idle timeout {int(idle_seconds)}s) -> {log_path}")


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def shutdown_daemons() -> None:
    """Stop all warm daemons (graceful via socket, SIGTERM/SIGKILL fallback) and remove their files."""
    if not os.path.isdir(DAEMON_DIR):
        print("[tts] no warm daemon running (~/.tts does not exist)")
        return
    sock_files = sorted(glob.glob(os.path.join(DAEMON_DIR, "tts-*.sock")))
    pid_files = sorted(glob.glob(os.path.join(DAEMON_DIR, "tts-*.pid")))
    if not sock_files and not pid_files:
        print("[tts] no warm daemon running")
        return

    stopped, stale = [], []
    for sock in sock_files:
        label = os.path.basename(sock)[: -len(".sock")]
        pid_path = os.path.join(DAEMON_DIR, label + ".pid")
        try:
            daemon_request(sock, {"shutdown": True}, read_timeout=5.0)
            stopped.append(label)
        except Exception:
            pid = None
            try:
                with open(pid_path) as f:
                    pid = int(f.read().strip())
            except Exception:
                pid = None
            if pid and pid_alive(pid):
                os.kill(pid, signal.SIGTERM)
                deadline = time.time() + 3.0
                while time.time() < deadline and pid_alive(pid):
                    time.sleep(0.15)
                if pid_alive(pid):
                    os.kill(pid, signal.SIGKILL)
                stopped.append(f"{label} (pid {pid}, force)")
            else:
                stale.append(label)
        cleanup_files(sock, pid_path)
    for pid_file in pid_files:
        cleanup_files(pid_file)

    msg = f"[tts] shutdown: {len(stopped)} warm daemon(s) stopped"
    if stale:
        msg += f", {len(stale)} stale socket(s) removed"
    if not stopped and not stale:
        msg += " (none were alive)"
    print(msg)


def serve(repo: str, voice: str, idle_seconds: float) -> None:
    """Daemon mode: keep the model loaded, serve synthesis requests over a Unix socket."""
    os.makedirs(DAEMON_DIR, exist_ok=True)
    sock_path = daemon_sock_path(repo, voice)
    pid_path = daemon_pid_path(repo, voice)
    log_path = daemon_log_path(repo, voice)

    # Remove a stale socket left by a crashed daemon (no process behind it).
    if os.path.exists(sock_path) and not daemon_alive(sock_path, timeout=0.2):
        cleanup_files(sock_path)

    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        srv.bind(sock_path)
    except OSError:
        with open(log_path, "a") as f:
            f.write(f"[{time.strftime('%H:%M:%S')}] another daemon already owns {sock_path}, exiting\n")
        sys.exit(1)
    srv.listen(4)
    srv.settimeout(idle_seconds)  # accept() raises TimeoutError after idle -> self-exit

    logf = open(log_path, "a")

    def dlog(msg: str) -> None:
        print(f"[daemon {time.strftime('%H:%M:%S')}] {msg}", file=logf, flush=True)

    def _term(signum, frame):
        cleanup_files(sock_path, pid_path)
        dlog("terminated by signal")
        os._exit(0)

    signal.signal(signal.SIGTERM, _term)
    signal.signal(signal.SIGINT, _term)

    with open(pid_path, "w") as f:
        f.write(str(os.getpid()))
    dlog(f"loading model {repo} ...")
    t0 = time.time()
    model = load_model(repo)
    dlog(f"model loaded ({time.time()-t0:.1f}s), listening on {sock_path} (idle timeout {int(idle_seconds)}s)")

    try:
        while True:
            try:
                conn, _addr = srv.accept()
            except TimeoutError:
                dlog("idle timeout reached, exiting")
                break
            except OSError:
                break
            try:
                conn.settimeout(10.0)
                buf = b""
                while not buf.endswith(b"\n"):
                    chunk = conn.recv(65536)
                    if not chunk:
                        break
                    buf += chunk
                    if len(buf) > (1 << 20):
                        raise RuntimeError("request too large")
                if not buf:
                    continue
                req = json.loads(buf.decode("utf-8").strip())
                if req.get("shutdown"):
                    conn.sendall(b'{"ok": true, "bye": true}\n')
                    dlog("shutdown requested by client")
                    conn.close()
                    break
                out = req.get("out")
                if not out:
                    raise RuntimeError("request missing 'out'")
                if not req.get("text"):
                    raise RuntimeError("request missing 'text'")
                t0 = time.time()
                dur, sr, peak = synthesize(
                    model,
                    out,
                    req["text"],
                    temperature=req.get("temperature", DEFAULT_TEMPERATURE),
                    max_tokens=req.get("max_tokens", 4096),
                    lang=req.get("lang", "auto"),
                    repetition_penalty=req.get("repetition_penalty"),
                    ref_audio=req.get("ref_audio"),
                    ref_text=req.get("ref_text"),
                    voice=req.get("voice_name"),
                    instruct=req.get("instruct"),
                )
                gen_s = time.time() - t0
                dlog(f"{dur:.1f}s speech -> {out} (gen {gen_s:.1f}s, RTF {gen_s/dur:.2f}x, peak {peak:.1f} GB)")
                conn.sendall((json.dumps({"ok": True, "out": out, "dur": dur, "sr": sr}) + "\n").encode("utf-8"))
            except Exception as e:
                dlog(f"error: {e}")
                try:
                    conn.sendall((json.dumps({"ok": False, "error": str(e)}) + "\n").encode("utf-8"))
                except OSError:
                    pass
            finally:
                conn.close()
    finally:
        cleanup_files(sock_path, pid_path)
        dlog("daemon exiting")


def main() -> None:
    ap = argparse.ArgumentParser(description="Local Qwen3-TTS speech synthesis (Apple Silicon)")
    ap.add_argument("text", nargs="?", help="Text to speak. If omitted, read from stdin.")
    ap.add_argument("--model", default=DEFAULT_MODEL, help="0.6b (default), 1.7b, or a full HF repo id")
    ap.add_argument("--out", help="Output wav path (default: ~/tts_output/tts_<timestamp>.wav)")
    ap.add_argument("--no-play", action="store_true", help="Disable automatic playback (default: plays the audio)")
    ap.add_argument("--ref-audio", help="Reference audio file for zero-shot voice cloning (~3s, clean, 24k mono). Overrides the preset's reference.")
    ap.add_argument("--ref-text", help="Transcript of the reference audio (optional but improves cloning)")
    ap.add_argument("--lang", default=None, choices=sorted(VALID_LANGS), help="Language hint (default: preset's lang or auto)")
    ap.add_argument("--voice", help="Named voice preset (see assets/voices.json, e.g. 'tars'), CustomVoice speaker name, or 'none' for the model's neutral default voice")
    ap.add_argument("--instruct", help="Emotion/style instruction (CustomVoice) or voice description (VoiceDesign)")
    ap.add_argument("--max-tokens", type=int, default=4096)
    ap.add_argument("--temperature", type=float, default=None, help=f"Sampling temperature (default {DEFAULT_TEMPERATURE} or preset's; lower = more deterministic, <0.5 risks repetition loops)")
    ap.add_argument("--repetition-penalty", type=float, help="Repetition penalty (default: 1.05, ICL mode auto-raises to >=1.5). Raise it (e.g. 1.5) with very low temperatures.")
    ap.add_argument("--daemon", action="store_true", help="After the (cold) run, spawn a detached warm daemon that serves later calls with the same --model/--voice from RAM (~1s each). It self-exits after --idle-timeout of inactivity.")
    ap.add_argument("--shutdown", action="store_true", help="Stop any warm daemon(s) and exit. Does not load the model.")
    ap.add_argument("--idle-timeout", type=int, default=DAEMON_IDLE_SECONDS, help=f"Warm daemon idle timeout in seconds (default {DAEMON_IDLE_SECONDS}). Only meaningful with --daemon/--serve.")
    ap.add_argument("--serve", action="store_true", help=argparse.SUPPRESS)  # internal daemon mode
    args = ap.parse_args()

    if args.shutdown:
        shutdown_daemons()
        return

    if args.serve:
        serve(resolve_model(args.model), args.voice, args.idle_timeout)
        return

    text = args.text if args.text is not None else sys.stdin.read().strip()
    if not text:
        sys.exit("No text provided — pass it as an argument or via stdin.")

    # Resolve voice: explicit --voice wins, otherwise neutral model voice (no preset by default)
    voices = load_voices()
    preset, is_preset = resolve_preset(args.voice, voices)
    voice_label = args.voice if args.voice else "default"

    # Effective parameters: explicit CLI flags > preset > script defaults
    temperature = args.temperature if args.temperature is not None else (
        preset.get("temperature", DEFAULT_TEMPERATURE) if preset else DEFAULT_TEMPERATURE
    )
    repetition_penalty = args.repetition_penalty if args.repetition_penalty is not None else (
        preset.get("repetition_penalty") if preset else None
    )
    lang = args.lang if args.lang is not None else (preset.get("lang", "auto") if preset else "auto")

    ref_audio = args.ref_audio
    if ref_audio and not os.path.isfile(os.path.expanduser(ref_audio)):
        sys.exit(f"Reference audio not found: {ref_audio}")
    if not ref_audio and preset:
        ref_audio = os.path.join(ASSETS_DIR, preset["ref_audio"])
        if not os.path.isfile(ref_audio):
            sys.exit(f"Preset '{args.voice}' reference missing: {ref_audio}")

    repo = resolve_model(args.model)

    if args.out:
        out_path = os.path.expanduser(args.out)
    else:
        os.makedirs(DEFAULT_OUT_DIR, exist_ok=True)
        out_path = os.path.join(DEFAULT_OUT_DIR, f"tts_{time.strftime('%Y%m%d_%H%M%S')}.wav")

    # FAST PATH: a warm daemon for this model+voice is already alive -> no load, no cold start.
    sock_path = daemon_sock_path(repo, args.voice)
    if daemon_alive(sock_path):
        try:
            req = dict(
                text=text,
                out=out_path,
                lang=lang,
                temperature=temperature,
                repetition_penalty=repetition_penalty,
                ref_audio=ref_audio,
                ref_text=args.ref_text,
                instruct=args.instruct,
                max_tokens=args.max_tokens,
            )
            if args.voice and not is_preset:  # CustomVoice speaker name passthrough
                req["voice_name"] = args.voice
            resp = daemon_request(sock_path, req)
            preset_note = f" (preset '{args.voice}')" if is_preset else ""
            print(f"[tts] daemon: voice={voice_label}{preset_note}, {resp['dur']:.1f}s speech @{resp['sr']} Hz -> {out_path} (warm, no model load)")
            if not args.no_play:
                play_audio(out_path)
            return
        except Exception as e:
            print(f"[tts] warning: warm daemon failed ({e}), falling back to a cold run")

    # COLD PATH
    t0 = time.time()
    model = load_model(repo)
    print(f"[tts] model loaded ({time.time()-t0:.1f}s)")

    t0 = time.time()
    dur, sr, peak = synthesize(
        model,
        out_path,
        text,
        temperature=temperature,
        max_tokens=args.max_tokens,
        lang=lang,
        repetition_penalty=repetition_penalty,
        ref_audio=ref_audio,
        ref_text=args.ref_text,
        voice=(args.voice if (args.voice and not is_preset) else None),
        instruct=args.instruct,
    )
    gen_s = time.time() - t0

    preset_note = f" (preset '{args.voice}')" if is_preset else ""
    print(f"[tts] voice={voice_label}{preset_note}, {dur:.1f}s speech @{sr} Hz -> {out_path} "
          f"(gen {gen_s:.1f}s, RTF {gen_s/dur:.2f}x, peak {peak:.1f} GB)")

    if not args.no_play:
        play_audio(out_path)

    # WARM-UP: keep this config warm for later calls (only on explicit --daemon).
    if args.daemon and not daemon_alive(sock_path):
        spawn_warm_daemon(repo, args.voice, args.idle_timeout)


if __name__ == "__main__":
    main()