const APP_VERSION = "1.0-alpha.7.2";
const PAGE_SIZE = 6;

const DB_NAME = "omo-x-soundboard";
const DB_VERSION = 1;
const STORE = "sounds";
const ORDER_KEY = "omo-x-soundboard-order-v1";
const META_KEY = "omo-x-soundboard-meta-v2";

const $ = (selector) => document.querySelector(selector);

const driveView = $("#driveView");
const manageView = $("#manageView");
const soundGrid = $("#soundGrid");
const emptyDrive = $("#emptyDrive");
const soundCount = $("#soundCount");
const pageLabel = $("#pageLabel");
const prevPageBtn = $("#prevPageBtn");
const nextPageBtn = $("#nextPageBtn");
const driveLoopBtn = $("#driveLoopBtn");
const driveLoopState = $("#driveLoopState");
const stopAllBtn = $("#stopAllBtn");
const manageBtn = $("#manageBtn");
const backDriveBtn = $("#backDriveBtn");
const wakeBtn = $("#wakeBtn");

const addSoundBtn = $("#addSoundBtn");
const fileInput = $("#fileInput");
const manageList = $("#manageList");
const manageEmpty = $("#manageEmpty");

const editorDialog = $("#editorDialog");
const editorQueueLabel = $("#editorQueueLabel");
const editorTitle = $("#editorTitle");
const closeEditorBtn = $("#closeEditorBtn");
const cancelEditorBtn = $("#cancelEditorBtn");
const soundName = $("#soundName");
const waveCanvas = $("#waveCanvas");
const waveFallback = $("#waveFallback");
const trimStart = $("#trimStart");
const trimEnd = $("#trimEnd");
const trimStartLabel = $("#trimStartLabel");
const trimEndLabel = $("#trimEndLabel");
const previewBtn = $("#previewBtn");
const loopBtn = $("#loopBtn");
const deleteBtn = $("#deleteBtn");
const saveSoundBtn = $("#saveSoundBtn");
const formatNote = $("#formatNote");
const toastEl = $("#toast");
const versionLabel = $("#versionLabel");
const soundLoudnessValue = $("#soundLoudnessValue");
const loudnessChoices = [...document.querySelectorAll(".loudness-choice")];

let db;
let sounds = [];
let currentPage = 0;
let currentPlayback = null;
let previewPlayback = null;
let importQueue = [];
let importIndex = 0;
let editorState = null;
let wakeLock = null;
let wakeWanted = false;
let audioContext = null;
let masterGain = null;
let limiter = null;


function dbToGain(db) {
  return Math.pow(10, db / 20);
}

const LOUDNESS_PRESETS = {
  normal: {
    label: "NORMAL",
    threshold: -1,
    knee: 0,
    ratio: 1,
    attack: 0.003,
    release: 0.12,
    makeupDb: 0
  },
  boost: {
    label: "BOOST",
    threshold: -18,
    knee: 12,
    ratio: 3,
    attack: 0.004,
    release: 0.14,
    makeupDb: 4
  },
  loud: {
    label: "LOUD",
    threshold: -24,
    knee: 10,
    ratio: 5,
    attack: 0.003,
    release: 0.16,
    makeupDb: 8
  },
  jeger: {
    label: "JEGER",
    threshold: -30,
    knee: 6,
    ratio: 10,
    attack: 0.002,
    release: 0.18,
    makeupDb: 12
  }
};

function normalizeLoudnessMode(mode, legacyGainDb = 0) {
  if (mode && LOUDNESS_PRESETS[mode]) return mode;

  // Non-destructive migration from alpha.7.1 dB presets.
  const db = Number(legacyGainDb) || 0;
  if (db >= 9) return "jeger";
  if (db >= 6) return "loud";
  if (db >= 3) return "boost";
  return "normal";
}

function createLoudnessChain(mode) {
  const selected = normalizeLoudnessMode(mode);
  const preset = LOUDNESS_PRESETS[selected];

  const compressor = audioContext.createDynamicsCompressor();
  compressor.threshold.value = preset.threshold;
  compressor.knee.value = preset.knee;
  compressor.ratio.value = preset.ratio;
  compressor.attack.value = preset.attack;
  compressor.release.value = preset.release;

  const makeupGain = audioContext.createGain();
  makeupGain.gain.value = dbToGain(preset.makeupDb);

  compressor.connect(makeupGain);
  makeupGain.connect(masterGain);

  return { mode: selected, compressor, makeupGain };
}

function updateLoudnessChain(chain, mode) {
  if (!chain || !audioContext) return;
  const selected = normalizeLoudnessMode(mode);
  const preset = LOUDNESS_PRESETS[selected];
  const now = audioContext.currentTime;

  try {
    chain.compressor.threshold.setTargetAtTime(preset.threshold, now, 0.015);
    chain.compressor.knee.setTargetAtTime(preset.knee, now, 0.015);
    chain.compressor.ratio.setTargetAtTime(preset.ratio, now, 0.015);
    chain.compressor.attack.setTargetAtTime(preset.attack, now, 0.015);
    chain.compressor.release.setTargetAtTime(preset.release, now, 0.015);
    chain.makeupGain.gain.setTargetAtTime(dbToGain(preset.makeupDb), now, 0.015);
    chain.mode = selected;
  } catch {}
}

