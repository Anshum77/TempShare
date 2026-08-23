const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const cors = require('cors');
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

// ---------- Ensure required directories exist ----------
function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
}
ensureDir(path.dirname(DATA_FILE)); // data/
ensureDir(UPLOADS_DIR);              // uploads/

// ---------- Persistence ----------
function loadRooms() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
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
function deleteRoom(roomId) {
  const roomDir = path.join(UPLOADS_DIR, roomId);
  try { if (fs.existsSync(roomDir)) fs.rmSync(roomDir, { recursive: true, force: true }); } catch(e) {}
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
    // Notify connected users right before wiping
    io.to('room:' + id).emit('room_deleted', { reason: 'expired' });
    io.to('room:' + id).socketsLeave('room:' + id);
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
  // Human-friendly short id
  return crypto.randomBytes(4).toString('hex').toLowerCase();
}

function sanitizeFilename(name) {
  return name.replace(/[\/\\\?\%\*\:\|"<>\x00-\x1f]/g, '_').slice(0, 200);
}

function defaultPermissions(role) {
  if (role === 'owner' || role === 'admin') {
    return { can_chat: true, can_upload: true, can_delete: true, can_create_folder: true, can_rename: true };
  }
  return { can_chat: true, can_upload: true, can_delete: false, can_create_folder: false, can_rename: false };
}

function getRoom(roomId) {
  return rooms[roomId] || null;
}

function getUser(room, userId) {
  return room.users.find(u => u.id === userId) || null;
}

function canDo(room, userId, action) {
  const user = getUser(room, userId);
  if (!user) return false;
  if (user.role === 'owner') return true;
  if (user.role === 'admin') {
    // Admins can do everything except demote/delete owner or manage other admins' roles
    if (action === 'manage_permissions') return true;
    return user.permissions[action] !== false;
  }
  return user.permissions[action] === true;
}

function roomPublicData(room, userId) {
  return {
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
    messages: room.messages.slice(-100), // last 100 messages
    myUserId: userId,
    myPermissions: (getUser(room, userId) || {}).permissions || null,
    myRole: (getUser(room, userId) || {}).role || null
  };
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
    // Use a unique storage name to avoid collisions, keep original name in metadata
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
// Given a POSIX-style relative path like "photos/vacation/img.jpg" and a starting folder id,
// ensure all intermediate folders exist in room.files and return the parent folder id
// where the file should live. Folder nodes are created as needed (idempotent — if a folder
// with the same name already exists at that level, we reuse it).
function ensureFolderPath(room, userId, relativePath, baseParentId) {
  if (!relativePath) return baseParentId;
  // Normalize separators and split
  const normalized = String(relativePath).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized) return baseParentId;
  const parts = normalized.split('/').map(p => sanitizeFilename(p)).filter(Boolean);
  if (parts.length === 0) return baseParentId;

  let currentParentId = baseParentId;
  const now = Date.now();
  const uploaderName = (getUser(room, userId) || {}).name || 'Unknown';

  // The last part is the filename, everything else is folders.
  // We are ONLY creating folders, so drop the filename (caller passes dir-only for files,
  // full path for files — we handle this by letting caller pass a file-aware path and we
  // pop the last component below).
  // Actually: we'll have caller pass the path and a flag, but for reuse we always interpret
  // the LAST segment as a folder too if `asFolder` is true; here we always treat all parts
  // as folders because the caller passes only the directory portion for files.
  for (const part of parts) {
    if (!part) continue;
    // Look for existing folder with same name & parent
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
    files: [{ id: 'root', name: 'root', type: 'folder', parentId: null, createdAt: now }],
    messages: []
  };
  saveRooms();
  res.json({ roomId, userId: ownerId, inviteLink: `/room/${roomId}` });
});

// Join room (sets/updates name, returns room data)
app.post('/api/rooms/:roomId/join', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found or expired' });

  let userId = req.body.userId;
  let user = userId ? getUser(room, userId) : null;

  const name = (req.body.name && String(req.body.name).trim().slice(0, 40)) || ('Guest_' + Math.floor(Math.random() * 1000));

  if (!user) {
    userId = uid();
    room.users.push({
      id: userId,
      name,
      role: 'member',
      permissions: defaultPermissions('member'),
      joinedAt: Date.now()
    });
    saveRooms();
  } else if (req.body.name && user.name !== name) {
    user.name = name;
    saveRooms();
  }

  res.json(roomPublicData(room, userId));
});

// Get room
app.get('/api/rooms/:roomId', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const userId = req.query.userId;
  const user = getUser(room, userId);
  if (!user) return res.status(401).json({ error: 'Not a member' });
  res.json(roomPublicData(room, userId));
});

