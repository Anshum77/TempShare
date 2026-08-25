// Room page logic
const roomId = window.location.pathname.split('/').pop();
const socket = io();

let state = {
  room: null,
  userId: localStorage.getItem('ts_user_' + roomId) || null,
  pendingId: localStorage.getItem('ts_pending_' + roomId) || null,
  currentFolder: 'root',
  folderPath: [],
  typingTimeout: null,
  isTyping: false,
  sidebarOpen: false,
  expiryInterval: null,
  replyTo: null,
  seenTarget: null
};

// DOM elements
const els = {
  roomName: document.getElementById('roomName'),
  roomCode: document.getElementById('roomCode'),
  expiryText: document.getElementById('expiryText'),
  changeExpiryBtn: document.getElementById('changeExpiryBtn'),
  expiryBadge: document.getElementById('expiryBadge'),
  expiryModal: document.getElementById('expiryModal'),
  closeExpiryModal: document.getElementById('closeExpiryModal'),
  expirySelect: document.getElementById('expirySelect'),
  saveExpiryBtn: document.getElementById('saveExpiryBtn'),
  deleteRoomBtn: document.getElementById('deleteRoomBtn'),
  leaveRoomBtn: document.getElementById('leaveRoomBtn'),
  clearChatBtn: document.getElementById('clearChatBtn'),
  copyLinkBtn: document.getElementById('copyLinkBtn'),
  toggleSidebar: document.getElementById('toggleSidebar'),
  sidebar: document.getElementById('sidebar'),
  pendingSection: document.getElementById('pendingSection'),
  pendingList: document.getElementById('pendingList'),
  pendingCount: document.getElementById('pendingCount'),
  pendingBadgeMobile: document.getElementById('pendingBadgeMobile'),
  userList: document.getElementById('userList'),
  userCount: document.getElementById('userCount'),
  myInfo: document.getElementById('myInfo'),
  breadcrumb: document.getElementById('breadcrumb'),
  backBtn: document.getElementById('backBtn'),
  homeBtn: document.getElementById('homeBtn'),
  downloadZipBtn: document.getElementById('downloadZipBtn'),
  fileList: document.getElementById('fileList'),
  emptyFiles: document.getElementById('emptyFiles'),
  newFolderBtn: document.getElementById('newFolderBtn'),
  fileInput: document.getElementById('fileInput'),
  folderInput: document.getElementById('folderInput'),
  dropZone: document.getElementById('dropZone'),
  dropOverlay: document.getElementById('dropOverlay'),
  uploadProgress: document.getElementById('uploadProgress'),
  uploadProgressTitle: document.getElementById('uploadProgressTitle'),
  uploadProgressDetail: document.getElementById('uploadProgressDetail'),
  uploadProgressPct: document.getElementById('uploadProgressPct'),
  uploadProgressBar: document.getElementById('uploadProgressBar'),
  messages: document.getElementById('messages'),
  chatForm: document.getElementById('chatForm'),
  chatInput: document.getElementById('chatInput'),
  chatMuted: document.getElementById('chatMuted'),
  typingIndicator: document.getElementById('typingIndicator'),
  activityBar: document.getElementById('activityBar'),
  replyBar: document.getElementById('replyBar'),
  replyToName: document.getElementById('replyToName'),
  replyToText: document.getElementById('replyToText'),
  cancelReplyBtn: document.getElementById('cancelReplyBtn'),
  seenModal: document.getElementById('seenModal'),
  seenBody: document.getElementById('seenBody'),
  closeSeenModal: document.getElementById('closeSeenModal'),
  nameModal: document.getElementById('nameModal'),
  joinNameInput: document.getElementById('joinNameInput'),
  joinNameBtn: document.getElementById('joinNameBtn'),
  waitingOverlay: document.getElementById('waitingOverlay'),
  waitingText: document.getElementById('waitingText'),
  cancelWaitBtn: document.getElementById('cancelWaitBtn'),
  permModal: document.getElementById('permModal'),
  closePermModal: document.getElementById('closePermModal'),
  permTitle: document.getElementById('permTitle'),
  permSubtitle: document.getElementById('permSubtitle'),
  permBody: document.getElementById('permBody'),
};

// ---------- Utilities ----------
function formatDuration(ms) {
  if (ms <= 0) return 'expired';
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day >= 365) return `~${Math.round(day/365)} year(s)`;
  if (day >= 30) return `~${Math.round(day/30)} month(s)`;
  if (day >= 1) return `${day}d ${hr % 24}h`;
  if (hr >= 1) return `${hr}h ${min % 60}m`;
  if (min >= 1) return `${min}m ${sec % 60}s`;
  return `${sec}s`;
}

function nearestExpiryOption(hours) {
  const options = [1, 6, 24, 72, 168, 720, 2190, 8760];
  let best = options[0];
  for (const o of options) {
    if (Math.abs(o - hours) < Math.abs(best - hours)) best = o;
  }
  return String(best);
}

function updateExpiryBadge() {
  if (!state.room) return;
  const ms = state.room.expiresAt - Date.now();
  els.expiryText.textContent = '⏳ ' + formatDuration(ms);
  els.expiryBadge.classList.remove('bg-slate-700/60', 'bg-amber-600/30', 'bg-red-600/40');
  if (ms < 1000 * 60 * 60) {
    els.expiryBadge.classList.add('bg-red-600/40');
  } else if (ms < 1000 * 60 * 60 * 24) {
    els.expiryBadge.classList.add('bg-amber-600/30');
  } else {
    els.expiryBadge.classList.add('bg-slate-700/60');
  }
  if (ms <= 0) {
    clearInterval(state.expiryInterval);
    showToast('This room has expired', true);
    setTimeout(() => window.location.href = '/', 1500);
  }
}

async function changeExpiry(hours) {
  try {
    const data = await api(`/api/rooms/${roomId}`, {
      method: 'PATCH',
      body: JSON.stringify({ userId: state.userId, expiresInHours: hours })
    });
    state.room.expiresAt = data.expiresAt;
    updateExpiryBadge();
    els.expiryModal.style.display = 'none';
    showToast('Expiry updated');
  } catch (e) { showToast(e.message, true); }
}

async function deleteRoom() {
  const ok1 = await Dialog.confirm(
    'This will permanently erase ALL files, folders, and chat messages. This cannot be undone.',
    'Delete this room?',
    { okText: 'Delete', danger: true }
  );
  if (!ok1) return;
  const ok2 = await Dialog.confirm(
    'Everyone currently in the room will be disconnected immediately.',
    'Are you really sure?',
    { okText: 'Yes, delete it', danger: true }
  );
  if (!ok2) return;
  try {
    await api(`/api/rooms/${roomId}`, {
      method: 'DELETE',
      body: JSON.stringify({ userId: state.userId })
    });
    clearIdentity();
    showToast('Room deleted');
    setTimeout(() => window.location.href = '/', 1000);
  } catch (e) { showToast(e.message, true); }
}

async function leaveRoom() {
  const isOwner = me() && me().role === 'owner';
  if (isOwner) return deleteRoom();
  const ok = await Dialog.confirm(
    'You will need the owner to approve you again if you want to come back.',
    'Leave this room?',
    { okText: 'Leave', danger: true }
  );
  if (!ok) return;
  try {
    await api(`/api/rooms/${roomId}/leave`, {
      method: 'POST',
      body: JSON.stringify({ userId: state.userId })
    });
    clearIdentity();
    showToast('You left the room');
    setTimeout(() => window.location.href = '/', 800);
  } catch (e) { showToast(e.message, true); }
}

function clearIdentity() {
  localStorage.removeItem('ts_user_' + roomId);
  localStorage.removeItem('ts_pending_' + roomId);
  state.userId = null;
  state.pendingId = null;
}

function showToast(msg, isError = false) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg shadow-lg text-sm z-50 show ' +
    (isError ? 'bg-red-600 text-white' : 'bg-slate-700 text-white');
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.classList.add('hidden'); }, 2500);
}