async function ensureAudioEngine() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;

  if (!audioContext) {
    audioContext = new AC();
    masterGain = audioContext.createGain();
    masterGain.gain.value = 1;

    limiter = audioContext.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.08;

    masterGain.connect(limiter);
    limiter.connect(audioContext.destination);
  }

  if (audioContext.state === "suspended") {
    try { await audioContext.resume(); } catch {}
  }

  return audioContext.state === "running";
}

async function decodeBlobFresh(blob) {
  if (!(await ensureAudioEngine())) throw new Error("Web Audio unavailable");
  const ab = await blob.arrayBuffer();
  return await audioContext.decodeAudioData(ab.slice(0));
}

function stopBufferPlayback(pb) {
  if (!pb?.source) return;
  try { pb.source.onended = null; } catch {}
  try { pb.source.stop(); } catch {}
  try { pb.source.disconnect(); } catch {}
  try { pb.gainNode?.disconnect(); } catch {}
  try { pb.compressor?.disconnect(); } catch {}
  try { pb.makeupGain?.disconnect(); } catch {}
}

/* =========================
   IndexedDB
   ========================= */

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getAllSounds() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function getAllSoundIds() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).getAllKeys();
    request.onsuccess = () => resolve((request.result || []).map(String));
    request.onerror = () => reject(request.error);
  });
}

