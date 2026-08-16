const TARGET_DURATION_SECONDS = 12;
const LAUNCH_DELAY_SECONDS = 5 / (1.5 * 1.5);
const MAX_END_TRIM_SECONDS = 0.48;
const MIN_END_TRIM_SECONDS = 0.08;
const CIRCLE_CIRCUMFERENCE = 2 * Math.PI * 46;
const BASE_VIBRATION_PATTERN = [150, 70, 150, 70, 480, 150, 150, 70, 150, 70, 480, 380];

const connectionText = document.querySelector("#connectionText");
const capabilityText = document.querySelector("#capabilityText");
const statusText = document.querySelector("#statusText");
const callProgress = document.querySelector("#callProgress");
const progressCircle = document.querySelector("#progressCircle");
const armButton = document.querySelector("#armButton");
const logicButton = document.querySelector("#logicButton");
const buttonHint = document.querySelector("#buttonHint");
const targetList = document.querySelector("#targetList");
const targetRows = [...document.querySelectorAll(".target-row")];
const panel = document.querySelector(".panel");
const backgroundGlitch = document.querySelector("#backgroundGlitch");
const dokkaebiStage = document.querySelector("#dokkaebiStage");
const dokkaebiPulse = document.querySelector("#dokkaebiPulse");
const iconFramePrimary = document.querySelector("#iconFramePrimary");
const iconFrameAlert = document.querySelector("#iconFrameAlert");
const iconBase = [...document.querySelectorAll(".dokkaebi-icon--base")];
const iconCyan = [...document.querySelectorAll(".dokkaebi-icon--cyan")];
const iconRed = [...document.querySelectorAll(".dokkaebi-icon--red")];
const ringAudio = document.querySelector("#ringAudio");

function createClientId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

const clientId = createClientId();
const canVibrate = typeof navigator.vibrate === "function";
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const phoneUserAgent = /iPhone|iPod|Android.+Mobile|Windows Phone/i.test(navigator.userAgent);
const compactTouchScreen = navigator.maxTouchPoints > 0 && Math.min(screen.width, screen.height) < 700;
const compactViewport = window.matchMedia("(max-width: 43.75rem)").matches;
const canInitiateCall = !(phoneUserAgent || compactTouchScreen || compactViewport);
const seenEvents = new Set();

document.documentElement.dataset.audioState = "preparing";
document.documentElement.dataset.canInitiate = String(canInitiateCall);
document.documentElement.classList.toggle("is-receiver-only", !canInitiateCall);

let armed = false;
let arming = false;
let connected = false;
let sending = false;
let launching = false;
let alarmActive = false;
let audioPrepared = false;
let audioUnlocked = false;
let ringDuration = TARGET_DURATION_SECONDS;
let ringObjectUrl;
let callRole = "idle";
let visualOnlyStartedAt = 0;
let visualOnlyTimer;
let progressFrame;
let glitchTimeline;
let backgroundTimeline;
let pulseTween;
let iconSwapTimeline;
let launchTween;
let swipePointerId;
let swipeProgress = 0;
let swipeListTop = 0;
let swipeListHeight = 1;
let allTargetsSelected = false;

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function encodeRepeatedWav(audioBuffer, framesPerRepeat, repeatCount, overlayBuffer) {
  const channelCount = Math.min(2, audioBuffer.numberOfChannels);
  const totalFrames = framesPerRepeat * repeatCount;
  const bytesPerSample = 2;
  const dataLength = totalFrames * channelCount * bytesPerSample;
  const wav = new ArrayBuffer(44 + dataLength);
  const view = new DataView(wav);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, audioBuffer.sampleRate, true);
  view.setUint32(28, audioBuffer.sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLength, true);

  const channels = Array.from({ length: channelCount }, (_, index) => audioBuffer.getChannelData(index));
  const overlayChannels = Array.from(
    { length: Math.min(2, overlayBuffer.numberOfChannels) },
    (_, index) => overlayBuffer.getChannelData(index),
  );
  let offset = 44;

  for (let repeat = 0; repeat < repeatCount; repeat += 1) {
    for (let frame = 0; frame < framesPerRepeat; frame += 1) {
      for (let channel = 0; channel < channelCount; channel += 1) {
        const primarySample = channels[channel][frame] * 0.88;
        const overlayChannel = overlayChannels[channel % overlayChannels.length];
        const overlayFrame = (repeat * framesPerRepeat + frame) % overlayBuffer.length;
        const overlaySample = overlayChannel[overlayFrame] * 0.62;
        const sample = Math.max(-1, Math.min(1, primarySample + overlaySample));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += bytesPerSample;
      }
    }
  }

  return new Blob([wav], { type: "audio/wav" });
}

