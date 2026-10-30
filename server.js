import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'groove_raw_secret_key_super_secure_9921_vinyl_os';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// =================== MONGODB CONNECTION & SCHEMAS ===================
let isMongoConnected = false;
const MONGODB_URI = process.env.MONGODB_URI;

if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000
  }).then(() => {
    isMongoConnected = true;
    console.log('📦 [MongoDB Atlas] Connected successfully to Groove Music Database!');
  }).catch(err => {
    console.warn('⚠️ [MongoDB Atlas] Connection warning:', err.message);
  });
}

// User Schema (Login info)
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  email: { type: String, trim: true, lowercase: true },
  password: { type: String, required: true },
  displayName: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

// Playlist / Crate Schema (User playlists & songs)
const playlistSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  id: { type: String, required: true }, // e.g. "crate-custom-12345"
  title: { type: String, required: true },
  subtitle: { type: String, default: 'CUSTOM PLAYLIST' },
  badge: { type: String, default: 'USER CRATE' },
  genre: { type: String, default: 'PERSONAL MIX' },
  rpm: { type: String, default: '33⅓ RPM' },
  cover: { type: String, default: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=300&h=200&fit=crop' },
  isCustom: { type: Boolean, default: true },
  tracks: [{
    id: { type: String, required: true }, // YouTube video ID
    cut: { type: String, default: '01' },
    title: { type: String, required: true },
    artist: { type: String, default: 'UNKNOWN ARTIST' },
    duration: { type: String, default: '03:45' },
    thumbnail: { type: String, default: '' }
  }],
  updatedAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Playlist = mongoose.model('Playlist', playlistSchema);

// Optional JWT Auth Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, error: 'NO_TOKEN_PROVIDED' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ success: false, error: 'INVALID_OR_EXPIRED_TOKEN' });
    }
    req.user = decoded; // { id, username }
    next();
  });
}

// In-memory rooms for "Groove Together"
// Key: 4-character code (uppercase alphanumeric e.g. "7K2A")
// Value: { code, name, createdAt, hostId, tracks, currentTrackIndex, isPlaying, playbackSeconds, lastStateUpdate, clients: Set<WebSocket> }
const grooveRooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Unambiguous characters (no 0/O, 1/I)
  let code = '';
  for (let attempt = 0; attempt < 100; attempt++) {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (!grooveRooms.has(code)) return code;
  }
  return code;
}

function broadcastToRoom(roomCode, message, excludeWs = null) {
  const room = grooveRooms.get(roomCode);
  if (!room) return;
  const data = typeof message === 'string' ? message : JSON.stringify(message);
  for (const client of room.clients) {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      try {
        client.send(data);
      } catch (e) {
        console.warn('Failed to send to client in room', roomCode, e.message);
      }
    }
  }
}

// In-memory LRU-style cache to save API quota and make instant responses
const searchCache = new Map();

/**
 * Fallback / Direct YouTube Public Search (No API Key Required!)
 * Extracts video items directly from YouTube search results without consuming quota.
 */
async function searchYouTubeScrape(query) {
  try {
    const encodedQuery = encodeURIComponent(query + ' official audio');
    const url = `https://www.youtube.com/results?search_query=${encodedQuery}`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    
    if (!response.ok) {
      throw new Error(`YouTube scrape failed with status ${response.status}`);
    }

    const html = await response.text();
    const ytInitialDataMatch = html.match(/ytInitialData\s*=\s*({.+?});<\/script>/s) ||
                               html.match(/var\s+ytInitialData\s*=\s*({.+?});/s);

    if (!ytInitialDataMatch) {
      return [];
    }

    const data = JSON.parse(ytInitialDataMatch[1]);
    const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
      ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];

    const results = [];
    for (const item of contents) {
      if (item.videoRenderer && results.length < 8) {
        const vr = item.videoRenderer;
        const videoId = vr.videoId;
        const title = vr.title?.runs?.[0]?.text || 'Unknown Title';
        const artist = vr.ownerText?.runs?.[0]?.text || vr.shortBylineText?.runs?.[0]?.text || 'Unknown Artist';
        const duration = vr.lengthText?.simpleText || '03:45';
        const thumbnail = vr.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

        if (videoId) {
          results.push({
            id: videoId,
            title,
            artist,
            duration,
            thumbnail
          });
        }
      }
    }

    return results;
  } catch (err) {
    console.error('Scrape search error:', err.message);
    return [];
  }
}