function getSoundRecord(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

function putSound(sound) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(sound);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function deleteSound(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}


/* =========================
   Helpers
   ========================= */

function readMetaMap() {
  try {
    const parsed = JSON.parse(localStorage.getItem(META_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeMetaMap(map) {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(map));
  } catch (error) {
    console.warn("Could not persist sound metadata:", error);
  }
}

function metadataFromRecord(record) {
  return {
    id: String(record.id),
    name: record.name || record.fileName || "Untitled Sound",
    fileName: record.fileName || "",
    mime: record.mime || record.blob?.type || "",
    duration: Number(record.duration) || 0,
    trimStart: Number.isFinite(record.trimStart) ? record.trimStart : 0,
    trimEnd: Number.isFinite(record.trimEnd) ? record.trimEnd : (Number(record.duration) || 0),
    loop: !!record.loop,
    soundGainDb: Number.isFinite(record.soundGainDb) ? record.soundGainDb : 0,
    soundLoudnessMode: normalizeLoudnessMode(record.soundLoudnessMode, record.soundGainDb),
    createdAt: Number(record.createdAt) || Date.now()
  };
}

function replaceSoundMeta(meta) {
  const map = readMetaMap();
  map[meta.id] = meta;
  writeMetaMap(map);

  const index = sounds.findIndex((sound) => sound.id === meta.id);
  if (index >= 0) sounds[index] = meta;
  else sounds.push(meta);
}

function removeSoundMeta(id) {
  const map = readMetaMap();
  delete map[id];
  writeMetaMap(map);
  sounds = sounds.filter((sound) => sound.id !== id);
}

async function loadMetadataOnly() {
  const ids = await getAllSoundIds();
  const known = new Set(ids);
  const map = readMetaMap();
  let changed = false;

  // Remove orphaned metadata.
  for (const id of Object.keys(map)) {
    if (!known.has(id)) {
      delete map[id];
      changed = true;
    }
  }

  // One-time migration for sounds created by previous alpha builds.
  // Reads each legacy record only if metadata has not yet been separated.
  for (const id of ids) {
    if (!map[id]) {
      const record = await getSoundRecord(id);
      if (record) {
        map[id] = metadataFromRecord(record);
        changed = true;
      }
    }
  }

  if (changed) writeMetaMap(map);

  return ids
    .map((id) => map[id])
    .filter(Boolean);
}

function readOrderIds() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ORDER_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeOrderIds(ids) {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
  } catch (error) {
    console.warn("Could not persist lightweight sound order:", error);
  }
}

function legacySortedSounds() {
  return [...sounds].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

function reconcileOrderIds() {
  const knownIds = new Set(sounds.map((sound) => sound.id));
  let ids = readOrderIds().filter((id) => knownIds.has(id));

  const already = new Set(ids);
  for (const sound of legacySortedSounds()) {
    if (!already.has(sound.id)) {
      ids.push(sound.id);
      already.add(sound.id);
    }
  }

  writeOrderIds(ids);
  return ids;
}

function orderedSounds() {
  const ids = reconcileOrderIds();
  const byId = new Map(sounds.map((sound) => [sound.id, sound]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function pageCount() {
  return Math.max(1, Math.ceil(sounds.length / PAGE_SIZE));
}

function clampCurrentPage() {
  currentPage = Math.max(0, Math.min(currentPage, pageCount() - 1));
}

function formatTime(sec) {
  if (!Number.isFinite(sec)) return "0:00.0";
  sec = Math.max(0, sec);
  const min = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, "0");
  return `${min}:${s}`;
}

function clipDuration(sound) {
  return Math.max(0, (sound.trimEnd ?? sound.duration) - (sound.trimStart ?? 0));
}

function extOf(name = "") {
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "";
}

function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toastEl.classList.remove("show"), 2200);
}

function makeMedia(blob, fileName = "") {
  const ext = extOf(fileName);
  const useVideo = blob.type.startsWith("video/") || ext === "mp4";
  const media = document.createElement(useVideo ? "video" : "audio");

  media.preload = "metadata";
  media.playsInline = true;
  media.setAttribute("playsinline", "");
  media.style.position = "fixed";
  media.style.width = "1px";
  media.style.height = "1px";
  media.style.opacity = "0";
  media.style.pointerEvents = "none";

  media.src = URL.createObjectURL(blob);
  document.body.appendChild(media);
  return media;
}

function disposeMedia(media) {
  if (!media) return;
  try { media.pause(); } catch {}
  try { URL.revokeObjectURL(media.src); } catch {}
  media.remove();
}

function waitForMetadata(media) {
  return new Promise((resolve, reject) => {
    if (Number.isFinite(media.duration) && media.duration > 0) {
      resolve(media.duration);
      return;
    }

    const onLoaded = () => {
      cleanup();
      if (Number.isFinite(media.duration) && media.duration > 0) resolve(media.duration);
      else reject(new Error("No valid duration."));
    };

    const onError = () => {
      cleanup();
      reject(new Error("Unsupported or unreadable media."));
    };

    const cleanup = () => {
      media.removeEventListener("loadedmetadata", onLoaded);
      media.removeEventListener("error", onError);
    };

    media.addEventListener("loadedmetadata", onLoaded, { once: true });
    media.addEventListener("error", onError, { once: true });
    media.load();
  });
}

/* =========================
   Drive mode rendering
   ========================= */

function renderDrive() {
  clampCurrentPage();

  const ordered = orderedSounds();
  const totalPages = pageCount();
  const start = currentPage * PAGE_SIZE;
  const pageSounds = ordered.slice(start, start + PAGE_SIZE);

  soundGrid.innerHTML = "";
  emptyDrive.hidden = sounds.length > 0;

  soundCount.textContent = `${sounds.length} sound${sounds.length === 1 ? "" : "s"}`;
  pageLabel.textContent = `PAGE ${currentPage + 1} / ${totalPages}`;

  prevPageBtn.disabled = currentPage === 0;
  nextPageBtn.disabled = currentPage >= totalPages - 1;

  const hasCurrent = !!currentPlayback;
  driveLoopBtn.disabled = !hasCurrent;
  driveLoopBtn.classList.toggle("on", !!currentPlayback?.loop);
  driveLoopBtn.setAttribute("aria-pressed", String(!!currentPlayback?.loop));
  driveLoopState.textContent = hasCurrent ? (currentPlayback.loop ? "ON" : "OFF") : "—";

  for (const sound of pageSounds) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sound-pad";

    if (currentPlayback?.id === sound.id) btn.classList.add("playing");

    const name = document.createElement("span");
    name.className = "pad-name";
    name.textContent = sound.name;

    const meta = document.createElement("span");
    meta.className = "pad-meta";

    const duration = document.createElement("span");
    duration.textContent = formatTime(clipDuration(sound));

    const loop = document.createElement("span");
    loop.textContent = sound.loop ? "🔁" : "";

    const state = document.createElement("span");
    state.className = "pad-state";
    state.textContent = currentPlayback?.id === sound.id ? "■ STOP" : "▶ PLAY";

    meta.append(duration, loop, state);
    btn.append(name, meta);

    btn.addEventListener("click", () => playSound(sound));
    soundGrid.appendChild(btn);
  }
}

/* =========================
   Manage mode rendering
   ========================= */

function renderManage() {
  const ordered = orderedSounds();
  manageList.innerHTML = "";
  manageEmpty.hidden = ordered.length > 0;

  ordered.forEach((sound, index) => {
    const page = Math.floor(index / PAGE_SIZE) + 1;

    const item = document.createElement("div");
    item.className = "manage-item";

    const info = document.createElement("div");
    info.className = "manage-info";

    const name = document.createElement("span");
    name.className = "manage-name";
    name.textContent = sound.name;

    const meta = document.createElement("div");
    meta.className = "manage-meta";
    const loudnessMode = normalizeLoudnessMode(sound.soundLoudnessMode, sound.soundGainDb);
    const loudnessLabel = loudnessMode !== "normal"
      ? ` • ${LOUDNESS_PRESETS[loudnessMode].label}`
      : "";
    meta.textContent = `Page ${page} • ${formatTime(clipDuration(sound))}${sound.loop ? " • Loop ON" : ""}${loudnessLabel}`;

    info.append(name, meta);

    const controls = document.createElement("div");
    controls.className = "manage-controls";

    const up = document.createElement("button");
    up.type = "button";
    up.textContent = "↑";
    up.title = "Move up";
    up.disabled = index === 0;
    up.addEventListener("click", () => moveSound(sound.id, -1));

    const down = document.createElement("button");
    down.type = "button";
    down.textContent = "↓";
    down.title = "Move down";
    down.disabled = index === ordered.length - 1;
    down.addEventListener("click", () => moveSound(sound.id, 1));

    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "✎";
    edit.title = "Edit sound";
    edit.addEventListener("click", () => openExistingEditor(sound));

    controls.append(up, down, edit);
    item.append(info, controls);
    manageList.appendChild(item);
  });
}

function moveSound(soundId, direction) {
  const ordered = orderedSounds();
  const ids = ordered.map((sound) => sound.id);
  const index = ids.indexOf(soundId);
  const target = index + direction;

  if (index < 0 || target < 0 || target >= ids.length) return;

  [ids[index], ids[target]] = [ids[target], ids[index]];

  // Reorder is metadata-only and synchronous. Zero Blob/IndexedDB writes.
  writeOrderIds(ids);

  renderManage();
  renderDrive();
  showToast(direction < 0 ? "Moved up." : "Moved down.");
}

/* =========================
   Playback
   ========================= */

function stopCurrent() {
  if (!currentPlayback) return;
  if (currentPlayback.engine === "buffer") stopBufferPlayback(currentPlayback);
  else {
    currentPlayback.cleanup?.();
    disposeMedia(currentPlayback.media);
  }
  currentPlayback = null;
  renderDrive();
}

function stopPreview() {
  if (!previewPlayback) return;

  if (previewPlayback.engine === "buffer") {
    stopBufferPlayback(previewPlayback);
  } else {
    previewPlayback.cleanup?.();
    disposeMedia(previewPlayback.media);
  }

  previewPlayback = null;
  previewBtn.textContent = "▶ PREVIEW";
}

function installTrimGuard(media, start, end, shouldLoop, onFinish) {
  const loopEnabled = () =>
    typeof shouldLoop === "function" ? !!shouldLoop() : !!shouldLoop;

  const guard = () => {
    if (!media || media.paused) return;

    if (media.currentTime >= end - 0.025) {
      if (loopEnabled()) {
        media.currentTime = start;
        media.play().catch(() => {});
      } else {
        media.pause();
        onFinish?.();
      }
    }
  };

  media.addEventListener("timeupdate", guard);
  const timer = setInterval(guard, 35);

  return () => {
    clearInterval(timer);
    media.removeEventListener("timeupdate", guard);
  };
}

function setMediaSession(sound) {
  if (!("mediaSession" in navigator)) return;

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: sound.name,
      artist: "OMO X Soundboard",
      album: `v${APP_VERSION}`
    });

    navigator.mediaSession.setActionHandler("stop", stopCurrent);
    navigator.mediaSession.setActionHandler("pause", stopCurrent);
    navigator.mediaSession.setActionHandler("play", async () => {
      if (!currentPlayback) await playSound(sound);
      else if (currentPlayback.engine === "media") await currentPlayback.media?.play();
    });
  } catch {}
}

