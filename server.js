const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cloudinary = require('cloudinary').v2;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configure Cloudinary
const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;

console.log('Cloudinary config check:');
console.log('  CLOUD_NAME:', cloudName ? 'SET (' + cloudName + ')' : 'MISSING');
console.log('  API_KEY:', apiKey ? 'SET (' + apiKey + ')' : 'MISSING');
console.log('  API_SECRET:', apiSecret ? 'SET (****)' : 'MISSING');

cloudinary.config({
  cloud_name: cloudName,
  api_key: apiKey,
  api_secret: apiSecret,
});

// ─── SSE: Server-Sent Events for realtime updates ───────────────────────────
const sseClients = [];

function broadcast(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((res, i) => {
    try {
      res.write(payload);
    } catch (e) {
      sseClients.splice(i, 1);
    }
  });
}

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`data: ${JSON.stringify({ type: 'connected', payload: {} })}\n\n`);
  sseClients.push(res);
  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

// ─── Pre-bundled icon catalog ────────────────────────────────────────────────
const ICON_CATALOG = [
  { key: 'icon1', name: 'Purple', file: '/icons/icon1.webp' },
  { key: 'icon2', name: 'Pink', file: '/icons/icon2.webp' },
  { key: 'icon3', name: 'Green', file: '/icons/icon3.webp' },
];

// ─── Pre-bundled splash screen catalog (expanded with new assets) ────────────
const SPLASH_CATALOG = [
  { key: 'splash1', name: 'Splash 1', file: '/splash/splash1.jpg' },
  { key: 'splash2', name: 'Splash 2', file: '/splash/splash2.webp' },
  { key: 'splash3', name: 'Splash 3', file: '/splash/splash3.webp' },
  { key: 'splash4', name: 'Splash 4', file: '/splash/splash4.webp' },
  { key: 'splash5', name: 'Splash 5', file: '/splash/splash5.webp' },
];

// Track dynamically uploaded splashes
const UPLOADED_SPLASH_DIR = path.join(__dirname, 'public', 'uploaded-splash');
if (!fs.existsSync(UPLOADED_SPLASH_DIR)) {
  fs.mkdirSync(UPLOADED_SPLASH_DIR, { recursive: true });
}

// Scan uploaded-splash directory on startup for any existing files
function getUploadedSplashes() {
  try {
    const files = fs.readdirSync(UPLOADED_SPLASH_DIR);
    return files.filter(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f)).map((f, i) => ({
      key: 'uploaded_' + i,
      name: path.parse(f).name,
      file: '/uploaded-splash/' + f,
      uploaded: true,
    }));
  } catch (e) {
    return [];
  }
}

// ─── In-memory metadata store (persists to JSON file) ────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (data.activeIcon === 'icon4' || data.activeIcon === 'icon5') {
      data.activeIcon = 'icon1';
      saveData(data);
    }
    return data;
  }
  return { appIcon: null, activeIcon: 'icon1', activeSplash: 'splash1', stickers: [] };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Rebuild data.json from Cloudinary on startup (handles Render ephemeral storage)