function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
  if (bytes < 1024*1024*1024) return (bytes/1024/1024).toFixed(1) + ' MB';
  return (bytes/1024/1024/1024).toFixed(2) + ' GB';
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const s = Math.floor(diff/1000);
  if (s < 10) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s/60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m/60);
  if (h < 24) return h + 'h ago';
  const d = new Date(ts);
  return d.toLocaleDateString();
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatSeenAt(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + time;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- File-type icons ----------
const ICON_STYLES = {
  image:    { bg: '#a78bfa', fg: '#1e1b4b', label: 'IMG' },
  video:    { bg: '#f472b6', fg: '#500724', label: 'VID' },
  audio:    { bg: '#34d399', fg: '#064e3b', label: 'AUD' },
  pdf:      { bg: '#ef4444', fg: '#fff',    label: 'PDF' },
  doc:      { bg: '#3b82f6', fg: '#fff',    label: 'DOC' },
  docx:     { bg: '#2563eb', fg: '#fff',    label: 'DOCX' },
  word:     { bg: '#2563eb', fg: '#fff',    label: 'DOC' },
  xls:      { bg: '#10b981', fg: '#fff',    label: 'XLS' },
  xlsx:     { bg: '#059669', fg: '#fff',    label: 'XLSX' },
  csv:      { bg: '#84cc16', fg: '#1a2e05', label: 'CSV' },
  ppt:      { bg: '#f97316', fg: '#fff',    label: 'PPT' },
  pptx:     { bg: '#ea580c', fg: '#fff',    label: 'PPTX' },
  txt:      { bg: '#94a3b8', fg: '#0f172a', label: 'TXT' },
  md:       { bg: '#64748b', fg: '#fff',    label: 'MD' },
  rtf:      { bg: '#94a3b8', fg: '#0f172a', label: 'RTF' },
  js:       { bg: '#fde047', fg: '#713f12', label: 'JS'  },
  mjs:      { bg: '#fde047', fg: '#713f12', label: 'MJS' },
  cjs:      { bg: '#fde047', fg: '#713f12', label: 'CJS' },
  ts:       { bg: '#3b82f6', fg: '#fff',    label: 'TS'  },
  jsx:      { bg: '#60a5fa', fg: '#1e3a8a', label: 'JSX' },
  tsx:      { bg: '#38bdf8', fg: '#0c4a6e', label: 'TSX' },
  html:     { bg: '#fb923c', fg: '#431407', label: 'HTML' },
  htm:      { bg: '#fb923c', fg: '#431407', label: 'HTM' },
  css:      { bg: '#6366f1', fg: '#fff',    label: 'CSS' },
  scss:     { bg: '#ec4899', fg: '#fff',    label: 'SCSS' },
  sass:     { bg: '#ec4899', fg: '#fff',    label: 'SASS' },
  less:     { bg: '#2563eb', fg: '#fff',    label: 'LESS' },
  json:     { bg: '#fbbf24', fg: '#78350f', label: 'JSON' },
  xml:      { bg: '#f59e0b', fg: '#78350f', label: 'XML' },
  yaml:     { bg: '#a3a3a3', fg: '#111',    label: 'YML' },
  yml:      { bg: '#a3a3a3', fg: '#111',    label: 'YML' },
  py:       { bg: '#0ea5e9', fg: '#fff',    label: 'PY'  },
  java:     { bg: '#dc2626', fg: '#fff',    label: 'JAVA' },
  c:        { bg: '#0284c7', fg: '#fff',    label: 'C'   },
  cpp:      { bg: '#0284c7', fg: '#fff',    label: 'C++' },
  cc:       { bg: '#0284c7', fg: '#fff',    label: 'C++' },
  cxx:      { bg: '#0284c7', fg: '#fff',    label: 'C++' },
  h:        { bg: '#0ea5e9', fg: '#fff',    label: 'H'   },
  hpp:      { bg: '#0ea5e9', fg: '#fff',    label: 'HPP' },
  cs:       { bg: '#7c3aed', fg: '#fff',    label: 'C#'  },
  go:       { bg: '#67e8f9', fg: '#083344', label: 'GO'  },
  rs:       { bg: '#f97316', fg: '#fff',    label: 'RS'  },
  rb:       { bg: '#dc2626', fg: '#fff',    label: 'RB'  },
  php:      { bg: '#a855f7', fg: '#fff',    label: 'PHP' },
  swift:    { bg: '#f97316', fg: '#fff',    label: 'SW'  },
  kt:       { bg: '#a855f7', fg: '#fff',    label: 'KT'  },
  sh:       { bg: '#14b8a6', fg: '#042f2e', label: 'SH'  },
  bash:     { bg: '#14b8a6', fg: '#042f2e', label: 'BASH' },
  zsh:      { bg: '#14b8a6', fg: '#042f2e', label: 'ZSH' },
  bat:      { bg: '#475569', fg: '#fff',    label: 'BAT' },
  ps1:      { bg: '#2563eb', fg: '#fff',    label: 'PS1' },
  sql:      { bg: '#0891b2', fg: '#fff',    label: 'SQL' },
  vue:      { bg: '#22c55e', fg: '#052e16', label: 'VUE' },
  svelte:   { bg: '#f97316', fg: '#fff',    label: 'SVL' },
  zip:      { bg: '#a16207', fg: '#fef3c7', label: 'ZIP' },
  rar:      { bg: '#a16207', fg: '#fef3c7', label: 'RAR' },
  '7z':     { bg: '#a16207', fg: '#fef3c7', label: '7Z'  },
  tar:      { bg: '#a16207', fg: '#fef3c7', label: 'TAR' },
  gz:       { bg: '#854d0e', fg: '#fef3c7', label: 'GZ'  },
  bz2:      { bg: '#854d0e', fg: '#fef3c7', label: 'BZ2' },
  xz:       { bg: '#854d0e', fg: '#fef3c7', label: 'XZ'  },
  exe:      { bg: '#475569', fg: '#fff',    label: 'EXE' },
  msi:      { bg: '#475569', fg: '#fff',    label: 'MSI' },
  dll:      { bg: '#334155', fg: '#fff',    label: 'DLL' },
  bin:      { bg: '#1e293b', fg: '#cbd5e1', label: 'BIN' },
  ttf:      { bg: '#db2777', fg: '#fff',    label: 'TTF' },
  otf:      { bg: '#db2777', fg: '#fff',    label: 'OTF' },
  woff:     { bg: '#be185d', fg: '#fff',    label: 'WOFF' },
  woff2:    { bg: '#be185d', fg: '#fff',    label: 'WOFF2' },
  iso:      { bg: '#64748b', fg: '#fff',    label: 'ISO' },
  dmg:      { bg: '#64748b', fg: '#fff',    label: 'DMG' }
};

const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp','svg','bmp','ico','tiff','tif','avif','heic','heif']);
const VIDEO_EXTS = new Set(['mp4','mov','avi','mkv','webm','flv','wmv','m4v','mpg','mpeg','3gp']);
const AUDIO_EXTS = new Set(['mp3','wav','ogg','flac','m4a','aac','wma','aiff','opus']);

function iconInfoFor(name) {
  const dot = name.lastIndexOf('.');
  const ext = (dot >= 0 ? name.slice(dot+1).toLowerCase() : '').trim();
  if (!ext) return ICON_STYLES.bin || { bg: '#475569', fg: '#fff', label: 'FILE' };
  if (IMAGE_EXTS.has(ext)) return { ...ICON_STYLES.image, label: ext.slice(0,4).toUpperCase() };
  if (VIDEO_EXTS.has(ext)) return { ...ICON_STYLES.video, label: ext.slice(0,4).toUpperCase() };
  if (AUDIO_EXTS.has(ext)) return { ...ICON_STYLES.audio, label: ext.slice(0,3).toUpperCase() };
  if (ICON_STYLES[ext]) return ICON_STYLES[ext];
  return { bg: '#475569', fg: '#f1f5f9', label: ext.slice(0,4).toUpperCase() };
}

function fileIconHTML(name) {
  const info = iconInfoFor(name);
  const label = escapeHtml(info.label);
  return `<span class="inline-flex items-center justify-center rounded-md font-bold text-[10px] tracking-tight" style="background:${info.bg};color:${info.fg};min-width:34px;height:28px;padding:0 6px;">${label}</span>`;
}

function folderIconHTML() {
  return `<span class="inline-flex items-center justify-center w-8 h-7 text-yellow-400 text-xl leading-none">📁</span>`;
}

function me() {
  return state.room && state.room.users.find(u => u.id === state.userId);
}

function can(perm) {
  const m = me();
  if (!m) return false;
  if (m.role === 'owner') return true;
  return m.permissions[perm] === true;
}

function ticksSVG() {
  return `<svg viewBox="0 0 16 15" fill="currentColor" aria-hidden="true"><path d="M15.01 3.316l-.478-.372a.365.365 0 00-.51.063L8.666 9.88a.32.32 0 01-.484.032l-.358-.325a.32.32 0 00-.484.032l-.378.48a.418.418 0 00.036.54l1.32 1.267c.16.15.41.14.56-.02l6.326-8.1a.366.366 0 00-.064-.512zm-4.1 0l-.478-.372a.365.365 0 00-.51.063L4.566 9.88a.32.32 0 01-.484.032L1.892 7.77a.366.366 0 00-.516.005l-.423.433a.364.364 0 00.006.514l3.255 3.185c.16.15.41.14.56-.02l6.326-8.1a.365.365 0 00-.064-.512z"/></svg>`;
}

// ---------- Waiting / name overlays ----------
function showNameModal() {
  els.nameModal.style.display = 'flex';
  els.waitingOverlay.style.display = 'none';
  els.waitingOverlay.classList.add('hidden');
  setTimeout(() => els.joinNameInput.focus(), 80);
}

function hideNameModal() {
  els.nameModal.style.display = 'none';
}

function showWaiting(name, roomName) {
  hideNameModal();
  const who = name ? ` as ${name}` : '';
  const room = roomName ? ` “${roomName}”` : '';
  els.waitingText.textContent = `Your request${who} was sent${room}. You'll enter as soon as the owner lets you in.`;
  els.waitingOverlay.classList.remove('hidden');
  els.waitingOverlay.style.display = 'flex';
}

function hideWaiting() {
  els.waitingOverlay.classList.add('hidden');
  els.waitingOverlay.style.display = 'none';
}

function enterAsMember(data) {
  state.room = data;
  state.userId = data.myUserId;
  state.pendingId = null;
  localStorage.setItem('ts_user_' + roomId, state.userId);
  localStorage.removeItem('ts_pending_' + roomId);
  hideNameModal();
  hideWaiting();
  initRoom();
}

// ---------- Rendering ----------
function renderHeader() {
  els.roomCode.textContent = '#' + state.room.id;
  els.roomName.value = state.room.name;
  const isOwner = me() && me().role === 'owner';
  els.roomName.readOnly = !isOwner;
  els.roomName.title = isOwner ? 'Click to rename room' : '';

  els.changeExpiryBtn.classList.toggle('hidden', !isOwner);
  els.deleteRoomBtn.classList.toggle('hidden', !isOwner);
  els.deleteRoomBtn.classList.toggle('flex', isOwner);
  els.leaveRoomBtn.classList.toggle('hidden', isOwner);
  els.leaveRoomBtn.classList.toggle('flex', !isOwner);
  if (els.clearChatBtn) {
    els.clearChatBtn.classList.toggle('hidden', !isOwner);
    els.clearChatBtn.classList.toggle('flex', isOwner);
  }
  els.expiryBadge.classList.remove('hidden');
  els.expiryBadge.classList.add('flex');

  clearInterval(state.expiryInterval);
  updateExpiryBadge();
  state.expiryInterval = setInterval(updateExpiryBadge, 1000);
}

function renderPending() {
  const isOwner = me() && me().role === 'owner';
  const list = (isOwner && state.room.pendingUsers) ? state.room.pendingUsers : [];
  const has = list.length > 0;
  els.pendingSection.classList.toggle('hidden', !has);
  if (els.pendingBadgeMobile) els.pendingBadgeMobile.classList.toggle('hidden', !has);
  els.pendingCount.textContent = `(${list.length})`;
  els.pendingList.innerHTML = '';
  if (!has) return;

  for (const p of list) {
    const row = document.createElement('div');
    row.className = 'bg-amber-500/10 border border-amber-500/20 rounded-xl p-2.5 fade-in';
    row.innerHTML = `
      <div class="flex items-center gap-2 mb-2">
        <div class="w-8 h-8 rounded-full bg-amber-500/30 flex items-center justify-center font-bold text-sm text-amber-100">
          ${escapeHtml((p.name || '?')[0] || '?').toUpperCase()}
        </div>
        <div class="flex-1 min-w-0">
          <div class="font-medium text-sm truncate">${escapeHtml(p.name)}</div>
          <div class="text-[11px] text-amber-200/70">Wants to join · ${timeAgo(p.requestedAt)}</div>
        </div>
      </div>
      <div class="flex gap-2">
        <button class="admit-btn flex-1 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold">Admit</button>
        <button class="deny-btn flex-1 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs font-semibold">Deny</button>
      </div>
    `;
    row.querySelector('.admit-btn').addEventListener('click', () => decidePending(p.id, true));
    row.querySelector('.deny-btn').addEventListener('click', () => decidePending(p.id, false));
    els.pendingList.appendChild(row);
  }
}

async function decidePending(pendingId, admit) {
  try {
    await api(`/api/rooms/${roomId}/${admit ? 'approve' : 'reject'}`, {
      method: 'POST',
      body: JSON.stringify({ actorUserId: state.userId, pendingId })
    });
    state.room.pendingUsers = (state.room.pendingUsers || []).filter(p => p.id !== pendingId);
    renderPending();
    showToast(admit ? 'Admitted' : 'Declined');
  } catch (e) { showToast(e.message, true); }
}

function renderUsers() {
  const sorted = [...state.room.users].sort((a, b) => {
    const order = { owner: 0, member: 1 };
    if ((order[a.role] ?? 9) !== (order[b.role] ?? 9)) return (order[a.role] ?? 9) - (order[b.role] ?? 9);
    return a.name.localeCompare(b.name);
  });
  els.userCount.textContent = `(${state.room.users.length})`;
  els.userList.innerHTML = '';
  for (const u of sorted) {
    const isMe = u.id === state.userId;
    const iAmOwner = me() && me().role === 'owner';
    const canRemove = iAmOwner && !isMe && u.role !== 'owner';
    const roleBadge = u.role === 'owner'
      ? '<span class="text-[10px] font-bold bg-gradient-to-r from-pink-600 to-purple-600 px-2 py-0.5 rounded-full">OWNER</span>'
      : '';
    const row = document.createElement('div');
    row.className = 'file-item flex items-center gap-3 p-2.5 rounded-lg fade-in';
    row.innerHTML = `
      <div class="relative">
        <div class="w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm ${isMe ? 'bg-gradient-to-br from-pink-500 to-indigo-500' : 'bg-slate-700'}">
          ${escapeHtml(u.name[0] || '?').toUpperCase()}
        </div>
        <span class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-slate-800 ${u.online ? 'bg-emerald-400' : 'bg-slate-500'}"></span>
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="font-medium truncate text-sm">${escapeHtml(u.name)}${isMe ? ' <span class="text-slate-500 text-xs">(you)</span>' : ''}</span>
          ${roleBadge}
        </div>
        <div class="text-[11px] text-slate-500">${u.online ? 'Online' : 'Offline'}</div>
      </div>
      ${canRemove ? `<div class="flex items-center gap-1 shrink-0">
        <button class="perm-btn p-1.5 rounded-md hover:bg-slate-700 text-slate-300" title="Change permissions">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
        </button>
        <button class="remove-btn px-2 py-1 rounded-md bg-slate-700 hover:bg-red-600/80 text-[11px] font-semibold transition" title="Remove ${escapeHtml(u.name)} from the room">Remove</button>
      </div>` : ''}
    `;
    const permBtn = row.querySelector('.perm-btn');
    if (permBtn) permBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPermModal(u);
    });
    const removeBtn = row.querySelector('.remove-btn');
    if (removeBtn) removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeMember(u);
    });
    els.userList.appendChild(row);
  }

  const m = me();
  if (m) {
    els.myInfo.innerHTML = `You are <span class="text-slate-300 font-semibold">${escapeHtml(m.name)}</span> · <span class="text-slate-400 capitalize">${m.role}</span>`;
  }
}

