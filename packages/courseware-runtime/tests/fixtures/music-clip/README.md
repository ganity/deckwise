# Sequential audio fixture

`tone.mp3` is an authored, local eight-second 523.25 Hz sine tone. It contains
no third-party content and makes no provider calls.

SHA-256: `b2904fd3c8dbec640904b6545daef5760fcdcd490ae92b0e4cdcb0d4d6ca1084`.

Created with the installed FFmpeg:

```sh
ffmpeg -v error -f lavfi -i 'sine=frequency=523.25:duration=8' -ac 1 -ar 22050 -codec:a libmp3lame -b:a 32k -map_metadata -1 tone.mp3
```

The dedicated browser gate pins these exact bytes and plays them through the
current fixed package resolver, SHA-256 loader and native HTMLAudioElement.
It does not establish supplier-output quality or authenticated team transport.
