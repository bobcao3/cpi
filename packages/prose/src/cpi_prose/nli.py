import time

from .progress import progress

BATCH_SIZE = 16


class NliScorer:
    def __init__(self, name, revision, device, offline, compile_model):
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        progress(f"Loading NLI model {name} on {device} in BF16; uncached files download now...")
        options = {"revision": revision, "local_files_only": offline, "trust_remote_code": False}
        self.tokenizer = AutoTokenizer.from_pretrained(name, **options)
        self.model = (
            AutoModelForSequenceClassification.from_pretrained(
                name, dtype=torch.bfloat16, **options
            )
            .to(device)
            .eval()
        )
        if any(parameter.dtype != torch.bfloat16 for parameter in self.model.parameters()):
            raise RuntimeError("NLI model did not load entirely in BF16")
        self.device = device
        self.cuda_compiled = compile_model and device == "cuda"
        self.batch_size = (
            (64 if torch.cuda.mem_get_info()[0] >= 8 * 1024**3 else 16)
            if device == "cuda"
            else BATCH_SIZE
        )
        self.entailment_id = next(
            (
                index
                for label, index in self.model.config.label2id.items()
                if label.lower().startswith("entail")
            ),
            None,
        )
        if self.entailment_id is None:
            raise ValueError("The tone checkpoint must identify its NLI entailment label")
        self.contradiction_id = -1 if self.entailment_id == 0 else 0
        self.attention_backend = self.model.config._attn_implementation
        self.attention = (
            "disentangled"
            if self.model.config.model_type in {"deberta", "deberta-v2"}
            else self.attention_backend
        )
        self.execution = "torch.compile" if compile_model else "native"
        self.warmed = False
        self.model_bytes = sum(
            parameter.numel() * parameter.element_size() for parameter in self.model.parameters()
        )
        progress(f"NLI weights ready: BF16, {self.model_bytes / 1048576:.1f} MiB.")
        progress(f"Attention: {self.attention}. Execution: {self.execution}.")
        if compile_model:
            self.model = torch.compile(
                self.model,
                dynamic=True,
                mode="reduce-overhead" if self.cuda_compiled else "default",
            )

    def score(self, sections, weights, labels, hypothesis):
        import torch

        started = time.perf_counter()
        warmup = not self.warmed
        if warmup and self.execution == "torch.compile":
            progress("Compiling/warming DeBERTa BF16 graphs; compiled artifacts are cached...")
        order = sorted(range(len(sections)), key=weights.__getitem__)
        pairs = [(section, label) for section in order for label in range(len(labels))]
        token_count = padded_count = 0
        batch_shapes = []
        totals = dict.fromkeys(labels, 0.0)
        total_weight = sum(weights)
        progress(f"DeBERTa BF16 warmup/inference: {len(pairs)} pairs, length-sorted batches...")
        with torch.inference_mode(), torch.profiler.record_function("cpi-prose.nli"):
            for start in range(0, len(pairs), self.batch_size):
                batch = pairs[start : start + self.batch_size]
                encoded = self.tokenizer(
                    [sections[section] for section, _ in batch],
                    [hypothesis.format(labels[label]) for _, label in batch],
                    padding=True,
                    truncation=False,
                    return_tensors="pt",
                )
                if encoded["input_ids"].shape[1] > self.model.config.max_position_embeddings:
                    raise ValueError("An NLI text/label pair exceeds the model context window")
                token_count += int(encoded["attention_mask"].sum())
                if self.cuda_compiled:
                    length = encoded["input_ids"].shape[1]
                    bucket = min(
                        self.model.config.max_position_embeddings,
                        max(32, 1 << (length - 1).bit_length()),
                    )
                    padding = (0, bucket - length)
                    if self.tokenizer.padding_side == "left":
                        padding = padding[::-1]
                    for name, tensor in encoded.items():
                        value = self.tokenizer.pad_token_id if name == "input_ids" else 0
                        encoded[name] = torch.nn.functional.pad(tensor, padding, value=value)
                padded_count += encoded["input_ids"].numel()
                batch_shapes.append(list(encoded["input_ids"].shape))
                encoded = encoded.to(self.device)
                if self.cuda_compiled:
                    for tensor in encoded.values():
                        torch._dynamo.mark_static(tensor, 1)
                    torch.compiler.cudagraph_mark_step_begin()
                logits = self.model(**encoded).logits
                selected = logits[:, [self.contradiction_id, self.entailment_id]]
                probabilities = (
                    torch.softmax(selected, dim=-1)
                    .to(device="cpu", dtype=torch.float64)[:, 1]
                    .tolist()
                )
                for (section, label), probability in zip(batch, probabilities, strict=True):
                    totals[labels[label]] += probability * weights[section] / total_weight
                if start % (8 * self.batch_size) == 0:
                    stop = min(start + self.batch_size, len(pairs))
                    progress(f"DeBERTa BF16: processing pairs {start + 1}-{stop}/{len(pairs)}...")
        elapsed = time.perf_counter() - started
        self.warmed = True
        progress(f"DeBERTa BF16 inference complete in {elapsed:.2f}s.")
        return totals, {
            "inference_seconds": elapsed,
            "warmup_included": warmup,
            "pairs": len(pairs),
            "batch_size": self.batch_size,
            "batch_shapes": batch_shapes,
            "input_tokens": token_count,
            "padded_tokens": padded_count,
        }