function buildFolderPath(folderId) {
  const path = [];
  let cur = state.room.files.find(f => f.id === folderId);
  while (cur) {
    path.unshift(cur);
    cur = cur.parentId ? state.room.files.find(f => f.id === cur.parentId) : null;
  }
  return path;
}

function navigateTo(folderId) {
  if (!state.room) return;
  const folder = state.room.files.find(f => f.id === folderId && f.type === 'folder');
  if (!folder) return;
  state.currentFolder = folderId;
  renderFiles();
}

function navigateUp() {
  if (!state.room) return;
  const cur = state.room.files.find(f => f.id === state.currentFolder);
  if (!cur || !cur.parentId) return;
  state.currentFolder = cur.parentId;
  renderFiles();
}

function navigateToRoot() {
  if (!state.room) return;
  state.currentFolder = 'root';
  renderFiles();
}

function renderBreadcrumb() {
  state.folderPath = buildFolderPath(state.currentFolder);
  els.breadcrumb.innerHTML = '';
  state.folderPath.forEach((f, i) => {
    const isLast = i === state.folderPath.length - 1;
    const btn = document.createElement('button');
    btn.className = 'px-2 py-1 rounded hover:bg-slate-700 transition truncate max-w-[200px] ' + (isLast ? 'text-white font-semibold cursor-default' : 'text-slate-400 hover:text-slate-200');
    btn.textContent = i === 0 ? '📁 Root' : '📁 ' + f.name;
    btn.title = i === 0 ? 'Root' : f.name;
    if (!isLast) btn.addEventListener('click', () => navigateTo(f.id));
    els.breadcrumb.appendChild(btn);
    if (!isLast) {
      const sep = document.createElement('span');
      sep.className = 'text-slate-600 mx-0.5';
      sep.textContent = '/';
      els.breadcrumb.appendChild(sep);
    }
  });
  const atRoot = state.currentFolder === 'root';
  els.backBtn.disabled = atRoot;
  els.backBtn.title = atRoot ? 'Already at root' : 'Go to parent folder (Backspace / Alt+↑)';
}

