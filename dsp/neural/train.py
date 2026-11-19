#!/usr/bin/env python3
"""
Universal clone: trains a recurrent network that maps (input sample, all knob values) to the output sample of a
plugin, from an extracted .vcprofile (`vch extract`). The network does not need to know what the plugin is.

    python train.py --data <extracted profile dir> --out <dir> [--hidden 40] [--minutes 10]

Progress, results and errors are written as JSON lines to stdout (read by clone/src/neural/workflow.ts):
  {"type": "info", "message": ...}
  {"type": "progress", "step": n, "steps": total, "loss": x}
  {"type": "result", "model": "<path>", "trainEsr": x, "validateEsr": x, ...}

Model: LSTM over [x(t), p1 … pn] → linear → + x(t) (the network learns the difference to the dry signal, so an
untrained or bypassed state passes audio through), times a level the knobs set on a logarithmic scale. Weights are exported in RTNeural's layout (model.json).
"""

import argparse
import json
import math
import os
import random
import sys
import time
import wave

import numpy as np
import torch


def emit(kind, **fields):
    print(json.dumps({"type": kind, **fields}), flush=True)


# ---- data -------------------------------------------------------------------------------------------------------


def read_wav(path):
    """32-bit float or 16/24-bit PCM WAV → float32 array (frames, channels)."""
    import soundfile  # only needed here; keeps the import error close to its cause

    data, rate = soundfile.read(path, dtype="float32", always_2d=True)
    return data, rate


def load_profile(directory):
    manifest = json.load(open(os.path.join(directory, "manifest.json")))
    parameters = json.load(open(os.path.join(directory, "parameters.json")))["parameters"]
    captures = json.load(open(os.path.join(directory, "captures.json")))["renders"]
    selected = manifest["capture"]["plan"].get("selectedParameters")
    if not selected:
        selected = [p["index"] for p in parameters if p.get("automatable", True) and not p.get("meta", False)]
    base = {p["index"]: float(p.get("value", p.get("default", 0.0))) for p in parameters}
    # controls that move in steps (positions.json, written by clone/src/neural/train.ts): the network sees the middle
    # of the position a value falls into, so it never has to learn a jump between two neighbouring values
    positions_path = os.path.join(directory, "positions.json")
    positions = {int(k): v for k, v in json.load(open(positions_path)).items()} if os.path.exists(positions_path) else {}
    x, rate = read_wav(os.path.join(directory, "input.wav"))
    x = x[:, 0]
    renders = []
    for r in captures:
        y, _ = read_wav(os.path.join(directory, r["file"]))
        values = dict(base)
        for p in r.get("params", []):
            values[p["index"]] = float(p["value"])
        for index, pos in positions.items():
            if index in values:
                values[index] = snap(pos, values[index])
        # the capture is input length + tail; the input is padded with silence for the tail
        n = y.shape[0]
        xin = np.zeros(n, dtype=np.float32)
        xin[: min(n, x.shape[0])] = x[: min(n, x.shape[0])]
        emphasised = y[1:] - 0.85 * y[:-1]
        renders.append({
            "power": max(float((emphasised ** 2).mean()), SILENCE_POWER),
            "id": r["id"],
            "purpose": r.get("purpose", "train"),
            "label": r.get("label", r["id"]),
            "cond": np.array([values[i] for i in selected], dtype=np.float32),
            "x": xin,
            "y": y.astype(np.float32),  # (frames, channels)
        })
    names = {p["index"]: p["name"] for p in parameters}
    return {"rate": rate, "selected": selected, "names": [names[i] for i in selected], "renders": renders,
            "positions": [positions.get(i) for i in selected]}


def snap(positions, value):
    """Middle of the position a value falls into: the one whose range contains it, else the nearest (positionOf)."""
    best, distance = 0, math.inf
    for i, (lo, hi) in enumerate(positions["bounds"]):
        d = lo - value if value < lo else value - hi if value > hi else 0.0
        if d < distance:
            best, distance = i, d
    return float(positions["values"][best])


# ---- model ------------------------------------------------------------------------------------------------------


# limit of the level on the natural-log scale: ±12 = ±104 dB (the same clamp in NeuralEngine.h)
LEVEL_LIMIT = 12.0

# Output power (mean square, dBFS) below which a render counts as silent: errors are measured against at least this
# power. A setting with the volume turned down (−77 dB) otherwise makes inaudible residual noise a huge error and
# draws the training towards it. The same floor in clone/src/neural/verify.ts.
SILENCE_POWER = 10 ** (-60 / 10)