/**
 * Official YouTube Data API v3 Search
 */
async function searchYouTubeAPI(query, apiKey) {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=8&key=${apiKey}`;
  const response = await fetch(url);
  
  if (!response.ok) {
    throw new Error(`YouTube API returned ${response.status}`);
  }

  const data = await response.json();
  return (data.items || []).map(item => ({
    id: item.id.videoId,
    title: item.snippet.title,
    artist: item.snippet.channelTitle,
    duration: '03:45',
    thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url
  }));
}

/**
 * AI Resolution with Gemini (translates vague moods/requests to concrete tracks)
 */
async function resolvePromptWithAI(prompt, geminiApiKey) {
  if (!geminiApiKey) {
    return prompt;
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Given the user mood, genre, or request: "${prompt}", name the single best matching real song and artist as a clean search query like: "Song Name - Artist Name". Reply with ONLY the song and artist name, nothing else.`
          }]
        }]
      })
    });

    if (!response.ok) return prompt;
    const json = await response.json();
    const suggestedQuery = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return suggestedQuery || prompt;
  } catch (e) {
    console.error('AI mood resolution failed:', e.message);
    return prompt;
  }
}

// =================== API ENDPOINTS ===================

// Health & Quota Info
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ONLINE',
    engine: 'ANALOG_VINYL_OS_v2.6',
    freeTierActive: true,
    hasOfficialApiKey: Boolean(process.env.YOUTUBE_API_KEY),
    hasGeminiApiKey: Boolean(process.env.GEMINI_API_KEY),
    cachedSearches: searchCache.size
  });
});

// Search Endpoint (Handles AI mood translation + YouTube search + Caching)
app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  const isAiPrompt = req.query.ai === 'true';

  if (!query) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  const cacheKey = `${isAiPrompt ? 'ai:' : 'raw:'}${query.toLowerCase()}`;
  if (searchCache.has(cacheKey)) {
    return res.json({
      cached: true,
      query,
      results: searchCache.get(cacheKey)
    });
  }

  try {
    let effectiveQuery = query;
    let aiTransformed = false;

    if (isAiPrompt) {
      const resolved = await resolvePromptWithAI(query, process.env.GEMINI_API_KEY);
      if (resolved && resolved !== query) {
        effectiveQuery = resolved;
        aiTransformed = true;
      }
    }

    let results = [];
    if (process.env.YOUTUBE_API_KEY) {
      try {
        results = await searchYouTubeAPI(effectiveQuery, process.env.YOUTUBE_API_KEY);
      } catch (apiErr) {
        console.warn('YouTube API failed, falling back to free scraper:', apiErr.message);
        results = await searchYouTubeScrape(effectiveQuery);
      }
    } else {
      results = await searchYouTubeScrape(effectiveQuery);
    }

    // Fallback curate list if scrape hits rare rate-limit
    if (!results || results.length === 0) {
      results = [
        {
          id: 'fHI8X483mQw',
          title: 'The Weeknd - After Hours (Official Audio)',
          artist: 'The Weeknd',
          duration: '06:01',
          thumbnail: 'https://i.ytimg.com/vi/fHI8X483mQw/hqdefault.jpg'
        },
        {
          id: '4NRXx6U8ABQ',
          title: 'The Weeknd - Blinding Lights (Official Video)',
          artist: 'The Weeknd',
          duration: '03:22',
          thumbnail: 'https://i.ytimg.com/vi/4NRXx6U8ABQ/hqdefault.jpg'
        },
        {
          id: '7-x3uDFv4hU',
          title: 'Daft Punk - Veridis Quo',
          artist: 'Daft Punk',
          duration: '05:45',
          thumbnail: 'https://i.ytimg.com/vi/7-x3uDFv4hU/hqdefault.jpg'
        }
      ];
    }

    searchCache.set(cacheKey, results);

    res.json({
      cached: false,
      aiTransformed,
      query: effectiveQuery,
      results
    });
  } catch (err) {
    res.status(500).json({ error: 'Search failed', details: err.message });
  }
});