async function syncFromCloudinary() {
  try {
    if (!cloudName || !apiKey || !apiSecret) {
      console.log('Skipping Cloudinary sync — credentials not configured');
      if (!fs.existsSync(DATA_FILE)) {
        saveData({ appIcon: null, activeIcon: 'icon1', activeSplash: 'splash1', stickers: [] });
      }
      return;
    }

    console.log('Syncing data from Cloudinary...');
    // Load existing data to preserve active selections
    const data = loadData();

    // Fetch icons
    const icons = await cloudinary.api.resources({
      type: 'upload',
      prefix: 'ustwo/icons/',
      max_results: 1,
      resource_type: 'image',
    });
    if (icons.resources.length > 0) {
      const icon = icons.resources[0];
      data.appIcon = {
        publicId: icon.public_id,
        url: icon.secure_url,
        uploadedAt: icon.created_at,
      };
    }

    // Fetch stickers
    const stickers = await cloudinary.api.resources({
      type: 'upload',
      prefix: 'ustwo/stickers/',
      max_results: 100,
      resource_type: 'image',
    });
    data.stickers = stickers.resources.map(r => ({
      id: 'sticker_' + r.created_at,
      publicId: r.public_id,
      url: r.secure_url,
      name: path.parse(r.public_id).name,
      category: 'general',
      uploadedAt: r.created_at,
    }));

    saveData(data);
    console.log('Synced: 1 icon, ' + data.stickers.length + ' stickers');
  } catch (err) {
    console.error('Cloudinary sync failed:', err.message || JSON.stringify(err));
    if (!fs.existsSync(DATA_FILE)) {
      saveData({ appIcon: null, activeIcon: 'icon1', activeSplash: 'splash1', stickers: [] });
    }
  }
}

// Multer: store in memory for Cloudinary upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files allowed'));
    }
  },
});

// Upload buffer to Cloudinary
async function uploadToCloudinary(buffer, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    stream.end(buffer);
  });
}

// Delete from Cloudinary
async function deleteFromCloudinary(publicId) {
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (e) {
    console.error('Cloudinary delete error:', e.message);
  }
}

// ─── Health check endpoint (for keep-alive pings) ────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── API: Get all CMS data ──────────────────────────────────────────────────
app.get('/api/data', (req, res) => {
  const data = loadData();
  data.iconCatalog = ICON_CATALOG;
  data.splashCatalog = [...SPLASH_CATALOG, ...getUploadedSplashes()];
  res.json(data);
});

// ─── API: Get active icon ───────────────────────────────────────────────────
app.get('/api/active-icon', (req, res) => {
  const data = loadData();
  const activeKey = data.activeIcon || 'icon1';
  const icon = ICON_CATALOG.find(i => i.key === activeKey) || ICON_CATALOG[0];
  res.json({ activeIcon: activeKey, icon });
});

// ─── API: Set active icon ───────────────────────────────────────────────────
app.post('/api/active-icon', (req, res) => {
  const { key } = req.body;
  if (!key || !ICON_CATALOG.find(i => i.key === key)) {
    return res.status(400).json({ error: 'Invalid icon key. Valid keys: ' + ICON_CATALOG.map(i => i.key).join(', ') });
  }
  const data = loadData();
  data.activeIcon = key;
  saveData(data);
  const icon = ICON_CATALOG.find(i => i.key === key);
  broadcast('icon-changed', { activeIcon: key, icon });
  res.json({ activeIcon: key, icon });
});

// ─── API: Get active splash ─────────────────────────────────────────────────
app.get('/api/active-splash', (req, res) => {
  const data = loadData();
  const activeKey = data.activeSplash || 'splash1';
  const allSplashes = [...SPLASH_CATALOG, ...getUploadedSplashes()];
  const splash = allSplashes.find(s => s.key === activeKey) || SPLASH_CATALOG[0];
  res.json({ activeSplash: activeKey, splash });
});

// ─── API: Set active splash ─────────────────────────────────────────────────
app.post('/api/active-splash', (req, res) => {
  const { key } = req.body;
  const allSplashes = [...SPLASH_CATALOG, ...getUploadedSplashes()];
  if (!key || !allSplashes.find(s => s.key === key)) {
    return res.status(400).json({ error: 'Invalid splash key. Valid keys: ' + allSplashes.map(s => s.key).join(', ') });
  }
  const data = loadData();
  data.activeSplash = key;
  saveData(data);
  const splash = allSplashes.find(s => s.key === key);
  broadcast('splash-changed', { activeSplash: key, splash });
  res.json({ activeSplash: key, splash });
});