async function playSound(sound) {
  if (currentPlayback?.id === sound.id) { stopCurrent(); return; }
  stopCurrent(); stopPreview();

  let record;
  try { record = await getSoundRecord(sound.id); }
  catch (e) { console.error(e); showToast("Could not read this sound."); return; }

  const blob = record?.blob;
  if (!blob || typeof blob.size !== "number") { showToast("Audio data is missing."); return; }

  const start = Math.max(0, sound.trimStart ?? 0);
  const end = Math.max(start + 0.01, sound.trimEnd ?? sound.duration);

  try {
    const buffer = await decodeBlobFresh(blob);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;

    const loudnessMode = normalizeLoudnessMode(sound.soundLoudnessMode, sound.soundGainDb);
    const loudnessChain = createLoudnessChain(loudnessMode);
    source.connect(loudnessChain.compressor);

    source.loop = !!sound.loop;
    source.loopStart = Math.min(start, buffer.duration);
    source.loopEnd = Math.min(end, buffer.duration);

    currentPlayback = {
      id: sound.id,
      engine: "buffer",
      source,
      compressor: loudnessChain.compressor,
      makeupGain: loudnessChain.makeupGain,
      loudnessMode,
      loop: !!sound.loop,
      buffer,
      start,
      end
    };

    source.onended = () => {
      if (!currentPlayback || currentPlayback.source !== source) return;
      currentPlayback = null; renderDrive();
    };

    if (source.loop) source.start(0, source.loopStart);
    else source.start(0, start, Math.max(0.01, Math.min(end, buffer.duration) - start));

    setMediaSession(sound); renderDrive(); return;
  } catch (e) {
    console.warn("WebAudio fallback:", e);
  }

  const media = makeMedia(blob, sound.fileName);
  currentPlayback = { id:sound.id, engine:"media", media, cleanup:null, loop:!!sound.loop };

  const finish = () => {
    if (!currentPlayback || currentPlayback.media !== media) return;
    currentPlayback.cleanup?.(); disposeMedia(media); currentPlayback=null; renderDrive();
  };

  const restart = async () => {
    if (!currentPlayback?.loop || currentPlayback.media !== media) { finish(); return; }
    try { media.currentTime = start; await media.play(); }
    catch {
      media.addEventListener("canplay", async () => {
        if (!currentPlayback?.loop || currentPlayback.media !== media) return;
        try { media.currentTime=start; await media.play(); } catch { finish(); }
      }, {once:true});
      media.load();
    }
  };

  currentPlayback.cleanup = installTrimGuard(
    media, start, end,
    () => !!currentPlayback && currentPlayback.media===media && currentPlayback.loop,
    () => currentPlayback?.loop ? restart() : finish()
  );
  media.addEventListener("ended", () => currentPlayback?.loop ? restart() : finish());

  try { media.currentTime=start; await media.play(); setMediaSession(sound); renderDrive(); }
  catch { showToast("Could not start playback."); finish(); }
}