function findTrimmedFrameCount(audioBuffer) {
  const sampleRate = audioBuffer.sampleRate;
  const minimumFrame = Math.max(0, audioBuffer.length - Math.floor(sampleRate * MAX_END_TRIM_SECONDS));
  const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, index) => audioBuffer.getChannelData(index));
  const silenceThreshold = 0.0035;
  let lastAudibleFrame = audioBuffer.length - 1;

  search: for (let frame = audioBuffer.length - 1; frame >= minimumFrame; frame -= 1) {
    for (const channel of channels) {
      if (Math.abs(channel[frame]) >= silenceThreshold) {
        lastAudibleFrame = frame;
        break search;
      }
    }
  }

  const tailPadding = Math.floor(sampleRate * 0.035);
  const detectedFrameCount = Math.min(audioBuffer.length, lastAudibleFrame + tailPadding);
  const minimumTrimmedFrameCount = audioBuffer.length - Math.floor(sampleRate * MAX_END_TRIM_SECONDS);
  const maximumTrimmedFrameCount = audioBuffer.length - Math.floor(sampleRate * MIN_END_TRIM_SECONDS);
  return Math.max(minimumTrimmedFrameCount, Math.min(maximumTrimmedFrameCount, detectedFrameCount));
}

function waitForAudioMetadata() {
  if (ringAudio.readyState >= 1 && Number.isFinite(ringAudio.duration)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    ringAudio.addEventListener("loadedmetadata", resolve, { once: true });
    ringAudio.addEventListener("error", () => reject(new Error("Audio metadata failed to load")), { once: true });
  });
}

async function prepareContinuousRing() {
  armButton.disabled = true;

  try {
    const [response, overlayResponse] = await Promise.all([
      fetch("/assets/dokkaebi-ring.mp3", { cache: "no-store" }),
      fetch("/assets/dokkaebi-overlay.mp3", { cache: "no-store" }),
    ]);
    if (!response.ok) throw new Error(`Ring audio HTTP ${response.status}`);
    if (!overlayResponse.ok) throw new Error(`Overlay audio HTTP ${overlayResponse.status}`);

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Web Audio is unavailable");

    const audioContext = new AudioContextClass();
    const [sourceBuffer, overlayBuffer] = await Promise.all([
      audioContext.decodeAudioData(await response.arrayBuffer()),
      audioContext.decodeAudioData(await overlayResponse.arrayBuffer()),
    ]);
    const framesPerRepeat = findTrimmedFrameCount(sourceBuffer);
    const trimmedDuration = framesPerRepeat / sourceBuffer.sampleRate;
    const repeatCount = Math.max(1, Math.round(TARGET_DURATION_SECONDS / trimmedDuration));
    const continuousRing = encodeRepeatedWav(sourceBuffer, framesPerRepeat, repeatCount, overlayBuffer);

    while (arming) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    ringObjectUrl = URL.createObjectURL(continuousRing);
    ringAudio.src = ringObjectUrl;
    ringAudio.loop = false;
    ringAudio.load();
    await waitForAudioMetadata();
    await audioContext.close();

    ringDuration = Number.isFinite(ringAudio.duration) ? ringAudio.duration : trimmedDuration * repeatCount;
    ringAudio.dataset.sourceDuration = String(sourceBuffer.duration);
    ringAudio.dataset.trimmedDuration = String(trimmedDuration);
    ringAudio.dataset.repeatCount = String(repeatCount);
    ringAudio.dataset.ringDuration = String(ringDuration);
    ringAudio.dataset.overlayDuration = String(overlayBuffer.duration);
    audioPrepared = true;
    document.documentElement.dataset.audioState = armed ? "armed" : "ready";
    if (armed && alarmActive && callRole === "incoming" && ringAudio.paused) void armAndResumeIncoming();
  } catch (error) {
    console.warn("Continuous ring preparation failed; using the original clip", error);
    ringAudio.src = "/assets/dokkaebi-ring.mp3";
    ringAudio.loop = true;
    ringAudio.load();
    await waitForAudioMetadata();
    ringDuration = TARGET_DURATION_SECONDS;
    audioPrepared = true;
    document.documentElement.dataset.audioState = armed ? "armed" : "ready";
    if (armed && alarmActive && callRole === "incoming" && ringAudio.paused) void armAndResumeIncoming();
  } finally {
    armButton.disabled = false;
    setCapabilityMessage();
  }
}