function renderFiles() {
  renderBreadcrumb();
  const children = state.room.files.filter(f => f.parentId === state.currentFolder);
  children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  els.fileList.innerHTML = '';
  if (children.length === 0) {
    els.emptyFiles.classList.remove('hidden');
  } else {
    els.emptyFiles.classList.add('hidden');
  }

  for (const node of children) {
    const row = document.createElement('div');
    row.className = 'file-item flex items-center gap-3 px-3 py-2 rounded-lg fade-in group';
    const canDelete = can('can_delete');
    const canRename = can('can_rename') || can('can_upload');
    const uploader = node.uploadedByName || node.createdByName || '';
    const date = node.uploadedAt || node.createdAt;
    const isFolder = node.type === 'folder';
    const iconHTML = isFolder ? folderIconHTML() : fileIconHTML(node.name);

    row.innerHTML = `
      <div class="w-9 flex items-center justify-center shrink-0">${iconHTML}</div>
      <div class="flex-1 min-w-0">
        <div class="font-medium text-sm truncate cursor-pointer file-name">${escapeHtml(node.name)}</div>
        <div class="text-xs text-slate-500 flex items-center gap-2">
          ${node.type === 'file' ? `<span>${formatSize(node.size)}</span> ·` : ''}
          <span>${uploader ? 'By ' + escapeHtml(uploader) : ''}</span>
          ${date ? `<span>· ${timeAgo(date)}</span>` : ''}
        </div>
      </div>
      <div class="opacity-0 group-hover:opacity-100 transition flex items-center gap-1 shrink-0">
        ${isFolder
          ? `<a href="/api/rooms/${state.room.id}/folders/${node.id}/zip?userId=${state.userId}" class="p-2 hover:bg-slate-700 rounded" title="Download folder as ZIP" download>
               <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"/></svg>
             </a>`
          : `<a href="/api/rooms/${state.room.id}/files/${node.id}/download?userId=${state.userId}" download class="p-2 hover:bg-slate-700 rounded" title="Download">
               <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
             </a>`
        }
        ${canRename ? `<button class="rename-btn p-2 hover:bg-slate-700 rounded" title="Rename">
             <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
           </button>` : ''}
        ${canDelete && node.id !== 'root' ? `<button class="delete-btn p-2 hover:bg-red-600/30 text-red-400 rounded" title="Delete">
             <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/></svg>
           </button>` : ''}
      </div>
    `;

    const nameEl = row.querySelector('.file-name');
    const openNode = () => {
      if (node.type === 'folder') {
        navigateTo(node.id);
      } else {
        window.open(`/api/rooms/${state.room.id}/files/${node.id}/download?userId=${state.userId}`, '_blank');
      }
    };
    nameEl.addEventListener('click', openNode);
    if (isFolder) {
      row.classList.add('cursor-pointer');
      row.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('a')) return;
        openNode();
      });
      row.addEventListener('dblclick', openNode);
    } else {
      row.addEventListener('dblclick', openNode);
    }

    const renameBtn = row.querySelector('.rename-btn');
    if (renameBtn) renameBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const newName = await Dialog.prompt(`Enter a new name for "${node.name}":`, node.name, 'Rename');
      if (newName && newName !== node.name) renameFile(node.id, newName);
    });

    const delBtn = row.querySelector('.delete-btn');
    if (delBtn) delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const msg = isFolder
        ? `Delete "${node.name}" and everything inside it? This cannot be undone.`
        : `Delete "${node.name}"? This cannot be undone.`;
      const ok = await Dialog.confirm(msg, 'Delete item?', { okText: 'Delete', danger: true });
      if (ok) deleteFile(node.id);
    });

    els.fileList.appendChild(row);
  }
}

function seenEntries(msg) {
  const raw = msg.seenBy || {};
  return Object.entries(raw).map(([id, info]) => {
    if (info && typeof info === 'object') return { id, ts: info.ts, name: info.name };
    return { id, ts: info, name: null };
  }).filter(e => e.id !== msg.userId);
}

