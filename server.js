const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const cors = require('cors');
const { ZipArchive } = require('archiver');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'rooms.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DEFAULT_EXPIRY_HOURS = parseInt(process.env.ROOM_EXPIRY_HOURS || '24', 10);
const MAX_EXPIRY_HOURS = parseInt(process.env.MAX_EXPIRY_HOURS || String(365 * 24), 10); // 1 year
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || String(50 * 1024 * 1024), 10); // 50MB

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Health check for UptimeRobot ----------
app.get('/healthz', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// ---------- Ensure required directories exist ----------
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    /* ignore */
  }
}

ensureDir(path.dirname(DATA_FILE)); // data/
ensureDir(UPLOADS_DIR);             // uploads/

// ---------- Persistence ----------
function normalizeRooms(data) {
  if (!data || typeof data !== 'object') return {};
  for (const room of Object.values(data)) {
    if (!room || typeof room !== 'object') continue;
    room.pendingUsers = Array.isArray(room.pendingUsers) ? room.pendingUsers : [];
    room.users = Array.isArray(room.users) ? room.users : [];
    room.files = Array.isArray(room.files) ? room.files : [];
    room.messages = Array.isArray(room.messages) ? room.messages : [];
    for (const u of room.users) {
      // Legacy "admin" role is collapsed into member
      if (u.role === 'admin') {
        u.role = 'member';
        u.permissions = defaultPermissions('member');
      } else if (u.role === 'owner') {
        u.permissions = defaultPermissions('owner');
      } else {
        u.role = 'member';
        u.permissions = defaultPermissions('member');
      }
    }
    for (const m of room.messages) {
      if (!m.seenBy || typeof m.seenBy !== 'object') m.seenBy = {};
      if (m.replyTo === undefined) m.replyTo = null;
    }
  }
  return data;
}

function loadRooms() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return normalizeRooms(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
    }
  } catch (e) {
    console.error('Failed to load rooms data:', e);
  }
  return {};
}

function saveRooms() {
  ensureDir(path.dirname(DATA_FILE));
  fs.writeFileSync(DATA_FILE, JSON.stringify(rooms, null, 2));
}

let rooms = loadRooms();

// ---------- Delete room (wipe all files + metadata) ----------
function notifyRoomGone(roomId, reason) {
  const room = rooms[roomId];
  io.to('room:' + roomId).emit('room_deleted', { reason });
  io.to('room:' + roomId).socketsLeave('room:' + roomId);
  if (room && Array.isArray(room.pendingUsers)) {
    for (const p of room.pendingUsers) {
      io.to('pending:' + p.id).emit('join_rejected', { reason: reason === 'expired' ? 'expired' : 'deleted' });
    }
  }
}

function deleteRoom(roomId) {
  const roomDir = path.join(UPLOADS_DIR, roomId);
  try { if (fs.existsSync(roomDir)) fs.rmSync(roomDir, { recursive: true, force: true }); } catch (e) {}
  delete rooms[roomId];
}

// Expire old rooms
function pruneExpiredRooms() {
  const now = Date.now();
  const expiredIds = [];
  for (const roomId of Object.keys(rooms)) {
    if (rooms[roomId].expiresAt && rooms[roomId].expiresAt < now) {
      expiredIds.push(roomId);
    }
  }
  for (const id of expiredIds) {
    notifyRoomGone(id, 'expired');
    deleteRoom(id);
  }
  if (expiredIds.length) saveRooms();
}
setInterval(pruneExpiredRooms, 30 * 1000);
pruneExpiredRooms();

// ---------- Helpers ----------
function uid() {
  return crypto.randomBytes(8).toString('hex');
}

function shortRoomId() {
  return crypto.randomBytes(4).toString('hex').toLowerCase();
}

