require('dotenv').config(); // ✅ Load .env file
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const csv = require('csv-parser');
const crypto = require('crypto'); 
const bcrypt = require('bcryptjs'); 
const jwt = require('jsonwebtoken'); 
const helmet = require('helmet'); 
const rateLimit = require('express-rate-limit');

// ✅ IMPORT DB MODULE
const { User, License, RC, Log, connectDB, Op } = require('./db');

const app = express();
const port = process.env.PORT || 3000;

// SECURITY HEADERS
app.use(helmet());

// CORS SETUP
const allowedOrigins = [
    process.env.APP_URL, // Production URL
    'http://127.0.0.1:5500',
    'http://localhost:3000'
];
app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            return callback(null, true); // Block unknown origins
        }
        return callback(null, true);
    }
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.text());

const upload = multer({ 
    dest: 'uploads/',
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB Max File Size
});

// ====================================================================
// 🔐 SECRETS FROM ENV
// ====================================================================
const PASSWORD_PEPPER = process.env.PASSWORD_PEPPER;
const JWT_SECRET = process.env.JWT_SECRET;

// RSA Keys (File system is safe for these on Render)
const PRIVATE_KEY_PATH = path.join(__dirname, 'private.pem');
const PUBLIC_KEY_PATH = path.join(__dirname, 'public.pem');

// Rate Limiter
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: "Too many login attempts, please try again later."
});

// HTTPS Agent for Performance
const httpsAgent = new https.Agent({ keepAlive: true });
const axiosClient = axios.create({ httpsAgent });

function generateRSAKeys() {
    if (!fs.existsSync(PRIVATE_KEY_PATH)) {
        console.log("🔑 Generating RSA Keys...");
        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        fs.writeFileSync(PRIVATE_KEY_PATH, privateKey);
        fs.writeFileSync(PUBLIC_KEY_PATH, publicKey);
        console.log("✅ RSA Keys Generated.");
    }
}
generateRSAKeys();

// ✅ CONNECT TO DATABASE
connectDB();

// ====================================================================
//  WebSocket & Status Logic
// ====================================================================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const activeConnections = new Map();
const disconnectTimers = new Map();

function broadcastUpdate() {
    const message = JSON.stringify({ type: 'USER_STATUS_CHANGE' });
    wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(message); });
}

function scheduleDisconnect(userId) {
    if (disconnectTimers.has(userId)) return;
    const timer = setTimeout(async () => {
        try {
            await User.update({ isActive: false, logoutTime: new Date() }, { where: { id: userId } });
            activeConnections.delete(userId);
            disconnectTimers.delete(userId);
            broadcastUpdate();
        } catch (err) { console.error(err); }
    }, 5000);
    disconnectTimers.set(userId, timer);
}

function cancelDisconnect(userId) {
    if (disconnectTimers.has(userId)) {
        clearTimeout(disconnectTimers.get(userId));
        disconnectTimers.delete(userId);
    }
}

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => ws.isAlive = true);
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'REGISTER' && data.userId) {
                ws.userId = data.userId;
                activeConnections.set(data.userId, ws);
                cancelDisconnect(ws.userId);
                User.update({ isActive: true, loginTime: new Date() }, { where: { id: data.userId } }).then(broadcastUpdate);
            }
        } catch (e) {}
    });
    ws.on('close', () => { if (ws.userId) scheduleDisconnect(ws.userId); });
});

setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// ====================================================================
//  🔐 AUTH & MIDDLEWARE
// ====================================================================

const verifyToken = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(403).json({ message: "No token provided" });
    const bearerToken = token.split(' ')[1];
    jwt.verify(bearerToken, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ message: "Unauthorized" });
        req.user = decoded;
        next();
    });
};

const verifySuperAdmin = (req, res, next) => {
    if (!req.user || req.user.role !== 'superadmin') {
        return res.status(403).json({ message: "Forbidden" });
    }
    next();
};

