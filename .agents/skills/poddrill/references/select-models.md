# Set up Moonshine weights

PodDrill does not download the weights. Install the package, download the model with word timestamps, then pass the returned directory to setup.

Install the package first.

```
pip install moonshine-voice
```

`python -m moonshine_voice.download` on moonshine-voice 0.1.5 exits unless you pass `--stt`. That command prints `Downloaded model path:`. The directory on that line does not include the attention decoder, so word timestamps stay empty. Call `get_model_for_language` with `include_word_timestamps=True` instead. The returned path is the directory setup stores.

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
