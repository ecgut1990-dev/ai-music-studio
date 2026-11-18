# Settings → Audio (0.60 – 0.61): plan

Agreed with the owner on 2026-11-17. Model: the Audio page of Ableton Live's preferences (screenshot from the owner):
Audio device, Sample rate, Latency, Test. The owner's PC uses the mainboard sound (Realtek, no own ASIO driver: ASIO
there through ASIO4ALL or FlexASIO). Output is enough for ASIO (no ASIO recording for now); a plain beep as test tone.

## Page layout

**Audio device**
- Driver type: *Windows (standard)* (WASAPI shared, through the page) · *ASIO* (0.61, through the plugin host)
- Audio input device (recording; "No input" possible) · Audio output device · Refresh list
- Channel configuration: which outputs (ASIO and multi-channel cards, 0.61)

**Sample rate**
- Input / output sample rate of playback (Auto, 44,100, 48,000, 88,200, 96,000 Hz)
- The export sample rate stays its own setting (as before)

**Latency**
- Buffer size (samples) → shown: input latency, output latency (measured by the audio system), driver error
  compensation (ms, for recording alignment), overall latency
- ASIO: buffer sizes of the driver, "ASIO control panel" (0.61)

**Test**
- Test tone on / off, test tone volume (dB, starts at −36 dB), test tone frequency (Hz, 440 by default)
- Simulated CPU load (%): burns that share of every audio block, to find a buffer size that does not crackle
- Dropout notice: when the audio system reports missing blocks, the page suggests a larger buffer

## How (0.60, Windows)
- Output device: `AudioContext.setSinkId()` / `HTMLMediaElement.setSinkId()` for every player of the app (Studio,
  Mastering, stem mixer, library and result players). Devices from `enumerateDevices()`.
- Sample rate and buffer: the Studio's AudioContext is made with `sampleRate` and `latencyHint` (buffer / rate);
  a change rebuilds the context (playback stops first).
- Latency shown: `baseLatency + outputLatency` of the context; input latency from the input track settings.
- Driver error compensation: added to the recording offset (recorded clips move earlier by this many ms).
- Input device: `getUserMedia({ deviceId })` for recording.
- Saved in the app (localStorage); a missing device falls back to the Windows default with a notice.

## How (0.61, ASIO)
- The plugin host gets JUCE's audio device layer with ASIO (Steinberg's ASIO SDK, GPL-3). The page's AudioContext
  then plays to no device (`setSinkId({ type: 'none' })`) and a worklet at the master sends the mix to the host,
  which plays it through the ASIO driver (with a small buffer that absorbs the clock difference).
- Only one program can use an ASIO driver at a time: a driver that is busy is reported as such.