async function toggleDriveLoop() {
  if (!currentPlayback) { showToast("Play a sound first."); return; }
  const sound = sounds.find(x => x.id === currentPlayback.id);
  if (!sound) return;

  const next = !currentPlayback.loop;
  sound.loop = next;
  replaceSoundMeta({...sound});

  if (currentPlayback.engine === "buffer") {
    const {id, buffer, start, end} = currentPlayback;
    stopBufferPlayback(currentPlayback);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;

    const loudnessMode = normalizeLoudnessMode(sound.soundLoudnessMode, sound.soundGainDb);
    const loudnessChain = createLoudnessChain(loudnessMode);
    source.connect(loudnessChain.compressor);

    source.loop = next;
    source.loopStart = Math.min(start, buffer.duration);
    source.loopEnd = Math.min(end, buffer.duration);
    currentPlayback = {
      id,
      engine: "buffer",
      source,
      compressor: loudnessChain.compressor,
      makeupGain: loudnessChain.makeupGain,
      loudnessMode,
      loop: next,
      buffer,
      start,
      end
    };
    source.onended = () => {
      if (!currentPlayback || currentPlayback.source !== source) return;
      currentPlayback=null; renderDrive();
    };
    if (next) source.start(0, start);
    else source.start(0, start, Math.max(0.01, Math.min(end, buffer.duration)-start));
  } else {
    currentPlayback.loop = next;
  }

  renderDrive(); renderManage();
  showToast(next ? "Loop ON." : "Loop OFF.");
}


function setSoundLoudnessUi(mode) {
  if (!editorState) return;

  const selected = normalizeLoudnessMode(mode, editorState.soundGainDb);
  editorState.soundLoudnessMode = selected;

  if (soundLoudnessValue) {
    soundLoudnessValue.textContent = LOUDNESS_PRESETS[selected].label;
  }

  loudnessChoices.forEach((btn) => {
    const active = btn.dataset.loudness === selected;
    btn.classList.toggle("selected", active);
    btn.setAttribute("aria-pressed", String(active));
  });

  // Live preview update without restarting the clip.
  if (previewPlayback?.compressor && previewPlayback?.makeupGain) {
    updateLoudnessChain(previewPlayback, selected);
  }
}

/* =========================
   Waveform + editor
   ========================= */

async function decodeForWaveform(blob) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("Web Audio unavailable.");

  const ctx = new AudioContextClass();
  try {
    const data = await blob.arrayBuffer();
    return await ctx.decodeAudioData(data.slice(0));
  } finally {
    ctx.close().catch(() => {});
  }
}

function sizeCanvas() {
  const rect = waveCanvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  waveCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
  waveCanvas.height = Math.max(1, Math.floor(rect.height * dpr));
}

function drawBlankWave() {
  sizeCanvas();
  const ctx = waveCanvas.getContext("2d");
  ctx.clearRect(0, 0, waveCanvas.width, waveCanvas.height);
  ctx.fillStyle = "rgba(255,255,255,.055)";
  ctx.fillRect(0, 0, waveCanvas.width, waveCanvas.height);
}

function drawWaveform(audioBuffer) {
  sizeCanvas();

  const ctx = waveCanvas.getContext("2d");
  const w = waveCanvas.width;
  const h = waveCanvas.height;
  const mid = h / 2;
  const data = audioBuffer.getChannelData(0);
  const bars = Math.max(70, Math.floor(w / 10));
  const block = Math.max(1, Math.floor(data.length / bars));

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(255,255,255,.055)";
  ctx.fillRect(0, 0, w, h);

  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#9cff70";
  ctx.fillStyle = accent;

  for (let i = 0; i < bars; i++) {
    let peak = 0;
    const from = i * block;
    const to = Math.min(data.length, from + block);

    for (let j = from; j < to; j++) {
      const v = Math.abs(data[j]);
      if (v > peak) peak = v;
    }

    const barW = Math.max(1, (w / bars) * .58);
    const x = (i / bars) * w;
    const barH = Math.max(2, peak * h * .9);

    ctx.fillRect(x, mid - barH / 2, barW, barH);
  }

  drawTrimOverlay();
}