app.get('/api/auth/public-key', (req, res) => {
    if (fs.existsSync(PUBLIC_KEY_PATH)) res.json({ publicKey: fs.readFileSync(PUBLIC_KEY_PATH, 'utf8') });
    else res.status(500).json({ message: "Keys not ready" });
});

app.post('/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await User.findOne({ where: { email } });
        if (!user) return res.status(401).json({ message: "Invalid credentials" });
        const isMatch = await bcrypt.compare(password + PASSWORD_PEPPER, user.password);
        if (!isMatch) return res.status(401).json({ message: "Invalid credentials" });
        const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
        res.json({ message: "Login successful", token, userId: user.id, role: user.role, name: user.name });
    } catch (err) { res.status(500).json({ message: "Server error" }); }
});

app.post('/api/logout/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        if (disconnectTimers.has(userId)) { clearTimeout(disconnectTimers.get(userId)); disconnectTimers.delete(userId); }
        await User.update({ isActive: false, logoutTime: new Date() }, { where: { id: userId } });
        if (activeConnections.has(userId)) { activeConnections.get(userId).terminate(); activeConnections.delete(userId); }
        broadcastUpdate();
        res.json({ message: "Logged out" });
    } catch (err) { res.status(500).json({ message: "Logout failed" }); }
});

app.post('/api/status/inactive', (req, res) => {
    try {
        let userId = req.body.userId || JSON.parse(req.body).userId;
        if(userId) scheduleDisconnect(userId);
        res.status(200).send('OK');
    } catch(e) { res.status(200).send('Error'); }
});

// ====================================================================
//  USER & DATA ROUTES
// ====================================================================

app.get('/api/users', async (req, res) => {
    try { const users = await User.findAll({ order: [['id', 'ASC']] }); res.json(users); }
    catch (err) { res.status(500).json({ message: "Fetch failed" }); }
});

app.post('/api/users', verifyToken, verifySuperAdmin, async (req, res) => {
    const { name, email, password, role } = req.body;
    try {
        const existing = await User.findOne({ where: { email } });
        if (existing) return res.status(409).json({ message: "Email exists" });
        const hashedPassword = await bcrypt.hash(password + PASSWORD_PEPPER, 10);
        const newUser = await User.create({ name, email, password: hashedPassword, role });
        broadcastUpdate();
        res.status(201).json({ message: "User added", userId: newUser.id });
    } catch (err) { res.status(500).json({ message: "Error adding user" }); }
});

app.delete('/api/users/:userId', verifyToken, verifySuperAdmin, async (req, res) => {
    const { userId } = req.params;
    try {
        const user = await User.findByPk(userId);
        if (!user) return res.status(404).json({ message: "User not found" });
        if (user.role === 'superadmin') {
            const count = await User.count({ where: { role: 'superadmin' } });
            if (count <= 1) return res.status(403).json({ message: "Cannot delete last superadmin" });
        }
        await user.destroy();
        broadcastUpdate();
        res.json({ message: "User deleted" });
    } catch (err) { res.status(500).json({ message: "Error deleting user" }); }
});

// Bulk Import & Blacklist
app.post('/api/admin/bulk-dl', verifyToken, verifySuperAdmin, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ message: "Upload CSV" });
    const results = [];
    fs.createReadStream(req.file.path).pipe(csv()).on('data', (data) => {
        const keys = Object.keys(data);
        const dlKey = keys.find(k => /(dl|license)/i.test(k));
        const nameKey = keys.find(k => /name/i.test(k));
        if(dlKey) results.push({ dl_number: data[dlKey].replace(/[^a-zA-Z0-9]/g, '').toUpperCase(), name: nameKey?data[nameKey]:"Unknown", Verification: 'blacklisted', crime_involved: 'Bulk Import' });
    }).on('end', async () => {
        await License.bulkCreate(results, { updateOnDuplicate: ['Verification'] });
        res.json({ message: "Imported" });
        if (req.file) fs.unlinkSync(req.file.path);
    });
});

