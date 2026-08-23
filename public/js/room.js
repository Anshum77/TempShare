// Room page logic
const roomId = window.location.pathname.split('/').pop();
const socket = io();

let state = {
  room: null,
  userId: localStorage.getItem('ts_user_' + roomId) || null,
  currentFolder: 'root',
  folderPath: [],
  typingTimeout: null,
  isTyping: false,
  sidebarOpen: false,
  expiryInterval: null
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
  copyLinkBtn: document.getElementById('copyLinkBtn'),
  toggleSidebar: document.getElementById('toggleSidebar'),
  sidebar: document.getElementById('sidebar'),
  userList: document.getElementById('userList'),
  userCount: document.getElementById('userCount'),
  myInfo: document.getElementById('myInfo'),
  breadcrumb: document.getElementById('breadcrumb'),
  fileList: document.getElementById('fileList'),
  emptyFiles: document.getElementById('emptyFiles'),
  newFolderBtn: document.getElementById('newFolderBtn'),
  fileInput: document.getElementById('fileInput'),
  folderInput: document.getElementById('folderInput'),
  dropZone: document.getElementById('dropZone'),
  dropOverlay: document.getElementById('dropOverlay'),
  messages: document.getElementById('messages'),
  chatForm: document.getElementById('chatForm'),
  chatInput: document.getElementById('chatInput'),
  chatMuted: document.getElementById('chatMuted'),
  typingIndicator: document.getElementById('typingIndicator'),
  activityBar: document.getElementById('activityBar'),
  permModal: document.getElementById('permModal'),
  closePermModal: document.getElementById('closePermModal'),
  permTitle: document.getElementById('permTitle'),
  permSubtitle: document.getElementById('permSubtitle'),
  permBody: document.getElementById('permBody'),
  permRoleSection: document.getElementById('permRoleSection'),
  nameModal: document.getElementById('nameModal'),
  joinNameInput: document.getElementById('joinNameInput'),
  joinNameBtn: document.getElementById('joinNameBtn'),
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
  } catch(e) { showToast(e.message, true); }
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
    showToast('Room deleted');
    setTimeout(() => window.location.href = '/', 1000);
  } catch(e) { showToast(e.message, true); }
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function getFileIcon(node) {
  if (node.type === 'folder') return '📁';
  const ext = (node.name.split('.').pop() || '').toLowerCase();
  const iconMap = {
    pdf: '📄', doc: '📝', docx: '📝', txt: '📃', md: '📃',
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️',
    mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬', webm: '🎬',
    mp3: '🎵', wav: '🎵', ogg: '🎵', flac: '🎵', m4a: '🎵',
    zip: '🗜️', rar: '🗜️', '7z': '🗜️', tar: '🗜️', gz: '🗜️',
    js: '📜', ts: '📜', jsx: '📜', tsx: '📜', html: '📜', css: '📜', py: '📜', java: '📜', c: '📜', cpp: '📜',
    json: '📋', csv: '📊', xlsx: '📊', xls: '📊', pptx: '📽️', ppt: '📽️',
    exe: '⚙️', sh: '⚙️', bin: '⚙️'
  };
  return iconMap[ext] || '📎';
}

function me() {
  return state.room.users.find(u => u.id === state.userId);
}

function can(perm) {
  const m = me();
  if (!m) return false;
  if (m.role === 'owner') return true;
  if (m.role === 'admin') {
    // admins can manage permissions by default (but cannot change other admins)
    if (perm === 'manage_permissions') return true;
    return m.permissions[perm] !== false;
  }
  return m.permissions[perm] === true;
}

// ---------- Rendering ----------
function renderHeader() {
  els.roomCode.textContent = '#' + state.room.id;
  els.roomName.value = state.room.name;
  const editable = me() && (me().role === 'owner' || me().role === 'admin');
  els.roomName.readOnly = !editable;
  els.roomName.title = editable ? 'Click to rename room' : '';

  // Owner controls
  const isOwner = me() && me().role === 'owner';
  els.changeExpiryBtn.classList.toggle('hidden', !isOwner);
  els.deleteRoomBtn.classList.toggle('hidden', !isOwner);
  els.deleteRoomBtn.classList.toggle('flex', isOwner);
  els.expiryBadge.classList.remove('hidden');
  els.expiryBadge.classList.add('flex');

  // Start/refresh countdown
  clearInterval(state.expiryInterval);
  updateExpiryBadge();
  state.expiryInterval = setInterval(updateExpiryBadge, 1000);
}