class Model(torch.nn.Module):
    """
    y(t) = exp(level) · (dense(gamma ⊙ h(t) + beta) + dry ⊙ x(t)),  h = LSTM([x(t), knobs])
    gamma, beta, dry, level = film(knobs): the knobs scale and shift what the network computes (FiLM) and set how much
    of the dry signal passes – a level or drive control acts multiplicatively, which a plain extra input learns badly.
    `level` is a gain on a logarithmic scale: volume controls span 100 dB and more (Tal-Filter-2: −77 … +43 dB),
    which a factor linear in the knobs cannot reach – with it the network learned nothing (validation ESR 0.92).
    The knobs only change when a control moves, so the plugin computes film() per block, not per sample.
    """

    def __init__(self, conditions, hidden, outputs, film_hidden=32, use_film=True):
        super().__init__()
        self.use_film = use_film
        self.lstm = torch.nn.LSTM(1 + conditions, hidden, batch_first=True)
        self.film1 = torch.nn.Linear(max(1, conditions), film_hidden)
        self.film2 = torch.nn.Linear(film_hidden, 2 * hidden + outputs + 1)
        self.dense = torch.nn.Linear(hidden, outputs)
        self.hidden = hidden
        self.outputs = outputs
        # start like the plain model: LSTM output unchanged (gamma = 1, beta = 0) plus the dry signal (dry = 1) –
        # without the dry path at the start the network does not find its way (ESR 0.8 instead of 0.04)
        torch.nn.init.zeros_(self.film2.weight)
        with torch.no_grad():
            self.film2.bias.zero_()
            self.film2.bias[:hidden] = 1.0
            self.film2.bias[2 * hidden: 2 * hidden + outputs] = 1.0  # dry; the level (last row) starts at 0 dB

    def film(self, cond):
        if cond.shape[1] == 0:
            cond = torch.zeros(cond.shape[0], 1, device=cond.device)
        f = self.film2(torch.tanh(self.film1(cond)))
        h, o = self.hidden, self.outputs
        level = torch.clamp(f[:, 2 * h + o:], -LEVEL_LIMIT, LEVEL_LIMIT)
        return f[:, :h], f[:, h: 2 * h], f[:, 2 * h: 2 * h + o], level

    def forward(self, x, cond, state=None):
        # x: (batch, time, 1), cond: (batch, cond)
        c = cond.unsqueeze(1).expand(-1, x.shape[1], -1)
        h, state = self.lstm(torch.cat([x, c], dim=2), state)
        if not self.use_film:
            return self.dense(h) + x, state
        gamma, beta, dry, level = self.film(cond)
        y = self.dense(gamma.unsqueeze(1) * h + beta.unsqueeze(1)) + dry.unsqueeze(1) * x
        return torch.exp(level).unsqueeze(1) * y, state


def emphasis(s):
    """First-order pre-emphasis along time (weights the highs a little, as audio losses usually do)."""
    return s[:, 1:] - 0.85 * s[:, :-1]


def esr(pred, target, power):
    """
    Error-to-signal ratio per example, normalised by the power of the whole render it comes from (`power`, batch):
    a quiet setting counts as much as a loud one (down to SILENCE_POWER), and a window of silence does not divide by zero.
    """
    err = ((emphasis(pred) - emphasis(target)) ** 2).mean(dim=(1, 2))
    return (err / power).mean()