app.post('/api/admin/bulk-rc', verifyToken, verifySuperAdmin, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ message: "Upload CSV" });
    const results = [];
    fs.createReadStream(req.file.path).pipe(csv()).on('data', (data) => {
        const keys = Object.keys(data);
        const rcKey = keys.find(k => /(rc|regn)/i.test(k));
        const ownerKey = keys.find(k => /(owner|name)/i.test(k));
        if(rcKey) results.push({ regn_number: data[rcKey].replace(/[^a-zA-Z0-9]/g, '').toUpperCase(), owner_name: ownerKey?data[ownerKey]:"Unknown", verification: 'blacklisted', crime_involved: 'Bulk Import' });
    }).on('end', async () => {
        await RC.bulkCreate(results, { updateOnDuplicate: ['verification'] });
        res.json({ message: "Imported" });
        if (req.file) fs.unlinkSync(req.file.path);
    });
});

app.post('/api/blacklist', async (req, res) => {
    const { type, number, name, phone_number, crime_involved, owner_name } = req.body;
    const cleaned = number.replace(/\s|-/g, '').toUpperCase();
    try {
        if (type === 'dl') await License.upsert({ dl_number: cleaned, Verification: "blacklisted", name: name||'N/A', phone_number: phone_number||'N/A', crime_involved: crime_involved||'Manual' });
        else await RC.upsert({ regn_number: cleaned, verification: "blacklisted", owner_name: owner_name||'N/A', crime_involved: crime_involved||'Manual' });
        res.json({ message: "Added" });
    } catch (err) { res.status(500).json({ message: "Error" }); }
});

app.get('/api/blacklist/dl', async (req, res) => {
    const page = parseInt(req.query.page) || 1; const limit = parseInt(req.query.limit) || 50; const offset = (page - 1) * limit; const search = req.query.search ? req.query.search.trim() : "";
    const where = { Verification: 'blacklisted' }; if (search) where.dl_number = { [Op.iLike]: `%${search}%` };
    const { count, rows } = await License.findAndCountAll({ where, limit, offset });
    res.json({ data: rows, total: count, page, pages: Math.ceil(count / limit) });
});

app.get('/api/blacklist/rc', async (req, res) => {
    const page = parseInt(req.query.page) || 1; const limit = parseInt(req.query.limit) || 50; const offset = (page - 1) * limit; const search = req.query.search ? req.query.search.trim() : "";
    const where = { verification: 'blacklisted' }; if (search) where.regn_number = { [Op.iLike]: `%${search}%` };
    const { count, rows } = await RC.findAndCountAll({ where, limit, offset });
    res.json({ data: rows, total: count, page, pages: Math.ceil(count / limit) });
});

// ====================================================================
//  OCR (Uses axiosClient for Keep-Alive)
// ====================================================================

app.post('/api/ocr/dl', upload.single('dlImage'), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "File required" });
    try {
        const form = new FormData();
        form.append('file', fs.createReadStream(req.file.path));
        const response = await axiosClient.post(process.env.PYTHON_DL_SERVICE_URL, form, { headers: form.getHeaders() });
        const dlNumber = response.data.dl_numbers?.[0] || "";
        res.json({ dl_number: dlNumber });
    } catch (err) { res.status(500).json({ message: "OCR Error" }); }
    finally { if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); }
});

app.post('/api/ocr/rc', upload.single('rcImage'), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "File required" });
    try {
        const form = new FormData();
        form.append('file', fs.createReadStream(req.file.path));
        const response = await axiosClient.post(process.env.PYTHON_ANPR_SERVICE_URL, form, { headers: form.getHeaders() });
        let text = null;
        if (Array.isArray(response.data) && response.data.length > 0) text = response.data[0].plate_text || response.data[0].text;
        else if (response.data) text = response.data.plate_text;
        res.json({ extracted_text: text });
    } catch (err) { res.status(500).json({ message: "OCR Error" }); }
    finally { if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); }
});