function drawTrimOverlay() {
  if (!editorState?.duration) return;

  const ctx = waveCanvas.getContext("2d");
  const w = waveCanvas.width;
  const h = waveCanvas.height;

  const startFrac = Number(trimStart.value) / editorState.duration;
  const endFrac = Number(trimEnd.value) / editorState.duration;

  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,.58)";
  ctx.fillRect(0, 0, w * startFrac, h);
  ctx.fillRect(w * endFrac, 0, w * (1 - endFrac), h);
  ctx.restore();
}

async function showWaveform(blob) {
  waveFallback.hidden = true;
  drawBlankWave();

  try {
    const decoded = await decodeForWaveform(blob);
    editorState.waveBuffer = decoded;
    drawWaveform(decoded);
  } catch {
    editorState.waveBuffer = null;
    drawBlankWave();
    waveFallback.hidden = false;
  }
}

function syncTrimUi() {
  if (!editorState) return;

  let start = Number(trimStart.value);
  let end = Number(trimEnd.value);

  if (start > end - 0.05) {
    if (document.activeElement === trimStart) {
      start = Math.max(0, end - 0.05);
      trimStart.value = start;
    } else {
      end = Math.min(editorState.duration, start + 0.05);
      trimEnd.value = end;
    }
  }

  trimStartLabel.textContent = formatTime(start);
  trimEndLabel.textContent = formatTime(end);

  if (editorState.waveBuffer) drawWaveform(editorState.waveBuffer);
  else drawTrimOverlay();
}

function setLoopUi(value) {
  editorState.loop = !!value;
  loopBtn.classList.toggle("on", editorState.loop);
  loopBtn.setAttribute("aria-pressed", String(editorState.loop));
  loopBtn.textContent = editorState.loop ? "🔁 LOOP ON" : "🔁 LOOP OFF";
}

async function prepareEditorFromFile(file, queueLabel) {
  stopPreview();

  const media = makeMedia(file, file.name);
  let duration;

  try {
    duration = await waitForMetadata(media);
  } finally {
    disposeMedia(media);
  }

  editorState = {
    mode: "import",
    blob: file,
    fileName: file.name,
    mime: file.type || "",
    duration,
    loop: false,
    soundGainDb: 0,
    soundLoudnessMode: "normal",
    waveBuffer: null
  };

  editorQueueLabel.textContent = queueLabel;
  editorTitle.textContent = "Trim & Preview";

  soundName.value = file.name.replace(/\.[^.]+$/, "") || "New Sound";

  trimStart.min = 0;
  trimStart.max = duration;
  trimStart.value = 0;

  trimEnd.min = 0;
  trimEnd.max = duration;
  trimEnd.value = duration;

  setLoopUi(false);
  setSoundLoudnessUi("normal");
  deleteBtn.hidden = true;

  formatNote.textContent =
    `${file.name} • ${file.type || "unknown MIME"} • source stays local on this device. MP4 plays audio-only; this alpha does not transcode it.`;

  syncTrimUi();
  editorDialog.showModal();
  await showWaveform(file);
}

async function openExistingEditor(sound) {
  stopPreview();

  let record;
  try {
    record = await getSoundRecord(sound.id);
  } catch (error) {
    console.error("Could not read sound for editor:", error);
    showToast("Could not read this sound from local storage.");
    return;
  }

  const blob = record?.blob;
  if (!blob || typeof blob.size !== "number") {
    showToast("Audio data is missing. Re-import this sound.");
    return;
  }

  editorState = {
    mode: "edit",
    id: sound.id,
    blob,
    fileName: sound.fileName,
    mime: sound.mime,
    duration: sound.duration,
    loop: !!sound.loop,
    soundGainDb: Number(sound.soundGainDb) || 0,
    soundLoudnessMode: normalizeLoudnessMode(sound.soundLoudnessMode, sound.soundGainDb),
    createdAt: sound.createdAt,
    waveBuffer: null
  };

  editorQueueLabel.textContent = "EDIT";
  editorTitle.textContent = "Sound Settings";
  soundName.value = sound.name;

  trimStart.min = 0;
  trimStart.max = sound.duration;
  trimStart.value = sound.trimStart ?? 0;

  trimEnd.min = 0;
  trimEnd.max = sound.duration;
  trimEnd.value = sound.trimEnd ?? sound.duration;

  setLoopUi(!!sound.loop);
  setSoundLoudnessUi(normalizeLoudnessMode(sound.soundLoudnessMode, sound.soundGainDb));
  deleteBtn.hidden = false;

  formatNote.textContent =
    `${sound.fileName} • ${sound.mime || "unknown MIME"} • audio is stored locally; edits are metadata-only.`;

  syncTrimUi();
  editorDialog.showModal();
  await showWaveform(blob);
}