function sanitizeFilename(name) {
  return name.replace(/[\/\\\?\%\*\:\|"<>\x00-\x1f]/g, '_').slice(0, 200);
}

function defaultPermissions(role) {
  if (role === 'owner') {
    return { can_chat: true, can_upload: true, can_delete: true, can_create_folder: true, can_rename: true };
  }
  // Members: chat + upload. Downloads are available to every admitted member.
  return { can_chat: true, can_upload: true, can_delete: false, can_create_folder: false, can_rename: false };
}

function getRoom(roomId) {
  return rooms[roomId] || null;
}

function getUser(room, userId) {
  if (!room || !userId) return null;
  return room.users.find(u => u.id === userId) || null;
}

function getPending(room, pendingId) {
  if (!room || !pendingId) return null;
  return (room.pendingUsers || []).find(p => p.id === pendingId) || null;
}

function canDo(room, userId, action) {
  const user = getUser(room, userId);
  if (!user) return false;
  if (user.role === 'owner') return true;
  return user.permissions[action] === true;
}

function requireMember(req, res) {
  const room = getRoom(req.params.roomId);
  if (!room) {
    res.status(404).json({ error: 'Room not found or expired' });
    return { room: null, user: null };
  }
  const userId = req.body?.userId || req.query?.userId || req.body?.actorUserId;
  const user = getUser(room, userId);
  if (!user) {
    res.status(401).json({ error: 'Not a member' });
    return { room, user: null };
  }
  return { room, user };
}

function roomPublicData(room, userId) {
  const me = getUser(room, userId);
  const data = {
    id: room.id,
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
    name: room.name,
    users: room.users.map(u => ({
      id: u.id,
      name: u.name,
      role: u.role,
      permissions: u.permissions,
      online: !!onlineUsers[room.id]?.[u.id]
    })),
    files: room.files,
    messages: room.messages.slice(-100),
    myUserId: userId,
    myPermissions: (me || {}).permissions || null,
    myRole: (me || {}).role || null
  };
  if (me && me.role === 'owner') {
    data.pendingUsers = room.pendingUsers || [];
  }
  return data;
}

// Track online users per room: { roomId: { userId: socketId } }
const onlineUsers = {};
function setOnline(roomId, userId, socketId) {
  onlineUsers[roomId] = onlineUsers[roomId] || {};
  onlineUsers[roomId][userId] = socketId;
}
function setOffline(roomId, userId) {
  if (onlineUsers[roomId]) delete onlineUsers[roomId][userId];
}
function broadcastRoom(roomId, event, payload) {
  io.to('room:' + roomId).emit(event, payload);
}

function kickUserSocket(roomId, userId, event, payload) {
  const sid = onlineUsers[roomId]?.[userId];
  if (sid) {
    const sock = io.sockets.sockets.get(sid);
    if (sock) {
      sock.emit(event, payload);
      sock.leave('room:' + roomId);
    }
  }
  setOffline(roomId, userId);
}

function markMessagesSeen(room, user) {
  if (!room || !user) return [];
  const now = Date.now();
  const updates = [];
  for (const msg of room.messages) {
    if (msg.userId === user.id) continue;
    if (!msg.seenBy || typeof msg.seenBy !== 'object') msg.seenBy = {};
    if (msg.seenBy[user.id]) continue;
    msg.seenBy[user.id] = { ts: now, name: user.name };
    updates.push({ messageId: msg.id, userId: user.id, ts: now, name: user.name });
  }
  return updates;
}

// ---------- File Upload ----------
// Store flat (no subfolders on disk) with unique names; virtual folder structure
// is reconstructed from metadata (so nested uploads never collide).
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const roomId = req.params.roomId;
    const roomDir = path.join(UPLOADS_DIR, roomId);
    fs.mkdirSync(roomDir, { recursive: true });
    cb(null, roomDir);
  },
  filename: function (req, file, cb) {
    const baseName = path.basename(file.originalname || 'file');
    const unique = uid() + '_' + sanitizeFilename(baseName);
    cb(null, unique);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE }
});

