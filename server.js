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
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// In-memory metadata store (persists to JSON file)
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
  return { appIcon: null, stickers: [] };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
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

// API: Get all CMS data
app.get('/api/data', (req, res) => {
  res.json(loadData());
});

// API: Upload icon
app.post('/api/icon', upload.single('icon'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const data = loadData();
    // Delete old icon from Cloudinary if exists
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
    res.json(data.appIcon);
  } catch (err) {
    console.error('Icon upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// API: Upload sticker
app.post('/api/stickers', upload.single('sticker'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const result = await uploadToCloudinary(req.file.buffer, 'ustwo/stickers');
    const data = loadData();
    const sticker = {
      id: `sticker_${Date.now()}`,
      publicId: result.public_id,
      url: result.secure_url,
      name: req.body.name || req.file.originalname,
      category: req.body.category || 'general',
      uploadedAt: new Date().toISOString(),
    };
    data.stickers.push(sticker);
    saveData(data);
    res.json(sticker);
  } catch (err) {
    console.error('Sticker upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// API: Delete sticker
app.delete('/api/stickers/:id', async (req, res) => {
  const data = loadData();
  const idx = data.stickers.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Sticker not found' });
  const sticker = data.stickers[idx];
  if (sticker.publicId) await deleteFromCloudinary(sticker.publicId);
  data.stickers.splice(idx, 1);
  saveData(data);
  res.json({ success: true });
});

// API: Update sticker name/category
app.patch('/api/stickers/:id', (req, res) => {
  const data = loadData();
  const sticker = data.stickers.find(s => s.id === req.params.id);
  if (!sticker) return res.status(404).json({ error: 'Sticker not found' });
  if (req.body.name) sticker.name = req.body.name;
  if (req.body.category) sticker.category = req.body.category;
  saveData(data);
  res.json(sticker);
});

// Serve CMS frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`CMS running at http://localhost:${PORT}`);
});