function setConnection(state, label) {
  connected = state === "connected";
  panel.classList.toggle("is-connected", connected);
  panel.classList.toggle("is-disconnected", state === "disconnected");
  connectionText.textContent = label;
  syncButtonDisabled();
}

function setCapabilityMessage() {
  capabilityText.hidden = true;
  armButton.hidden = true;
  armButton.disabled = !audioPrepared;
}

function syncButtonDisabled() {
  logicButton.disabled = !canInitiateCall || !connected || sending || launching || callRole !== "idle" || !allTargetsSelected;
}

function setCallRole(role) {
  callRole = role;
  panel.classList.toggle("is-incoming", role === "incoming");
  panel.classList.toggle("is-outgoing", role === "sender");
  buttonHint.hidden = role !== "idle";
  if (role === "idle") {
    buttonHint.textContent = allTargetsSelected ? "AVAILABLE" : "LOCKED";
    setCapabilityMessage();
  } else {
    capabilityText.hidden = true;
    armButton.hidden = true;
  }
  syncButtonDisabled();
}

function rememberEvent(id) {
  seenEvents.add(id);
  if (seenEvents.size > 50) seenEvents.delete(seenEvents.values().next().value);
}

function setProgress(value) {
  const progress = Math.min(1, Math.max(0, value));
  window.gsap.set(progressCircle, { strokeDashoffset: CIRCLE_CIRCUMFERENCE * (1 - progress) });
  callProgress.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
}

function buildVibrationPattern(durationMs) {
  const pattern = [];
  let elapsed = 0;
  while (elapsed < durationMs) {
    for (const segment of BASE_VIBRATION_PATTERN) {
      if (elapsed >= durationMs) break;
      pattern.push(Math.min(segment, durationMs - elapsed));
      elapsed += segment;
    }
  }
  return pattern;
}