// ---------- Virtual path helpers ----------
function ensureFolderPath(room, userId, relativePath, baseParentId) {
  if (!relativePath) return baseParentId;
  const normalized = String(relativePath).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized) return baseParentId;
  const parts = normalized.split('/').map(p => sanitizeFilename(p)).filter(Boolean);
  if (parts.length === 0) return baseParentId;

  let currentParentId = baseParentId;
  const now = Date.now();
  const uploaderName = (getUser(room, userId) || {}).name || 'Unknown';

  for (const part of parts) {
    if (!part) continue;
    let folder = room.files.find(f => f.type === 'folder' && f.parentId === currentParentId && f.name === part);
    if (!folder) {
      const newFolder = {
        id: uid(),
        name: part,
        type: 'folder',
        parentId: currentParentId,
        createdBy: userId,
        createdByName: uploaderName,
        createdAt: now
      };
      room.files.push(newFolder);
      folder = newFolder;
    }
    currentParentId = folder.id;
  }
  return currentParentId;
}

function sanitizeZipName(name) {
  let n = String(name).replace(/[\/\\\?\%\*\:\|"<>\x00-\x1f]/g, '_').replace(/^\.+/, '_');
  return n.slice(0, 200) || 'file';
}

// ---------- REST Routes ----------

// Create room
app.post('/api/rooms', (req, res) => {
  const roomId = shortRoomId();
  if (rooms[roomId]) return res.status(500).json({ error: 'Try again' });

  const ownerId = uid();
  const ownerName = (req.body.name && String(req.body.name).trim()) || 'Owner';
  const roomName = (req.body.roomName && String(req.body.roomName).trim()) || 'Untitled Room';

  const now = Date.now();
  let expiryMs = DEFAULT_EXPIRY_HOURS * 60 * 60 * 1000;
  if (req.body.expiresInHours != null) {
    const hours = Number(req.body.expiresInHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      return res.status(400).json({ error: 'expiresInHours must be a positive number' });
    }
    if (hours > MAX_EXPIRY_HOURS) {
      return res.status(400).json({ error: `Maximum expiry is ${MAX_EXPIRY_HOURS} hours (1 year)` });
    }
    expiryMs = Math.round(hours * 60 * 60 * 1000);
  } else if (req.body.expiresAt != null) {
    const ts = Number(req.body.expiresAt);
    if (!Number.isFinite(ts) || ts <= now) {
      return res.status(400).json({ error: 'expiresAt must be a future timestamp' });
    }
    if (ts - now > MAX_EXPIRY_HOURS * 3600000) {
      return res.status(400).json({ error: `Maximum expiry is ${MAX_EXPIRY_HOURS} hours (1 year)` });
    }
    expiryMs = ts - now;
  }

  rooms[roomId] = {
    id: roomId,
    name: roomName,
    createdAt: now,
    expiresAt: now + expiryMs,
    ownerId,
    users: [{
      id: ownerId,
      name: ownerName.slice(0, 40),
      role: 'owner',
      permissions: defaultPermissions('owner'),
      joinedAt: now
    }],
    pendingUsers: [],
    files: [{ id: 'root', name: 'root', type: 'folder', parentId: null, createdAt: now }],
    messages: []
  };
  saveRooms();
  res.json({ roomId, userId: ownerId, inviteLink: `/room/${roomId}` });
});

// Join room — existing members re-enter; everyone else waits for owner approval
app.post('/api/rooms/:roomId/join', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found or expired' });

  let userId = req.body.userId;
  let user = userId ? getUser(room, userId) : null;
  const name = (req.body.name && String(req.body.name).trim().slice(0, 40)) || ('Guest_' + Math.floor(Math.random() * 1000));

  if (user) {
    if (req.body.name && user.name !== name) {
      user.name = name;
      saveRooms();
    }
    return res.json(roomPublicData(room, user.id));
  }

  let pending = userId ? getPending(room, userId) : null;
  if (pending) {
    if (req.body.name && pending.name !== name) {
      pending.name = name;
      saveRooms();
      broadcastRoom(room.id, 'pending_updated', { pendingUsers: room.pendingUsers });
    }
    return res.json({ status: 'pending', pendingId: pending.id, name: pending.name, roomName: room.name });
  }

  const pendingId = uid();
  room.pendingUsers = room.pendingUsers || [];
  room.pendingUsers.push({
    id: pendingId,
    name,
    requestedAt: Date.now()
  });
  saveRooms();
  broadcastRoom(room.id, 'pending_updated', { pendingUsers: room.pendingUsers });
  broadcastRoom(room.id, 'join_request', { id: pendingId, name });
  res.json({ status: 'pending', pendingId, name, roomName: room.name });
});

// Get room (admitted members only)
app.get('/api/rooms/:roomId', (req, res) => {
  const { room, user } = requireMember(req, res);
  if (!room || !user) return;
  res.json(roomPublicData(room, user.id));
});

// Owner admits a waiting user
app.post('/api/rooms/:roomId/approve', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const actor = getUser(room, req.body.actorUserId);
  if (!actor || actor.role !== 'owner') return res.status(403).json({ error: 'Only the owner can admit people' });

  const pendingId = req.body.pendingId;
  const pending = getPending(room, pendingId);
  if (!pending) return res.status(404).json({ error: 'No such join request' });

  room.pendingUsers = room.pendingUsers.filter(p => p.id !== pendingId);
  const now = Date.now();
  room.users.push({
    id: pending.id,
    name: pending.name,
    role: 'member',
    permissions: defaultPermissions('member'),
    joinedAt: now
  });
  saveRooms();

  const admitted = roomPublicData(room, pending.id);
  io.to('pending:' + pending.id).emit('join_approved', admitted);
  broadcastRoom(room.id, 'users_updated', { users: admitted.users });
  broadcastRoom(room.id, 'pending_updated', { pendingUsers: room.pendingUsers });
  broadcastRoom(room.id, 'activity', { text: `${actor.name} admitted ${pending.name}` });
  res.json({ ok: true, user: { id: pending.id, name: pending.name, role: 'member' } });
});

