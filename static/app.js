/**
 * Voice Notes Reminder Agent - Frontend Engine
 * Powered by local faster-whisper backend transcription, Web Audio API,
 * WebSocket real-time alerts, and FastAPI REST endpoints.
 */

let currentState = 'ready';
let isListening = false;
let isMuted = false;
let currentFilter = 'ALL';
let timerInterval = null;
let elapsedSeconds = 0;
let currentDueReminderId = null;

// MediaRecorder and Web Audio API handles
let mediaRecorder = null;
let audioChunks = [];
let micStream = null;
let audioContext = null;
let analyserNode = null;
let dummyGainNode = null;
let animFrameId = null;
let isMonitoringVu = false;

// Audio context for hardware alert chimes
let chimeAudioCtx = null;

function getChimeContext() {
  if (!chimeAudioCtx) {
    chimeAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return chimeAudioCtx;
}

function playHardwareChime(frequency = 880, duration = 0.25) {
  if (isMuted) return;
  try {
    const ctx = getChimeContext();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(frequency * 1.5, ctx.currentTime + duration);
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch (err) {
    console.warn("Audio chime error:", err);
  }
}

// ---------------------------------------------------------------------------
// 1. Web Speech Synthesis (TTS)
// ---------------------------------------------------------------------------

function speakReply(text) {
  if (isMuted || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.0;
  utterance.pitch = 1.0;
  window.speechSynthesis.speak(utterance);
}

function toggleMute() {
  isMuted = !isMuted;
  const btn = document.getElementById('mute-btn');
  if (btn) {
    btn.innerHTML = isMuted
      ? '<span class="w-1.5 h-1.5 rounded-full bg-secondary inline-block"></span>MUTE: ON'
      : '<span class="w-1.5 h-1.5 rounded-full border border-primary inline-block"></span>MUTE: OFF';
  }
  if (isMuted && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
}

// ---------------------------------------------------------------------------
// 2. Local Whisper MediaRecorder Audio Capture & VU Meter
// ---------------------------------------------------------------------------

async function startAudioRecording() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
      }
    });

    // Real-time microphone audio level monitoring for hardware VU meter
    try {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (!audioContext || audioContext.state === 'closed') {
        audioContext = new AudioCtxClass();
      }
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
      const source = audioContext.createMediaStreamSource(micStream);
      analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 512;
      analyserNode.smoothingTimeConstant = 0.3;

      // Connect through a silent gain node to destination to ensure Chrome/WebKit pulls audio frames
      dummyGainNode = audioContext.createGain();
      dummyGainNode.gain.value = 0;
      source.connect(analyserNode);
      analyserNode.connect(dummyGainNode);
      dummyGainNode.connect(audioContext.destination);
    } catch (e) {
      console.warn("Could not initialize microphone analyser:", e);
    }

    // Determine supported mime type
    let mimeType = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      if (MediaRecorder.isTypeSupported('audio/webm')) {
        mimeType = 'audio/webm';
      } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
        mimeType = 'audio/mp4';
      } else if (MediaRecorder.isTypeSupported('audio/ogg')) {
        mimeType = 'audio/ogg';
      } else {
        mimeType = '';
      }
    }

    const options = mimeType ? { mimeType } : {};
    mediaRecorder = new MediaRecorder(micStream, options);
    audioChunks = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      stopLiveVuMonitoring();
      if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
        micStream = null;
      }
      if (audioChunks.length === 0) {
        setRecorderState('ready');
        return;
      }

      const recordedBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      await processRecordedAudio(recordedBlob);
    };

    mediaRecorder.start(200); // 200ms slice
    setRecorderState('listening');
    startLiveVuMonitoring();

  } catch (err) {
    console.error("Microphone access error:", err);
    setRecorderState('error');
    const transcriptEl = document.getElementById('transcript-content');
    if (transcriptEl) {
      transcriptEl.innerHTML = '<span class="text-error font-bold">Microphone permission denied. Please allow mic access.</span>';
    }
  }
}

function stopAudioRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

