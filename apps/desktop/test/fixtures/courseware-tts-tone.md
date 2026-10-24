# MP3 decoder fixture

`courseware-tts-tone.mp3` is a 576-byte, mono 440 Hz test tone generated locally:

```sh
ffmpeg -v error -f lavfi -i 'sine=frequency=440:duration=0.1:sample_rate=8000' -ac 1 -codec:a libmp3lame -b:a 16k -write_xing 0 -id3v2_version 0 courseware-tts-tone.mp3
```

Encoded frame padding makes decoded duration longer than the input's 100 ms.
The actual Electron check accepts 100–400 ms. This fixture establishes codec
support, not TTS output or speech quality. ffmpeg is not a product dependency.