function startGlitch() {
  const iconLayers = [...iconBase, ...iconCyan, ...iconRed];
  window.gsap.killTweensOf([backgroundGlitch, dokkaebiStage, dokkaebiPulse, iconFramePrimary, iconFrameAlert, ...iconLayers]);
  window.gsap.set(dokkaebiStage, { autoAlpha: 1 });
  window.gsap.set(backgroundGlitch, { autoAlpha: 1, clipPath: "none" });
  window.gsap.set(iconFramePrimary, { autoAlpha: 1 });
  window.gsap.set(iconFrameAlert, { autoAlpha: 0 });

  pulseTween?.kill();
  pulseTween = window.gsap.fromTo(
    dokkaebiPulse,
    { scale: 0.965 },
    { scale: 1.045, duration: 0.92, ease: "sine.inOut", yoyo: true, repeat: -1 },
  );

  if (reduceMotion) {
    window.gsap.fromTo(dokkaebiStage, { opacity: 0 }, { opacity: 1, duration: 0.2 });
    window.gsap.set(backgroundGlitch, { opacity: 0.35 });
    return;
  }

  iconSwapTimeline?.kill();
  iconSwapTimeline = window.gsap.timeline({ repeat: -1 });
  iconSwapTimeline
    .to(iconFramePrimary, { autoAlpha: 0, duration: 0.045 }, 0.48)
    .to(iconFrameAlert, { autoAlpha: 1, duration: 0.045 }, 0.48)
    .to(iconFrameAlert, { autoAlpha: 0, duration: 0.045 }, 0.98)
    .to(iconFramePrimary, { autoAlpha: 1, duration: 0.045 }, 0.98);

  backgroundTimeline?.kill();
  backgroundTimeline = window.gsap.timeline({ repeat: -1, repeatDelay: 0.045 });
  backgroundTimeline
    .fromTo(backgroundGlitch, { opacity: 0.34, x: 0, y: 0, filter: "contrast(1.15) saturate(1.2)", backgroundPosition: "0 0, 0 0, 50% 35%, 0 0" }, { opacity: 0.78, duration: 0.1 })
    .to(backgroundGlitch, { x: -19, y: 5, filter: "contrast(2.35) saturate(2) hue-rotate(22deg)", backgroundPosition: "0 26px, -46px 0, 44% 39%, 26px 0", duration: 0.05 }, 0.16)
    .to(backgroundGlitch, { x: 16, y: -4, opacity: 0.46, filter: "contrast(2.7) saturate(1.55) hue-rotate(-18deg)", backgroundPosition: "0 -18px, 38px 0, 58% 29%, -24px 0", duration: 0.055 }, 0.23)
    .to(backgroundGlitch, { x: 0, y: 0, opacity: 0.64, filter: "contrast(1.5) saturate(1.55)", duration: 0.08 }, 0.32)
    .to(backgroundGlitch, { opacity: 0.9, x: 8, duration: 0.03, repeat: 5, yoyo: true }, 0.62)
    .to(backgroundGlitch, { opacity: 0.48, x: 0, y: 0, backgroundPosition: "0 12px, -18px 0, 50% 35%, 12px 0", duration: 0.09 }, 0.94);

  glitchTimeline?.kill();
  glitchTimeline = window.gsap.timeline({ repeat: -1, repeatDelay: 0.12 });
  glitchTimeline
    .fromTo(dokkaebiStage, { opacity: 0, filter: "brightness(2.2) contrast(1.7)" }, { opacity: 1, filter: "brightness(1) contrast(1)", duration: 0.18, ease: "steps(3)" })
    .set(iconCyan, { opacity: 0.72, x: -10, clipPath: "inset(8% 0 62% 0)" }, 0.06)
    .set(iconRed, { opacity: 0.72, x: 10, clipPath: "inset(54% 0 12% 0)" }, 0.06)
    .to(iconBase, { x: -4, duration: 0.045, repeat: 2, yoyo: true }, 0.06)
    .set([...iconCyan, ...iconRed], { opacity: 0, x: 0, clipPath: "inset(0 0 0 0)" }, 0.22)
    .to(dokkaebiStage, { x: 3, duration: 0.035, repeat: 5, yoyo: true, ease: "none" }, 0.42)
    .set(iconCyan, { opacity: 0.62, x: 7, clipPath: "inset(66% 0 8% 0)" }, 0.78)
    .set(iconRed, { opacity: 0.55, x: -7, clipPath: "inset(20% 0 56% 0)" }, 0.78)
    .to(iconBase, { filter: "brightness(1.8) contrast(1.8)", duration: 0.055, repeat: 1, yoyo: true }, 0.78)
    .set([...iconCyan, ...iconRed], { opacity: 0, x: 0, clipPath: "inset(0 0 0 0)" }, 0.96)
    .to(dokkaebiStage, { x: 0, duration: 0.01 }, 1.06);
}

function stopGlitch(immediate = false) {
  glitchTimeline?.kill();
  glitchTimeline = undefined;
  backgroundTimeline?.kill();
  backgroundTimeline = undefined;
  pulseTween?.kill();
  pulseTween = undefined;
  iconSwapTimeline?.kill();
  iconSwapTimeline = undefined;
  window.gsap.killTweensOf([backgroundGlitch, dokkaebiStage, dokkaebiPulse, iconFramePrimary, iconFrameAlert, ...iconBase, ...iconCyan, ...iconRed]);
  window.gsap.set([...iconCyan, ...iconRed], { opacity: 0, x: 0, clipPath: "inset(0 0 0 0)" });
  window.gsap.set(iconBase, { x: 0, filter: "none" });
  window.gsap.set(iconFramePrimary, { autoAlpha: 1 });
  window.gsap.set(iconFrameAlert, { autoAlpha: 0 });
  window.gsap.set(dokkaebiPulse, { scale: 1 });
  if (immediate) {
    window.gsap.set(backgroundGlitch, { autoAlpha: 0, x: 0, y: 0, clipPath: "none", filter: "none" });
    window.gsap.set(dokkaebiStage, { autoAlpha: 0, x: 0, filter: "none" });
  } else {
    window.gsap.to(backgroundGlitch, { autoAlpha: 0, x: 0, duration: 0.18 });
    window.gsap.to(dokkaebiStage, { autoAlpha: 0, x: 0, duration: 0.18 });
  }
}

