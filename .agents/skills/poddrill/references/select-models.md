# Set up Moonshine weights

Read this only when the episode language is `ja`, `ko`, or `zh`. Ask the user before you install moonshine-voice. PodDrill does not download the weights. After the user agrees, install the current moonshine-voice release into the PodDrill Python, download the model with word timestamps, then pass the returned directory to setup. The version is unpinned. On a PEP 668 Python, use the venv from `poddrill install-python`.

Install the package first. `$PODDRILL_PYTHON` is the interpreter PodDrill spawns.

```
"$PODDRILL_PYTHON" -m pip install moonshine-voice
```

A missing package fails with: `Install moonshine-voice into the PodDrill Python: "$PODDRILL_PYTHON" -m pip install moonshine-voice`.

`"$PODDRILL_PYTHON" -m moonshine_voice.download` on moonshine-voice 0.1.5 exits unless you pass `--stt`. That command prints `Downloaded model path:`. The directory on that line does not include the attention decoder, so word timestamps stay empty. Call `get_model_for_language` with `include_word_timestamps=True` instead. The returned path is the directory setup stores.

Setup still needs `--provider` and `--queue-length`. Use the provider the skill already named. Add `--model-weights` to that command.

## Japanese

Architecture 0 is tiny.

```python
from moonshine_voice import get_model_for_language

path, _arch = get_model_for_language("ja", 0, include_word_timestamps=True)
print(path)
```

```
poddrill setup --provider <id> --queue-length 1 --model-weights moonshine-tiny-ja=<path>
```

## Korean

Architecture 0 is tiny.

```python
from moonshine_voice import get_model_for_language

path, _arch = get_model_for_language("ko", 0, include_word_timestamps=True)
print(path)
```

```
poddrill setup --provider <id> --queue-length 1 --model-weights moonshine-tiny-ko=<path>
```

## Chinese

Architecture 1 is base.

```python
from moonshine_voice import get_model_for_language

path, _arch = get_model_for_language("zh", 1, include_word_timestamps=True)
print(path)
```

```
poddrill setup --provider <id> --queue-length 1 --model-weights moonshine-base-zh=<path>
```