def stft_loss(pred, target):
    """Log-magnitude difference over three resolutions: catches spectral errors the sample loss averages away."""
    total = 0.0
    p = pred.reshape(-1, pred.shape[1])
    t = target.reshape(-1, target.shape[1])
    for n in (256, 1024, 4096):
        if p.shape[1] < n:
            continue
        window = torch.hann_window(n, device=p.device)
        P = torch.stft(p, n, n // 4, window=window, return_complex=True).abs()
        T = torch.stft(t, n, n // 4, window=window, return_complex=True).abs()
        total = total + (torch.log(P + 1e-5) - torch.log(T + 1e-5)).abs().mean() + ((P - T).norm() / (T.norm() + 1e-8))
    return total


# ---- training ---------------------------------------------------------------------------------------------------


def batches(renders, channels, window, warmup, batch, rng):
    """Random windows from random training renders; the first `warmup` samples only settle the state."""
    length = window + warmup
    xs, ys, cs, ps = [], [], [], []
    for _ in range(batch):
        r = renders[rng.randrange(len(renders))]
        n = r["x"].shape[0]
        start = rng.randrange(0, max(1, n - length))
        ch = rng.randrange(channels)
        xs.append(r["x"][start:start + length])
        ys.append(r["y"][start:start + length, ch])
        cs.append(r["cond"])
        ps.append(r["power"])
    return (np.stack(xs)[:, :, None], np.stack(ys)[:, :, None], np.stack(cs), np.array(ps, dtype=np.float32))


class Streams:
    """
    Truncated backpropagation through time: every lane plays one render (one channel) from its start to its end in
    consecutive chunks, and the network's state is carried from chunk to chunk (gradients stop at the chunk
    border). The network so learns what happens over whole renders – a compressor's release, a filter ringing out –
    not only within a short window. A lane that reaches the end of its render starts the next one from silence,
    with a cleared state, exactly as the plugin starts after a reset.
    """

    def __init__(self, renders, channels, lanes, window, rng):
        self.renders, self.channels, self.window, self.rng = renders, channels, window, rng
        self.lanes = [self._new() for _ in range(lanes)]

    def _new(self):
        return {"render": self.renders[self.rng.randrange(len(self.renders))], "channel": self.rng.randrange(self.channels), "pos": 0}

    def next(self):
        """(x, y, cond, power, fresh) for the next chunk of every lane; fresh marks lanes whose state starts empty"""
        xs, ys, cs, ps, fresh = [], [], [], [], []
        for i, lane in enumerate(self.lanes):
            if lane["pos"] + self.window > lane["render"]["x"].shape[0]:
                lane = self.lanes[i] = self._new()
            r, start = lane["render"], lane["pos"]
            fresh.append(start == 0)
            xs.append(r["x"][start:start + self.window])
            ys.append(r["y"][start:start + self.window, lane["channel"]])
            cs.append(r["cond"])
            ps.append(r["power"])
            lane["pos"] += self.window
        return (np.stack(xs)[:, :, None], np.stack(ys)[:, :, None], np.stack(cs), np.array(ps, dtype=np.float32), np.array(fresh))


@torch.no_grad()
def evaluate(model, renders, device, channels):
    """ESR over whole renders (all channels), processed in chunks with the state carried on."""
    model.eval()
    results = []
    for r in renders:
        x = torch.from_numpy(r["x"]).to(device)[None, :, None]
        cond = torch.from_numpy(r["cond"]).to(device)[None]
        state = None
        outs = []
        # (cuDNN refuses very long sequences: chunks of 8192 with the state carried on give the same result)
        for i in range(0, x.shape[1], 8192):
            y, state = model(x[:, i:i + 8192].contiguous(), cond, state)
            outs.append(y)
        pred = torch.cat(outs, dim=1)[0, :, 0].cpu().numpy()
        errors = []
        for ch in range(channels):
            target = r["y"][:, ch]
            errors.append(float(((pred - target) ** 2).sum() / max(float((target ** 2).sum()), target.shape[0] * SILENCE_POWER)))
        results.append({"id": r["id"], "label": r["label"], "esr": float(np.mean(errors))})
    model.train()
    return results


def export(model, meta, path):
    """Weights in RTNeural's layout: LSTM W (in×4h), U (h×4h), b (4h, input + recurrent bias), gate order i f g o."""
    lstm, dense = model.lstm, model.dense
    hidden = lstm.hidden_size
    data = {
        **meta,
        "hidden": hidden,
        "inputs": lstm.input_size,
        "outputs": dense.out_features,
        "lstm": {
            "W": lstm.weight_ih_l0.detach().cpu().numpy().T.tolist(),
            "U": lstm.weight_hh_l0.detach().cpu().numpy().T.tolist(),
            "b": (lstm.bias_ih_l0 + lstm.bias_hh_l0).detach().cpu().numpy().tolist(),
        },
        "dense": {
            "W": dense.weight.detach().cpu().numpy().tolist(),
            "b": dense.bias.detach().cpu().numpy().tolist(),
        },
        # film(knobs) = film2(tanh(film1(knobs))) → [gamma (hidden), beta (hidden), dry (outputs), level (1)]
        "film": {
            "W1": model.film1.weight.detach().cpu().numpy().tolist(),
            "b1": model.film1.bias.detach().cpu().numpy().tolist(),
            "W2": model.film2.weight.detach().cpu().numpy().tolist(),
            "b2": model.film2.bias.detach().cpu().numpy().tolist(),
        },
    }
    with open(path, "w") as f:
        json.dump(data, f)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--hidden", type=int, default=40)
    parser.add_argument("--minutes", type=float, default=10.0, help="training time budget")
    parser.add_argument("--steps", type=int, default=0, help="fixed number of steps instead of the time budget")
    parser.add_argument("--batch", type=int, default=32)
    parser.add_argument("--window", type=int, default=4096)
    parser.add_argument("--warmup", type=int, default=1024)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--lr", type=float, default=2e-3)
    parser.add_argument("--stft", type=float, default=0.0, help="weight of the multi-resolution STFT loss")
    parser.add_argument("--mode", default="windows", help="stream: whole renders in consecutive chunks (state carried); windows: random short windows")
    parser.add_argument("--film", type=int, default=1, help="0: knobs only as extra inputs (no FiLM)")
    parser.add_argument("--loss", default="render", help="render: ESR per render power; batch: ESR over the batch")
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    torch.manual_seed(args.seed)
    rng = random.Random(args.seed)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    emit("info", message=f"Training on {torch.cuda.get_device_name(0) if device == 'cuda' else 'CPU (no CUDA device – slow)'}")

    data = load_profile(args.data)
    channels = data["renders"][0]["y"].shape[1]
    train = [r for r in data["renders"] if r["purpose"] != "validate"]
    validate = [r for r in data["renders"] if r["purpose"] == "validate"]
    emit("info", message=f"{len(train)} training and {len(validate)} validation renders, {len(data['selected'])} controls ({', '.join(data['names'])}), {channels} channel(s)")

    model = Model(len(data["selected"]), args.hidden, 1, use_film=bool(args.film)).to(device)
    optimiser = torch.optim.Adam(model.parameters(), lr=args.lr)
    started = time.time()
    budget = args.minutes * 60
    step, best, best_state = 0, math.inf, None
    # last state with a finite loss, and a factor on the learning rate that halves after every divergence
    good_state, lr_scale, resets = {k: v.detach().clone() for k, v in model.state_dict().items()}, 1.0, 0
    total = args.steps or None
    streams = Streams(train, channels, args.batch, args.window // 2, rng) if args.mode == "stream" else None
    state = None
    while True:
        elapsed = time.time() - started
        if (total and step >= total) or (not total and elapsed >= budget):
            break
        # learning rate falls over the run (cosine over the time or step budget)
        progress = step / total if total else elapsed / budget
        for group in optimiser.param_groups:
            group["lr"] = lr_scale * args.lr * (0.05 + 0.95 * 0.5 * (1 + math.cos(math.pi * min(1.0, progress))))
        if streams is not None:
            x, y, c, power, fresh = streams.next()
            x, y, c, power = (torch.from_numpy(a).to(device) for a in (x, y, c, power))
            if state is not None:
                # lanes that start a new render begin with an empty state; the rest continue (without gradients)
                keep = torch.from_numpy(~fresh).to(device).float()[None, :, None]
                state = tuple((s * keep).detach() for s in state)
            pred, state = model(x, c, state)
            p, t = pred, y
        else:
            x, y, c, power = batches(train, channels, args.window, args.warmup, args.batch, rng)
            x, y, c, power = (torch.from_numpy(a).to(device) for a in (x, y, c, power))
            pred, _ = model(x, c)
            p, t = pred[:, args.warmup:], y[:, args.warmup:]
        base = esr(p, t, power) if args.loss == "render" else ((emphasis(p) - emphasis(t)) ** 2).sum() / ((emphasis(t) ** 2).sum() + 1e-8)
        loss = base + (args.stft * stft_loss(p[..., 0], t[..., 0]) if args.stft > 0 else 0.0)
        if not torch.isfinite(loss):
            # diverged: back to the last good state with half the learning rate (a fresh optimiser state too)
            resets += 1
            if resets > 8:
                raise RuntimeError("training keeps diverging")
            model.load_state_dict(good_state)
            optimiser = torch.optim.Adam(model.parameters(), lr=args.lr)
            state = None
            lr_scale *= 0.5
            emit("info", message=f"step {step}: training diverged, continuing from the last good state with a lower learning rate")
            continue
        optimiser.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimiser.step()
        step += 1
        if step % 200 == 0:
            good_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
        if step % 50 == 0:
            emit("progress", step=step, steps=total or 0, seconds=round(elapsed), budget=round(budget), loss=float(loss))
        if step % 500 == 0 and validate:
            score = float(np.mean([v["esr"] for v in evaluate(model, validate, device, channels)]))
            if score < best:
                best, best_state = score, {k: v.detach().clone() for k, v in model.state_dict().items()}
            emit("info", message=f"step {step}: validation ESR {score:.4f}")

    if best_state is not None:
        final = float(np.mean([v["esr"] for v in evaluate(model, validate, device, channels)]))
        if final > best:
            model.load_state_dict(best_state)
    train_results = evaluate(model, train, device, channels)
    validate_results = evaluate(model, validate, device, channels)
    path = os.path.join(args.out, "model.json")
    export(model, {"sampleRate": data["rate"], "parameters": data["selected"], "names": data["names"], "positions": data["positions"]}, path)
    if os.environ.get("VCH_NEURAL_DEBUG"):
        for r in sorted(train_results + validate_results, key=lambda r: r["esr"]):
            emit("info", message=f"{r['id']} {r['label']}: ESR {r['esr']:.4f}")
    emit("result", model=path, steps=step, seconds=round(time.time() - started),
         trainEsr=float(np.mean([r["esr"] for r in train_results])),
         validateEsr=float(np.mean([r["esr"] for r in validate_results])) if validate_results else None,
         worst=sorted(validate_results or train_results, key=lambda r: -r["esr"])[:5])


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # reported to the workflow instead of a bare traceback
        emit("error", message=f"{type(error).__name__}: {error}")
        raise