function renderUsers() {
  const sorted = [...state.room.users].sort((a,b) => {
    const order = { owner: 0, admin: 1, member: 2 };
    if (order[a.role] !== order[b.role]) return order[a.role] - order[b.role];
    return a.name.localeCompare(b.name);
  });
  els.userCount.textContent = `(${state.room.users.length})`;
  els.userList.innerHTML = '';
  for (const u of sorted) {
    const isMe = u.id === state.userId;
    const roleBadge = {
      owner: '<span class="text-[10px] font-bold bg-gradient-to-r from-pink-600 to-purple-600 px-2 py-0.5 rounded-full">OWNER</span>',
      admin: '<span class="text-[10px] font-bold bg-indigo-600 px-2 py-0.5 rounded-full">ADMIN</span>',
      member: ''
    }[u.role];
    const canManage = me() && (me().role === 'owner' || (me().role === 'admin' && u.role === 'member')) && !isMe;
    const row = document.createElement('div');
    row.className = 'file-item flex items-center gap-3 p-2.5 rounded-lg cursor-pointer fade-in';
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
      ${canManage ? '<button class="perm-btn text-slate-400 hover:text-white p-1" title="Manage permissions"><svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg></button>' : ''}
    `;
    const btn = row.querySelector('.perm-btn');
    if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); openPermModal(u); });
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

function renderBreadcrumb() {
  state.folderPath = buildFolderPath(state.currentFolder);
  els.breadcrumb.innerHTML = '';
  state.folderPath.forEach((f, i) => {
    const isLast = i === state.folderPath.length - 1;
    const btn = document.createElement('button');
    btn.className = 'px-2 py-1 rounded hover:bg-slate-700 transition ' + (isLast ? 'text-white font-semibold' : 'text-slate-400');
    btn.textContent = i === 0 ? '📁 Root' : '📁 ' + f.name;
    if (!isLast) btn.addEventListener('click', () => { state.currentFolder = f.id; renderFiles(); });
    els.breadcrumb.appendChild(btn);
    if (!isLast) {
      const sep = document.createElement('span');
      sep.className = 'text-slate-600';
      sep.textContent = '/';
      els.breadcrumb.appendChild(sep);
    }
  });
}

function renderFiles() {
  renderBreadcrumb();
  const children = state.room.files.filter(f => f.parentId === state.currentFolder);
  // Sort: folders first, then files, alphabetical
  children.sort((a,b) => {
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

    row.innerHTML = `
      <div class="text-2xl w-8 text-center">${getFileIcon(node)}</div>
      <div class="flex-1 min-w-0">
        <div class="font-medium text-sm truncate cursor-pointer file-name">${escapeHtml(node.name)}</div>
        <div class="text-xs text-slate-500 flex items-center gap-2">
          ${node.type === 'file' ? `<span>${formatSize(node.size)}</span> ·` : ''}
          <span>${uploader ? 'By ' + escapeHtml(uploader) : ''}</span>
          ${date ? `<span>· ${timeAgo(date)}</span>` : ''}
        </div>
      </div>
      <div class="opacity-0 group-hover:opacity-100 transition flex items-center gap-1">
        ${node.type === 'file' ? `<a href="/api/rooms/${state.room.id}/files/${node.id}/download?userId=${state.userId}" download class="p-2 hover:bg-slate-700 rounded" title="Download"><svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg></a>` : ''}
        ${canRename ? `<button class="rename-btn p-2 hover:bg-slate-700 rounded" title="Rename"><svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg></button>` : ''}
        ${canDelete && node.id !== 'root' ? `<button class="delete-btn p-2 hover:bg-red-600/30 text-red-400 rounded" title="Delete"><svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/></svg></button>` : ''}
      </div>
    `;

    const nameEl = row.querySelector('.file-name');
    nameEl.addEventListener('click', () => {
      if (node.type === 'folder') {
        state.currentFolder = node.id;
        renderFiles();
      } else {
        // Download on click (simple UX)
        window.open(`/api/rooms/${state.room.id}/files/${node.id}/download?userId=${state.userId}`, '_blank');
      }
    });

    const renameBtn = row.querySelector('.rename-btn');
    if (renameBtn) renameBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const newName = await Dialog.prompt(`Enter a new name for "${node.name}":`, node.name, 'Rename');
      if (newName && newName !== node.name) {
        renameFile(node.id, newName);
      }
    });

    const delBtn = row.querySelector('.delete-btn');
    if (delBtn) delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const msg = node.type === 'folder'
        ? `Delete "${node.name}" and everything inside it? This cannot be undone.`
        : `Delete "${node.name}"? This cannot be undone.`;
      const ok = await Dialog.confirm(msg, 'Delete item?', { okText: 'Delete', danger: true });
      if (ok) deleteFile(node.id);
    });

    els.fileList.appendChild(row);
  }
}

function renderMessages() {
  const wasAtBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 80;
  els.messages.innerHTML = '';
  for (const msg of state.room.messages) {
    const isMe = msg.userId === state.userId;
    const wrapper = document.createElement('div');
    wrapper.className = 'flex fade-in ' + (isMe ? 'justify-end' : 'justify-start');
    wrapper.innerHTML = `
      <div class="max-w-[80%] ${isMe ? 'items-end' : 'items-start'} flex flex-col">
        ${!isMe ? `<span class="text-[11px] text-slate-500 mb-0.5 ml-2">${escapeHtml(msg.userName)}${msg.role !== 'member' ? ' <span class="text-pink-400 font-semibold">('+msg.role.toUpperCase()+')</span>' : ''} · ${formatTime(msg.ts)}</span>` : ''}
        <div class="${isMe ? 'bubble-me' : 'bubble-other'} px-3 py-2 text-sm shadow break-words">${escapeHtml(msg.text)}</div>
        ${isMe ? `<span class="text-[11px] text-slate-500 mt-0.5 mr-2">${formatTime(msg.ts)}</span>` : ''}
      </div>
    `;
    els.messages.appendChild(wrapper);
  }
  if (wasAtBottom) els.messages.scrollTop = els.messages.scrollHeight;
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
  els.roomName.readOnly = !(me() && (me().role === 'owner' || me().role === 'admin'));
}

// ---------- API actions ----------
async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts
  });
  let data = {};
  try { data = await res.json(); } catch(e) {}
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function joinRoom(name) {
  try {
    const data = await api(`/api/rooms/${roomId}/join`, {
      method: 'POST',
      body: JSON.stringify({ name, userId: state.userId })
    });
    state.room = data;
    state.userId = data.myUserId;
    localStorage.setItem('ts_user_' + roomId, state.userId);
    localStorage.setItem('ts_lastname', name);
    els.nameModal.style.display = 'none';
    initRoom();
  } catch(e) {
    showToast(e.message, true);
  }
}

async function uploadFiles(fileList, paths = null) {
  if (!can('can_upload')) return showToast('No upload permission', true);
  const files = Array.from(fileList);
  if (files.length === 0) return;
  const fd = new FormData();
  files.forEach(f => fd.append('files', f));
  fd.append('userId', state.userId);
  fd.append('parentId', state.currentFolder);
  if (paths && paths.length === files.length) {
    fd.append('paths', JSON.stringify(paths));
  }
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  const folderMsg = paths ? ` (${new Set(paths.map(p => p.split('/').slice(0,-1).join('/')).filter(Boolean)).size} folders)` : '';
  showToast(`Uploading ${files.length} file(s)${folderMsg} — ${formatSize(totalSize)}`);
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/rooms/${roomId}/upload`);
    await new Promise((resolve, reject) => {
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
        else {
          try { reject(new Error(JSON.parse(xhr.response).error || 'Upload failed')); }
          catch(e) { reject(new Error('Upload failed')); }
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(fd);
    });
    showToast(`Uploaded ${files.length} file(s)${folderMsg} successfully`);
    // files_updated event will refresh the list
  } catch(e) {
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
  } catch(e) { showToast(e.message, true); }
}