function startLiveVuMonitoring() {
  if (!analyserNode) return;
  isMonitoringVu = true;
  const bufferLength = analyserNode.fftSize;
  const samples = new Float32Array(bufferLength);

  function checkLevel() {
    if (!isMonitoringVu || !analyserNode) {
      return;
    }

    analyserNode.getFloatTimeDomainData(samples);

    // Compute Root-Mean-Square (RMS) amplitude
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) {
      sumSquares += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSquares / samples.length);

    // Decibels relative to Full Scale (dBFS), bounded between -60 dB and 0 dB
    const db = rms > 0.0001 ? Math.max(-60, Math.min(0, 20 * Math.log10(rms))) : -60;

    // Map decibels smoothly to 8 physical VU bars:
    // Silence/Room noise: <= -48 dB (0-1 bar)
    // Soft speech: -35 dB to -24 dB (2-4 bars)
    // Normal conversational voice: -22 dB to -14 dB (4-6 bars)
    // Loud / speaking close: -12 dB to -2 dB (7-8 bars)
    let barsCount = 0;
    if (db > -50) barsCount = 1;
    if (db > -42) barsCount = 2;
    if (db > -34) barsCount = 3;
    if (db > -26) barsCount = 4;
    if (db > -20) barsCount = 5;
    if (db > -14) barsCount = 6;
    if (db > -8)  barsCount = 7;
    if (db > -3)  barsCount = 8;

    const bars = document.querySelectorAll('#vu-meter .vu-bar');
    bars.forEach((b, i) => {
      if (i < barsCount) {
        b.className = (i > 5) ? 'vu-bar bg-secondary h-full' : 'vu-bar bg-primary h-full';
      } else {
        b.className = 'vu-bar bg-outline-variant h-full';
      }
    });



    animFrameId = requestAnimationFrame(checkLevel);
  }

  animFrameId = requestAnimationFrame(checkLevel);
}

function stopLiveVuMonitoring() {
  isMonitoringVu = false;
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  const bars = document.querySelectorAll('#vu-meter .vu-bar');
  bars.forEach((b) => {
    b.className = 'vu-bar bg-outline-variant h-full';
  });
  const dbEl = document.getElementById('vu-db-readout');
  if (dbEl) dbEl.textContent = '-60 dB';
}

// ---------------------------------------------------------------------------
// 3. Floating Voice Dock & UI State Management
// ---------------------------------------------------------------------------

let isDockOpen = false;
let dockCollapseTimer = null;

function expandDock() {
  const drawer = document.getElementById('voice-dock-drawer');
  const chevron = document.getElementById('dock-chevron');
  const label = document.getElementById('dock-toggle-label');
  if (drawer) {
    drawer.classList.add('dock-open');
    isDockOpen = true;
  }
  if (chevron) chevron.style.transform = 'rotate(180deg)';
  if (label) label.textContent = 'COLLAPSE';
  if (dockCollapseTimer) clearTimeout(dockCollapseTimer);
}

function collapseDock() {
  const drawer = document.getElementById('voice-dock-drawer');
  const chevron = document.getElementById('dock-chevron');
  const label = document.getElementById('dock-toggle-label');
  if (drawer) {
    drawer.classList.remove('dock-open');
    isDockOpen = false;
  }
  if (chevron) chevron.style.transform = 'rotate(0deg)';
  if (label) label.textContent = 'EXPAND';
  if (dockCollapseTimer) clearTimeout(dockCollapseTimer);
}

function toggleDock() {
  if (isDockOpen) {
    collapseDock();
  } else {
    expandDock();
  }
}