// Upload files (supports nested folder uploads via `paths` JSON array)
// Optional body field: `paths` — JSON array of relative paths (POSIX, using /), one per file,
// e.g. ["photos/1.jpg", "photos/thumbs/1.jpg", "readme.txt"]. Folders are created automatically.
// Without `paths`, files are placed directly in parentId (backward-compatible).
app.post('/api/rooms/:roomId/upload', upload.array('files', 500), (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const userId = req.body.userId;
  if (!canDo(room, userId, 'can_upload')) {
    (req.files || []).forEach(f => { try { fs.unlinkSync(f.path); } catch(e){} });
    return res.status(403).json({ error: 'You do not have upload permission' });
  }

  const parentId = req.body.parentId || 'root';
  const parentFolder = room.files.find(f => f.id === parentId && f.type === 'folder');
  if (!parentFolder) return res.status(400).json({ error: 'Invalid folder' });

  // Parse per-file relative paths (for folder uploads)
  let paths = [];
  if (req.body.paths) {
    try { paths = JSON.parse(req.body.paths); } catch (e) { paths = []; }
  }
  if (!Array.isArray(paths)) paths = [];

  const uploaderName = (getUser(room, userId) || {}).name || 'Unknown';
  const added = [];
  const foldersCreatedBefore = room.files.filter(f => f.type === 'folder').length;

  for (let i = 0; i < (req.files || []).length; i++) {
    const f = req.files[i];
    const relPath = paths[i]; // may be undefined
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

  // Collect all files in subtree
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
        try { fs.unlinkSync(p); } catch(e){}
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

// Download file
app.get('/api/rooms/:roomId/files/:fileId/download', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).send('Room not found');
  const node = room.files.find(f => f.id === req.params.fileId);
  if (!node || node.type !== 'file') return res.status(404).send('File not found');
  const p = path.join(UPLOADS_DIR, room.id, node.storageName);
  if (!fs.existsSync(p)) return res.status(404).send('File missing on server');
  res.download(p, node.name);
});

// Update user permissions (admin/owner only)
app.patch('/api/rooms/:roomId/users/:userId/permissions', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const actorId = req.body.actorUserId;
  const actor = getUser(room, actorId);
  if (!actor || (actor.role !== 'owner' && actor.role !== 'admin')) return res.status(403).json({ error: 'Not allowed' });

  const targetId = req.params.userId;
  const target = getUser(room, targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  // Owner permissions cannot be changed by admins
  if (target.role === 'owner') return res.status(403).json({ error: 'Cannot change owner permissions' });
  if (actor.role === 'admin' && target.role === 'admin') return res.status(403).json({ error: 'Admins cannot modify other admins' });

  const allowedKeys = ['can_chat', 'can_upload', 'can_delete', 'can_create_folder', 'can_rename'];
  for (const key of allowedKeys) {
    if (typeof req.body.permissions?.[key] === 'boolean') {
      target.permissions[key] = req.body.permissions[key];
    }
  }
  saveRooms();
  broadcastRoom(room.id, 'users_updated', { users: room.users });
  res.json({ user: target });
});

// Change user role
app.patch('/api/rooms/:roomId/users/:userId/role', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const actorId = req.body.actorUserId;
  const actor = getUser(room, actorId);
  if (!actor || actor.role !== 'owner') return res.status(403).json({ error: 'Only owner can change roles' });

  const targetId = req.params.userId;
  if (targetId === actorId) return res.status(400).json({ error: 'Cannot change your own role' });
  const target = getUser(room, targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const newRole = req.body.role;
  if (!['admin', 'member'].includes(newRole)) return res.status(400).json({ error: 'Invalid role' });
  target.role = newRole;
  target.permissions = defaultPermissions(newRole);
  saveRooms();
  broadcastRoom(room.id, 'users_updated', { users: room.users });
  broadcastRoom(room.id, 'activity', { text: `${actor.name} set ${target.name} as ${newRole}` });
  res.json({ user: target });
});

// Rename room / change expiry
app.patch('/api/rooms/:roomId', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const userId = req.body.userId;
  const user = getUser(room, userId);
  if (!user || (user.role !== 'owner' && user.role !== 'admin')) return res.status(403).json({ error: 'Not allowed' });

  let changed = false;
  if (typeof req.body.name === 'string') {
    const newName = String(req.body.name).slice(0, 60).trim();
    if (newName && newName !== room.name) { room.name = newName; changed = true; }
  }
  if (req.body.expiresInHours != null) {
    if (user.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change expiry' });
    const hours = Number(req.body.expiresInHours);
    if (Number.isFinite(hours) && hours > 0 && hours <= MAX_EXPIRY_HOURS) {
      room.expiresAt = Date.now() + Math.round(hours * 60 * 60 * 1000);
      changed = true;
    } else {
      return res.status(400).json({ error: `Expiry must be between 1 hour and ${MAX_EXPIRY_HOURS} hours (1 year)` });
    }
  }
  if (req.body.expiresAt != null) {
    if (user.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change expiry' });
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
  io.to('room:' + roomId).emit('room_deleted', { reason: 'deleted' });
  io.to('room:' + roomId).socketsLeave('room:' + roomId);
  deleteRoom(roomId);
  saveRooms();
  res.json({ ok: true });
});

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUserId = null;

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

    // Notify others of join
    const user = getUser(room, userId);
    if (wasOffline) {
      io.to('room:' + roomId).emit('presence', { users: room.users.map(u => ({ ...u, online: !!onlineUsers[roomId][u.id] })) });
      io.to('room:' + roomId).emit('activity', { text: `${user.name} joined the room` });
    } else {
      socket.emit('presence', { users: room.users.map(u => ({ ...u, online: !!onlineUsers[roomId][u.id] })) });
    }
  });

  socket.on('send_message', ({ roomId, userId, text }) => {
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
    const msg = {
      id: uid(),
      userId,
      userName: user.name,
      role: user.role,
      text: cleanText,
      ts: Date.now()
    };
    room.messages.push(msg);
    if (room.messages.length > 500) room.messages = room.messages.slice(-500);
    saveRooms();
    io.to('room:' + roomId).emit('new_message', msg);
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
        io.to('room:' + currentRoom).emit('presence', { users: room.users.map(u => ({ ...u, online: !!(onlineUsers[currentRoom] && onlineUsers[currentRoom][u.id]) })) });
        if (user) {
          io.to('room:' + currentRoom).emit('activity', { text: `${user.name} went offline` });
        }
      }
    }
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
