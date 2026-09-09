const APP_VERSION = "1.0-alpha.1";
const PAGE_SIZE = 6;

const DB_NAME = "omo-x-soundboard";
const DB_VERSION = 1;
const STORE = "sounds";

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

function orderedSounds() {
  return [...sounds].sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt));
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
    meta.textContent = `Page ${page} • ${formatTime(clipDuration(sound))}${sound.loop ? " • Loop ON" : ""}`;

    info.append(name, meta);

    const controls = document.createElement("div");
    controls.className = "manage-controls";

    const up = document.createElement("button");
    up.type = "button";
    up.textContent = "↑";
    up.title = "Move up";
    up.disabled = index === 0;
    up.addEventListener("click", () => moveSound(index, -1));

    const down = document.createElement("button");
    down.type = "button";
    down.textContent = "↓";
    down.title = "Move down";
    down.disabled = index === ordered.length - 1;
    down.addEventListener("click", () => moveSound(index, 1));

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

async function moveSound(index, direction) {
  const ordered = orderedSounds();
  const target = index + direction;
  if (target < 0 || target >= ordered.length) return;

  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];

  const stamp = Date.now();
  for (let i = 0; i < ordered.length; i++) {
    ordered[i].order = stamp + i;
    await putSound(ordered[i]);
  }

  sounds = await getAllSounds();
  renderManage();
  renderDrive();
}

/* =========================
   Playback
   ========================= */

function stopCurrent() {
  if (!currentPlayback) return;

  currentPlayback.cleanup?.();
  disposeMedia(currentPlayback.media);
  currentPlayback = null;

  renderDrive();
}

function stopPreview() {
  if (!previewPlayback) return;

  previewPlayback.cleanup?.();
  disposeMedia(previewPlayback.media);
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

    navigator.mediaSession.setActionHandler("play", async () => {
      if (currentPlayback?.media) await currentPlayback.media.play();
    });

    navigator.mediaSession.setActionHandler("pause", () => {
      currentPlayback?.media?.pause();
    });

    navigator.mediaSession.setActionHandler("stop", stopCurrent);
  } catch {}
}

async function playSound(sound) {
  if (currentPlayback?.id === sound.id) {
    stopCurrent();
    return;
  }

  stopCurrent();
  stopPreview();

  const media = makeMedia(sound.blob, sound.fileName);
  const start = sound.trimStart ?? 0;
  const end = sound.trimEnd ?? sound.duration;
  currentPlayback = {
    id: sound.id,
    media,
    cleanup: null,
    loop: !!sound.loop
  };

  const finish = () => {
    if (!currentPlayback || currentPlayback.media !== media) return;

    currentPlayback.cleanup?.();
    disposeMedia(media);
    currentPlayback = null;
    renderDrive();
  };

  currentPlayback.cleanup = installTrimGuard(
    media,
    start,
    end,
    () => !!currentPlayback && currentPlayback.media === media && currentPlayback.loop,
    finish
  );

  media.addEventListener("ended", () => {
    const shouldLoopNow =
      !!currentPlayback && currentPlayback.media === media && currentPlayback.loop;

    if (shouldLoopNow) {
      media.currentTime = start;
      media.play().catch(finish);
    } else {
      finish();
    }
  });

  media.addEventListener("error", () => {
    showToast("Playback failed — this codec may not be supported.");
    finish();
  }, { once: true });

  try {
    media.currentTime = start;
    await media.play();
    setMediaSession(sound);
    renderDrive();
  } catch {
    showToast("Could not start playback.");
    finish();
  }
}

async function toggleDriveLoop() {
  if (!currentPlayback) {
    showToast("Play a sound first.");
    return;
  }

  const sound = sounds.find((item) => item.id === currentPlayback.id);
  if (!sound) return;

  currentPlayback.loop = !currentPlayback.loop;
  sound.loop = currentPlayback.loop;

  try {
    await putSound(sound);
    sounds = await getAllSounds();
    renderDrive();
    renderManage();
    showToast(currentPlayback.loop ? "Loop ON." : "Loop OFF.");
  } catch {
    showToast("Could not save loop setting.");
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
  deleteBtn.hidden = true;

  formatNote.textContent =
    `${file.name} • ${file.type || "unknown MIME"} • source stays local on this device. MP4 plays audio-only; this alpha does not transcode it.`;

  syncTrimUi();
  editorDialog.showModal();
  await showWaveform(file);
}

async function openExistingEditor(sound) {
  stopPreview();

  editorState = {
    mode: "edit",
    id: sound.id,
    blob: sound.blob,
    fileName: sound.fileName,
    mime: sound.mime,
    duration: sound.duration,
    loop: !!sound.loop,
    createdAt: sound.createdAt,
    order: sound.order,
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
  deleteBtn.hidden = false;

  formatNote.textContent =
    `${sound.fileName} • ${sound.mime || "unknown MIME"} • stored locally in this PWA.`;

  syncTrimUi();
  editorDialog.showModal();
  await showWaveform(sound.blob);
}

async function previewEditor() {
  if (!editorState) return;

  if (previewPlayback) {
    stopPreview();
    return;
  }

  stopCurrent();

  const media = makeMedia(editorState.blob, editorState.fileName);
  const start = Number(trimStart.value);
  const end = Number(trimEnd.value);
  const shouldLoop = !!editorState.loop;

  previewPlayback = {
    media,
    cleanup: null
  };

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
    } else {
      finish();
    }
  });

  media.addEventListener("error", () => {
    showToast("Preview failed — unsupported codec/container.");
    finish();
  }, { once: true });

  try {
    media.currentTime = start;
    await media.play();
    previewBtn.textContent = "■ STOP PREVIEW";
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

  const record = {
    id: editorState.mode === "edit" ? editorState.id : crypto.randomUUID(),
    name,
    fileName: editorState.fileName,
    mime: editorState.mime,
    blob: editorState.blob,
    duration: editorState.duration,
    trimStart: start,
    trimEnd: end,
    loop: !!editorState.loop,
    createdAt: editorState.createdAt ?? now,
    order: editorState.order ?? now
  };

  await putSound(record);
  sounds = await getAllSounds();

  renderManage();
  renderDrive();

  stopPreview();
  editorDialog.close();

  const wasImport = editorState.mode === "import";

  if (wasImport && importIndex < importQueue.length - 1) {
    importIndex += 1;
    await openImportAtIndex();
  } else {
    importQueue = [];
    importIndex = 0;
    editorState = null;
    showToast("Saved locally.");
  }
}

async function removeCurrentEditorSound() {
  if (!editorState || editorState.mode !== "edit") return;

  const existing = sounds.find((sound) => sound.id === editorState.id);
  const ok = confirm(`Delete "${existing?.name || "this sound"}" from this device?`);
  if (!ok) return;

  if (currentPlayback?.id === editorState.id) stopCurrent();

  await deleteSound(editorState.id);
  sounds = await getAllSounds();

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
  sounds = await getAllSounds();

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
