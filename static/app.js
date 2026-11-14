/**
 * Voice Notes Reminder Agent - Frontend Engine
 * Connects Web Speech API (STT & TTS), WebSocket real-time updates,
 * and FastAPI REST endpoints to the industrial UI chassis.
 */

let currentState = 'ready';
let isListening = false;
let isMuted = false;
let currentFilter = 'ALL';
let timerInterval = null;
let elapsedSeconds = 0;
let recognition = null;
let currentDueReminderId = null;

// Audio context for hardware alert chimes
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

function playHardwareChime(frequency = 880, duration = 0.25) {
  if (isMuted) return;
  try {
    const ctx = getAudioContext();
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
// 2. Web Speech Recognition (STT)
// ---------------------------------------------------------------------------

function initSpeechRecognition() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    console.warn("Web SpeechRecognition is not supported in this browser.");
    return null;
  }
  const rec = new SpeechRec();
  rec.continuous = false;
  rec.interimResults = true;
  rec.lang = 'en-US';

  rec.onstart = () => {
    setRecorderState('listening');
  };

  rec.onresult = (event) => {
    let interim = '';
    let finalTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript;
      } else {
        interim += event.results[i][0].transcript;
      }
    }

    const transcriptEl = document.getElementById('transcript-content');
    if (finalTranscript) {
      transcriptEl.innerHTML = `“${finalTranscript}”<span class="inline-block w-2 h-3.5 bg-secondary ml-1 animate-pulse"></span>`;
      handleVoiceCommand(finalTranscript);
    } else if (interim) {
      transcriptEl.innerHTML = `“${interim}”<span class="inline-block w-2 h-3.5 bg-primary ml-1 animate-pulse"></span>`;
    }
  };

  rec.onerror = (event) => {
    console.error("Speech recognition error:", event.error);
    setRecorderState('error');
    const transcriptEl = document.getElementById('transcript-content');
    if (event.error === 'not-allowed') {
      transcriptEl.innerHTML = '<span class="text-error font-bold">Microphone permission denied. Please allow mic access in your browser settings.</span>';
    } else if (event.error === 'no-speech') {
      transcriptEl.innerHTML = '<span class="text-error font-bold">No speech detected. Press the mic button and speak clearly.</span>';
    } else {
      transcriptEl.innerHTML = `<span class="text-error font-bold">Speech recognition error: ${event.error}</span>`;
    }
  };

  rec.onend = () => {
    if (currentState === 'listening') {
      setRecorderState('ready');
    }
  };

  return rec;
}

// ---------------------------------------------------------------------------
// 3. UI State Management & VU Meter
// ---------------------------------------------------------------------------

function updateVuRandom() {
  if (currentState === 'listening') {
    const bars = document.querySelectorAll('#vu-meter .vu-bar');
    const activeCount = Math.floor(Math.random() * 5) + 3;
    bars.forEach((b, i) => {
      if (i < activeCount) {
        b.className = (i > 5) ? 'vu-bar bg-secondary h-full' : 'vu-bar bg-primary h-full';
      } else {
        b.className = 'vu-bar bg-outline-variant h-full';
      }
    });
    const dBs = ['-6.2 dB', '-4.1 dB', '-8.9 dB', '-2.4 dB', '-12.0 dB'];
    document.getElementById('vu-db-readout').textContent = dBs[Math.floor(Math.random() * dBs.length)];
  }
}
setInterval(updateVuRandom, 150);