// ====================================================================
//  ⚡ OPTIMIZED VERIFICATION (Parallel Execution)
// ====================================================================

async function getDLData(raw) {
    if (!raw) return { status: "no_data_provided" };
    const dlNum = raw.replace(/\s|-/g, '').toUpperCase();
    const dl = await License.findOne({ where: { dl_number: dlNum } });
    if (dl) return { status: dl.Verification, licenseNumber: dl.dl_number, name: dl.name, phone_number: dl.phone_number };
    return { status: "not_found", licenseNumber: dlNum };
}
async function getRCData(raw) {
    if (!raw) return { status: "no_data_provided" };
    const rcNum = raw.replace(/\s|-/g, '').toUpperCase();
    const rc = await RC.findOne({ where: { regn_number: rcNum } });
    if (rc) return { ...rc.toJSON(), status: rc.verification };
    return { status: "not_found", regn_number: rcNum };
}
async function getFaceDataFromPython(path) {
    try {
        const form = new FormData();
        form.append('file', fs.createReadStream(path)); 
        const res = await axiosClient.post(process.env.PYTHON_FACE_SERVICE_URL, form, { headers: { ...form.getHeaders() } });
        return { status: res.data.status || 'UNKNOWN', name: res.data.closest_match || "Unknown", score: res.data.score };
    } catch (e) { return { status: 'SERVICE_UNAVAILABLE' }; }
}

app.post('/api/verify', upload.fields([{ name: 'driverImage', maxCount: 1 }, { name: 'dlImage', maxCount: 1 }, { name: 'rcImage', maxCount: 1 }]), async (req, res) => {
    const { dl_number, rc_number, location, tollgate } = req.body;
    const driverImage = req.files && req.files['driverImage'] ? req.files['driverImage'][0] : null;

    try {
        const [dlData, rcData, driverData] = await Promise.all([
            dl_number ? getDLData(dl_number) : Promise.resolve(null),
            rc_number ? getRCData(rc_number) : Promise.resolve(null),
            driverImage ? getFaceDataFromPython(driverImage.path) : Promise.resolve(null)
        ]);

        const logEntry = { timestamp: new Date(), scanned_by: 'OCR/Manual', location: location || 'Unknown', tollgate: tollgate || 'Unknown' };
        if (dlData) { logEntry.dl_number = dlData.licenseNumber; logEntry.dl_status = dlData.status; }
        if (rcData) { logEntry.vehicle_number = rcData.regn_number; logEntry.rc_status = rcData.status; }
        if (driverData) { logEntry.driver_status = driverData.status; logEntry.driver_name = driverData.name; }
        
        if (Object.keys(logEntry).length > 4) await Log.create(logEntry);

        let suspicious = (dlData?.status === 'blacklisted' || rcData?.status === 'blacklisted');
        res.json({ dlData, rcData, driverData, suspicious });

    } catch (err) { 
        console.error(err); 
        res.status(500).json({ message: "Verify Error" }); 
    } finally {
        if (req.files) Object.values(req.files).flat().forEach(f => { if(fs.existsSync(f.path)) fs.unlinkSync(f.path); });
    }
});

app.get('/api/logs', async (req, res) => {
    try { const logs = await Log.findAll({ order: [['timestamp', 'DESC']] }); res.json(logs); } 
    catch (err) { res.status(500).json({ message: "Error fetching logs" }); }
});

// Warm-Up Function (Prevents Cold Starts)
function keepAlive() {
    https.get(process.env.APP_URL, (res) => {}).on('error', () => {});
    [process.env.PYTHON_DL_SERVICE_URL, process.env.PYTHON_ANPR_SERVICE_URL, process.env.PYTHON_FACE_SERVICE_URL].forEach(url => {
        try { axiosClient.head(url).catch(() => {}); } catch(e) {}
    });
}
setInterval(keepAlive, 5 * 60 * 1000);

server.listen(port, () => {
    console.log(`🌐 Netra Sarathi Secure Server Running on Port: ${port}`);
    keepAlive();
});