// Crates & Playlists storage (starts completely empty, populated dynamically by user)
const SERVER_CRATES = [];

// Default initial crate playlist endpoint
app.get('/api/initial-crate', (req, res) => {
  res.json({
    crateTitle: 'MY PLAYLIST // CRATE 01',
    crateId: 'crate-default',
    tracks: []
  });
});

// Image Proxy Endpoint (Bypasses any browser CORS or referrer restrictions on image canvases)
app.get('/api/proxy-image', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) {
    return res.status(400).send('Missing url parameter');
  }

  try {
    const upstreamRes = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!upstreamRes.ok) {
      return res.status(upstreamRes.status).send('Failed to fetch image');
    }

    const contentType = upstreamRes.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');

    const arrayBuffer = await upstreamRes.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    res.status(500).send('Proxy error: ' + err.message);
  }
});

// All crates & playlists endpoint
app.get('/api/crates', (req, res) => {
  res.json({
    count: SERVER_CRATES.length,
    crates: SERVER_CRATES
  });
});

// =================== MONGODB USER AUTHENTICATION & PLAYLIST API ===================

// Register user
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, email } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'USERNAME_AND_PASSWORD_REQUIRED' });
    }

    const cleanUsername = username.trim().toLowerCase();
    if (cleanUsername.length < 3) {
      return res.status(400).json({ success: false, error: 'USERNAME_TOO_SHORT' });
    }
    if (password.length < 4) {
      return res.status(400).json({ success: false, error: 'PASSWORD_TOO_SHORT' });
    }

    if (!isMongoConnected) {
      return res.status(503).json({ success: false, error: 'DATABASE_OFFLINE' });
    }

    const existing = await User.findOne({ username: cleanUsername });
    if (existing) {
      return res.status(409).json({ success: false, error: 'USERNAME_ALREADY_EXISTS' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new User({
      username: cleanUsername,
      email: (email || '').trim().toLowerCase(),
      password: hashedPassword,
      displayName: username.trim().toUpperCase()
    });
    await newUser.save();

    // Create initial starter crate for new user in MongoDB
    const defaultCrate = new Playlist({
      userId: newUser._id,
      id: `crate-${Date.now()}`,
      title: `${newUser.displayName} // CRATE 01`,
      subtitle: 'PERSONAL VINYL COLLECTION',
      badge: 'MY CRATE',
      genre: 'FAVORITES',
      rpm: '33⅓ RPM',
      cover: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=300&h=200&fit=crop',
      tracks: [
        {
          id: 'fHI8X483mQw',
          cut: '01',
          title: 'AFTER HOURS',
          artist: 'THE WEEKND',
          duration: '06:01',
          thumbnail: 'https://i.ytimg.com/vi/fHI8X483mQw/hqdefault.jpg'
        }
      ]
    });
    await defaultCrate.save();

    const token = jwt.sign(
      { id: newUser._id, username: newUser.username },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      message: 'REGISTRATION_SUCCESSFUL',
      token,
      user: {
        id: newUser._id,
        username: newUser.username,
        displayName: newUser.displayName
      }
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ success: false, error: 'SERVER_ERROR: ' + err.message });
  }
});

