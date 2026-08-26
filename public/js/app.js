// Landing page logic
const nameInput = document.getElementById('nameInput');
const roomNameInput = document.getElementById('roomNameInput');
const createBtn = document.getElementById('createBtn');
const joinInput = document.getElementById('joinInput');
const joinBtn = document.getElementById('joinBtn');

// Try to remember last name used
nameInput.value = localStorage.getItem('ts_lastname') || '';

function showToast(msg, isError = false) {
  const t = document.getElementById('toast') || (() => {
    const el = document.createElement('div');
    el.id = 'toast';
    el.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 text-white px-4 py-2 rounded-lg shadow-lg text-sm z-50';
    document.body.appendChild(el);
    return el;
  })();
  t.textContent = msg;
  t.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 text-white px-4 py-2 rounded-lg shadow-lg text-sm z-50 show ' +
    (isError ? 'bg-red-600' : 'bg-slate-700');
  setTimeout(() => { t.classList.add('hidden'); }, 2500);
}

createBtn.addEventListener('click', async () => {
  const name = nameInput.value.trim() || ('Guest_' + Math.floor(Math.random() * 1000));
  const expirySelect = document.getElementById('expirySelect');
  const expiresInHours = Number(expirySelect?.value || 24);
  const passkey = (document.getElementById('passkeyInput')?.value || '').trim();
  const passkeyConfirm = (document.getElementById('passkeyConfirmInput')?.value || '').trim();
  if (passkey.length < 4) return showToast('Passkey must be at least 4 characters', true);
  if (passkey.length > 64) return showToast('Passkey is too long', true);
  if (passkey !== passkeyConfirm) return showToast('Passkeys do not match', true);
  localStorage.setItem('ts_lastname', name);
  createBtn.disabled = true;
  createBtn.innerHTML = '<span class="animate-spin">⏳</span> Creating...';
  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, roomName: roomNameInput.value.trim(), expiresInHours, passkey })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    // Store the userId for this room in localStorage so we can return later
    localStorage.setItem('ts_user_' + data.roomId, data.userId);
    window.location.href = '/room/' + data.roomId;
  } catch(e) {
    showToast(e.message, true);
    createBtn.disabled = false;
    createBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg> Create a Room`;
  }
});

function extractRoomCode(val) {
  if (!val) return '';
  val = val.trim();
  // If it's a URL, extract last segment
  if (val.includes('/')) {
    const parts = val.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1];
  }
  return val;
}

joinBtn.addEventListener('click', () => {
  const code = extractRoomCode(joinInput.value);
  if (!code) return showToast('Enter a room link or code', true);
  window.location.href = '/room/' + code;
});
joinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') createBtn.click(); });
roomNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') createBtn.click(); });
