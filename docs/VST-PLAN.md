# VST plugins (0.50 – 0.52): plan

Agreed with the owner on 2026-11-17. Standard VST3 and VST2 support; tested later with the plugins installed on the
owner's PC (no particular plugins are required).

## Decisions

- **64-bit plugins only.** 32-bit VST2 plugins are not supported; the plugin list and the docs say so.
- **Audio goes to the plugin host only while a plugin is in use** (a track, the master or the mastering chain has a
  plugin switched on). Without plugins nothing changes and the host is not even started.
- **Plugin windows float above the app** (always on top of the app window, like Ableton).
- **Plugin search:** on the first start after installing the version with plugins, and afterwards only when the
  user presses **Search for plugins** (Settings → Plugins). New plugins are not searched for at every start.
- Order: effects in the Studio (0.50), master and mastering chain (0.51), instruments on MIDI tracks (0.52).

## How it works

```
renderer (Web Audio)                     AMS Plugin Host (C++, JUCE 7, GPL-3.0)
 track ── vst-insert worklet ──┐
                               │ MessagePort
                 audio worker ─┴── WebSocket 127.0.0.1 (binary blocks) ──► plugin.processBlock
 Settings / Studio UI ───────────── WebSocket (JSON commands) ──────────► load, state, editor, scan
 Electron main: starts the host on demand, restarts it after a crash, passes port + token to the page
```

- **Host program** `ams-plugin-host.exe`, built with JUCE 7.0.12 (GPL-3.0, like the app; JUCE 8 is AGPL).
  VST3 through JUCE; VST2 through JUCE with the free **FST** headers (the VST2 SDK is no longer distributed).
  Shipped in the installer next to the app (`resources/plugin-host`).
- **Crash safety:** plugins run in the host, not in the app. If the host dies the app restarts it, reloads the
  plugins with their saved state and reports which plugin was running. Scanning runs one plugin per short child
  process, so a plugin that crashes while being scanned is marked as failed and skipped next time.
- **Audio path:** a `vst-insert` AudioWorklet collects 128-sample quanta into blocks and posts them to a dedicated
  worker (not the page's main thread, so the UI cannot make it stutter); the worker sends them to the host and back.
  The worklet plays the processed audio with a fixed delay (a few blocks). The track is fed that much earlier
  (look-ahead), so it stays in time with the other tracks; the plugin's own latency is added to that
  (delay compensation).
- **Saving:** each plugin's full state (the plugin's own chunk, base64) is saved in the project and restored when it
  opens. Missing plugins are kept in the project (greyed out) so nothing is lost when a project moves to another PC.
- **Export:** tracks with plugins are rendered through the host offline (faster than real time where the plugin
  allows), then mixed like before.

## Steps

### 0.50.0: foundation and effects in the Studio
1. Host program: WebSocket server, scan, load / unload, process, state, editor windows; builds on Linux (tests)
   and Windows (release workflow, MSVC).
2. Electron: start / stop / restart the host, port and token to the page.
3. Settings → Plugins: folders (defaults plus the VST folders of Settings → General), **Search for plugins**, list
   with name, vendor, type (effect / instrument), format (VST3 / VST2) and a tick per plugin; failed plugins marked;
   note "64-bit plugins only".
4. Studio: plugins in "+ Effect…" under the built-in effects; click opens the plugin window; on / off and order as
   with the built-in effects; CPU load of the host shown.
5. Project save / open with plugin states; export with plugins.
6. Tests: unit tests for the protocol and block buffering; end-to-end on Linux with a test VST3 (JUCE gain example).

### 0.51.0: master and mastering
7. Plugins on the Studio master.
8. Plugin slot in the mastering chain (movable between the built-in modules), before / after, export.

### 0.52.0: instruments
9. Instrument plugins (VSTi) on MIDI tracks: Piano Roll, MIDI recording and the MIDI keyboard play them.
10. Export with instruments.

### Later (ideas)
Plugin parameters as automation lanes, presets per plugin, sidechain.