// Login user
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'USERNAME_AND_PASSWORD_REQUIRED' });
    }

    if (!isMongoConnected) {
      return res.status(503).json({ success: false, error: 'DATABASE_OFFLINE' });
    }

    const cleanUsername = username.trim().toLowerCase();
    const user = await User.findOne({ username: cleanUsername });
    if (!user) {
      return res.status(401).json({ success: false, error: 'INVALID_CREDENTIALS' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, error: 'INVALID_CREDENTIALS' });
    }

    const token = jwt.sign(
      { id: user._id, username: user.username },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        username: user.username,
        displayName: user.displayName || user.username.toUpperCase()
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, error: 'SERVER_ERROR: ' + err.message });
  }
});

// Get current logged-in user profile
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
    }
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get all playlists & tracks for authenticated user
app.get('/api/user/playlists', authenticateToken, async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ success: false, error: 'DATABASE_OFFLINE' });
    }
    const playlists = await Playlist.find({ userId: req.user.id }).sort({ updatedAt: -1 });
    res.json({
      success: true,
      count: playlists.length,
      playlists: playlists.map(p => ({
        id: p.id,
        title: p.title,
        subtitle: p.subtitle,
        badge: p.badge,
        genre: p.genre,
        rpm: p.rpm,
        cover: p.cover,
        isCustom: true,
        tracks: p.tracks
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save or sync all playlists/crates for authenticated user
app.post('/api/user/sync-crates', authenticateToken, async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ success: false, error: 'DATABASE_OFFLINE' });
    }

    const incomingCrates = Array.isArray(req.body.crates) ? req.body.crates : [];
    const userId = req.user.id;

    for (const crate of incomingCrates) {
      if (!crate.id || !crate.title) continue;

      const cleanTracks = (Array.isArray(crate.tracks) ? crate.tracks : []).map((t, idx) => ({
        id: t.id,
        cut: t.cut || String(idx + 1).padStart(2, '0'),
        title: (t.title || 'UNTITLED TRACK').toUpperCase(),
        artist: (t.artist || 'UNKNOWN ARTIST').toUpperCase(),
        duration: t.duration || '03:45',
        thumbnail: t.thumbnail || `https://i.ytimg.com/vi/${t.id}/hqdefault.jpg`
      }));

      await Playlist.findOneAndUpdate(
        { userId, id: crate.id },
        {
          userId,
          id: crate.id,
          title: (crate.title || 'MY CRATE').toUpperCase(),
          subtitle: crate.subtitle || 'CUSTOM USER PLAYLIST',
          badge: crate.badge || 'SAVED CRATE',
          genre: crate.genre || 'PERSONAL MIX',
          rpm: crate.rpm || '33⅓ RPM',
          cover: cleanTracks[0]?.thumbnail || crate.cover || 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=300&h=200&fit=crop',
          isCustom: true,
          tracks: cleanTracks,
          updatedAt: new Date()
        },
        { upsert: true, new: true }
      );
    }

    const allUserPlaylists = await Playlist.find({ userId }).sort({ updatedAt: -1 });

    res.json({
      success: true,
      message: 'PLAYLISTS_SYNCED_TO_MONGODB',
      count: allUserPlaylists.length,
      playlists: allUserPlaylists.map(p => ({
        id: p.id,
        title: p.title,
        subtitle: p.subtitle,
        badge: p.badge,
        genre: p.genre,
        rpm: p.rpm,
        cover: p.cover,
        isCustom: true,
        tracks: p.tracks
      }))
    });
  } catch (err) {
    console.error('Crates sync error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete a user playlist from MongoDB
app.delete('/api/user/playlist/:id', authenticateToken, async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ success: false, error: 'DATABASE_OFFLINE' });
    }
    const crateId = req.params.id;
    await Playlist.deleteOne({ userId: req.user.id, id: crateId });
    res.json({ success: true, message: 'PLAYLIST_DELETED_FROM_MONGODB' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================= GROOVE TOGETHER (ROOMS & SYNC) API =================

// Create a new Groove Together room (with a random 4-character code)
app.post('/api/room/create', (req, res) => {
  const code = generateRoomCode();
  const roomName = (req.body.name || `GROOVE JAM // ${code}`).toUpperCase().trim();
  const initialTracks = Array.isArray(req.body.tracks) ? req.body.tracks : [];
  const initialIndex = typeof req.body.currentTrackIndex === 'number' ? req.body.currentTrackIndex : 0;
  const initialPlaying = Boolean(req.body.isPlaying);

  const room = {
    code,
    name: roomName,
    createdAt: Date.now(),
    tracks: initialTracks,
    currentTrackIndex: initialIndex,
    isPlaying: initialPlaying,
    playbackSeconds: 0,
    lastStateUpdate: Date.now(),
    clients: new Set()
  };

  grooveRooms.set(code, room);

  console.log(`[Groove Together] Room created: ${code} ("${roomName}") with ${room.tracks.length} tracks.`);

  res.json({
    success: true,
    code,
    room: {
      code: room.code,
      name: room.name,
      tracks: room.tracks,
      currentTrackIndex: room.currentTrackIndex,
      isPlaying: room.isPlaying,
      playbackSeconds: room.playbackSeconds,
      listenersCount: room.clients.size
    }
  });
});

// Get room details by code
app.get('/api/room/:code', (req, res) => {
  const code = (req.params.code || '').toUpperCase().trim();
  const room = grooveRooms.get(code);

  if (!room) {
    return res.status(404).json({ success: false, error: 'ROOM NOT FOUND. CHECK YOUR 4-DIGIT CODE.' });
  }

  res.json({
    success: true,
    room: {
      code: room.code,
      name: room.name,
      tracks: room.tracks,
      currentTrackIndex: room.currentTrackIndex,
      isPlaying: room.isPlaying,
      playbackSeconds: room.playbackSeconds,
      listenersCount: room.clients.size
    }
  });
});

// All active rooms (for discovery / listing)
app.get('/api/rooms', (req, res) => {
  const list = [];
  for (const [code, r] of grooveRooms.entries()) {
    list.push({
      code,
      name: r.name,
      trackCount: r.tracks.length,
      currentTrack: r.tracks[r.currentTrackIndex] || null,
      isPlaying: r.isPlaying,
      listenersCount: r.clients.size,
      createdAt: r.createdAt
    });
  }
  res.json({ count: list.length, rooms: list });
});

// WebSocket Real-Time Synchronization for Groove Together
wss.on('connection', (ws) => {
  let joinedRoomCode = null;
  let clientUserName = 'ANONYMOUS';

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      const { type, code, payload } = msg;

      if (type === 'JOIN_ROOM') {
        const targetCode = (code || '').toUpperCase().trim();
        const room = grooveRooms.get(targetCode);
        if (!room) {
          ws.send(JSON.stringify({ type: 'ERROR', message: `ROOM "${targetCode}" NOT FOUND` }));
          return;
        }

        // Leave previous room if any
        if (joinedRoomCode && grooveRooms.has(joinedRoomCode)) {
          const oldRoom = grooveRooms.get(joinedRoomCode);
          oldRoom.clients.delete(ws);
          broadcastToRoom(joinedRoomCode, {
            type: 'ROOM_UPDATE',
            room: {
              code: oldRoom.code,
              name: oldRoom.name,
              tracks: oldRoom.tracks,
              currentTrackIndex: oldRoom.currentTrackIndex,
              isPlaying: oldRoom.isPlaying,
              playbackSeconds: oldRoom.playbackSeconds,
              listenersCount: oldRoom.clients.size
            },
            eventNotice: `${clientUserName} left the jam.`
          });
        }

        joinedRoomCode = targetCode;
        if (payload?.userName) clientUserName = payload.userName.toUpperCase().trim();
        room.clients.add(ws);

        // Send full room snapshot to joining user
        ws.send(JSON.stringify({
          type: 'ROOM_JOINED',
          room: {
            code: room.code,
            name: room.name,
            tracks: room.tracks,
            currentTrackIndex: room.currentTrackIndex,
            isPlaying: room.isPlaying,
            playbackSeconds: room.playbackSeconds,
            listenersCount: room.clients.size
          }
        }));

        // Broadcast to everyone else in the room
        broadcastToRoom(joinedRoomCode, {
          type: 'ROOM_UPDATE',
          room: {
            code: room.code,
            name: room.name,
            tracks: room.tracks,
            currentTrackIndex: room.currentTrackIndex,
            isPlaying: room.isPlaying,
            playbackSeconds: room.playbackSeconds,
            listenersCount: room.clients.size
          },
          eventNotice: `${clientUserName} joined the groove!`
        }, ws);

        console.log(`[Groove Together] User "${clientUserName}" joined room ${targetCode}. Total: ${room.clients.size}`);
      }
      else if (type === 'LEAVE_ROOM') {
        if (joinedRoomCode && grooveRooms.has(joinedRoomCode)) {
          const room = grooveRooms.get(joinedRoomCode);
          room.clients.delete(ws);
          broadcastToRoom(joinedRoomCode, {
            type: 'ROOM_UPDATE',
            room: {
              code: room.code,
              name: room.name,
              tracks: room.tracks,
              currentTrackIndex: room.currentTrackIndex,
              isPlaying: room.isPlaying,
              playbackSeconds: room.playbackSeconds,
              listenersCount: room.clients.size
            },
            eventNotice: `${clientUserName} left the room.`
          });
        }
        joinedRoomCode = null;
        ws.send(JSON.stringify({ type: 'ROOM_LEFT' }));
      }
      else if (joinedRoomCode && grooveRooms.has(joinedRoomCode)) {
        const room = grooveRooms.get(joinedRoomCode);

        if (type === 'ADD_TRACK') {
          if (payload?.track) {
            room.tracks.push(payload.track);
            // If playlist was previously empty, select this track
            if (room.tracks.length === 1) {
              room.currentTrackIndex = 0;
            }
            broadcastToRoom(joinedRoomCode, {
              type: 'ROOM_UPDATE',
              room: {
                code: room.code,
                name: room.name,
                tracks: room.tracks,
                currentTrackIndex: room.currentTrackIndex,
                isPlaying: room.isPlaying,
                playbackSeconds: room.playbackSeconds,
                listenersCount: room.clients.size
              },
              eventNotice: `${clientUserName} added "${payload.track.title}" to the queue.`
            });
          }
        }
        else if (type === 'REMOVE_TRACK') {
          const idx = payload?.index;
          if (typeof idx === 'number' && idx >= 0 && idx < room.tracks.length) {
            const removed = room.tracks.splice(idx, 1)[0];
            if (room.currentTrackIndex >= room.tracks.length) {
              room.currentTrackIndex = Math.max(0, room.tracks.length - 1);
            }
            broadcastToRoom(joinedRoomCode, {
              type: 'ROOM_UPDATE',
              room: {
                code: room.code,
                name: room.name,
                tracks: room.tracks,
                currentTrackIndex: room.currentTrackIndex,
                isPlaying: room.isPlaying,
                playbackSeconds: room.playbackSeconds,
                listenersCount: room.clients.size
              },
              eventNotice: `${clientUserName} removed "${removed?.title || 'track'}" from queue.`
            });
          }
        }
        else if (type === 'REORDER_TRACKS') {
          const { fromIndex, toIndex } = payload || {};
          if (typeof fromIndex === 'number' && typeof toIndex === 'number' &&
              fromIndex >= 0 && fromIndex < room.tracks.length &&
              toIndex >= 0 && toIndex < room.tracks.length) {
            const temp = room.tracks[fromIndex];
            room.tracks[fromIndex] = room.tracks[toIndex];
            room.tracks[toIndex] = temp;

            if (room.currentTrackIndex === fromIndex) {
              room.currentTrackIndex = toIndex;
            } else if (room.currentTrackIndex === toIndex) {
              room.currentTrackIndex = fromIndex;
            }

            broadcastToRoom(joinedRoomCode, {
              type: 'ROOM_UPDATE',
              room: {
                code: room.code,
                name: room.name,
                tracks: room.tracks,
                currentTrackIndex: room.currentTrackIndex,
                isPlaying: room.isPlaying,
                playbackSeconds: room.playbackSeconds,
                listenersCount: room.clients.size
              },
              eventNotice: `${clientUserName} moved track order.`
            });
          }
        }
        else if (type === 'SET_TRACK') {
          const idx = payload?.index;
          if (typeof idx === 'number' && idx >= 0 && idx < room.tracks.length) {
            room.currentTrackIndex = idx;
            room.isPlaying = true;
            room.playbackSeconds = 0;
            room.lastStateUpdate = Date.now();

            broadcastToRoom(joinedRoomCode, {
              type: 'PLAY_TRACK',
              index: idx,
              isPlaying: true,
              playbackSeconds: 0,
              track: room.tracks[idx],
              eventNotice: `${clientUserName} started playing track #${idx + 1}`
            });
          }
        }
        else if (type === 'PLAY_PAUSE') {
          room.isPlaying = Boolean(payload?.isPlaying);
          if (typeof payload?.playbackSeconds === 'number') {
            room.playbackSeconds = payload.playbackSeconds;
          }
          room.lastStateUpdate = Date.now();

          broadcastToRoom(joinedRoomCode, {
            type: 'PLAY_PAUSE',
            isPlaying: room.isPlaying,
            playbackSeconds: room.playbackSeconds,
            eventNotice: `${clientUserName} ${room.isPlaying ? 'resumed' : 'paused'} playback.`
          });
        }
        else if (type === 'SEEK') {
          const seconds = payload?.seconds || 0;
          room.playbackSeconds = seconds;
          room.lastStateUpdate = Date.now();

          broadcastToRoom(joinedRoomCode, {
            type: 'SEEK',
            seconds,
            eventNotice: `${clientUserName} scrubbed to ${formatTime(seconds)}`
          }, ws); // don't echo back to sender to avoid jitter
        }
        else if (type === 'SKIP') {
          const dir = payload?.direction || 1; // 1 = next, -1 = prev
          if (room.tracks.length > 0) {
            room.currentTrackIndex = (room.currentTrackIndex + dir + room.tracks.length) % room.tracks.length;
            room.isPlaying = true;
            room.playbackSeconds = 0;
            room.lastStateUpdate = Date.now();

            broadcastToRoom(joinedRoomCode, {
              type: 'PLAY_TRACK',
              index: room.currentTrackIndex,
              isPlaying: true,
              playbackSeconds: 0,
              track: room.tracks[room.currentTrackIndex],
              eventNotice: `${clientUserName} ${dir > 0 ? 'skipped to next track' : 'went to previous track'}`
            });
          }
        }
      }
    } catch (err) {
      console.warn('[Groove Together WS error]', err.message);
    }
  });

  ws.on('close', () => {
    if (joinedRoomCode && grooveRooms.has(joinedRoomCode)) {
      const room = grooveRooms.get(joinedRoomCode);
      room.clients.delete(ws);
      broadcastToRoom(joinedRoomCode, {
        type: 'ROOM_UPDATE',
        room: {
          code: room.code,
          name: room.name,
          tracks: room.tracks,
          currentTrackIndex: room.currentTrackIndex,
          isPlaying: room.isPlaying,
          playbackSeconds: room.playbackSeconds,
          listenersCount: room.clients.size
        },
        eventNotice: `${clientUserName} left the jam.`
      });
    }
  });
});

function formatTime(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Serve frontend static files
app.use(express.static(__dirname));

// Dedicated Login Page Route
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Only listen on port if not running in serverless environment
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🎧 GROOVE.RAW // VINYL_OS running at: http://localhost:${PORT}`);
    console.log(`📡 Ready for YouTube streaming & AI mood search!`);
    console.log(`🤝 Groove Together Rooms (WebSocket) ready!`);
    console.log(`======================================================\n`);
  });
}

export default app;