function renderMessages() {
  const wasAtBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 80;
  els.messages.innerHTML = '';
  const myRole = me() && me().role;
  const myId = state.userId;

  for (const msg of state.room.messages) {
    const isMe = msg.userId === myId;
    const canDelete = isMe || myRole === 'owner';
    const seen = seenEntries(msg);
    const seenClass = seen.length ? 'seen' : 'sent';
    const reply = msg.replyTo;

    const wrapper = document.createElement('div');
    wrapper.className = 'flex fade-in group/message relative ' + (isMe ? 'justify-end' : 'justify-start');
    wrapper.dataset.msgId = msg.id;
    wrapper.innerHTML = `
      <div class="max-w-[80%] ${isMe ? 'items-end' : 'items-start'} flex flex-col">
        ${!isMe ? `<span class="text-[11px] text-slate-500 mb-0.5 ml-2">${escapeHtml(msg.userName)}${msg.role === 'owner' ? ' <span class="text-pink-400 font-semibold">(OWNER)</span>' : ''} · ${formatTime(msg.ts)}</span>` : ''}
        <div class="relative flex items-center gap-1 ${isMe ? 'flex-row-reverse' : ''}">
          <div class="${isMe ? 'bubble-me' : 'bubble-other'} px-3 py-2 text-sm shadow break-words">
            ${reply ? `<div class="reply-quote" data-jump="${escapeHtml(reply.id)}">
              <div class="reply-quote-name">${escapeHtml(reply.userName || 'Message')}</div>
              <div class="reply-quote-text">${escapeHtml(reply.text || '')}</div>
            </div>` : ''}
            ${escapeHtml(msg.text)}
          </div>
          <div class="opacity-0 group-hover/message:opacity-100 transition flex items-center gap-0.5 shrink-0">
            <button data-reply-id="${msg.id}" class="msg-reply p-1.5 rounded-full hover:bg-slate-700 text-slate-300" title="Reply">
              <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/></svg>
            </button>
            ${canDelete ? `<button data-msg-id="${msg.id}" class="msg-del p-1.5 rounded-full hover:bg-red-600/20 text-red-400" title="Delete message">
              <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/></svg>
            </button>` : ''}
          </div>
        </div>
        ${isMe ? `<span class="text-[11px] text-slate-500 mt-0.5 mr-1 flex items-center gap-1">
          ${formatTime(msg.ts)}
          <button class="ticks ${seenClass} seen-btn" title="${seen.length ? 'Seen · tap for details' : 'Sent · tap for details'}" aria-label="Message info">${ticksSVG()}</button>
        </span>` : ''}
      </div>
    `;

    const quote = wrapper.querySelector('.reply-quote');
    if (quote) quote.addEventListener('click', () => scrollToMessage(reply.id));

    const replyBtn = wrapper.querySelector('.msg-reply');
    if (replyBtn) replyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setReplyTo(msg);
    });

    const delBtn = wrapper.querySelector('.msg-del');
    if (delBtn) {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await Dialog.confirm(
          isMe ? 'Unsend this message? It will be removed for everyone.'
               : 'Delete this message for everyone?',
          'Delete message?',
          { okText: 'Delete', danger: true }
        );
        if (ok) deleteMessage(msg.id);
      });
    }

    const seenBtn = wrapper.querySelector('.seen-btn');
    if (seenBtn) seenBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSeenModal(msg);
    });

    els.messages.appendChild(wrapper);
  }
  if (wasAtBottom) els.messages.scrollTop = els.messages.scrollHeight;
}

function setReplyTo(msg) {
  state.replyTo = { id: msg.id, userName: msg.userName, text: msg.text };
  els.replyToName.textContent = msg.userName || 'Message';
  els.replyToText.textContent = msg.text || '';
  els.replyBar.classList.remove('hidden');
  els.chatInput.focus();
}

function clearReply() {
  state.replyTo = null;
  els.replyBar.classList.add('hidden');
}