async function deleteFile(fileId) {
  try {
    await api(`/api/rooms/${roomId}/files/${fileId}?userId=${state.userId}`, { method: 'DELETE' });
  } catch(e) { showToast(e.message, true); }
}

async function renameFile(fileId, newName) {
  try {
    await api(`/api/rooms/${roomId}/files/${fileId}`, {
      method: 'PATCH',
      body: JSON.stringify({ userId: state.userId, name: newName })
    });
  } catch(e) { showToast(e.message, true); }
}

async function renameRoom(newName) {
  try {
    await api(`/api/rooms/${roomId}`, {
      method: 'PATCH',
      body: JSON.stringify({ userId: state.userId, name: newName })
    });
  } catch(e) { showToast(e.message, true); }
}

async function updatePermissions(targetUserId, perms) {
  try {
    await api(`/api/rooms/${roomId}/users/${targetUserId}/permissions`, {
      method: 'PATCH',
      body: JSON.stringify({ actorUserId: state.userId, permissions: perms })
    });
  } catch(e) { showToast(e.message, true); }
}

async function updateRole(targetUserId, role) {
  try {
    await api(`/api/rooms/${roomId}/users/${targetUserId}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ actorUserId: state.userId, role })
    });
    closePermModalFn();
  } catch(e) { showToast(e.message, true); }
}

// ---------- Permissions modal ----------
let permTarget = null;
function openPermModal(user) {
  permTarget = user;
  els.permTitle.textContent = user.name;
  els.permSubtitle.textContent = `Role: ${user.role}`;
  const myRole = me().role;
  const iAmOwner = myRole === 'owner';

  const fields = [
    { key: 'can_chat', label: 'Can send chat messages', icon: '💬' },
    { key: 'can_upload', label: 'Can upload files', icon: '⬆️' },
    { key: 'can_create_folder', label: 'Can create folders', icon: '📁' },
    { key: 'can_delete', label: 'Can delete files/folders', icon: '🗑️' },
    { key: 'can_rename', label: 'Can rename items', icon: '✏️' },
  ];

  // Can't edit other admins if you're not owner, or owner
  if (user.role === 'owner') {
    els.permBody.innerHTML = '<p class="text-sm text-slate-400">The room owner has full permissions and cannot be restricted.</p>';
    els.permRoleSection.classList.add('hidden');
    els.permModal.style.display = 'flex';
    return;
  }

  const canEdit = iAmOwner || (myRole === 'admin' && user.role === 'member');
  if (!canEdit) {
    els.permBody.innerHTML = '<p class="text-sm text-slate-400">You cannot modify this user.</p>';
    els.permRoleSection.classList.add('hidden');
    els.permModal.style.display = 'flex';
    return;
  }

  els.permBody.innerHTML = '';
  for (const f of fields) {
    const enabled = user.permissions[f.key] === true;
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
    });
  });

  // Role buttons (owner only)
  if (iAmOwner && user.id !== state.userId) {
    els.permRoleSection.classList.remove('hidden');
    els.permRoleSection.querySelectorAll('.role-btn').forEach(b => {
      b.classList.remove('bg-pink-600', 'bg-indigo-600');
      b.classList.add('bg-slate-700');
      if (b.dataset.role === user.role) {
        b.classList.remove('bg-slate-700');
        b.classList.add('bg-indigo-600');
      }
    });
  } else {
    els.permRoleSection.classList.add('hidden');
  }

  els.permModal.style.display = 'flex';
}

function closePermModalFn() {
  els.permModal.style.display = 'none';
  permTarget = null;
}

// ---------- Chat ----------
function sendMessage() {
  const text = els.chatInput.value.trim();
  if (!text) return;
  socket.emit('send_message', { roomId, userId: state.userId, text });
  els.chatInput.value = '';
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

// ---------- Socket events ----------
socket.on('connect', () => {
  if (state.room && state.userId) {
    socket.emit('join_room', { roomId, userId: state.userId });
  }
});

socket.on('new_message', (msg) => {
  state.room.messages.push(msg);
  if (state.room.messages.length > 500) state.room.messages = state.room.messages.slice(-500);
  renderMessages();
});

socket.on('users_updated', ({ users }) => {
  state.room.users = users;
  renderUsers();
  updateChatPermission();
  updateFilePermissions();
});

socket.on('presence', ({ users }) => {
  // Merge online status
  const onlineMap = {};
  users.forEach(u => onlineMap[u.id] = u.online);
  state.room.users.forEach(u => { u.online = onlineMap[u.id] || false; });
  renderUsers();
});

socket.on('files_updated', ({ files }) => {
  state.room.files = files;
  // Make sure we still have a valid current folder
  if (!files.find(f => f.id === state.currentFolder)) {
    state.currentFolder = 'root';
  }
  renderFiles();
});

socket.on('room_updated', ({ name, expiresAt }) => {
  if (name) state.room.name = name;
  if (expiresAt) state.room.expiresAt = expiresAt;
  renderHeader();
});

socket.on('room_deleted', ({ reason }) => {
  clearInterval(state.expiryInterval);
  showToast(reason === 'expired' ? 'This room has expired and was deleted' : 'This room was deleted by the owner', true);
  setTimeout(() => window.location.href = '/', 2000);
});

socket.on('activity', ({ text }) => {
  els.activityBar.textContent = text;
  els.activityBar.classList.remove('hidden');
  clearTimeout(els.activityBar._t);
  els.activityBar._t = setTimeout(() => els.activityBar.classList.add('hidden'), 4000);
});

socket.on('typing_update', ({ userId, userName, isTyping }) => {
  // show one name at a time for simplicity
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
  } catch(e) {
    // Fallback: select text in a temporary textarea so user can copy
    const ta = document.createElement('textarea');
    ta.value = link;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showToast('Invite link copied!'); }
    catch(_) {
      // Last resort: custom prompt showing the link
      await Dialog.alert(link, 'Copy this invite link');
    }
    document.body.removeChild(ta);
  }
});

els.newFolderBtn.addEventListener('click', createFolder);

els.fileInput.addEventListener('change', (e) => {
  uploadFiles(e.target.files);
  e.target.value = '';
});

els.folderInput.addEventListener('change', (e) => {
  // When using webkitdirectory, the browser provides `webkitRelativePath` on each File
  const files = Array.from(e.target.files || []);
  const paths = files.map(f => f.webkitRelativePath || f.name);
  uploadFiles(files, paths);
  e.target.value = '';
});

// ---------- Drag-and-drop (files + folders) ----------
// Recursively read dropped items so folders preserve structure.
function readEntry(entry, pathPrefix = '') {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(file => {
        // Attach relative path for our upload handler
        Object.defineProperty(file, 'relPath', { value: pathPrefix + file.name });
        resolve([file]);
      }, () => resolve([]));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const allEntries = [];
      const readBatch = () => {
        reader.readEntries(async (batch) => {
          if (batch.length === 0) {
            const results = [];
            for (const child of allEntries) {
              const childFiles = await readEntry(child, pathPrefix + entry.name + '/');
              results.push(...childFiles);
            }
            resolve(results);
          } else {
            allEntries.push(...batch);
            readBatch();
          }
        }, () => resolve([]));
      };
      readBatch();
    } else {
      resolve([]);
    }
  });
}

async function getDroppedFiles(dt) {
  const items = dt.items;
  // If we have DataTransferItemList with webkitGetAsEntry, use it (handles folders)
  if (items && items.length && items[0].webkitGetAsEntry) {
    const files = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry();
      if (!entry) continue;
      const got = await readEntry(entry, '');
      files.push(...got);
    }
    return files;
  }
  // Fallback: plain files list (no structure info)
  return Array.from(dt.files || []);
}

// Drag & drop
;['dragenter','dragover'].forEach(ev => {
  els.dropZone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    if (can('can_upload')) els.dropOverlay.classList.remove('hidden');
  });
});
;['dragleave','drop'].forEach(ev => {
  els.dropZone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    els.dropOverlay.classList.add('hidden');
  });
});
els.dropZone.addEventListener('drop', async (e) => {
  const dropped = await getDroppedFiles(e.dataTransfer);
  if (dropped.length) {
    const paths = dropped.map(f => f.relPath || f.name);
    const hasFolderStructure = dropped.some(f => f.relPath && f.relPath.includes('/'));
    uploadFiles(dropped, hasFolderStructure ? paths : null);
  }
});

// Rename room on enter
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

els.closePermModal.addEventListener('click', closePermModalFn);
els.permModal.addEventListener('click', (e) => { if (e.target === els.permModal) closePermModalFn(); });
els.permRoleSection.querySelectorAll('.role-btn').forEach(b => {
  b.addEventListener('click', () => {
    if (permTarget) updateRole(permTarget.id, b.dataset.role);
  });
});

els.joinNameBtn.addEventListener('click', () => {
  const name = els.joinNameInput.value.trim() || localStorage.getItem('ts_lastname') || ('Guest_' + Math.floor(Math.random() * 1000));
  joinRoom(name);
});
els.joinNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.joinNameBtn.click(); });

// Expiry modal handlers
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

// Delete room
els.deleteRoomBtn.addEventListener('click', deleteRoom);

// Mobile sidebar toggle
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
  // Check if we already have a userId for this room
  if (state.userId) {
    try {
      const data = await api(`/api/rooms/${roomId}?userId=${state.userId}`);
      state.room = data;
      els.nameModal.style.display = 'none';
      initRoom();
      return;
    } catch(e) {
      // Invalid user - fall through to name prompt
      state.userId = null;
    }
  }
  // Show name modal
  els.joinNameInput.value = localStorage.getItem('ts_lastname') || '';
  els.nameModal.style.display = 'flex';
  setTimeout(() => els.joinNameInput.focus(), 100);
}

function initRoom() {
  renderHeader();
  renderUsers();
  renderFiles();
  renderMessages();
  updateChatPermission();
  updateFilePermissions();
  updateRoomNameEditable();

  // Join socket room
  socket.emit('join_room', { roomId, userId: state.userId });

  // Scroll chat to bottom
  setTimeout(() => { els.messages.scrollTop = els.messages.scrollHeight; }, 100);
}

loadRoom();