// Owner declines a waiting user
app.post('/api/rooms/:roomId/reject', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const actor = getUser(room, req.body.actorUserId);
  if (!actor || actor.role !== 'owner') return res.status(403).json({ error: 'Only the owner can decline people' });

  const pendingId = req.body.pendingId;
  const pending = getPending(room, pendingId);
  if (!pending) return res.status(404).json({ error: 'No such join request' });

  room.pendingUsers = room.pendingUsers.filter(p => p.id !== pendingId);
  saveRooms();
  io.to('pending:' + pending.id).emit('join_rejected', { reason: 'denied' });
  broadcastRoom(room.id, 'pending_updated', { pendingUsers: room.pendingUsers });
  broadcastRoom(room.id, 'activity', { text: `${actor.name} declined ${pending.name}` });
  res.json({ ok: true });
});

// Leave room. Owner leaving destroys the room and all files.
app.post('/api/rooms/:roomId/leave', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const userId = req.body.userId;

  const pending = getPending(room, userId);
  if (pending) {
    room.pendingUsers = room.pendingUsers.filter(p => p.id !== userId);
    saveRooms();
    io.to('pending:' + userId).emit('join_rejected', { reason: 'left' });
    broadcastRoom(room.id, 'pending_updated', { pendingUsers: room.pendingUsers });
    return res.json({ ok: true });
  }

  const user = getUser(room, userId);
  if (!user) return res.status(401).json({ error: 'Not a member' });

  if (user.role === 'owner') {
    notifyRoomGone(room.id, 'deleted');
    deleteRoom(room.id);
    saveRooms();
    return res.json({ ok: true, destroyed: true });
  }

  const name = user.name;
  room.users = room.users.filter(u => u.id !== userId);
  saveRooms();
  kickUserSocket(room.id, userId, 'forced_leave', { reason: 'left' });
  broadcastRoom(room.id, 'users_updated', {
    users: room.users.map(u => ({
      id: u.id,
      name: u.name,
      role: u.role,
      permissions: u.permissions,
      online: !!onlineUsers[room.id]?.[u.id]
    }))
  });
  broadcastRoom(room.id, 'activity', { text: `${name} left the room` });
  res.json({ ok: true });
});