// ─── API: Upload custom splash screen ───────────────────────────────────────
app.post('/api/splash', upload.single('splash'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const ext = path.extname(req.file.originalname) || '.webp';
    const fileName = 'custom_' + Date.now() + ext;
    const localPath = path.join(UPLOADED_SPLASH_DIR, fileName);

    // Save locally
    fs.writeFileSync(localPath, req.file.buffer);

    // Also upload to Cloudinary for backup
    let cloudinaryUrl = null;
    try {
      const result = await uploadToCloudinary(req.file.buffer, 'ustwo/splash');
      cloudinaryUrl = result.secure_url;
    } catch (e) {
      console.warn('Cloudinary splash upload failed (local copy saved):', e.message);
    }

    const splashEntry = {
      key: 'uploaded_' + Date.now(),
      name: req.body.name || path.parse(req.file.originalname).name,
      file: '/uploaded-splash/' + fileName,
      cloudinaryUrl,
      uploaded: true,
    };

    broadcast('splash-uploaded', splashEntry);
    res.json(splashEntry);
  } catch (err) {
    console.error('Splash upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ─── API: Upload icon ───────────────────────────────────────────────────────
app.post('/api/icon', upload.single('icon'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const data = loadData();
    if (data.appIcon && data.appIcon.publicId) {
      await deleteFromCloudinary(data.appIcon.publicId);
    }
    const result = await uploadToCloudinary(req.file.buffer, 'ustwo/icons');
    data.appIcon = {
      publicId: result.public_id,
      url: result.secure_url,
      uploadedAt: new Date().toISOString(),
    };
    saveData(data);
    broadcast('icon-uploaded', data.appIcon);
    res.json(data.appIcon);
  } catch (err) {
    console.error('Icon upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ─── API: Upload sticker ────────────────────────────────────────────────────
app.post('/api/stickers', upload.single('sticker'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const result = await uploadToCloudinary(req.file.buffer, 'ustwo/stickers');
    const data = loadData();
    const sticker = {
      id: 'sticker_' + Date.now(),
      publicId: result.public_id,
      url: result.secure_url,
      name: req.body.name || req.file.originalname,
      category: req.body.category || 'general',
      uploadedAt: new Date().toISOString(),
    };
    data.stickers.push(sticker);
    saveData(data);
    broadcast('sticker-added', sticker);
    res.json(sticker);
  } catch (err) {
    console.error('Sticker upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ─── API: Delete sticker ────────────────────────────────────────────────────
app.delete('/api/stickers/:id', async (req, res) => {
  const data = loadData();
  const idx = data.stickers.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Sticker not found' });
  const sticker = data.stickers[idx];
  if (sticker.publicId) await deleteFromCloudinary(sticker.publicId);
  data.stickers.splice(idx, 1);
  saveData(data);
  broadcast('sticker-deleted', { id: req.params.id });
  res.json({ success: true });
});

// ─── API: Update sticker name/category ──────────────────────────────────────
app.patch('/api/stickers/:id', (req, res) => {
  const data = loadData();
  const sticker = data.stickers.find(s => s.id === req.params.id);
  if (!sticker) return res.status(404).json({ error: 'Sticker not found' });
  if (req.body.name) sticker.name = req.body.name;
  if (req.body.category) sticker.category = req.body.category;
  saveData(data);
  broadcast('sticker-updated', sticker);
  res.json(sticker);
});

// ─── Serve CMS frontend ─────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Self-ping every 14 minutes to prevent Render free tier from sleeping ───
function keepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (url) {
    setInterval(() => {
      fetch(url + '/health').catch(() => {});
    }, 14 * 60 * 1000);
    console.log('Keep-alive enabled: pinging ' + url + '/health every 14 min');
  } else {
    console.log('Keep-alive disabled: RENDER_EXTERNAL_URL not set');
  }
}

// Sync from Cloudinary before starting
syncFromCloudinary().then(() => {
  app.listen(PORT, () => {
    console.log('CMS running at http://localhost:' + PORT);
    console.log('SSE endpoint: /api/events');
    keepAlive();
  });
});