function scrollToMessage(id) {
  const el = els.messages.querySelector(`[data-msg-id="${id}"]`);
  if (!el) {
    showToast('Original message is no longer available');
    return;
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('msg-highlight');
  setTimeout(() => el.classList.remove('msg-highlight'), 1600);
}

function openSeenModal(msg) {
  state.seenTarget = msg;
  const seen = seenEntries(msg).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const seenIds = new Set(seen.map(s => s.id));
  const others = (state.room.users || []).filter(u => u.id !== msg.userId && !seenIds.has(u.id));

  let html = '';
  html += `<div>
    <p class="text-xs uppercase tracking-wide text-slate-400 font-semibold mb-2">Seen by</p>`;
  if (!seen.length) {
    html += `<p class="text-slate-500 text-sm">No one has seen this yet.</p>`;
  } else {
    html += `<div class="space-y-2">`;
    for (const s of seen) {
      const name = s.name || (state.room.users.find(u => u.id === s.id) || {}).name || 'Someone';
      html += `<div class="flex items-center justify-between gap-3">
        <span class="font-medium truncate">${escapeHtml(name)}</span>
        <span class="text-slate-400 text-xs shrink-0">${s.ts ? formatSeenAt(s.ts) : ''}</span>
      </div>`;
    }
    html += `</div>`;
  }
  html += `</div>`;

  html += `<div>
    <p class="text-xs uppercase tracking-wide text-slate-400 font-semibold mb-2">Not seen yet</p>`;
  if (!others.length) {
    html += `<p class="text-slate-500 text-sm">${seen.length ? 'Everyone currently in the room has seen it.' : 'Waiting for others to open the chat.'}</p>`;
  } else {
    html += `<div class="space-y-1.5">`;
    for (const u of others) {
      html += `<div class="text-slate-300">${escapeHtml(u.name)}</div>`;
    }
    html += `</div>`;
  }
  html += `</div>`;

  els.seenBody.innerHTML = html;
  els.seenModal.style.display = 'flex';
}

function closeSeenModal() {
  els.seenModal.style.display = 'none';
  state.seenTarget = null;
}

async function deleteMessage(msgId) {
  try {
    await api(`/api/rooms/${roomId}/messages/${msgId}?userId=${state.userId}`, { method: 'DELETE' });
    state.room.messages = state.room.messages.filter(m => m.id !== msgId);
    renderMessages();
  } catch (e) { showToast(e.message, true); }
}

let permTarget = null;
function openPermModal(user) {
  permTarget = user;
  if (!els.permModal) return;
  els.permTitle.textContent = user.name;
  els.permSubtitle.textContent = 'Toggle what this member can do';

  if (user.role === 'owner') {
    els.permBody.innerHTML = '<p class="text-sm text-slate-400">The room owner has full permissions and cannot be restricted.</p>';
    els.permModal.style.display = 'flex';
    return;
  }

  const fields = [
    { key: 'can_chat', label: 'Can send chat messages', icon: '💬' },
    { key: 'can_upload', label: 'Can upload files', icon: '⬆️' },
    { key: 'can_create_folder', label: 'Can create folders', icon: '📁' },
    { key: 'can_delete', label: 'Can delete files/folders', icon: '🗑️' },
    { key: 'can_rename', label: 'Can rename items', icon: '✏️' },
  ];

  els.permBody.innerHTML = '';
  for (const f of fields) {
    const enabled = user.permissions && user.permissions[f.key] === true;
    const row = document.createElement('label');
    row.className = 'flex items-center justify-between p-3 bg-slate-900/50 rounded-lg cursor-pointer hover:bg-slate-900';
    row.innerHTML = `
      <span class="flex items-center gap-2 text-sm"><span>${f.icon}</span>${f.label}</span>
      <div class="relative">
        <input type="checkbox" data-key="${f.key}" ${enabled ? 'checked' : ''} class="peer sr-only perm-toggle" />
        <div class="w-11 h-6 bg-slate-600 rounded-full peer-checked:bg-pink-500 transition"></div>
        <div class="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition peer-checked:translate-x-5"></div>
      </div>
    `;
    els.permBody.appendChild(row);
  }
  els.permBody.querySelectorAll('.perm-toggle').forEach(cb => {
    cb.addEventListener('change', () => {
      updatePermissions(user.id, { [cb.dataset.key]: cb.checked });
      if (permTarget && permTarget.id === user.id) {
        permTarget.permissions = permTarget.permissions || {};
        permTarget.permissions[cb.dataset.key] = cb.checked;
      }
    });
  });
  els.permModal.style.display = 'flex';
}

function closePermModalFn() {
  if (els.permModal) els.permModal.style.display = 'none';
  permTarget = null;
}

async function updatePermissions(targetUserId, perms) {
  try {
    await api(`/api/rooms/${roomId}/users/${targetUserId}/permissions`, {
      method: 'PATCH',
      body: JSON.stringify({ actorUserId: state.userId, permissions: perms })
    });
    const u = state.room.users.find(x => x.id === targetUserId);
    if (u) u.permissions = { ...(u.permissions || {}), ...perms };
    showToast('Permissions updated');
  } catch (e) { showToast(e.message, true); }
}

async function removeMember(user) {
  const ok = await Dialog.confirm(
    `${user.name} will be kicked out immediately and will need your approval to rejoin.`,
    `Remove ${user.name}?`,
    { okText: 'Remove', danger: true }
  );
  if (!ok) return;
  try {
    await api(`/api/rooms/${roomId}/users/${user.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ actorUserId: state.userId })
    });
    state.room.users = state.room.users.filter(u => u.id !== user.id);
    renderUsers();
    showToast(`${user.name} was removed`);
  } catch (e) { showToast(e.message, true); }
}

async function clearChat() {
  const ok = await Dialog.confirm(
    'Every message in this room will be deleted for everyone. This cannot be undone.',
    'Clear all chat?',
    { okText: 'Clear chat', danger: true }
  );
  if (!ok) return;
  try {
    await api(`/api/rooms/${roomId}/messages?userId=${state.userId}`, { method: 'DELETE' });
    state.room.messages = [];
    clearReply();
    renderMessages();
    showToast('Chat cleared');
  } catch (e) { showToast(e.message, true); }
}

function updateChatPermission() {
  const chatOk = can('can_chat');
  els.chatInput.disabled = !chatOk;
  els.chatInput.placeholder = chatOk ? 'Type a message...' : 'Chat disabled';
  els.chatMuted.classList.toggle('hidden', chatOk);
  els.chatForm.querySelector('button').disabled = !chatOk;
}

function updateFilePermissions() {
  els.newFolderBtn.disabled = !can('can_create_folder');
  els.newFolderBtn.classList.toggle('opacity-50', !can('can_create_folder'));
  els.fileInput.disabled = !can('can_upload');
  els.folderInput.disabled = !can('can_upload');
  els.folderInput.parentElement.classList.toggle('opacity-50', !can('can_upload'));
  els.folderInput.parentElement.classList.toggle('pointer-events-none', !can('can_upload'));
}

function updateRoomNameEditable() {
  els.roomName.readOnly = !(me() && me().role === 'owner');
}

function markVisibleSeen() {
  if (!state.room || !state.userId) return;
  if (document.visibilityState !== 'visible') return;
  const unseen = state.room.messages
    .filter(m => m.userId !== state.userId && !(m.seenBy && m.seenBy[state.userId]))
    .map(m => m.id);
  if (!unseen.length) return;
  socket.emit('mark_seen', { roomId, userId: state.userId, messageIds: unseen });
}

// ---------- API actions ----------
async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function requestJoin(name) {
  try {
    const data = await api(`/api/rooms/${roomId}/join`, {
      method: 'POST',
      body: JSON.stringify({ name, userId: state.userId || state.pendingId || undefined })
    });
    if (data.status === 'pending') {
      state.pendingId = data.pendingId;
      localStorage.setItem('ts_pending_' + roomId, data.pendingId);
      localStorage.setItem('ts_lastname', name);
      showWaiting(data.name, data.roomName);
      socket.emit('wait_approval', { roomId, pendingId: data.pendingId });
      return;
    }
    localStorage.setItem('ts_lastname', name);
    enterAsMember(data);
  } catch (e) {
    showToast(e.message, true);
  }
}

let uploadUi = { lastEmit: 0, hideTimer: null, local: false };

function setUploadProgress({ title, detail, percent, error, done, local = true }) {
  if (!els.uploadProgress) return;
  const pct = Math.max(0, Math.min(100, Math.round(percent || 0)));
  els.uploadProgress.classList.remove('hidden');
  if (els.uploadProgressTitle) els.uploadProgressTitle.textContent = title || 'Uploading…';
  if (els.uploadProgressDetail) {
    els.uploadProgressDetail.textContent = detail || '';
    els.uploadProgressDetail.classList.toggle('text-red-400', !!error);
    els.uploadProgressDetail.classList.toggle('text-slate-400', !error);
  }
  if (els.uploadProgressPct) {
    els.uploadProgressPct.textContent = done && !error ? 'Done' : (error ? 'Failed' : pct + '%');
    els.uploadProgressPct.classList.toggle('text-red-400', !!error);
    els.uploadProgressPct.classList.toggle('text-emerald-300', !!(done && !error));
    els.uploadProgressPct.classList.toggle('text-pink-300', !error && !done);
  }
  if (els.uploadProgressBar) {
    els.uploadProgressBar.style.width = pct + '%';
    els.uploadProgressBar.classList.toggle('bg-red-500', !!error);
  }
  uploadUi.local = local;
  clearTimeout(uploadUi.hideTimer);
  if (done || error) {
    uploadUi.hideTimer = setTimeout(hideUploadProgress, error ? 4000 : 1800);
  }
}

function hideUploadProgress() {
  if (!els.uploadProgress) return;
  els.uploadProgress.classList.add('hidden');
  if (els.uploadProgressBar) els.uploadProgressBar.style.width = '0%';
  uploadUi.local = false;
}

function emitUploadProgress(payload) {
  const now = Date.now();
  if (!payload.done && !payload.error && now - uploadUi.lastEmit < 250) return;
  uploadUi.lastEmit = now;
  if (!state.userId) return;
  socket.emit('upload_progress', {
    roomId,
    userId: state.userId,
    percent: payload.percent || 0,
    label: payload.title || 'Uploading…',
    detail: payload.detail || '',
    done: !!payload.done,
    error: !!payload.error
  });
}

async function uploadFiles(fileList, paths = null, folderPaths = null) {
  if (!can('can_upload')) return showToast('No upload permission', true);
  const files = Array.from(fileList);
  if (files.length === 0 && (!folderPaths || folderPaths.length === 0)) return;
  const fd = new FormData();
  files.forEach(f => fd.append('files', f));
  fd.append('userId', state.userId);
  fd.append('parentId', state.currentFolder);
  if (paths && paths.length === files.length) {
    fd.append('paths', JSON.stringify(paths));
  }
  if (folderPaths && folderPaths.length) {
    fd.append('folderPaths', JSON.stringify(folderPaths));
  }
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  const folderCount = folderPaths && folderPaths.length ? folderPaths.length : 0;
  const title = folderCount
    ? `Uploading folder (${files.length} file${files.length === 1 ? '' : 's'})`
    : `Uploading ${files.length} file${files.length === 1 ? '' : 's'}`;
  const start = { title, detail: formatSize(totalSize) + ' total', percent: 0, local: true };
  setUploadProgress(start);
  emitUploadProgress(start);
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/rooms/${roomId}/upload`);
    await new Promise((resolve, reject) => {
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const percent = e.total ? (e.loaded / e.total) * 100 : 0;
        const payload = {
          title,
          detail: `${formatSize(e.loaded)} / ${formatSize(e.total)}`,
          percent,
          local: true
        };
        setUploadProgress(payload);
        emitUploadProgress(payload);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
        else {
          try { reject(new Error(JSON.parse(xhr.response).error || 'Upload failed')); }
          catch (e) { reject(new Error('Upload failed')); }
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(fd);
    });
    const done = {
      title: folderCount ? 'Folder uploaded' : 'Upload complete',
      detail: `${files.length} file${files.length === 1 ? '' : 's'} · ${formatSize(totalSize)}`,
      percent: 100,
      done: true,
      local: true
    };
    setUploadProgress(done);
    emitUploadProgress(done);
    showToast(`Uploaded ${files.length} file(s)${folderCount ? ` in ${folderCount} folder(s)` : ''} successfully`);
  } catch (e) {
    const fail = { title: 'Upload failed', detail: e.message, percent: 0, error: true, local: true };
    setUploadProgress(fail);
    emitUploadProgress(fail);
    showToast('Upload failed: ' + e.message, true);
  }
}

async function createFolder() {
  if (!can('can_create_folder')) return showToast('No permission to create folders', true);
  const name = await Dialog.prompt('Enter a name for the new folder:', 'New Folder', 'New Folder');
  if (!name || !name.trim()) return;
  try {
    await api(`/api/rooms/${roomId}/folders`, {
      method: 'POST',
      body: JSON.stringify({ userId: state.userId, name: name.trim(), parentId: state.currentFolder })
    });
  } catch (e) { showToast(e.message, true); }
}

async function deleteFile(fileId) {
  try {
    await api(`/api/rooms/${roomId}/files/${fileId}?userId=${state.userId}`, { method: 'DELETE' });
  } catch (e) { showToast(e.message, true); }
}

async function renameFile(fileId, newName) {
  try {
    await api(`/api/rooms/${roomId}/files/${fileId}`, {
      method: 'PATCH',
      body: JSON.stringify({ userId: state.userId, name: newName })
    });
  } catch (e) { showToast(e.message, true); }
}

async function renameRoom(newName) {
  try {
    await api(`/api/rooms/${roomId}`, {
      method: 'PATCH',
      body: JSON.stringify({ userId: state.userId, name: newName })
    });
  } catch (e) { showToast(e.message, true); }
}

// ---------- Chat ----------
function sendMessage() {
  const text = els.chatInput.value.trim();
  if (!text) return;
  socket.emit('send_message', {
    roomId,
    userId: state.userId,
    text,
    replyToId: state.replyTo ? state.replyTo.id : undefined
  });
  els.chatInput.value = '';
  clearReply();
  state.isTyping = false;
  socket.emit('typing', { roomId, userId: state.userId, isTyping: false });
}

els.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});