function updateProgress() {
  if (!alarmActive) return;
  const elapsed = visualOnlyStartedAt
    ? (performance.now() - visualOnlyStartedAt) / 1000
    : ringAudio.currentTime || 0;
  setProgress(elapsed / ringDuration);
  progressFrame = requestAnimationFrame(updateProgress);
}

function setTargetSelection(progress) {
  const normalized = Math.min(1, Math.max(0, progress));
  const selectedCount = Math.ceil(normalized * targetRows.length);
  targetRows.forEach((row, index) => row.classList.toggle("is-selected", index < selectedCount));
  window.gsap.set(targetList, { "--swipe-progress": normalized });
  allTargetsSelected = selectedCount === targetRows.length;
  if (!launching && callRole === "idle") {
    buttonHint.textContent = allTargetsSelected ? "AVAILABLE" : "LOCKED";
  }
  syncButtonDisabled();
}

function endLaunchVisual({ keepTargets = false } = {}) {
  launchTween?.kill();
  launchTween = undefined;
  launching = false;
  panel.classList.remove("is-launching");
  targetRows.forEach((row) => row.classList.remove("is-scanning"));
  if (!keepTargets) setTargetSelection(0);
  buttonHint.textContent = allTargetsSelected ? "AVAILABLE" : "LOCKED";
  setProgress(0);
  syncButtonDisabled();
}

function startLaunchSequence() {
  if (!canInitiateCall || !allTargetsSelected || launching || callRole !== "idle" || logicButton.disabled) return;

  launching = true;
  panel.classList.add("is-launching");
  targetList.classList.remove("is-swiping");
  buttonHint.hidden = false;
  buttonHint.textContent = "HACKING 00%";
  setTargetSelection(1);
  syncButtonDisabled();

  const launchState = { progress: 0 };
  launchTween = window.gsap.to(launchState, {
    progress: 1,
    duration: LAUNCH_DELAY_SECONDS,
    ease: "none",
    onUpdate: () => {
      setProgress(launchState.progress);
      buttonHint.textContent = `HACKING ${String(Math.round(launchState.progress * 100)).padStart(2, "0")}%`;
      const activeRow = Math.min(targetRows.length - 1, Math.floor(launchState.progress * targetRows.length));
      targetRows.forEach((row, index) => row.classList.toggle("is-scanning", index === activeRow));
    },
    onComplete: async () => {
      targetRows.forEach((row) => row.classList.remove("is-scanning"));
      const sent = await sendSignal();
      if (!sent && callRole === "idle") endLaunchVisual();
    },
  });
}

function stopAlarm({ immediate = false, announceReset = false } = {}) {
  alarmActive = false;
  clearTimeout(visualOnlyTimer);
  cancelAnimationFrame(progressFrame);
  visualOnlyStartedAt = 0;
  ringAudio.pause();
  ringAudio.currentTime = 0;
  navigator.vibrate?.(0);
  panel.classList.remove("is-ringing");
  stopGlitch(immediate);
  endLaunchVisual();
  setProgress(0);
  setCallRole("idle");
  statusText.textContent = announceReset ? "Call dismissed." : "";
}

function finishAlarm() {
  if (!alarmActive) return;
  stopAlarm();
}

function startVisualOnly() {
  visualOnlyStartedAt = performance.now();
  visualOnlyTimer = setTimeout(finishAlarm, ringDuration * 1000);
}

