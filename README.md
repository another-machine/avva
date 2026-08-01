# AVVA

One machine turns music into color, the other color into music. Point them at
each other, and then get in-between.

A camera feeds an analyzer that drives an FM synth; the synth's output feeds an
analyzer that drives the visuals. Run both halves in one tab and the loop closes
on itself.

```bash
npm install
npm run dev          # http://localhost:5173
```

The root URL is a launcher listing every view. Nothing starts until you pick
one — a bare visit asks for no camera and opens no AudioContext.

## Views

| URL            | What it does                                                                   |
| -------------- | ------------------------------------------------------------------------------ |
| `/?view=loop`  | The closed loop, and a broadcast of the synth output for listener tabs          |
| `/?view=va`    | Video → audio only. Drives the synth and broadcasts; no local renderer          |
| `/?view=av`    | Audio → video. Receives a stream from any broadcasting tab and draws it         |
| `/controller/` | Every tunable parameter, live-synced to the other tabs. Pick the media folder here |

## Keys

**`S` starts the synth.** It is silent until you press it — an AudioContext
needs a user gesture, and that keypress is the gesture.

| key | |
| --- | --- |
| `S` | Synth on / off |
| `C` | Cycle source |
| `M` | Heat overlay |
| `R` | Mirror |
| `H` | HUD |
| `F` | Fullscreen |

## Video files

There are no bundled assets. Video belongs to whoever is performing, not to the
repo — and a single 3.9 GB file in a bundled `assets/` directory was enough to
fail the production build outright by blowing past the bundler's 2 GiB limit.

Choose a folder in the controller instead. The handle is kept in IndexedDB, so a
reload reconnects on its own without anyone clicking through a picker — which
matters when this is running unattended.

`?source=` then takes a bare filename, resolved against that folder:

```
/?view=loop&source=lavalamp.mp4
```

Because the folder is a per-machine setting and the filename is not, **a preset
link means the same thing on any machine whose folder holds a file by that
name.** Anything with a slash or a scheme is still treated as a path, so older
`/assets/…` links keep resolving.

Folder picking uses `showDirectoryPicker`, which is Chromium-only. Other
browsers fall back to a directory input that works but forgets the folder on
every reload.

## State lives in the URL

Every parameter in `src/store/schema.ts` is addressable, so a look is a link —
copy the URL and you have the preset. The controller writes to the same store
and syncs over BroadcastChannel to other tabs in the same browser.

For a controller on a *different device*, run the relay:

```bash
npm run relay        # ws://0.0.0.0:3001, PORT= to change it
```

```
http://<lan-ip>:5173/controller/?relay=ws://<lan-ip>:3001
```

The relay is a Node WebSocket server, so it does not exist on static hosting —
on a deployed build, cross-device sync needs the relay hosted somewhere of its
own, and an HTTPS page must reach it over `wss://`. Same-browser sync is
unaffected either way.

## Layout

```
src/analysis    video and audio analyzers — the 0..1 scene axes everything reads
src/harmony     palette, chords, perceptual hue mapping
src/audio       FM synth, drums, layers, AudioWorklets, bus graph
src/render      GL renderer
src/input       video source switching, media folder, WebRTC bridge
src/store       schema, URL seeding, cross-tab sync, telemetry
src/views       the three views
controller/     the parameter UI
server/relay.ts the optional cross-device relay
```

Parts of this have been generalised into
[another-machine/public-library](https://github.com/another-machine/public-library)
and are consumed back from there: the FM voice, drums, layers and worklets as
`@amplib/sound-synthesis`, the display-to-perceptual hue mapping as
`@amplib/color`, the chord parser as part of `@amplib/music-theory`, and camera,
screen and microphone capture as `@amplib/devices`.

Three of those come from npm. `@amplib/color` is a `file:` link to the sibling
checkout while it is still unpublished, so a clone of this repo alone will not
resolve it — `../public-library` has to be there too.

The hue wheel built on top of that mapping went out briefly as
`@amplib/hue-wheel` and came back: it lives in `src/harmony/palette.ts` until
something other than AVVA wants it and can argue for its own defaults.

## Build

Vite. `npm run build` type-checks first, so a type error fails the build rather
than shipping. Output is `dist/` — two entry points, the app and the controller.

Deployed to GitHub Pages at [avva.amplib.app](https://avva.amplib.app) by
`.github/workflows/deploy.yml`, which mirrors public-library's workflow. The
custom domain lives in `public/CNAME` so it is declared in the repo rather than
only in repo settings.

Requires HTTPS in production for the camera, the folder picker and worklets.
`localhost` is exempt.

The relay does not exist on static hosting — it is a Node WebSocket server, so
cross-device sync on a deployed build needs one hosted separately and reached
over `wss://`. The launcher says so, based on the hostname it is served from.