async function previewEditor() {
  if (!editorState) return;

  if (previewPlayback) {
    stopPreview();
    return;
  }

  stopCurrent();

  const start = Number(trimStart.value);
  const end = Number(trimEnd.value);
  const duration = Math.max(0.01, end - start);
  const loudnessMode = normalizeLoudnessMode(editorState.soundLoudnessMode, editorState.soundGainDb);

  // Preferred preview path: same Web Audio compressor + makeup gain as Drive playback.
  try {
    const buffer = editorState.waveBuffer || await decodeBlobFresh(editorState.blob);
    await ensureAudioEngine();

    const source = audioContext.createBufferSource();
    source.buffer = buffer;

    const loudnessChain = createLoudnessChain(loudnessMode);
    source.connect(loudnessChain.compressor);

    source.loop = !!editorState.loop;
    source.loopStart = Math.min(start, buffer.duration);
    source.loopEnd = Math.min(end, buffer.duration);

    previewPlayback = {
      engine: "buffer",
      source,
      compressor: loudnessChain.compressor,
      makeupGain: loudnessChain.makeupGain,
      loudnessMode,
      buffer,
      loop: !!editorState.loop
    };

    source.onended = () => {
      if (!previewPlayback || previewPlayback.source !== source) return;
      previewPlayback = null;
      previewBtn.textContent = "▶ PREVIEW";
    };

    if (source.loop) source.start(0, source.loopStart);
    else source.start(0, start, Math.min(duration, Math.max(0.01, buffer.duration - start)));

    previewBtn.textContent = "■ STOP PREVIEW";
    return;
  } catch (error) {
    console.warn("Web Audio preview unavailable; using media fallback:", error);
  }

  // Fallback: basic media preview. Positive WebAudio gain may be unavailable for this codec/container.
  const media = makeMedia(editorState.blob, editorState.fileName);
  const shouldLoop = !!editorState.loop;
  previewPlayback = { engine: "media", media, cleanup: null, gainNode: null };

  const finish = () => {
    if (!previewPlayback || previewPlayback.media !== media) return;
    previewPlayback.cleanup?.();
    disposeMedia(media);
    previewPlayback = null;
    previewBtn.textContent = "▶ PREVIEW";
  };

  previewPlayback.cleanup = installTrimGuard(media, start, end, shouldLoop, finish);
  media.addEventListener("ended", () => {
    if (shouldLoop) {
      media.currentTime = start;
      media.play().catch(finish);
    } else finish();
  });

  try {
    media.currentTime = start;
    await media.play();
    previewBtn.textContent = "■ STOP PREVIEW";
    if (loudnessMode !== "normal") {
      showToast("Loudness processing is unavailable for this fallback codec.");
    }
  } catch {
    showToast("Preview could not start.");
    finish();
  }
}

async function saveEditor() {
  if (!editorState) return;

  const name = soundName.value.trim() || "Untitled Sound";
  const start = Number(trimStart.value);
  const end = Number(trimEnd.value);

  if (!(end > start)) {
    showToast("Trim end must be after trim start.");
    return;
  }

  const now = Date.now();
  const isEdit = editorState.mode === "edit";
  const id = isEdit ? editorState.id : crypto.randomUUID();

  const meta = {
    id,
    name,
    fileName: editorState.fileName,
    mime: editorState.mime,
    duration: editorState.duration,
    trimStart: start,
    trimEnd: end,
    loop: !!editorState.loop,
    soundGainDb: Number(editorState.soundGainDb) || 0,
    soundLoudnessMode: normalizeLoudnessMode(editorState.soundLoudnessMode, editorState.soundGainDb),
    createdAt: editorState.createdAt ?? now
  };

  if (isEdit) {
    // Existing audio is immutable. Rename/trim/loop only touch local metadata.
    replaceSoundMeta(meta);
  } else {
    // Import writes the Blob exactly once.
    const record = {
      ...meta,
      blob: editorState.blob
    };

    await putSound(record);
    replaceSoundMeta(meta);

    // Append new sound to the lightweight order registry.
    const ids = readOrderIds().filter((existingId) => existingId !== id);
    ids.push(id);
    writeOrderIds(ids);
  }

  renderManage();
  renderDrive();

  stopPreview();
  editorDialog.close();

  if (!isEdit && importIndex < importQueue.length - 1) {
    importIndex += 1;
    await openImportAtIndex();
  } else {
    importQueue = [];
    importIndex = 0;
    editorState = null;
    showToast(isEdit ? "Changes saved." : "Saved locally.");
  }
}

async function removeCurrentEditorSound() {
  if (!editorState || editorState.mode !== "edit") return;

  const existing = sounds.find((sound) => sound.id === editorState.id);
  const ok = confirm(`Delete "${existing?.name || "this sound"}" from this device?`);
  if (!ok) return;

  if (currentPlayback?.id === editorState.id) stopCurrent();

  const deletedId = editorState.id;

  try {
    await deleteSound(deletedId);
  } catch (error) {
    console.error("Delete failed:", error);
    showToast("Could not delete this sound.");
    return;
  }

  removeSoundMeta(deletedId);
  writeOrderIds(readOrderIds().filter((id) => id !== deletedId));
  reconcileOrderIds();

  renderManage();
  renderDrive();

  stopPreview();
  editorDialog.close();
  editorState = null;

  showToast("Deleted.");
}