async function startIncomingAudio() {
  try {
    ringAudio.loop = false;
    ringAudio.currentTime = 0;
    await ringAudio.play();
  } catch (error) {
    document.documentElement.dataset.audioError = `${error?.name || "Error"}: ${error?.message || String(error)}`;
    statusText.textContent = "The browser blocked audio. Enable sound for this page.";
    startVisualOnly();
  }
}

async function startAlarm(event) {
  if (!event?.id || seenEvents.has(event.id)) return;
  rememberEvent(event.id);

  const isSender = event.senderId === clientId;
  if (!isSender && canInitiateCall) return;

  if (alarmActive) stopAlarm({ immediate: true });
  if (launching) endLaunchVisual({ keepTargets: isSender });
  alarmActive = true;
  ringAudio.currentTime = 0;

  if (isSender) {
    panel.classList.remove("is-ringing");
    setProgress(0);
    setCallRole("sender");
    startVisualOnly();
    return;
  }

  panel.classList.add("is-ringing");
  setProgress(0);
  progressFrame = requestAnimationFrame(updateProgress);

  setCallRole("incoming");
  startGlitch();

  if (canVibrate && armed && document.visibilityState === "visible") {
    navigator.vibrate(buildVibrationPattern(ringDuration * 1000));
  }

  if (!armed || !audioUnlocked) {
    statusText.textContent = "Audio is not enabled.";
    startVisualOnly();
    return;
  }

  await startIncomingAudio();
}

async function unlockAudio() {
  const previousMuted = ringAudio.muted;
  ringAudio.muted = true;
  ringAudio.currentTime = 0;

  try {
    await ringAudio.play();
    audioUnlocked = true;
    document.documentElement.dataset.audioState = "armed";
    delete document.documentElement.dataset.audioError;
  } finally {
    ringAudio.pause();
    ringAudio.currentTime = 0;
    ringAudio.muted = previousMuted;
  }
}

async function armDevice({ silent = false } = {}) {
  if (armed || arming) return armed;
  arming = true;
  armButton.disabled = true;

  try {
    await unlockAudio();
    armed = true;
    if (canVibrate) navigator.vibrate(45);
    statusText.textContent = "";
    setCapabilityMessage();
    return true;
  } catch (error) {
    if (!silent) {
      statusText.textContent = "Unable to enable audio.";
    }
    document.documentElement.dataset.audioState = "waiting-for-gesture";
    document.documentElement.dataset.audioError = `${error?.name || "Error"}: ${error?.message || String(error)}`;
    return false;
  } finally {
    arming = false;
    armButton.disabled = false;
  }
}