function setRecorderState(state) {
  currentState = state;
  const led = document.getElementById('hardware-led');
  const statusText = document.getElementById('hardware-status-text');
  const heroText = document.getElementById('mic-status-hero');
  const masterBtn = document.getElementById('master-mic-btn');
  const needle = document.getElementById('rotary-needle');
  const transcript = document.getElementById('transcript-content');

  clearInterval(timerInterval);

  if (state === 'ready') {
    isListening = false;
    if (led) led.className = 'w-2.5 h-2.5 rounded-full bg-primary inline-block';
    if (statusText) statusText.textContent = 'READY';
    if (heroText) heroText.textContent = 'START LISTENING [SPACE]';
    if (masterBtn) masterBtn.className = 'relative w-11 h-11 rounded-full border-2 border-primary bg-surface-variant flex items-center justify-center cursor-pointer transition-none active:translate-x-0.5 active:translate-y-0.5 outline-none hover:bg-primary group text-primary hover:text-on-primary';
    if (needle) needle.style.transform = 'translateX(-50%) rotate(0deg)';
    const timerEl = document.getElementById('session-timer');
    if (timerEl) timerEl.textContent = '00:00.0';
    const bars = document.querySelectorAll('#vu-meter .vu-bar');
    bars.forEach((b) => {
      b.className = 'vu-bar bg-outline-variant h-full';
    });
  } else if (state === 'listening') {
    isListening = true;
    elapsedSeconds = 0;
    playHardwareChime(660, 0.1);
    expandDock();
    if (led) led.className = 'w-2.5 h-2.5 rounded-full bg-secondary inline-block animate-ping';
    if (statusText) statusText.textContent = 'RECORDING';
    if (heroText) heroText.textContent = 'RECORDING... [SPACE/STOP]';
    if (masterBtn) masterBtn.className = 'relative w-11 h-11 rounded-full border-2 border-secondary bg-secondary text-on-secondary flex items-center justify-center cursor-pointer transition-none active:translate-x-0.5 active:translate-y-0.5 outline-none animate-pulse';
    if (needle) needle.style.transform = 'translateX(-50%) rotate(180deg)';
    if (transcript) transcript.innerHTML = 'Listening... Speak your reminder clearly, then click Stop or press Spacebar.<span class="inline-block w-2 h-3.5 bg-secondary ml-1 animate-pulse"></span>';

    timerInterval = setInterval(() => {
      elapsedSeconds += 0.1;
      const mins = Math.floor(elapsedSeconds / 60).toString().padStart(2, '0');
      const secs = (elapsedSeconds % 60).toFixed(1).padStart(4, '0');
      const timerEl = document.getElementById('session-timer');
      if (timerEl) timerEl.textContent = `${mins}:${secs}`;
    }, 100);
  } else if (state === 'processing') {
    isListening = false;
    expandDock();
    if (led) led.className = 'w-2.5 h-2.5 rounded-full bg-primary inline-block animate-pulse';
    if (statusText) statusText.textContent = 'PROCESSING';
    if (heroText) heroText.textContent = 'TRANSCRIBING...';
    if (masterBtn) masterBtn.className = 'relative w-11 h-11 rounded-full border-2 border-primary bg-surface-container-high flex items-center justify-center cursor-wait transition-none text-primary';
    if (needle) needle.style.transform = 'translateX(-50%) rotate(90deg)';
  } else if (state === 'error') {
    isListening = false;
    if (led) led.className = 'w-2.5 h-2.5 rounded-full bg-error inline-block';
    if (statusText) statusText.textContent = 'ERROR';
    if (heroText) heroText.textContent = 'ERROR (RETRY)';
    if (masterBtn) masterBtn.className = 'relative w-11 h-11 rounded-full border-2 border-error bg-surface flex items-center justify-center cursor-pointer transition-none text-error';
    if (needle) needle.style.transform = 'translateX(-50%) rotate(270deg)';
  }
}

function toggleListening() {
  if (currentState === 'listening') {
    stopAudioRecording();
  } else {
    startAudioRecording();
  }
}

// ---------------------------------------------------------------------------
// 4. API Communication & Whisper Processing
// ---------------------------------------------------------------------------

async function processRecordedAudio(audioBlob) {
  setRecorderState('processing');
  const transcriptEl = document.getElementById('transcript-content');
  if (transcriptEl) {
    transcriptEl.innerHTML = 'Transcribing with local Whisper AI...<span class="inline-block w-2 h-3.5 bg-primary ml-1 animate-pulse"></span>';
  }

  try {
    const formData = new FormData();
    formData.append('file', audioBlob, 'voice_command.webm');

    const response = await fetch('/api/voice-command', {
      method: 'POST',
      body: formData,
    });

    const data = await response.json();
    setRecorderState('ready');

    // Update transcript view with recognized text
    if (transcriptEl) {
      if (data.transcript) {
        transcriptEl.innerHTML = `“${escapeHtml(data.transcript)}”<span class="inline-block w-2 h-3.5 bg-secondary ml-1"></span>`;
      } else {
        transcriptEl.innerHTML = `“${escapeHtml(data.reply || 'Audio processed.')}”`;
      }
    }

    // Update Agent Response card
    updateAgentResponse(data);

    // Speak response aloud
    if (data.reply) {
      speakReply(data.reply);
    }

    // Refresh queue
    refreshQueue();

  } catch (error) {
    console.error("Error processing audio command:", error);
    setRecorderState('error');
    if (transcriptEl) {
      transcriptEl.innerHTML = '<span class="text-error font-bold">Failed to process audio with local Whisper.</span>';
    }
    updateAgentResponse({
      reply: "Failed to connect to backend transcription service.",
      intent: "error",
      success: false,
    });
  }
}