els.chatInput.addEventListener('input', () => {
  if (!can('can_chat')) return;
  if (!state.isTyping) {
    state.isTyping = true;
    socket.emit('typing', { roomId, userId: state.userId, isTyping: true });
  }
  clearTimeout(state.typingTimeout);
  state.typingTimeout = setTimeout(() => {
    state.isTyping = false;
    socket.emit('typing', { roomId, userId: state.userId, isTyping: false });
  }, 1500);
});

els.cancelReplyBtn.addEventListener('click', clearReply);

// ---------- Socket events ----------
socket.on('connect', () => {
  if (state.room && state.userId) {
    socket.emit('join_room', { roomId, userId: state.userId });
  } else if (state.pendingId) {
    socket.emit('wait_approval', { roomId, pendingId: state.pendingId });
  }
});

socket.on('new_message', (msg) => {
  if (!state.room) return;
  if (!msg.seenBy) msg.seenBy = {};
  state.room.messages.push(msg);
  if (state.room.messages.length > 500) state.room.messages = state.room.messages.slice(-500);
  renderMessages();
  if (msg.userId !== state.userId) markVisibleSeen();
});

socket.on('users_updated', ({ users }) => {
  if (!state.room) return;
  state.room.users = users;
  renderUsers();
  updateChatPermission();
  updateFilePermissions();
});

socket.on('presence', ({ users }) => {
  if (!state.room) return;
  const onlineMap = {};
  users.forEach(u => onlineMap[u.id] = u.online);
  state.room.users.forEach(u => { u.online = onlineMap[u.id] || false; });
  renderUsers();
});

socket.on('files_updated', ({ files }) => {
  if (!state.room) return;
  state.room.files = files;
  if (!files.find(f => f.id === state.currentFolder)) state.currentFolder = 'root';
  renderFiles();
});

socket.on('room_updated', ({ name, expiresAt }) => {
  if (!state.room) return;
  if (name) state.room.name = name;
  if (expiresAt) state.room.expiresAt = expiresAt;
  renderHeader();
});

socket.on('message_deleted', ({ messageId }) => {
  if (!state.room) return;
  const before = state.room.messages.length;
  state.room.messages = state.room.messages.filter(m => m.id !== messageId);
  if (state.room.messages.length !== before) renderMessages();
});

socket.on('seen_update', ({ updates }) => {
  if (!state.room || !updates) return;
  let changed = false;
  for (const u of updates) {
    const msg = state.room.messages.find(m => m.id === u.messageId);
    if (!msg) continue;
    if (!msg.seenBy) msg.seenBy = {};
    msg.seenBy[u.userId] = { ts: u.ts, name: u.name };
    changed = true;
  }
  if (changed) {
    renderMessages();
    if (state.seenTarget) {
      const fresh = state.room.messages.find(m => m.id === state.seenTarget.id);
      if (fresh) openSeenModal(fresh);
    }
  }
});

socket.on('pending_updated', ({ pendingUsers }) => {
  if (!state.room) return;
  state.room.pendingUsers = pendingUsers || [];
  renderPending();
});

socket.on('join_request', ({ name }) => {
  if (me() && me().role === 'owner') {
    showToast(`${name} wants to join`);
  }
});

socket.on('join_approved', (data) => {
  showToast('You were admitted to the room');
  enterAsMember(data);
});

socket.on('join_rejected', ({ reason }) => {
  localStorage.removeItem('ts_pending_' + roomId);
  state.pendingId = null;
  const msg = {
    denied: 'The owner declined your request',
    expired: 'This room has expired',
    deleted: 'This room was deleted',
    left: 'Join request cancelled',
    not_found: 'This room is no longer available'
  }[reason] || 'You cannot join this room';
  showToast(msg, reason !== 'left');
  setTimeout(() => window.location.href = '/', 1800);
});

socket.on('forced_leave', ({ reason } = {}) => {
  clearIdentity();
  if (reason === 'removed') {
    showToast('The owner removed you from the room', true);
  } else {
    showToast('You left the room');
  }
  setTimeout(() => window.location.href = '/', 800);
});

socket.on('chat_cleared', ({ clearedByName }) => {
  if (!state.room) return;
  state.room.messages = [];
  clearReply();
  renderMessages();
  showToast(`${clearedByName || 'The owner'} cleared the chat`);
});

socket.on('room_deleted', ({ reason }) => {
  clearInterval(state.expiryInterval);
  clearIdentity();
  showToast(reason === 'expired' ? 'This room has expired and was deleted' : 'This room was deleted by the owner', true);
  setTimeout(() => window.location.href = '/', 2000);
});

socket.on('upload_progress', ({ userId, userName, percent, label, detail, done, error }) => {
  if (userId === state.userId) return;
  setUploadProgress({
    title: `${userName || 'Someone'} — ${label || 'Uploading…'}`,
    detail: detail || '',
    percent,
    done,
    error,
    local: false
  });
});

socket.on('activity', ({ text }) => {
  els.activityBar.textContent = text;
  els.activityBar.classList.remove('hidden');
  clearTimeout(els.activityBar._t);
  els.activityBar._t = setTimeout(() => els.activityBar.classList.add('hidden'), 4000);
});

socket.on('typing_update', ({ userName, isTyping }) => {
  if (isTyping) {
    els.typingIndicator.textContent = `${userName} is typing...`;
    els.typingIndicator.classList.remove('hidden');
  } else {
    els.typingIndicator.classList.add('hidden');
  }
});

socket.on('error_msg', (msg) => showToast(msg, true));

// ---------- Event listeners ----------
els.copyLinkBtn.addEventListener('click', async () => {
  const link = window.location.origin + '/room/' + state.room.id;
  try {
    await navigator.clipboard.writeText(link);
    showToast('Invite link copied!');
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = link;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showToast('Invite link copied!'); }
    catch (_) { await Dialog.alert(link, 'Copy this invite link'); }
    document.body.removeChild(ta);
  }
});

els.newFolderBtn.addEventListener('click', createFolder);

els.fileInput.addEventListener('change', (e) => {
  uploadFiles(e.target.files);
  e.target.value = '';
});

els.folderInput.addEventListener('click', async (e) => {
  if (window.showDirectoryPicker) {
    e.preventDefault();
    try {
      const dirHandle = await window.showDirectoryPicker();
      const { files, folderPaths } = await readDirHandle(dirHandle, dirHandle.name);
      const paths = files.map(f => f.relPath);
      await uploadFiles(files, paths, folderPaths);
    } catch (err) {
      /* cancelled */
    }
  }
});

els.folderInput.addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  const paths = files.map(f => f.webkitRelativePath || f.name);
  const folderPaths = new Set();
  for (const p of paths) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) folderPaths.add(parts.slice(0, i).join('/'));
  }
  uploadFiles(files, paths, [...folderPaths]);
  e.target.value = '';
});