// Upload files (supports nested folder uploads via `paths` JSON array)
app.post('/api/rooms/:roomId/upload', upload.array('files', 500), (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const userId = req.body.userId;
  if (!canDo(room, userId, 'can_upload')) {
    (req.files || []).forEach(f => { try { fs.unlinkSync(f.path); } catch (e) {} });
    return res.status(403).json({ error: 'You do not have upload permission' });
  }

  const parentId = req.body.parentId || 'root';
  const parentFolder = room.files.find(f => f.id === parentId && f.type === 'folder');
  if (!parentFolder) return res.status(400).json({ error: 'Invalid folder' });

  let paths = [];
  if (req.body.paths) {
    try { paths = JSON.parse(req.body.paths); } catch (e) { paths = []; }
  }
  if (!Array.isArray(paths)) paths = [];

  const uploaderName = (getUser(room, userId) || {}).name || 'Unknown';
  const added = [];
  const foldersCreatedBefore = room.files.filter(f => f.type === 'folder').length;

  let folderPaths = [];
  if (req.body.folderPaths) {
    try { folderPaths = JSON.parse(req.body.folderPaths); } catch (e) { folderPaths = []; }
  }
  if (!Array.isArray(folderPaths)) folderPaths = [];

  const inferredDirs = new Set();
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    const normalized = p.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      inferredDirs.add(parts.slice(0, i).join('/'));
    }
  }
  for (const fp of folderPaths) {
    if (typeof fp === 'string' && fp.trim()) ensureFolderPath(room, userId, fp.trim(), parentId);
  }
  for (const dir of inferredDirs) {
    ensureFolderPath(room, userId, dir, parentId);
  }

  for (let i = 0; i < (req.files || []).length; i++) {
    const f = req.files[i];
    const relPath = paths[i];
    let fileParentId = parentId;
    let displayName = sanitizeFilename(f.originalname);

    if (relPath && typeof relPath === 'string') {
      const normalized = relPath.replace(/\\/g, '/');
      const parts = normalized.split('/').map(p => sanitizeFilename(p)).filter(Boolean);
      if (parts.length > 0) {
        displayName = parts[parts.length - 1];
        const dirParts = parts.slice(0, -1);
        if (dirParts.length > 0) {
          fileParentId = ensureFolderPath(room, userId, dirParts.join('/'), parentId);
        }
      }
    }

    const id = uid();
    const node = {
      id,
      name: displayName,
      type: 'file',
      parentId: fileParentId,
      size: f.size,
      mimeType: f.mimetype,
      storageName: f.filename,
      uploadedBy: userId,
      uploadedByName: uploaderName,
      uploadedAt: Date.now()
    };
    room.files.push(node);
    added.push(node);
  }

  const foldersCreatedAfter = room.files.filter(f => f.type === 'folder').length;
  const newFolderCount = foldersCreatedAfter - foldersCreatedBefore;

  saveRooms();
  broadcastRoom(room.id, 'files_updated', { files: room.files });
  let msg = `${uploaderName} uploaded ${added.length} file(s)`;
  if (newFolderCount > 0) msg += ` in ${newFolderCount} new folder(s)`;
  broadcastRoom(room.id, 'activity', { text: msg });
  res.json({ files: added, foldersCreated: newFolderCount });
});

// Create folder
app.post('/api/rooms/:roomId/folders', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const userId = req.body.userId;
  if (!canDo(room, userId, 'can_create_folder')) return res.status(403).json({ error: 'No permission' });
  const name = sanitizeFilename(String(req.body.name || 'New Folder')).slice(0, 100);
  const parentId = req.body.parentId || 'root';
  const parentFolder = room.files.find(f => f.id === parentId && f.type === 'folder');
  if (!parentFolder) return res.status(400).json({ error: 'Invalid folder' });
  const id = uid();
  const node = {
    id,
    name,
    type: 'folder',
    parentId,
    createdBy: userId,
    createdByName: (getUser(room, userId) || {}).name,
    createdAt: Date.now()
  };
  room.files.push(node);
  saveRooms();
  broadcastRoom(room.id, 'files_updated', { files: room.files });
  res.json({ folder: node });
});

