"""aiVideo's own HTTP wrapper around the official CosyVoice inference_vc API.

Run inside the CosyVoice environment; see docs/models.md. No model code is vendored.
"""
import io
import os
import sys
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import Response

model = None
model_lock = threading.Lock()


@asynccontextmanager
async def lifespan(app):
    global model
    root = Path(os.environ["COSYVOICE_ROOT"]).resolve()
    sys.path.insert(0, str(root))
    sys.path.insert(0, str(root / "third_party" / "Matcha-TTS"))
    from cosyvoice.cli.cosyvoice import AutoModel
    model = AutoModel(model_dir=os.environ["COSYVOICE_MODEL_DIR"])
    yield


app = FastAPI(lifespan=lifespan)


def authorize(authorization):
    token = os.environ.get("VOICE_API_TOKEN")
    if token and authorization != "Bearer " + token:
        raise HTTPException(401, "Unauthorized")


@app.get("/health")
def health(authorization: str | None = Header(default=None)):
    authorize(authorization)
    return {"ready": model is not None, "engine": "CosyVoice inference_vc"}


@app.post("/voice-convert")
def convert(source: UploadFile = File(), target: UploadFile = File(), authorization: str | None = Header(default=None)):
    authorize(authorization)
    import soundfile as sf
    import torch

    with model_lock, TemporaryDirectory(prefix="aivideo-voice-") as directory:
        paths = []
        for name, upload in (("source", source), ("target", target)):
            data = upload.file.read(16 * 1024 * 1024 + 1)
            if len(data) > 16 * 1024 * 1024:
                raise HTTPException(413, "Audio too large")
            path = Path(directory) / (name + ".wav")
            path.write_bytes(data)
            info = sf.info(str(path))
            limit = 15 if name == "source" else 30
            if info.duration <= 0 or info.duration > limit:
                raise HTTPException(400, "Unsupported audio duration")
            # The current official frontend accepts filenames and resamples internally.
            paths.append(str(path))
        with torch.inference_mode():
            outputs = list(model.inference_vc(paths[0], paths[1], stream=False))
        if not outputs:
            raise HTTPException(502, "Voice model produced no audio")
        speech = torch.cat([output["tts_speech"] for output in outputs], dim=1)
        result = io.BytesIO()
        sf.write(result, speech.squeeze(0).detach().cpu().numpy(), model.sample_rate, format="WAV", subtype="PCM_16")
        return Response(result.getvalue(), media_type="audio/wav")
