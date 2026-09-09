# OMO X Soundboard — v1.0 alpha.5

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

## v1.0 alpha.3 iPhone navigation hotfix
- Rebuilt the bottom navigation using explicit CSS Grid areas.
- PREV and NEXT are hard-locked to row 1, 50/50.
- LOOP is hard-locked to row 2 and centered.
- Removed wrapper-based layout that could collapse/wrap incorrectly on iOS.
- Added explicit min-width/min-height constraints and stacking separation from STOP ALL.
- No IndexedDB schema change; existing local sounds remain intact at the same origin.

## v1.0 alpha.4 reorder reliability fix
- Rebuilt sound reordering around sound IDs instead of stale list indices.
- All reordered records are now written atomically in ONE IndexedDB transaction.
- Order values are normalized to 0..N-1, removing duplicate/tied legacy values.
- Existing alpha sound order is normalized once on launch.
- Added tactile press feedback to reorder/edit controls.
- No database schema change and no audio/blob migration: existing local sounds, trims, names and loop settings are preserved.

## v1.0 alpha.4.1 reorder latency hotfix
- Reordering no longer writes sound records or audio Blobs to IndexedDB at all.
- Button order is now stored as a tiny ID-only array in localStorage.
- Move Up/Down is therefore immediate and synchronous from the UI perspective.
- Existing v1.0 alpha.3/alpha.4 visible order is adopted automatically on first launch.
- Import appends the new sound ID to the order registry.
- Delete removes the sound ID from the order registry.
- Existing audio, trims, names, loop settings and IndexedDB schema remain untouched.


## v1.0 alpha.5 — iOS Blob stability rebuild
This release changes the internal architecture to avoid Safari/iOS IndexedDB Blob instability after metadata operations.

### Key changes
- Imported audio/video Blob is written to IndexedDB exactly ONCE at import.
- Reorder writes only a tiny ID array to localStorage.
- Rename, trim and loop settings write only lightweight metadata to localStorage.
- Playback fetches a FRESH Blob record from IndexedDB by sound ID on every tap.
- Editing fetches a fresh Blob record only when the editor is opened.
- The normal in-memory sound list contains metadata only — no long-lived Blob references.
- Existing alpha sounds are migrated non-destructively: metadata is copied out once; audio is not rewritten.
- Database schema stays v1; no destructive IndexedDB migration is performed.

This specifically targets symptoms where reorder/edit operations could be delayed for 60–120 seconds
or make previously valid audio suddenly report unreadable/unsupported until the PWA was restarted.