// Delete file/folder
app.delete('/api/rooms/:roomId/files/:fileId', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const userId = req.body.userId || req.query.userId;
  if (!canDo(room, userId, 'can_delete')) return res.status(403).json({ error: 'No permission' });
  const fileId = req.params.fileId;
  if (fileId === 'root') return res.status(400).json({ error: 'Cannot delete root' });

  const toDelete = new Set();
  function collect(id) {
    toDelete.add(id);
    room.files.filter(f => f.parentId === id).forEach(child => collect(child.id));
  }
  collect(fileId);

  const removed = [];
  for (const id of toDelete) {
    const node = room.files.find(f => f.id === id);
    if (node) {
      removed.push(node);
      if (node.type === 'file' && node.storageName) {
        const p = path.join(UPLOADS_DIR, room.id, node.storageName);
        try { fs.unlinkSync(p); } catch (e) {}
      }
    }
  }
  room.files = room.files.filter(f => !toDelete.has(f.id));
  saveRooms();
  broadcastRoom(room.id, 'files_updated', { files: room.files });
  broadcastRoom(room.id, 'activity', { text: `${(getUser(room, userId) || {}).name} deleted ${removed.length} item(s)` });
  res.json({ ok: true });
});

// Rename file/folder
app.patch('/api/rooms/:roomId/files/:fileId', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const userId = req.body.userId;
  if (!canDo(room, userId, 'can_rename') && !canDo(room, userId, 'can_upload')) return res.status(403).json({ error: 'No permission' });
  const node = room.files.find(f => f.id === req.params.fileId);
  if (!node) return res.status(404).json({ error: 'Not found' });
  if (node.id === 'root') return res.status(400).json({ error: 'Cannot rename root' });
  if (req.body.name) {
    node.name = sanitizeFilename(String(req.body.name)).slice(0, 100);
  }
  saveRooms();
  broadcastRoom(room.id, 'files_updated', { files: room.files });
  res.json({ node });
});

// Download file — any admitted member (or owner) can download
app.get('/api/rooms/:roomId/files/:fileId/download', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).send('Room not found');
  const user = getUser(room, req.query.userId);
  if (!user) return res.status(401).send('Not a member');
  const node = room.files.find(f => f.id === req.params.fileId);
  if (!node || node.type !== 'file') return res.status(404).send('File not found');
  const p = path.join(UPLOADS_DIR, room.id, node.storageName);
  if (!fs.existsSync(p)) return res.status(404).send('File missing on server');
  res.download(p, node.name);
});

// Download folder as ZIP (preserves subfolder structure)
// Any admitted member (or owner) can download.
app.get('/api/rooms/:roomId/folders/:folderId/zip', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).send('Room not found');
  const user = getUser(room, req.query.userId);
  if (!user) return res.status(401).send('Not a member');

  const folderId = req.params.folderId;
  const folder = room.files.find(f => f.id === folderId && f.type === 'folder');
  if (!folder) return res.status(404).send('Folder not found');

  const descendants = new Set();
  function collect(id) {
    descendants.add(id);
    room.files.filter(f => f.parentId === id).forEach(child => collect(child.id));
  }
  collect(folderId);

  const byId = {};
  room.files.forEach(f => { byId[f.id] = f; });

  const rootPrefix = folder.id === 'root' ? '' : sanitizeZipName(folder.name) + '/';
  function zipPathFor(fileNode) {
    const parts = [];
    let cur = fileNode;
    while (cur && cur.id !== folderId) {
      parts.unshift(sanitizeZipName(cur.name));
      cur = cur.parentId ? byId[cur.parentId] : null;
    }
    return rootPrefix + parts.join('/');
  }

  const archiveName = (folder.id === 'root' ? (room.name || 'room') : folder.name).replace(/[^\w\- .\u00A0-\uFFFF]/g, '_') || 'download';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${archiveName}.zip"`);

  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on('error', err => {
    console.error('ZIP error:', err);
    try { res.status(500).end(); } catch (e) {}
  });
  archive.pipe(res);

  let anyFile = false;
  for (const node of room.files) {
    if (node.type !== 'file' || !descendants.has(node.id)) continue;
    const diskPath = path.join(UPLOADS_DIR, room.id, node.storageName);
    if (!fs.existsSync(diskPath)) continue;
    archive.file(diskPath, { name: zipPathFor(node) });
    anyFile = true;
  }

  if (!anyFile) {
    archive.append('This folder is empty.\n', { name: rootPrefix + '(empty).txt' });
  }

  archive.finalize();
});