async function handleVoiceCommand(transcript) {
  setRecorderState('processing');

  try {
    const response = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript }),
    });

    const data = await response.json();
    setRecorderState('ready');

    updateAgentResponse(data);

    if (data.reply) {
      speakReply(data.reply);
    }

    refreshQueue();

  } catch (error) {
    console.error("Error executing command:", error);
    setRecorderState('error');
    updateAgentResponse({
      reply: "Failed to connect to backend service.",
      intent: "error",
      success: false,
    });
  }
}

function updateAgentResponse(data) {
  expandDock();
  const replyEl = document.getElementById('agent-reply-text');
  const chipsContainer = document.getElementById('agent-param-chips');

  if (replyEl) {
    replyEl.textContent = data.reply || "Command executed.";
  }

  if (chipsContainer) {
    chipsContainer.innerHTML = '';

    const addChip = (label, value, isHighlight = false) => {
      const chip = document.createElement('span');
      chip.className = isHighlight
        ? 'border border-secondary bg-secondary text-on-secondary px-2 py-0.5 font-label-sm text-label-sm font-mono uppercase font-bold'
        : 'border border-primary px-2 py-0.5 font-label-sm text-label-sm bg-surface-container font-mono uppercase font-bold';
      chip.textContent = `${label}: ${value}`;
      chipsContainer.appendChild(chip);
    };

    addChip('INTENT', data.intent || 'UNKNOWN', true);
    if (data.task) addChip('TASK', data.task);
    if (data.due_at) addChip('DUE_AT', data.due_at);
    addChip('STATUS', data.success ? 'SUCCESS' : 'ATTENTION');
  }

  // Auto-collapse drawer after 4.5 seconds if action was successful
  if (data.success && isDockOpen) {
    if (dockCollapseTimer) clearTimeout(dockCollapseTimer);
    dockCollapseTimer = setTimeout(() => {
      if (!isListening) collapseDock();
    }, 4500);
  }
}

// ---------------------------------------------------------------------------
// 5. Reminders Queue Rendering & CRUD
// ---------------------------------------------------------------------------

async function refreshQueue() {
  const counter = document.getElementById('queue-count-display');
  if (counter) counter.textContent = 'SYNCING...';

  try {
    const response = await fetch('/api/reminders');
    if (!response.ok) throw new Error("Failed to load reminders");
    const reminders = await response.json();
    renderReminders(reminders);
  } catch (err) {
    console.error("Error fetching reminders:", err);
    setQueueView('error');
  }
}

function setFilter(filterType) {
  currentFilter = filterType;

  const tabs = {
    'ALL': document.getElementById('filter-all'),
    'TODAY': document.getElementById('filter-today'),
    'PENDING': document.getElementById('filter-pending'),
  };

  Object.entries(tabs).forEach(([type, tab]) => {
    if (tab) {
      if (type === filterType) {
        tab.className = 'font-label-sm text-label-sm border border-primary bg-primary text-on-primary px-2.5 py-1 uppercase font-bold';
      } else {
        tab.className = 'font-label-sm text-label-sm border border-primary bg-surface text-on-surface px-2.5 py-1 uppercase hover:bg-surface-container font-bold';
      }
    }
  });

  refreshQueue();
}

