# Recordings

Pre-recorded voice clips for the emulator's `mic` command. Drop `.flac` (or
`.wav`) files in this folder and feed them into the voice pipeline as if they
were spoken into the satellite's microphone:

```
HE> mic                  # list the clips in this folder
HE> mic turn-on-lights   # extension optional; unique prefix is enough
```

Requirements: 16-bit PCM. Any sample rate and channel count work — clips are
downmixed to mono and resampled to the 16 kHz the mic pipeline expects.

Tip: with the `input_buffer_debug` global setting enabled, the emulator saves
what the mic actually captured during a real voice turn as a FLAC in the audio
folder — those files can be copied here and replayed as test cases.

Clips are git-ignored by default (they usually contain your voice). Remove the
ignore rules in `.gitignore` if you want to commit shared test fixtures.