function setRecorderState(state) {
  currentState = state;
  const led = document.getElementById('hardware-led');
  const statusText = document.getElementById('hardware-status-text');
  const heroText = document.getElementById('mic-status-hero');
  const coreBtn = document.getElementById('mic-inner-core');
  const coreLabel = document.getElementById('mic-core-label');
  const needle = document.getElementById('rotary-needle');
  const transcript = document.getElementById('transcript-content');

  // Update state switcher buttons highlight
  ['ready', 'listening', 'processing', 'error'].forEach(s => {
    const btn = document.getElementById('btn-state-' + s);
    if (btn) {
      if (s === state) {
        btn.className = 'font-label-sm text-label-sm px-2 py-0.5 uppercase bg-primary text-on-primary';
      } else {
        btn.className = 'font-label-sm text-label-sm px-2 py-0.5 uppercase text-on-surface hover:bg-surface-container-high';
      }
    }
  });

  clearInterval(timerInterval);

  if (state === 'ready') {
    isListening = false;
    if (led) led.className = 'w-2.5 h-2.5 rounded-full bg-primary inline-block';
    if (statusText) statusText.textContent = 'READY';
    if (heroText) heroText.textContent = 'START LISTENING';
    if (coreLabel) coreLabel.textContent = 'REC';
    if (coreBtn) coreBtn.className = 'w-24 h-24 rounded-full border border-primary bg-surface-container flex flex-col items-center justify-center gap-1 group-hover:bg-primary group-hover:text-on-primary transition-none';
    if (needle) needle.style.transform = 'translateX(-50%) rotate(0deg)';
    document.getElementById('session-timer').textContent = '00:00.0';
    document.getElementById('vu-db-readout').textContent = '-18 dB';
  } else if (state === 'listening') {
    isListening = true;
    elapsedSeconds = 0;
    playHardwareChime(660, 0.1);
    if (led) led.className = 'w-2.5 h-2.5 rounded-full bg-secondary inline-block animate-ping';
    if (statusText) statusText.textContent = 'RECORDING';
    if (heroText) heroText.textContent = 'RECORDING...';
    if (coreLabel) coreLabel.textContent = 'STOP';
    if (coreBtn) coreBtn.className = 'w-24 h-24 rounded-full border-2 border-secondary bg-secondary text-on-secondary flex flex-col items-center justify-center gap-1 transition-none';
    if (needle) needle.style.transform = 'translateX(-50%) rotate(180deg)';
    if (transcript) transcript.innerHTML = 'Listening... speak now.<span class="inline-block w-2 h-3.5 bg-secondary ml-1 animate-pulse"></span>';

    timerInterval = setInterval(() => {
      elapsedSeconds += 0.1;
      const mins = Math.floor(elapsedSeconds / 60).toString().padStart(2, '0');
      const secs = (elapsedSeconds % 60).toFixed(1).padStart(4, '0');
      document.getElementById('session-timer').textContent = `${mins}:${secs}`;
    }, 100);
  } else if (state === 'processing') {
    isListening = false;
    if (led) led.className = 'w-2.5 h-2.5 rounded-full bg-primary inline-block animate-pulse';
    if (statusText) statusText.textContent = 'PROCESSING';
    if (heroText) heroText.textContent = 'PROCESSING...';
    if (coreLabel) coreLabel.textContent = 'WAIT';
    if (coreBtn) coreBtn.className = 'w-24 h-24 rounded-full border border-primary bg-surface-container-high flex flex-col items-center justify-center gap-1 transition-none';
    if (needle) needle.style.transform = 'translateX(-50%) rotate(90deg)';
  } else if (state === 'error') {
    isListening = false;
    if (led) led.className = 'w-2.5 h-2.5 rounded-full bg-error inline-block';
    if (statusText) statusText.textContent = 'ERROR';
    if (heroText) heroText.textContent = 'ERROR';
    if (coreLabel) coreLabel.textContent = 'RETRY';
    if (coreBtn) coreBtn.className = 'w-24 h-24 rounded-full border-2 border-error bg-surface flex flex-col items-center justify-center gap-1 transition-none text-error';
    if (needle) needle.style.transform = 'translateX(-50%) rotate(270deg)';
  }
}

function toggleListening() {
  if (currentState === 'listening') {
    if (recognition) {
      try { recognition.stop(); } catch (e) {}
    }
    setRecorderState('ready');
  } else {
    if (!recognition) {
      recognition = initSpeechRecognition();
    }
    if (recognition) {
      try {
        recognition.start();
      } catch (err) {
        console.warn("Recognition already started or error:", err);
      }
    } else {
      alert("Web Speech API is not supported in this browser. Please use Google Chrome, Microsoft Edge, or Safari.");
    }
  }
}