// Rename room / change expiry — owner only
app.patch('/api/rooms/:roomId', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const user = getUser(room, req.body.userId);
  if (!user || user.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change room settings' });

  let changed = false;
  if (typeof req.body.name === 'string') {
    const newName = String(req.body.name).slice(0, 60).trim();
    if (newName && newName !== room.name) { room.name = newName; changed = true; }
  }
  if (req.body.expiresInHours != null) {
    const hours = Number(req.body.expiresInHours);
    if (Number.isFinite(hours) && hours > 0 && hours <= MAX_EXPIRY_HOURS) {
      room.expiresAt = Date.now() + Math.round(hours * 60 * 60 * 1000);
      changed = true;
    } else {
      return res.status(400).json({ error: `Expiry must be between 1 hour and ${MAX_EXPIRY_HOURS} hours (1 year)` });
    }
  }
  if (req.body.expiresAt != null) {
    const ts = Number(req.body.expiresAt);
    const now = Date.now();
    if (Number.isFinite(ts) && ts > now && ts - now <= MAX_EXPIRY_HOURS * 3600000) {
      room.expiresAt = ts;
      changed = true;
    } else {
      return res.status(400).json({ error: 'Invalid expiry date' });
    }
  }

  if (changed) {
    saveRooms();
    broadcastRoom(room.id, 'room_updated', { name: room.name, expiresAt: room.expiresAt });
    broadcastRoom(room.id, 'activity', { text: `${user.name} updated room settings` });
  }
  res.json({ name: room.name, expiresAt: room.expiresAt });
});

// Delete room (owner only)
app.delete('/api/rooms/:roomId', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const userId = req.body.userId || req.query.userId;
  const user = getUser(room, userId);
  if (!user || user.role !== 'owner') return res.status(403).json({ error: 'Only the owner can delete the room' });

  const roomId = room.id;
  notifyRoomGone(roomId, 'deleted');
  deleteRoom(roomId);
  saveRooms();
  res.json({ ok: true });
});