function formatRelativeCountdown(dueAtStr, isCompleted) {
  if (isCompleted) return 'RESOLVED';
  if (!dueAtStr) return '';
  const now = new Date();
  const due = new Date(dueAtStr);
  const diffMs = due - now;
  const diffSec = Math.round(diffMs / 1000);
  const diffMin = Math.round(diffSec / 60);
  const diffHour = Math.round(diffMin / 60);
  const diffDay = Math.round(diffHour / 24);

  if (diffSec < -60) {
    if (Math.abs(diffMin) < 60) return `OVERDUE ${Math.abs(diffMin)}M AGO`;
    if (Math.abs(diffHour) < 24) return `OVERDUE ${Math.abs(diffHour)}H AGO`;
    return `OVERDUE ${Math.abs(diffDay)}D AGO`;
  }
  if (diffSec >= -60 && diffSec <= 60) {
    return 'DUE RIGHT NOW';
  }
  if (diffMin < 60) {
    return `in ${diffMin} min${diffMin !== 1 ? 's' : ''}`;
  }
  if (diffHour < 24) {
    return `in ${diffHour} hour${diffHour !== 1 ? 's' : ''}`;
  }
  if (diffDay === 1) {
    return 'tomorrow';
  }
  return `in ${diffDay} days`;
}

function renderReminders(reminders) {
  const tbody = document.getElementById('reminder-tbody');
  const countBadge = document.getElementById('queue-count-badge');
  const countDisplay = document.getElementById('queue-count-display');
  if (!tbody) return;

  const now = new Date();
  const todayDateStr = now.toISOString().split('T')[0];

  let filtered = reminders;
  if (currentFilter === 'PENDING') {
    filtered = reminders.filter(r => r.status === 'pending');
  } else if (currentFilter === 'TODAY') {
    filtered = reminders.filter(r => (r.due_at || '').startsWith(todayDateStr));
  }

  tbody.innerHTML = '';

  if (countBadge) countBadge.textContent = filtered.length;
  if (countDisplay) countDisplay.textContent = `${filtered.length} REMINDER${filtered.length !== 1 ? 'S' : ''}`;

  if (filtered.length === 0) {
    setQueueView('empty');
    return;
  }

  setQueueView('normal');

  // Categorize reminders into distinct visual sections
  const groups = [
    { id: 'due_now', title: 'OVERDUE', items: [], headerClass: 'text-secondary bg-secondary/10' },
    { id: 'today', title: 'TODAY', items: [], headerClass: 'text-brand-blue bg-brand-blue/10' },
    { id: 'upcoming', title: 'UPCOMING', items: [], headerClass: 'text-on-surface bg-surface-container-high' },
    { id: 'completed', title: 'COMPLETED', items: [], headerClass: 'text-on-surface-variant bg-surface-container' },
  ];

  filtered.forEach(r => {
    const isDue = r.status === 'announced';
    const isCompleted = r.status === 'completed';
    const dueTime = r.due_at ? new Date(r.due_at) : null;
    const isOverdue = dueTime && dueTime < now && !isCompleted;
    const isToday = r.due_at && r.due_at.startsWith(todayDateStr);

    if (isCompleted) {
      groups[3].items.push(r);
    } else if (isDue || isOverdue) {
      groups[0].items.push(r);
    } else if (isToday) {
      groups[1].items.push(r);
    } else {
      groups[2].items.push(r);
    }
  });

  groups.forEach(group => {
    if (group.items.length === 0) return;

    // Render group header separator row
    const groupRow = document.createElement('tr');
    groupRow.className = `group-separator-row ${group.headerClass}`;
    groupRow.innerHTML = `
      <td colspan="4" class="py-2.5 px-space-md font-label-sm text-label-sm uppercase font-bold tracking-wider">
        <div class="flex items-center justify-between">
          <span>${group.title}</span>
          <span class="px-2 py-0.5 border border-primary/20 text-xs font-mono font-bold bg-surface/60">${group.items.length}</span>
        </div>
      </td>
    `;
    tbody.appendChild(groupRow);

    group.items.forEach(r => {
      const row = document.createElement('tr');
      const isDue = r.status === 'announced';
      const isCompleted = r.status === 'completed';
      const dueTime = r.due_at ? new Date(r.due_at) : null;
      const isOverdue = dueTime && dueTime < now && !isCompleted;

      if (isDue || isOverdue) {
        row.className = 'bg-secondary/10 hover:bg-secondary/15 transition-none';
      } else if (isCompleted) {
        row.className = 'opacity-40 hover:bg-surface-container transition-none';
      } else {
        row.className = 'hover:bg-surface-container transition-none';
      }

      let formattedDue = r.due_at || '';
      try {
        const dt = new Date(r.due_at);
        const timeStr = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const dateStr = dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
        formattedDue = `${dateStr} ${timeStr}`;
      } catch (e) {}

      const relativeCountdown = formatRelativeCountdown(r.due_at, isCompleted);

      let statusBadge = '';
      if (isDue || isOverdue) {
        statusBadge = `
          <span class="inline-flex items-center gap-1.5 bg-secondary text-on-secondary px-2 py-0.5 font-label-sm text-label-sm uppercase font-bold">
            <span class="w-2 h-2 rounded-full bg-on-secondary animate-ping"></span>
            ${isDue ? 'DUE NOW' : 'OVERDUE'}
          </span>`;
      } else if (isCompleted) {
        statusBadge = `
          <span class="inline-flex items-center gap-1.5 border border-outline bg-surface-container px-2 py-0.5 font-label-sm text-label-sm uppercase text-on-surface-variant font-mono font-bold">
            RESOLVED
          </span>`;
      } else {
        statusBadge = `
          <span class="inline-flex items-center gap-1.5 border border-primary bg-surface-container px-2 py-0.5 font-label-sm text-label-sm uppercase text-primary font-bold">
            <span class="w-2 h-2 rounded-full bg-primary"></span>
            PENDING
          </span>`;
      }

      row.innerHTML = `
        <td class="py-3 px-space-md align-top">${statusBadge}</td>
        <td class="py-3 px-space-md align-top font-mono">
          <div class="${(isDue || isOverdue) ? 'text-secondary font-bold' : 'text-primary font-bold'}">
            ${formattedDue}
          </div>
          <div class="font-label-sm text-label-sm ${(isDue || isOverdue) ? 'text-secondary font-bold' : 'text-brand-blue font-bold'} mt-0.5 uppercase">
            ${relativeCountdown}
          </div>
        </td>
        <td class="py-3 px-space-md text-primary font-body-md text-body-md align-top">
          <div class="font-medium">${escapeHtml(r.task)}</div>
        </td>
        <td class="py-3 px-space-md text-right space-x-1.5 align-top">
          ${!isCompleted ? `
            <button type="button" onclick="completeReminder('${r.id}')" class="font-label-sm text-label-sm border border-primary bg-primary text-on-primary px-2.5 py-1 uppercase hover:bg-surface hover:text-primary active:translate-x-px active:translate-y-px transition-none font-bold" title="Mark Done">
              [DONE]
            </button>
          ` : ''}
          <button type="button" onclick="deleteReminder('${r.id}')" class="font-label-sm text-label-sm border border-outline text-on-surface-variant px-2 py-1 uppercase hover:bg-secondary hover:text-on-secondary hover:border-secondary active:translate-x-px active:translate-y-px transition-none font-bold" title="Delete Reminder">
            [X]
          </button>
        </td>
      `;
      tbody.appendChild(row);
    });
  });
}