// ---------------------------------------------------------------------------
// 4. API Communication & Command Execution
// ---------------------------------------------------------------------------

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

    // Update Agent Response Cassette
    updateAgentResponse(data);

    // Speak response aloud
    if (data.reply) {
      speakReply(data.reply);
    }

    // Refresh queue
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
        ? 'border border-secondary bg-secondary text-on-secondary px-1.5 py-0.5 font-label-sm text-label-sm font-mono uppercase'
        : 'border border-primary px-1.5 py-0.5 font-label-sm text-label-sm bg-surface-container font-mono uppercase';
      chip.textContent = `${label}: ${value}`;
      chipsContainer.appendChild(chip);
    };

    addChip('INTENT', data.intent || 'UNKNOWN', true);
    if (data.task) addChip('TASK', data.task);
    if (data.due_at) addChip('DUE_AT', data.due_at);
    addChip('STATUS', data.success ? 'SUCCESS' : 'ATTENTION');
  }
}

// ---------------------------------------------------------------------------
// 5. Reminders Queue Rendering & CRUD
// ---------------------------------------------------------------------------

async function refreshQueue() {
  const counter = document.getElementById('queue-count-display');
  if (counter) counter.textContent = 'SYNCING RTC...';

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

  // Highlight active filter tab
  const tabs = {
    'ALL': document.getElementById('filter-all'),
    'TODAY': document.getElementById('filter-today'),
    'PENDING': document.getElementById('filter-pending'),
  };

  Object.entries(tabs).forEach(([type, tab]) => {
    if (tab) {
      if (type === filterType) {
        tab.className = 'font-label-sm text-label-sm border border-primary bg-primary text-on-primary px-2 py-1 uppercase';
      } else {
        tab.className = 'font-label-sm text-label-sm border border-primary bg-surface text-on-surface px-2 py-1 uppercase hover:bg-surface-container';
      }
    }
  });

  refreshQueue();
}