// Delete (unsend) message
// Owner can delete any message; members can unsend their own.
app.delete('/api/rooms/:roomId/messages/:msgId', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const userId = req.body.userId || req.query.userId;
  const actor = getUser(room, userId);
  if (!actor) return res.status(401).json({ error: 'Not a member' });

  const msgIdx = room.messages.findIndex(m => m.id === req.params.msgId);
  if (msgIdx === -1) return res.status(404).json({ error: 'Message not found' });
  const msg = room.messages[msgIdx];

  const allowed = actor.role === 'owner' || msg.userId === userId;
  if (!allowed) return res.status(403).json({ error: 'You cannot delete this message' });

  room.messages.splice(msgIdx, 1);
  saveRooms();
  broadcastRoom(room.id, 'message_deleted', { messageId: msg.id, deletedBy: userId });
  res.json({ ok: true });
});

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUserId = null;
  let currentPendingId = null;

  socket.on('wait_approval', ({ roomId, pendingId }) => {
    const room = getRoom(roomId);
    if (!room || !pendingId) {
      socket.emit('join_rejected', { reason: 'not_found' });
      return;
    }
    const user = getUser(room, pendingId);
    if (user) {
      socket.emit('join_approved', roomPublicData(room, pendingId));
      return;
    }
    const pending = getPending(room, pendingId);
    if (!pending) {
      socket.emit('join_rejected', { reason: 'not_found' });
      return;
    }
    socket.join('pending:' + pendingId);
    currentPendingId = pendingId;
    socket.emit('waiting', { pendingId, name: pending.name, roomName: room.name });
  });

  socket.on('join_room', ({ roomId, userId }) => {
    const room = getRoom(roomId);
    if (!room || !getUser(room, userId)) {
      socket.emit('error_msg', 'Room not found or invalid user');
      return;
    }
    socket.join('room:' + roomId);
    currentRoom = roomId;
    currentUserId = userId;
    const wasOffline = !onlineUsers[roomId] || !onlineUsers[roomId][userId];
    setOnline(roomId, userId, socket.id);

    const user = getUser(room, userId);
    const presenceUsers = room.users.map(u => ({ ...u, online: !!onlineUsers[roomId][u.id] }));
    if (wasOffline) {
      io.to('room:' + roomId).emit('presence', { users: presenceUsers });
      io.to('room:' + roomId).emit('activity', { text: `${user.name} joined the room` });
    } else {
      socket.emit('presence', { users: presenceUsers });
    }

    if (user.role === 'owner') {
      socket.emit('pending_updated', { pendingUsers: room.pendingUsers || [] });
    }

    const seenUpdates = markMessagesSeen(room, user);
    if (seenUpdates.length) {
      saveRooms();
      io.to('room:' + roomId).emit('seen_update', { updates: seenUpdates });
    }
  });

  socket.on('send_message', ({ roomId, userId, text, replyToId }) => {
    const room = getRoom(roomId);
    if (!room) return;
    const user = getUser(room, userId);
    if (!user) return;
    if (!canDo(room, userId, 'can_chat')) {
      socket.emit('error_msg', 'You do not have permission to chat');
      return;
    }
    const cleanText = String(text || '').slice(0, 2000).trim();
    if (!cleanText) return;

    let replyTo = null;
    if (replyToId) {
      const orig = room.messages.find(m => m.id === replyToId);
      if (orig) {
        replyTo = {
          id: orig.id,
          userName: orig.userName,
          text: String(orig.text || '').slice(0, 200)
        };
      }
    }

    const msg = {
      id: uid(),
      userId,
      userName: user.name,
      role: user.role,
      text: cleanText,
      ts: Date.now(),
      replyTo,
      seenBy: {}
    };
    room.messages.push(msg);
    if (room.messages.length > 500) room.messages = room.messages.slice(-500);
    saveRooms();
    io.to('room:' + roomId).emit('new_message', msg);
  });

  socket.on('mark_seen', ({ roomId, userId, messageIds }) => {
    const room = getRoom(roomId);
    if (!room) return;
    const user = getUser(room, userId);
    if (!user) return;
    const now = Date.now();
    const updates = [];
    const filter = Array.isArray(messageIds) && messageIds.length ? new Set(messageIds) : null;
    for (const msg of room.messages) {
      if (filter && !filter.has(msg.id)) continue;
      if (msg.userId === userId) continue;
      if (!msg.seenBy || typeof msg.seenBy !== 'object') msg.seenBy = {};
      if (msg.seenBy[userId]) continue;
      msg.seenBy[userId] = { ts: now, name: user.name };
      updates.push({ messageId: msg.id, userId, ts: now, name: user.name });
    }
    if (updates.length) {
      saveRooms();
      io.to('room:' + roomId).emit('seen_update', { updates });
    }
  });

  socket.on('typing', ({ roomId, userId, isTyping }) => {
    const room = getRoom(roomId);
    if (!room) return;
    const user = getUser(room, userId);
    if (!user) return;
    socket.to('room:' + roomId).emit('typing_update', { userId, userName: user.name, isTyping });
  });

  socket.on('disconnect', () => {
    if (currentRoom && currentUserId) {
      const room = getRoom(currentRoom);
      setOffline(currentRoom, currentUserId);
      if (room) {
        const user = getUser(room, currentUserId);
        io.to('room:' + currentRoom).emit('presence', {
          users: room.users.map(u => ({
            ...u,
            online: !!(onlineUsers[currentRoom] && onlineUsers[currentRoom][u.id])
          }))
        });
        if (user) {
          io.to('room:' + currentRoom).emit('activity', { text: `${user.name} went offline` });
        }
      }
    }
    currentPendingId = null;
  });
});

// ---------- SPA fallback for /room/:id ----------
app.get('/room/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`TempShare running on http://localhost:${PORT}`);
  console.log(`Default room expiry: ${DEFAULT_EXPIRY_HOURS}h. Max expiry: ${MAX_EXPIRY_HOURS}h. Uploads dir: ${UPLOADS_DIR}`);
});