function readEntry(entry, pathPrefix = '') {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(file => {
        Object.defineProperty(file, 'relPath', { value: pathPrefix + file.name });
        resolve({ files: [file], folderPaths: pathPrefix ? [pathPrefix.replace(/\/$/, '')] : [] });
      }, () => resolve({ files: [], folderPaths: [] }));
    } else if (entry.isDirectory) {
      const dirPath = pathPrefix + entry.name;
      const reader = entry.createReader();
      const allEntries = [];
      const readBatch = () => {
        reader.readEntries(async (batch) => {
          if (batch.length === 0) {
            const files = [];
            const folders = [dirPath];
            for (const child of allEntries) {
              const got = await readEntry(child, dirPath + '/');
              files.push(...got.files);
              folders.push(...got.folderPaths);
            }
            resolve({ files, folderPaths: folders });
          } else {
            allEntries.push(...batch);
            readBatch();
          }
        }, () => resolve({ files: [], folderPaths: [dirPath] }));
      };
      readBatch();
    } else {
      resolve({ files: [], folderPaths: [] });
    }
  });
}

async function getDroppedFiles(dt) {
  const items = dt.items;
  if (items && items.length && items[0].webkitGetAsEntry) {
    const files = [];
    const folderPaths = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry();
      if (!entry) continue;
      const got = await readEntry(entry, '');
      files.push(...got.files);
      folderPaths.push(...got.folderPaths);
    }
    return { files, folderPaths: [...new Set(folderPaths)] };
  }
  return { files: Array.from(dt.files || []), folderPaths: [] };
}

async function readDirHandle(dirHandle, baseName) {
  const files = [];
  const folderPaths = [];
  async function walk(handle, path) {
    if (handle.kind === 'file') {
      const file = await handle.getFile();
      Object.defineProperty(file, 'relPath', { value: path });
      files.push(file);
    } else if (handle.kind === 'directory') {
      folderPaths.push(path);
      for await (const [name, child] of handle.entries()) {
        await walk(child, path ? path + '/' + name : name);
      }
    }
  }
  await walk(dirHandle, baseName);
  return { files, folderPaths };
}

;['dragenter', 'dragover'].forEach(ev => {
  els.dropZone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    if (can('can_upload')) els.dropOverlay.classList.remove('hidden');
  });
});
;['dragleave', 'drop'].forEach(ev => {
  els.dropZone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    els.dropOverlay.classList.add('hidden');
  });
});
els.dropZone.addEventListener('drop', async (e) => {
  const { files: dropped, folderPaths } = await getDroppedFiles(e.dataTransfer);
  if (dropped.length || (folderPaths && folderPaths.length)) {
    const paths = dropped.map(f => f.relPath || f.name);
    const hasFolderStructure = dropped.some(f => f.relPath && f.relPath.includes('/'));
    uploadFiles(
      dropped,
      hasFolderStructure ? paths : null,
      folderPaths && folderPaths.length ? folderPaths : null
    );
  }
});

els.roomName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.target.blur();
    const newName = e.target.value.trim();
    if (newName && newName !== state.room.name) renameRoom(newName);
    else e.target.value = state.room.name;
  } else if (e.key === 'Escape') {
    e.target.value = state.room.name;
    e.target.blur();
  }
});
els.roomName.addEventListener('blur', () => {
  const newName = els.roomName.value.trim();
  if (newName && newName !== state.room.name) renameRoom(newName);
  else els.roomName.value = state.room.name;
});

els.joinNameBtn.addEventListener('click', () => {
  const name = els.joinNameInput.value.trim() || localStorage.getItem('ts_lastname') || ('Guest_' + Math.floor(Math.random() * 1000));
  requestJoin(name);
});
els.joinNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.joinNameBtn.click(); });

els.changeExpiryBtn.addEventListener('click', () => {
  const hoursLeft = Math.max(1, (state.room.expiresAt - Date.now()) / 3600000);
  els.expirySelect.value = nearestExpiryOption(hoursLeft);
  els.expiryModal.style.display = 'flex';
});
els.closeExpiryModal.addEventListener('click', () => { els.expiryModal.style.display = 'none'; });
els.expiryModal.addEventListener('click', (e) => { if (e.target === els.expiryModal) els.expiryModal.style.display = 'none'; });
els.saveExpiryBtn.addEventListener('click', () => {
  changeExpiry(Number(els.expirySelect.value));
});

els.deleteRoomBtn.addEventListener('click', deleteRoom);
els.leaveRoomBtn.addEventListener('click', leaveRoom);
if (els.clearChatBtn) els.clearChatBtn.addEventListener('click', clearChat);
if (els.closePermModal) els.closePermModal.addEventListener('click', closePermModalFn);
if (els.permModal) els.permModal.addEventListener('click', (e) => { if (e.target === els.permModal) closePermModalFn(); });

els.closeSeenModal.addEventListener('click', closeSeenModal);
els.seenModal.addEventListener('click', (e) => { if (e.target === els.seenModal) closeSeenModal(); });

els.cancelWaitBtn.addEventListener('click', async () => {
  const id = state.pendingId;
  if (id) {
    try {
      await api(`/api/rooms/${roomId}/leave`, {
        method: 'POST',
        body: JSON.stringify({ userId: id })
      });
    } catch (e) { /* ignore */ }
  }
  clearIdentity();
  window.location.href = '/';
});

els.backBtn.addEventListener('click', navigateUp);
els.homeBtn.addEventListener('click', navigateToRoot);

els.downloadZipBtn.addEventListener('click', (e) => {
  e.preventDefault();
  if (!state.room) return;
  const folderId = state.currentFolder || 'root';
  const url = `/api/rooms/${roomId}/folders/${folderId}/zip?userId=${state.userId}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast('Preparing ZIP download…');
});

document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable;
  if (isTyping) return;
  const dialogOpen = document.getElementById('dialog')?.style?.display === 'flex'
                  || els.expiryModal?.style?.display === 'flex'
                  || els.seenModal?.style?.display === 'flex'
                  || els.permModal?.style?.display === 'flex'
                  || els.nameModal?.style?.display === 'flex';
  if (dialogOpen) return;

  if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) {
    e.preventDefault();
    navigateUp();
  } else if (e.key === 'Home' || (e.altKey && (e.key === 'h' || e.key === 'H'))) {
    e.preventDefault();
    navigateToRoot();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') markVisibleSeen();
});

els.toggleSidebar.addEventListener('click', () => {
  state.sidebarOpen = !state.sidebarOpen;
  if (state.sidebarOpen) {
    els.sidebar.classList.remove('hidden');
    els.sidebar.classList.add('flex');
    els.sidebar.style.position = 'absolute';
    els.sidebar.style.top = '56px';
    els.sidebar.style.bottom = '0';
    els.sidebar.style.left = '0';
    els.sidebar.style.zIndex = '30';
    els.sidebar.style.width = '280px';
  } else {
    els.sidebar.classList.add('hidden');
    els.sidebar.classList.remove('flex');
    els.sidebar.style = '';
  }
});

// ---------- Init ----------
async function loadRoom() {
  if (state.userId) {
    try {
      const data = await api(`/api/rooms/${roomId}?userId=${state.userId}`);
      enterAsMember(data);
      return;
    } catch (e) {
      localStorage.removeItem('ts_user_' + roomId);
      state.userId = null;
    }
  }

  if (state.pendingId) {
    try {
      const data = await api(`/api/rooms/${roomId}/join`, {
        method: 'POST',
        body: JSON.stringify({
          name: localStorage.getItem('ts_lastname') || 'Guest',
          userId: state.pendingId
        })
      });
      if (data.status === 'pending') {
        showWaiting(data.name, data.roomName);
        socket.emit('wait_approval', { roomId, pendingId: data.pendingId });
        return;
      }
      enterAsMember(data);
      return;
    } catch (e) {
      localStorage.removeItem('ts_pending_' + roomId);
      state.pendingId = null;
    }
  }

  els.joinNameInput.value = localStorage.getItem('ts_lastname') || '';
  showNameModal();
}

function initRoom() {
  renderHeader();
  renderPending();
  renderUsers();
  renderFiles();
  renderMessages();
  updateChatPermission();
  updateFilePermissions();
  updateRoomNameEditable();
  socket.emit('join_room', { roomId, userId: state.userId });
  setTimeout(() => {
    els.messages.scrollTop = els.messages.scrollHeight;
    markVisibleSeen();
  }, 100);
}

loadRoom();