function renderReminders(reminders) {
  const tbody = document.getElementById('reminder-tbody');
  if (!tbody) return;

  const now = new Date();
  const todayDateStr = now.toISOString().split('T')[0];

  // Apply active tab filter
  let filtered = reminders;
  if (currentFilter === 'PENDING') {
    filtered = reminders.filter(r => r.status === 'pending');
  } else if (currentFilter === 'TODAY') {
    filtered = reminders.filter(r => (r.due_at || '').startsWith(todayDateStr));
  }

  tbody.innerHTML = '';

  if (filtered.length === 0) {
    setQueueView('empty');
    return;
  }

  setQueueView('normal');

  filtered.forEach(r => {
    const row = document.createElement('tr');
    const isDue = r.status === 'announced';
    const isCompleted = r.status === 'completed';

    if (isDue) {
      row.className = 'bg-secondary/10 hover:bg-secondary/15 transition-none';
    } else if (isCompleted) {
      row.className = 'opacity-40 hover:bg-surface-container transition-none';
    } else {
      row.className = 'hover:bg-surface-container transition-none';
    }

    // Format human date
    let formattedDue = r.due_at || '';
    try {
      const dt = new Date(r.due_at);
      const timeStr = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const dateStr = dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
      formattedDue = `${dateStr} ${timeStr}`;
    } catch (e) {}

    // Badge status
    let statusBadge = '';
    if (isDue) {
      statusBadge = `
        <span class="inline-flex items-center gap-1 bg-secondary text-on-secondary px-1.5 py-0.5 font-label-sm text-label-sm uppercase font-bold">
          <span class="w-1.5 h-1.5 rounded-full bg-on-secondary animate-ping"></span>
          DUE NOW
        </span>`;
    } else if (isCompleted) {
      statusBadge = `
        <span class="inline-flex items-center gap-1 border border-outline bg-surface-container px-1.5 py-0.5 font-label-sm text-label-sm uppercase text-on-surface-variant font-mono">
          RESOLVED
        </span>`;
    } else {
      statusBadge = `
        <span class="inline-flex items-center gap-1 border border-primary bg-surface-container px-1.5 py-0.5 font-label-sm text-label-sm uppercase text-primary">
          <span class="w-1.5 h-1.5 rounded-full bg-primary"></span>
          PENDING
        </span>`;
    }

    row.innerHTML = `
      <td class="py-2.5 px-space-md">${statusBadge}</td>
      <td class="py-2.5 px-space-md font-mono ${isDue ? 'text-secondary font-bold' : 'text-primary'}">
        ${formattedDue}
      </td>
      <td class="py-2.5 px-space-md text-primary font-body-md text-body-md">
        ${escapeHtml(r.task)}
        <div class="font-label-sm text-label-sm text-on-surface-variant font-mono mt-0.5">
          ${r.id.substring(0, 8)}
        </div>
      </td>
      <td class="py-2.5 px-space-md text-right space-x-1">
        ${!isCompleted ? `
          <button type="button" onclick="completeReminder('${r.id}')" class="font-label-sm text-label-sm border border-primary bg-primary text-on-primary px-2 py-0.5 uppercase hover:bg-surface hover:text-primary active:translate-x-px active:translate-y-px transition-none">
            [DONE]
          </button>
        ` : ''}
        <button type="button" onclick="deleteReminder('${r.id}')" class="font-label-sm text-label-sm border border-outline text-on-surface-variant px-1.5 py-0.5 uppercase hover:bg-secondary hover:text-on-secondary hover:border-secondary active:translate-x-px active:translate-y-px transition-none">
          [X]
        </button>
      </td>
    `;
    tbody.appendChild(row);
  });

  const countDisplay = document.getElementById('queue-count-display');
  if (countDisplay) {
    countDisplay.textContent = `${filtered.length} REMINDER${filtered.length !== 1 ? 'S' : ''}`;
  }
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

  const bNormal = document.getElementById('btn-q-normal');
  const bEmpty = document.getElementById('btn-q-empty');
  const bError = document.getElementById('btn-q-error');

  [bNormal, bEmpty, bError].forEach(b => {
    if (b) b.className = 'font-label-sm text-label-sm px-1.5 py-0.5 uppercase text-on-surface hover:bg-surface-container-high';
  });

  if (normalView) normalView.classList.add('hidden');
  if (emptyView) emptyView.classList.add('hidden');
  if (errorView) errorView.classList.add('hidden');

  if (mode === 'normal') {
    if (normalView) normalView.classList.remove('hidden');
    if (bNormal) bNormal.className = 'font-label-sm text-label-sm px-1.5 py-0.5 uppercase bg-primary text-on-primary';
  } else if (mode === 'empty') {
    if (emptyView) emptyView.classList.remove('hidden');
    if (bEmpty) bEmpty.className = 'font-label-sm text-label-sm px-1.5 py-0.5 uppercase bg-primary text-on-primary';
    document.getElementById('queue-count-display').textContent = '0 REMINDERS';
  } else if (mode === 'error') {
    if (errorView) errorView.classList.remove('hidden');
    if (bError) bError.className = 'font-label-sm text-label-sm px-1.5 py-0.5 uppercase bg-secondary text-on-secondary';
    document.getElementById('queue-count-display').textContent = 'ERROR';
  }
}

// ---------------------------------------------------------------------------
// 6. Demo Command Injection
// ---------------------------------------------------------------------------

function injectPrompt(rawText) {
  const transcriptEl = document.getElementById('transcript-content');
  if (transcriptEl) {
    transcriptEl.innerHTML = `&ldquo;${rawText}&rdquo;<span class="inline-block w-2 h-3.5 bg-secondary ml-1 animate-pulse"></span>`;
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

  // Play hardware chime and speak announcement
  playHardwareChime(960, 0.4);
  speakReply(`Reminder: ${reminder.task} is due now.`);

  // Browser desktop notification if permitted
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
    completeReminder(currentDueReminderId);
    currentDueReminderId = null;
  }
}

function snoozeAlert(minutes = 5) {
  dismissAlert();
  if (currentDueReminderId) {
    // Re-schedule reminder in X minutes via command
    handleVoiceCommand(`Remind me to follow up in ${minutes} minutes.`);
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
        btn.textContent = permission === 'granted' ? '[NOTIFICATIONS: ON]' : '[NOTIFICATIONS: DENIED]';
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 8. Keyboard Shortcuts & Initialization
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
    setRecorderState('ready');
  } else if (e.key === 'r' || e.key === 'R') {
    refreshQueue();
  } else if (e.key === 'd' || e.key === 'D') {
    dismissAlert();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  recognition = initSpeechRecognition();
  connectWebSocket();
  refreshQueue();
});