async function completeReminder(id) {
  try {
    const res = await fetch(`/api/reminders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });
    if (res.ok) {
      playHardwareChime(1040, 0.15);
      refreshQueue();
    }
  } catch (err) {
    console.error("Error completing reminder:", err);
  }
}

async function deleteReminder(id) {
  try {
    const res = await fetch(`/api/reminders/${id}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      playHardwareChime(440, 0.15);
      refreshQueue();
    }
  } catch (err) {
    console.error("Error deleting reminder:", err);
  }
}

async function deleteLastReminder() {
  await handleVoiceCommand("Delete my last reminder.");
}

function setQueueView(mode) {
  const normalView = document.getElementById('queue-table-view');
  const emptyView = document.getElementById('queue-empty-view');
  const errorView = document.getElementById('queue-error-view');

  if (normalView) normalView.classList.add('hidden');
  if (emptyView) emptyView.classList.add('hidden');
  if (errorView) errorView.classList.add('hidden');

  if (mode === 'normal') {
    if (normalView) normalView.classList.remove('hidden');
  } else if (mode === 'empty') {
    if (emptyView) emptyView.classList.remove('hidden');
    const countDisplay = document.getElementById('queue-count-display');
    if (countDisplay) countDisplay.textContent = '0 REMINDERS';
    const countBadge = document.getElementById('queue-count-badge');
    if (countBadge) countBadge.textContent = '0';
  } else if (mode === 'error') {
    if (errorView) errorView.classList.remove('hidden');
    const countDisplay = document.getElementById('queue-count-display');
    if (countDisplay) countDisplay.textContent = 'ERROR';
  }
}

