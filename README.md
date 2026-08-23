# TempShare

> **Temporary, link-based collaborative workspaces.**
> Share files, organize folders, and chat — all in one ephemeral room. No signup. No install.

Inspired by a mix of Google Drive + WhatsApp + Discord, but ephemeral and link-based. Anyone you share the link with can join instantly. The owner (and promoted admins) control who can chat, upload, delete, and manage folders.

---

## ✨ Features

- 🔗 **One-click room creation** — click "Create a Room", get a shareable link instantly.
- 👥 **Join by link** — no accounts, no passwords (display name only).
- 📁 **File & folder sharing** — upload files or entire folders (subfolder structure preserved), create folders, organize together.
- 📤 **Drag & drop uploads** — drop files *or* entire folders anywhere in the file panel; subfolders are recreated exactly.
- 💬 **Real-time chat** — powered by Socket.IO, with typing indicators.
- 🛡️ **Role-based permissions (RBAC):**
  - **Owner** — full control, can promote/demote admins.
  - **Admin** — can manage member permissions and room settings.
  - **Member** — permissions configurable per user (chat / upload / create folders / delete / rename).
- 🟢 **Online presence** — see who's currently in the room.
- ⏳ **Custom auto-expiry (1 hour → 1 year)** — choose when creating, owner can change anytime; everything (files + chat) is permanently wiped when the timer runs out.
- 🗑️ **Owner "Delete Room"** — instantly destroy the room and all its data; everyone gets disconnected.
- 📱 **Responsive UI** — works on desktop and mobile.
- 📋 **Copy invite link** button for easy sharing.
- 🕐 Activity feed showing who joined / uploaded / changed roles / updated settings.

---

## 🚀 Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Run the server
npm start
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 🛠️ Configuration (Environment Variables)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `ROOM_EXPIRY_HOURS` | `24` | Default expiry for new rooms (in hours) |
| `MAX_EXPIRY_HOURS` | `8760` (1 year) | Hard cap users can extend a room's expiry to |
| `MAX_FILE_SIZE` | `52428800` (50 MB) | Max upload size per file in bytes |

Example:
```bash
ROOM_EXPIRY_HOURS=48 MAX_EXPIRY_HOURS=8760 MAX_FILE_SIZE=104857600 npm start
```

---

## 📂 Project Structure

```
temp-share/
├── server.js              # Express + Socket.IO backend
├── package.json
├── public/
│   ├── index.html         # Landing page (create/join room)
│   ├── room.html          # Room/workspace UI
│   ├── css/
│   │   └── style.css      # Custom styles (Tailwind via CDN)
│   └── js/
│       ├── app.js         # Landing page logic
│       └── room.js        # Room page logic (chat, files, permissions)
├── uploads/               # Uploaded files (organized by room ID) — created at runtime
└── data/
    └── rooms.json         # Persisted room/user/file/chat metadata
```

---

## 🧑‍💻 How to Use

1. Open the homepage, enter your name, pick an **auto-delete** duration (1 hour → 1 year), then click **Create a Room**.
2. You'll be taken to your new room. Click **Copy Link** and share it with others.
3. Others open the link, enter their name, and land in the same room.
4. **Upload files** (button or drag & drop, including whole folders), **create folders**, and **chat** in the right panel.
5. The header shows a live countdown ⏳ until the room expires. As **owner**, click the pencil icon next to it to change the expiry anytime.
6. As owner, click the **red Delete button** in the header to instantly wipe the room and disconnect everyone (double-confirm).
7. As owner/admin, click the ⚙️ icon next to any user's name in the sidebar to:
   - Toggle individual permissions (chat, upload, delete, create folder, rename).
   - Promote to admin / demote to member (owner-only).

---

## ☁️ Deployment

This is a standard Node.js app with **no build step** — Tailwind is loaded via CDN. Deploy anywhere that supports Node:

### Render / Railway / Fly.io / Heroku
- Set the start command: `npm start`
- The app listens on `process.env.PORT` (set automatically by most platforms).
- ⚠️ **Note:** File uploads and `data/rooms.json` are stored on the local filesystem. For ephemeral filesystems (like Heroku), consider mounting a persistent disk or switching to S3/Firebase storage.

### Self-hosted (VPS)
```bash
git clone <your-repo>
cd temp-share
npm install --production
PORT=80 ROOM_EXPIRY_HOURS=24 npm start
```
Use `pm2` or `systemd` to keep it running.

### Nginx reverse proxy (for HTTPS + WebSocket support)
```nginx
server {
  listen 80;
  server_name yourdomain.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
```

---

## 🗄️ Data Model (in `data/rooms.json`)

```js
{
  "<roomId>": {
    "id": "abcd1234",
    "name": "Project Files",
    "createdAt": 1700000000000,
    "expiresAt": 1700086400000,
    "ownerId": "...",
    "users": [
      {
        "id": "...",
        "name": "Alex",
        "role": "owner", // owner | admin | member
        "permissions": {
          "can_chat": true,
          "can_upload": true,
          "can_delete": true,
          "can_create_folder": true,
          "can_rename": true
        },
        "joinedAt": 1700000000000
      }
    ],
    "files": [
      { "id": "root", "name": "root", "type": "folder", "parentId": null, ... },
      { "id": "...", "type": "file", "name": "report.pdf", "parentId": "root", "size": 12345, "storageName": "...", "uploadedBy": "..." }
    ],
    "messages": [
      { "id": "...", "userId": "...", "userName": "Alex", "text": "Hello!", "ts": 1700000000000 }
    ]
  }
}
```

---

## 🔮 Ideas for Next Steps / Contributions

- 🔒 Optional room passwords
- 📊 File activity log (audit trail)
- ☁️ S3 / Cloudinary / Firebase Storage backend for uploads
- 💾 Persistent database (MongoDB / PostgreSQL / Redis) instead of JSON file
- 🔔 Browser notifications for mentions
- 👀 Read receipts
- 🧭 File previews (images, PDFs, text)
- 🔗 File sharing links (per-file public URLs)
- 🌙 Dark/light theme toggle

---

## 📝 License

MIT — feel free to use this for your own projects, portfolios, or startups.
