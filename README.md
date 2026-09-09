# OMO X Soundboard — v1.0 alpha.2

A local-first PWA soundboard designed for portrait iPhone use.

## Drive Mode
- No scrolling.
- 6 fixed large sound buttons per page (2 columns × 3 rows).
- Large PREV and NEXT buttons with a compact live LOOP toggle between them.
- Large STOP ALL button.
- Tap a sound once to play; tap the same sound again to stop.
- Starting another sound stops the current one.
- Per-sound loop.
- Optional Screen Wake Lock button.

## Manage Mode
- Scrolling is allowed here.
- Import multiple files.
- Rename buttons.
- Trim start/end.
- Preview before saving.
- Waveform preview when Web Audio can decode the source.
- Edit or delete existing sounds.
- Reorder using ↑ / ↓ buttons.
- Page number is calculated automatically from the order.

## Local storage
Imported media is stored in IndexedDB on that browser/device.
It is NOT uploaded to GitHub.
Keep original audio/video files as backup.

## File formats
The picker accepts:
- MP3
- M4A
- WAV
- OGG
- Opus
- AAC
- MP4

Actual playback/decoding depends on browser + iOS codec support.
MP3, M4A/AAC and WAV are generally the safest choices.

MP4 is played as hidden media with audio only.
This alpha does NOT transcode or permanently extract an MP4 audio track.

## Deploy to GitHub Pages
Upload these files to the ROOT of the existing GitHub Pages repository:
- index.html
- styles.css
- app.js
- manifest.json
- service-worker.js
- icon-192.png
- icon-512.png

This package replaces the previous versions of index.html,
manifest.json and service-worker.js.

After GitHub Pages finishes deploying:
1. Open the site while online.
2. Hard refresh / reload once or twice.
3. Confirm the page says "v1.0 alpha".
4. On iPhone, open the URL in Safari.
5. Share → Add to Home Screen → Open as Web App.
6. Open the installed app once online so the app shell is cached.
7. Add sounds from Manage mode on the iPhone itself.

Sounds imported on a Mac do not automatically sync to the iPhone.

## v1.0 alpha.1 tactile patch
- Added strong press feedback (depress, dim, inset shadow) to Drive Mode controls.
- Added a compact LOOP button between PREV and NEXT.
- The LOOP button controls the currently playing sound and persists that sound's loop setting.
- LOOP is disabled when nothing is playing.
- Updating the app at the same GitHub Pages URL does not intentionally clear IndexedDB audio.

## v1.0 alpha.2 navigation layout fix
- PREV and NEXT now always occupy the first row, 50/50.
- LOOP is centered on its own second row underneath.
- Prevents mobile wrapping into [PREV][LOOP] / [NEXT].
- No IndexedDB schema changes; existing imported sounds should remain intact after updating at the same URL.