// ---------------------------------------------------------------------------
// 6. Demo Command Injection
// ---------------------------------------------------------------------------

function injectPrompt(rawText) {
  expandDock();
  const transcriptEl = document.getElementById('transcript-content');
  if (transcriptEl) {
    transcriptEl.innerHTML = `“${escapeHtml(rawText)}”<span class="inline-block w-2 h-3.5 bg-secondary ml-1 animate-pulse"></span>`;
  }
  handleVoiceCommand(rawText);
}

// ---------------------------------------------------------------------------
// 7. WebSocket Live Updates & Alarm Triggering
// ---------------------------------------------------------------------------

let ws = null;

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("Connected to reminder WebSocket stream.");
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log("WebSocket message:", data);

      if (data.event === 'reminder_announced') {
        triggerAlarm(data.reminder);
      }

      refreshQueue();
    } catch (e) {
      console.warn("Non-JSON WS message:", event.data);
    }
  };

  ws.onclose = () => {
    console.log("WebSocket disconnected. Reconnecting in 3s...");
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
    ws.close();
  };
}

function triggerAlarm(reminder) {
  currentDueReminderId = reminder ? reminder.id : null;
  const banner = document.getElementById('alert-banner');
  const bannerText = document.getElementById('alert-banner-text');

  if (banner && bannerText && reminder) {
    bannerText.textContent = `DUE NOW: ${reminder.task.toUpperCase()}`;
    banner.classList.remove('hidden');
  }

  playHardwareChime(960, 0.4);
  speakReply(`Reminder: ${reminder.task} is due now.`);

  if (window.Notification && Notification.permission === 'granted') {
    new Notification("Voice Reminder Due!", {
      body: reminder.task,
      icon: "/static/favicon.ico",
    });
  }
}

function dismissAlert() {
  const banner = document.getElementById('alert-banner');
  if (banner) banner.classList.add('hidden');
  if (currentDueReminderId) {
    if (!currentDueReminderId.startsWith('test-')) {
      completeReminder(currentDueReminderId);
    }
    currentDueReminderId = null;
  }
}

function testAlarm() {
  triggerAlarm({
    id: "test-001",
    task: "CALL DR. ARIS AT 14:00 (URGENT LAB REPORT)",
    status: "announced",
  });
}

function requestNotificationPermission() {
  if (window.Notification) {
    Notification.requestPermission().then(permission => {
      const btn = document.getElementById('notify-btn');
      if (btn) {
        btn.textContent = permission === 'granted' ? 'NOTIFICATIONS: ON' : 'NOTIFICATIONS: OFF';
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 8. Theme Management (Light / Dark Mode)
// ---------------------------------------------------------------------------

function initTheme() {
  const saved = localStorage.getItem('voice_reminder_theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = saved === 'dark' || (!saved && prefersDark);
  applyTheme(isDark);
}

function toggleTheme() {
  const isDark = !document.documentElement.classList.contains('dark');
  applyTheme(isDark);
  try {
    localStorage.setItem('voice_reminder_theme', isDark ? 'dark' : 'light');
  } catch (e) {}
}

function applyTheme(isDark) {
  const html = document.documentElement;
  const label = document.getElementById('theme-label');
  const dot = document.getElementById('theme-status-dot');

  if (isDark) {
    html.classList.add('dark');
    if (label) label.textContent = 'THEME: DARK';
    if (dot) dot.className = 'w-1.5 h-1.5 rounded-full bg-brand-orange inline-block';
  } else {
    html.classList.remove('dark');
    if (label) label.textContent = 'THEME: LIGHT';
    if (dot) dot.className = 'w-1.5 h-1.5 rounded-full bg-brand-blue inline-block';
  }
}

// ---------------------------------------------------------------------------
// 9. Keyboard Shortcuts & Initialization
// ---------------------------------------------------------------------------

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if (e.code === 'Space') {
    e.preventDefault();
    toggleListening();
  } else if (e.code === 'Escape') {
    e.preventDefault();
    if (currentState === 'listening') {
      stopAudioRecording();
    }
    setRecorderState('ready');
    collapseDock();
    dismissAlert();
  } else if (e.key === 'r' || e.key === 'R') {
    refreshQueue();
  } else if (e.key === 'd' || e.key === 'D') {
    dismissAlert();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  connectWebSocket();
  refreshQueue();
});