async function sendSignal() {
  sending = true;
  syncButtonDisabled();

  try {
    const response = await fetch("/api/logic-bomb", {
      method: "POST",
      headers: { "X-Logic-Bomb-Client": clientId },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return true;
  } catch (error) {
    console.error(error);
    statusText.textContent = "Unable to send the signal.";
    return false;
  } finally {
    sending = false;
    syncButtonDisabled();
  }
}

function showTapHit(x, y) {
  const hit = document.createElement("span");
  hit.className = "tap-hit";
  hit.style.left = `${x}px`;
  hit.style.top = `${y}px`;
  document.body.append(hit);
  window.gsap.fromTo(
    hit,
    { autoAlpha: 0.95, scale: 0.25, xPercent: -50, yPercent: -50, rotation: -12 },
    { autoAlpha: 0, scale: 1.85, rotation: 14, duration: 0.38, ease: "power2.out", onComplete: () => hit.remove() },
  );
}

function registerImpactTap(event) {
  if (!alarmActive || callRole !== "incoming") return;

  showTapHit(event.clientX, event.clientY);
  navigator.vibrate?.(22);
}

async function armAndResumeIncoming() {
  const unlocked = armed || (await armDevice());
  if (!unlocked || !alarmActive || callRole !== "incoming" || !ringAudio.paused) {
    return;
  }

  clearTimeout(visualOnlyTimer);
  visualOnlyStartedAt = 0;
  ringAudio.currentTime = 0;
  if (canVibrate && document.visibilityState === "visible") {
    navigator.vibrate(buildVibrationPattern(ringDuration * 1000));
  }
  await startIncomingAudio();
}

function stopIncomingWhenHidden() {
  if (document.visibilityState === "hidden" && alarmActive && callRole === "incoming") {
    stopAlarm({ immediate: true });
  }
}

function beginSwipe(event) {
  if (!canInitiateCall || callRole !== "idle" || launching || sending) return;
  event.preventDefault();
  swipePointerId = event.pointerId;
  const bounds = targetList.getBoundingClientRect();
  swipeListTop = bounds.top;
  swipeListHeight = Math.max(1, bounds.height);
  swipeProgress = Math.min(1, Math.max(0, (event.clientY - swipeListTop) / swipeListHeight));
  targetList.classList.add("is-swiping");
  targetList.setPointerCapture?.(event.pointerId);
  setTargetSelection(swipeProgress);
}

function moveSwipe(event) {
  if (event.pointerId !== swipePointerId) return;
  event.preventDefault();
  swipeProgress = Math.min(1, Math.max(0, (event.clientY - swipeListTop) / swipeListHeight));
  setTargetSelection(swipeProgress);
}

function finishSwipe(event, cancelled = false) {
  if (event.pointerId !== swipePointerId) return;
  event.preventDefault();
  targetList.releasePointerCapture?.(event.pointerId);
  targetList.classList.remove("is-swiping");
  swipePointerId = undefined;
  if (cancelled) return;
  setTargetSelection(swipeProgress);
  if (!armed) void armDevice();
}

ringAudio.addEventListener("ended", finishAlarm);

function armFromFirstGesture() {
  if (!armed) void armAndResumeIncoming();
}

document.addEventListener("pointerdown", armFromFirstGesture, { capture: true, passive: true });
document.addEventListener("touchstart", armFromFirstGesture, { capture: true, passive: true });
document.addEventListener(
  "click",
  (event) => {
    registerImpactTap(event);
    armFromFirstGesture();
  },
  { capture: true },
);

targetList.addEventListener("pointerdown", beginSwipe);
targetList.addEventListener("pointermove", moveSwipe);
targetList.addEventListener("pointerup", (event) => finishSwipe(event));
targetList.addEventListener("pointercancel", (event) => finishSwipe(event, true));
targetList.addEventListener("keydown", (event) => {
  if (!canInitiateCall || callRole !== "idle" || launching || sending) return;
  const selectedCount = targetRows.filter((row) => row.classList.contains("is-selected")).length;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    setTargetSelection(Math.min(1, (selectedCount + 1) / targetRows.length));
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    setTargetSelection(Math.max(0, (selectedCount - 1) / targetRows.length));
  } else if (event.key === "End") {
    event.preventDefault();
    setTargetSelection(1);
  } else if (event.key === "Home") {
    event.preventDefault();
    setTargetSelection(0);
  }
});

logicButton.addEventListener("click", (event) => {
  event.preventDefault();
  if (!logicButton.disabled) startLaunchSequence();
});

logicButton.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && !event.repeat && !logicButton.disabled) {
    event.preventDefault();
    if (!armed) void armDevice();
    startLaunchSequence();
  }
});

document.addEventListener("visibilitychange", stopIncomingWhenHidden);
window.addEventListener("pagehide", () => {
  if (alarmActive && callRole === "incoming") stopAlarm({ immediate: true });
});

const events = new EventSource("/api/events");

events.addEventListener("ready", () => setConnection("connected", "Connected"));

events.addEventListener("logic-bomb", (message) => {
  try {
    void startAlarm(JSON.parse(message.data));
  } catch (error) {
    console.error("Invalid logic bomb event", error);
  }
});

events.onerror = () => setConnection("disconnected", "Reconnecting…");

window.addEventListener("beforeunload", () => {
  stopAlarm({ immediate: true });
  events.close();
  if (ringObjectUrl) URL.revokeObjectURL(ringObjectUrl);
});

setProgress(0);
setTargetSelection(0);
setCallRole("idle");
setCapabilityMessage();
setConnection("connecting", "Connecting…");
void prepareContinuousRing();

document.documentElement.dataset.serviceWorker = "unavailable";
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then(() => {
        document.documentElement.dataset.serviceWorker = "registered";
      })
      .catch((error) => {
        document.documentElement.dataset.serviceWorker = "failed";
        console.warn("Service worker registration failed", error);
      });
  });
}