function cancelEditor() {
  stopPreview();
  editorDialog.close();

  if (editorState?.mode === "import") {
    importQueue = [];
    importIndex = 0;
  }

  editorState = null;
}

async function openImportAtIndex() {
  const file = importQueue[importIndex];
  const label = `IMPORT ${importIndex + 1} / ${importQueue.length}`;

  try {
    await prepareEditorFromFile(file, label);
  } catch {
    showToast(`${file.name}: unsupported or unreadable.`);

    if (importIndex < importQueue.length - 1) {
      importIndex += 1;
      await openImportAtIndex();
    } else {
      importQueue = [];
      importIndex = 0;
      editorState = null;
    }
  }
}

/* =========================
   Wake lock
   ========================= */

async function syncWakeLock() {
  if (!("wakeLock" in navigator)) {
    wakeBtn.classList.remove("active");
    return;
  }

  if (!wakeWanted) {
    if (wakeLock) {
      await wakeLock.release().catch(() => {});
      wakeLock = null;
    }
    wakeBtn.classList.remove("active");
    return;
  }

  if (document.visibilityState !== "visible") return;
  if (wakeLock) return;

  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeBtn.classList.add("active");

    wakeLock.addEventListener("release", () => {
      wakeLock = null;
      if (!wakeWanted) wakeBtn.classList.remove("active");
    });
  } catch {
    wakeBtn.classList.remove("active");
  }
}

async function toggleWake() {
  if (!("wakeLock" in navigator)) {
    showToast("Keep-awake is not available in this browser.");
    return;
  }

  wakeWanted = !wakeWanted;
  await syncWakeLock();
  showToast(wakeWanted ? "Keep-awake on." : "Keep-awake off.");
}

/* =========================
   View switching
   ========================= */

function showDrive() {
  manageView.hidden = true;
  driveView.hidden = false;
  document.documentElement.style.overflow = "hidden";
  document.body.style.overflow = "hidden";
  renderDrive();
}

function showManage() {
  stopCurrent();
  driveView.hidden = true;
  manageView.hidden = false;
  document.documentElement.style.overflow = "";
  document.body.style.overflow = "";
  renderManage();
}

/* =========================
   Events
   ========================= */

prevPageBtn.addEventListener("click", () => {
  if (currentPage > 0) {
    currentPage -= 1;
    renderDrive();
  }
});

nextPageBtn.addEventListener("click", () => {
  if (currentPage < pageCount() - 1) {
    currentPage += 1;
    renderDrive();
  }
});

driveLoopBtn.addEventListener("click", toggleDriveLoop);

stopAllBtn.addEventListener("click", () => {
  stopCurrent();
  stopPreview();
});

manageBtn.addEventListener("click", showManage);
backDriveBtn.addEventListener("click", showDrive);
wakeBtn.addEventListener("click", toggleWake);

addSoundBtn.addEventListener("click", () => {
  fileInput.value = "";
  fileInput.click();
});

fileInput.addEventListener("change", async () => {
  importQueue = [...fileInput.files];
  importIndex = 0;

  if (importQueue.length) await openImportAtIndex();
});

previewBtn.addEventListener("click", previewEditor);

loopBtn.addEventListener("click", () => {
  if (!editorState) return;
  setLoopUi(!editorState.loop);
});

loudnessChoices.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!editorState) return;
    setSoundLoudnessUi(btn.dataset.loudness);
  });
});

saveSoundBtn.addEventListener("click", saveEditor);
deleteBtn.addEventListener("click", removeCurrentEditorSound);
cancelEditorBtn.addEventListener("click", cancelEditor);
closeEditorBtn.addEventListener("click", cancelEditor);

trimStart.addEventListener("input", () => {
  stopPreview();
  syncTrimUi();
});

trimEnd.addEventListener("input", () => {
  stopPreview();
  syncTrimUi();
});

editorDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  cancelEditor();
});

window.addEventListener("resize", () => {
  if (editorState?.waveBuffer) drawWaveform(editorState.waveBuffer);
});

document.addEventListener("visibilitychange", syncWakeLock);

/* =========================
   Init
   ========================= */

async function init() {
  db = await openDb();

  /*
    v1.0 alpha.5:
    Keep audio Blobs immutable in IndexedDB.
    The in-memory sound list is metadata-only.
    Fresh Blob records are fetched only when playing or editing.
  */
  sounds = await loadMetadataOnly();
  reconcileOrderIds();
  if (versionLabel) versionLabel.textContent = `v${APP_VERSION.replace("1.0-", "1.0 ")}`;

  renderDrive();
  renderManage();
  showDrive();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }

  if (navigator.storage?.persist) {
    try { await navigator.storage.persist(); } catch {}
  }
}

init().catch((error) => {
  console.error(error);
  showToast("Local storage failed to initialize.");
});
