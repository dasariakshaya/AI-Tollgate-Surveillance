require('dotenv').config(); 
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
const { User, License, RC, Log, connectDB, Op } = require('./db');

const app = express();
const port = process.env.PORT || 3000;
const server = http.createServer(app);

// 1. HELMET (Standard Security Headers)
app.use(helmet());

// ====================================================================
// 🛑 FIREWALL MIDDLEWARE (PREVENTS ACCESS TO SENSITIVE FILES)
// ====================================================================
app.use((req, res, next) => {
    // Block requests for sensitive file extensions immediately
    if (req.path.match(/\.(log|env|pem|json)$/i)) {
        console.warn(`⚠️ Blocked attempt to access system file: ${req.path} from ${req.ip}`);
        return res.status(403).send('Forbidden: Access Denied');
    }
    next();
});

const allowedOrigins = [
    process.env.APP_URL, 
    'https://ai-tollgate-surveillance-1.onrender.com',
    'http://127.0.0.1:5500',
    'http://localhost:3000'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            return callback(null, true); 
        }
        return callback(null, true);
    }
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.text());
app.use(express.urlencoded({ extended: true })); 

const upload = multer({ 
    dest: 'uploads/',
    limits: { fileSize: 5 * 1024 * 1024 } 
});

// ✅ SECRETS LOADED FROM .ENV
const PASSWORD_PEPPER = process.env.PASSWORD_PEPPER;
const JWT_SECRET = process.env.JWT_SECRET;
const DART_CLIENT_SALT = process.env.DART_CLIENT_SALT; 

const ALLOWED_DOMAINS = ['netrasarathi.com', 'gmail.com', 'yahoo.com'];

function isDomainAllowed(email) {
    const domain = email.split('@')[1];
    return ALLOWED_DOMAINS.includes(domain);
}

function getRequestSource(req) {
    const userAgent = req.headers['user-agent'] || '';
    if (userAgent.includes('Dart') || userAgent.includes('Flutter')) {
        return 'Mobile App';
    }
    return 'Web Portal';
}

// ====================================================================
// 🕒 DAY / NIGHT LOGIC HELPER
// ====================================================================
function isDayTime(dateObj = new Date()) {
    // India Time (IST) is handled by server time usually, but ensuring hour logic
    const hour = dateObj.getHours();
    // Day is 06:00 (inclusive) to 18:00 (exclusive)
    return hour >= 6 && hour < 18;
}

// ====================================================================
// 📝 SECURE DEBUG LOGGER
// ====================================================================
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
const LOG_FILE_PATH = path.join(LOG_DIR, 'server_debug.log');

const debugLogger = (req, res, next) => {
    const start = Date.now();
    const source = getRequestSource(req);
    const originalSend = res.send;

    res.send = function (body) {
        const duration = Date.now() - start;
        const status = res.statusCode;
        let failureReason = '';

        if (status >= 400) {
            try {
                const parsed = typeof body === 'string' ? JSON.parse(body) : body;
                failureReason = parsed.message || parsed.error || JSON.stringify(parsed);
            } catch (e) {
                failureReason = 'Error details not parseable'; 
            }
        }

        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] | SOURCE: ${source} | ${req.method} ${req.originalUrl} | STATUS: ${status} | TIME: ${duration}ms | ${status >= 400 ? `❌ FAILED: ${failureReason}` : '✅ SUCCESS'}\n`;

        fs.appendFile(LOG_FILE_PATH, logLine, (err) => {
            if (err) console.error("Logging failed:", err);
        });

        return originalSend.call(this, body);
    };

    next();
};

app.use(debugLogger);

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: "Too many login attempts, please try again later."
});

// ✅ SECURITY: Base Timeout 60s
const httpsAgent = new https.Agent({ keepAlive: true });
const axiosClient = axios.create({ 
    httpsAgent,
    timeout: 60000 // Default 60s for standard calls
});

// ✅ CONFIG: Use the Base URL from .env
const FACE_API_URL = process.env.PYTHON_FACE_SERVICE_URL; 
const PYTHON_DL_SERVICE_URL = process.env.PYTHON_DL_SERVICE_URL;
const PYTHON_ANPR_SERVICE_URL = process.env.PYTHON_ANPR_SERVICE_URL;

const PRIVATE_KEY_PATH = path.join(__dirname, 'private.pem');
const PUBLIC_KEY_PATH = path.join(__dirname, 'public.pem');

function generateRSAKeys() {
    if (!fs.existsSync(PRIVATE_KEY_PATH)) {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        fs.writeFileSync(PRIVATE_KEY_PATH, privateKey);
        fs.writeFileSync(PUBLIC_KEY_PATH, publicKey);
    }
}
generateRSAKeys();

function convertToAppHash(plainPassword) {
    return crypto.createHash('sha256').update(plainPassword + DART_CLIENT_SALT).digest('hex');
}

const RENDER_URL = 'https://ai-tollgate-surveillance-1.onrender.com';

function autoPing() {
    console.log(`Auto-Ping: Keeping server alive... (${new Date().toISOString()})`);
    https.get(RENDER_URL, (res) => {
        res.on('data', () => {}); 
        res.on('end', () => {});
    }).on('error', (err) => {
        console.error(`Auto-Ping Failed: ${err.message}`);
    });
}

setInterval(autoPing, 12 * 60 * 1000);

async function performBackup() {
    try {
        const backupDir = path.join(__dirname, 'backups');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = path.join(backupDir, `backup-${timestamp}.json`);

        const [users, logs, blacklistDL, blacklistRC] = await Promise.all([
            User.findAll(),
            Log.findAll(),
            License.findAll({ where: { Verification: 'blacklisted' } }),
            RC.findAll({ where: { verification: 'blacklisted' } })
        ]);

        const backupData = { date: new Date(), users, logs, blacklist: { dl: blacklistDL, rc: blacklistRC } };
        fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2));
        
        const files = fs.readdirSync(backupDir);
        if (files.length > 7) fs.unlinkSync(path.join(backupDir, files[0]));
    } catch (err) { console.error("Backup Failed:", err); }
}
setInterval(performBackup, 24 * 60 * 60 * 1000);

async function createDefaultAdmin() {
    try {
        const count = await User.count();
        if (count === 0) {
            const defaultEmail = "admin@netrasarathi.com";
            const defaultPass = "admin123"; 
            
            const appHash = convertToAppHash(defaultPass);
            const finalPassword = await bcrypt.hash(appHash + PASSWORD_PEPPER, 10);

            await User.create({
                name: "System Admin",
                email: defaultEmail,
                password: finalPassword,
                role: 'superadmin',
                isActive: true,
                lastActive: new Date(),
                loginTime: new Date()
            });
            console.log(`Default Admin Created: ${defaultEmail}`);
        }
    } catch (err) { console.error("Error creating default admin:", err); }
}

connectDB().then(() => { 
    createDefaultAdmin();
    setTimeout(autoPing, 60000);
});

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
                User.update({ isActive: true }, { where: { id: data.userId } }).then(broadcastUpdate);
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
// 🔐 MIDDLEWARE: AUTH & DYNAMIC INACTIVITY CHECK
// ====================================================================
const verifyToken = async (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(403).json({ message: "No token provided" });
    
    const bearerToken = token.startsWith('Bearer ') ? token.split(' ')[1] : token;
    
    try {
        const decoded = jwt.verify(bearerToken, JWT_SECRET);
        
        const user = await User.findByPk(decoded.id);
        if (!user) return res.status(401).json({ message: "User not found" });

        const lastActiveTime = new Date(user.lastActive);
        const currentTime = new Date();

        // 🌗 DYNAMIC INACTIVITY LOGIC
        // Logic: If CURRENT time is Day OR LAST ACTIVE was Day, use Day limits.
        // This satisfies "during changes from day to night... day time expiry considered".
        const isDayNow = isDayTime(currentTime);
        const wasDayThen = isDayTime(lastActiveTime);
        const useDayRules = isDayNow || wasDayThen;

        // Day: 30 mins (30*60*1000), Night: 15 mins (15*60*1000)
        const limit = useDayRules ? (30 * 60 * 1000) : (15 * 60 * 1000);

        if ((currentTime.getTime() - lastActiveTime.getTime()) > limit) {
            await User.update({ isActive: false }, { where: { id: user.id } });
            return res.status(401).json({ message: "Session expired due to inactivity. Please login again." });
        }

        await User.update({ lastActive: new Date() }, { where: { id: user.id } });
        req.user = user.toJSON(); 
        next();

    } catch (err) {
        return res.status(401).json({ message: "Unauthorized" });
    }
};

const verifySuperAdmin = (req, res, next) => {
    if (!req.user || req.user.role !== 'superadmin') {
        return res.status(403).json({ message: "Forbidden: Super Admin Access Required" });
    }
    next();
};

app.get('/api/auth/public-key', (req, res) => {
    if (fs.existsSync(PUBLIC_KEY_PATH)) res.json({ publicKey: fs.readFileSync(PUBLIC_KEY_PATH, 'utf8') });
    else res.status(500).json({ message: "Keys not ready" });
});

app.post('/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body;
    
    if (!isDomainAllowed(email)) return res.status(403).json({ message: "Access Denied: Domain not authorized." });

    const source = getRequestSource(req);
    console.log(`Login Attempt | User: ${email} | Source: ${source}`);

    try {
        const user = await User.findOne({ where: { email } });
        if (!user) return res.status(401).json({ message: "Invalid credentials" });
        
        const isAppHash = /^[a-f0-9]{64}$/i.test(password);
        let passwordToVerify = password;
        if (!isAppHash) {
            passwordToVerify = convertToAppHash(password);
        }

        const isMatch = await bcrypt.compare(passwordToVerify + PASSWORD_PEPPER, user.password);
        if (!isMatch) return res.status(401).json({ message: "Invalid credentials" });
        
        await User.update({ 
            isActive: true, 
            loginTime: new Date(),
            lastActive: new Date() 
        }, { where: { id: user.id } });

        // 🌗 DYNAMIC JWT EXPIRY
        // Day: 3 Hours, Night: 45 Minutes
        const expiryDuration = isDayTime() ? '3h' : '45m';

        const token = jwt.sign(
            { id: user.id, role: user.role }, 
            JWT_SECRET, 
            { expiresIn: expiryDuration } 
        );

        res.json({ message: "Login successful", token, userId: user.id, role: user.role, name: user.name });
    } catch (err) { 
        console.error(err);
        res.status(500).json({ message: "Server error" }); 
    }
});

app.post('/api/logout/:userId', async (req, res) => {
    try {
        await User.update({ isActive: false, logoutTime: new Date() }, { where: { id: req.params.userId } });
        if (activeConnections.has(req.params.userId)) { 
             activeConnections.get(req.params.userId).terminate(); 
             activeConnections.delete(req.params.userId); 
        }
        broadcastUpdate();
        res.json({ message: "Logged out" });
    } catch (err) { res.status(500).json({ message: "Logout failed" }); }
});

app.post('/api/users', verifyToken, verifySuperAdmin, async (req, res) => {
    const { name, email, password, role } = req.body;
    
    if (!isDomainAllowed(email)) return res.status(400).json({ message: "Domain not allowed." });

    try {
        const existing = await User.findOne({ where: { email } });
        if (existing) return res.status(409).json({ message: "Email exists" });
        
        const isInputAlreadyHashed = /^[a-f0-9]{64}$/i.test(password);
        let appStyleHash = isInputAlreadyHashed ? password : convertToAppHash(password);
        
        const hashedPassword = await bcrypt.hash(appStyleHash + PASSWORD_PEPPER, 10);
        
        const newUser = await User.create({ name, email, password: hashedPassword, role, lastActive: new Date() });
        res.status(201).json({ message: "User added", userId: newUser.id });
    } catch (err) { res.status(500).json({ message: "Error adding user" }); }
});

app.get('/api/users', verifyToken, verifySuperAdmin, async (req, res) => {
    try { 
        const users = await User.findAll({ 
            attributes: ['id', 'name', 'email', 'role', 'isActive', 'loginTime', 'lastActive'],
            order: [['id', 'ASC']] 
        }); 
        res.json(users); 
    }
    catch (err) { res.status(500).json({ message: "Fetch failed" }); }
});

app.put('/api/users/:userId/role', verifyToken, verifySuperAdmin, async (req, res) => {
    try {
        const user = await User.findByPk(req.params.userId);
        if (!user) return res.status(404).json({ message: "User not found" });
        if (user.role === 'superadmin' && req.body.newRole !== 'superadmin') {
             const adminCount = await User.count({ where: { role: 'superadmin' } });
             if (adminCount <= 1) return res.status(403).json({ message: "Cannot remove the last Super Admin" });
        }
        user.role = req.body.newRole;
        await user.save();
        res.json({ message: "Role updated" });
    } catch (err) { res.status(500).json({ message: "Error updating role" }); }
});

app.delete('/api/users/:userId', verifyToken, verifySuperAdmin, async (req, res) => {
    try {
        const user = await User.findByPk(req.params.userId);
        if (!user) return res.status(404).json({ message: "User not found" });
        if (user.role === 'superadmin') {
            const count = await User.count({ where: { role: 'superadmin' } });
            if (count <= 1) return res.status(403).json({ message: "Cannot delete last superadmin" });
        }
        await user.destroy();
        res.json({ message: "User deleted" });
    } catch (err) { res.status(500).json({ message: "Error deleting user" }); }
});

app.post('/api/blacklist', verifyToken, async (req, res) => {
    const { type, number, name, phone_number, crime_involved, owner_name } = req.body;
    const cleaned = number.replace(/\s|-/g, '').toUpperCase();
    try {
        if (type === 'dl') await License.upsert({ dl_number: cleaned, Verification: "blacklisted", name: name||'N/A', phone_number: phone_number||'N/A', crime_involved: crime_involved||'Manual' });
        else await RC.upsert({ regn_number: cleaned, verification: "blacklisted", owner_name: owner_name||'N/A', crime_involved: crime_involved||'Manual' });
        res.json({ message: "Added" });
    } catch (err) { res.status(500).json({ message: "Error" }); }
});

app.get('/api/blacklist/dl', verifyToken, async (req, res) => {
    const page = parseInt(req.query.page) || 1; const limit = parseInt(req.query.limit) || 50; const offset = (page - 1) * limit; const search = req.query.search ? req.query.search.trim() : "";
    const where = { Verification: 'blacklisted' }; if (search) where.dl_number = { [Op.iLike]: `%${search}%` };
    const { count, rows } = await License.findAndCountAll({ where, limit, offset });
    res.json({ data: rows, total: count, page, pages: Math.ceil(count / limit) });
});

app.get('/api/blacklist/rc', verifyToken, async (req, res) => {
    const page = parseInt(req.query.page) || 1; const limit = parseInt(req.query.limit) || 50; const offset = (page - 1) * limit; const search = req.query.search ? req.query.search.trim() : "";
    const where = { verification: 'blacklisted' }; if (search) where.regn_number = { [Op.iLike]: `%${search}%` };
    const { count, rows } = await RC.findAndCountAll({ where, limit, offset });
    res.json({ data: rows, total: count, page, pages: Math.ceil(count / limit) });
});

app.put('/api/blacklist/:type/:id', verifyToken, async (req, res) => {
    const { type, id } = req.params;
    try {
        let result;
        if (type === 'dl') result = await License.update({ Verification: 'valid' }, { where: { id: id } });
        else if (type === 'rc') result = await RC.update({ verification: 'valid' }, { where: { id: id } });
        
        if (result[0] > 0) res.json({ message: "Marked as valid" });
        else res.status(404).json({ message: "Entry not found" });
    } catch(err) { res.status(500).json({message: "Error updating status"}); }
});

app.get('/api/suspects', verifyToken, async (req, res) => {
    try {
        // Appends '/list_suspects' to the base URL
        const response = await axiosClient.get(`${FACE_API_URL}/list_suspects`);
        res.json(response.data);
    } catch (err) {
        console.error("Error proxying suspect list:", err.message);
        if (err.response) {
            return res.status(err.response.status).json({ message: "Error from Face API provider" });
        }
        res.status(500).json({ message: "Internal Server Error fetching suspects" });
    }
});

app.post('/api/suspects/add', verifyToken, upload.single('file'), async (req, res) => {
    try {
        if (!req.file || !req.body.person_name) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(400).json({message: "person_name and file are required"});
        }
        
        const form = new FormData();
        form.append('person_name', req.body.person_name);
        form.append('file', fs.createReadStream(req.file.path)); 
        
        // 🚀 TIMEOUT OVERRIDE: 120 Seconds (2 Minutes) for heavy operation
        const response = await axiosClient.post(`${FACE_API_URL}/add_suspect`, form, {
            headers: { ...form.getHeaders() },
            timeout: 120000 
        });
        
        fs.unlinkSync(req.file.path); 
        res.json(response.data);
    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        console.error("Error adding suspect:", err.message);
        if (err.response) {
            return res.status(err.response.status).json({ message: "Error from Face API provider" });
        }
        res.status(500).json({ message: "Internal Server Error adding suspect" });
    }
});

app.post('/api/suspects/delete', verifyToken, async (req, res) => {
    try {
        const { person_name } = req.body;
        if (!person_name) return res.status(400).json({ message: "person_name is required" });

        const formData = new URLSearchParams();
        formData.append('person_name', person_name);

        // 🚀 TIMEOUT OVERRIDE: 120 Seconds (2 Minutes) for heavy operation
        const response = await axiosClient.post(`${FACE_API_URL}/delete_suspect`, formData, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 120000 
        });

        res.json(response.data);
    } catch (err) {
        console.error("Error deleting suspect:", err.message);
        if (err.response) {
            return res.status(err.response.status).json({ message: "Error from Face API provider" });
        }
        res.status(500).json({ message: "Internal Server Error deleting suspect" });
    }
});

app.post('/api/recognize', verifyToken, upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: "Image required" });
        }
        
        const form = new FormData();
        form.append('file', fs.createReadStream(req.file.path)); 
        
        // Appends '/recognize' to the base URL
        const response = await axiosClient.post(`${FACE_API_URL}/recognize`, form, {
            headers: { ...form.getHeaders() }
        });
        
        fs.unlinkSync(req.file.path); 
        res.json(response.data);
    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        console.error("Error recognizing face:", err.message);
        if (err.response) {
            return res.status(err.response.status).json({ message: "Error from Face API provider" });
        }
        res.status(500).json({ message: "Internal Server Error during recognition" });
    }
});

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
// 🔍 HELPER FUNCTIONS (RESTORED FROM OLD SERVER, UPDATED FOR SEQUELIZE/PG)
// ====================================================================

async function getDLData(dlNumberRaw) {
    if (!dlNumberRaw) return { status: "no_data_provided" };
    const dlNumber = dlNumberRaw.replace(/\s|-/g, '').toUpperCase();
    
    // Using Sequelize findOne (converted from MongoDB findOne)
    const dl = await License.findOne({ 
        where: { dl_number: dlNumber } 
    });

    return dl ? { 
        status: dl.Verification, 
        licenseNumber: dl.dl_number, 
        name: dl.name, 
        validity: dl.validity || 'Unknown', 
        phone_number: dl.phone_number 
    } : { status: "not_found", licenseNumber: dlNumber };
}

async function getRCData(rcNumberRaw) {
    if (!rcNumberRaw) return { status: "no_data_provided" };
    const rcNumber = rcNumberRaw.replace(/\s|-/g, '').toUpperCase();
    
    // Using Sequelize findOne
    const rc = await RC.findOne({ 
        where: { regn_number: rcNumber } 
    });

    return rc ? { 
        status: rc.verification, // Matches 'verification' field in DB
        regn_number: rc.regn_number,
        owner_name: rc.owner_name,
        engine_number: rc.engine_number || 'N/A', 
        chassis_number: rc.chassis_number || 'N/A',
        crime_involved: rc.crime_involved 
    } : { status: "not_found", regn_number: rcNumber };
}

async function getFaceDataFromPython(imagePath) {
    try {
        const form = new FormData();
        form.append('image', fs.createReadStream(imagePath));
        
        // Using axiosClient for security/timeouts (replacing raw axios)
        // Ensure endpoint is /verify_driver (from old server logic)
        const response = await axiosClient.post(`${FACE_API_URL}/verify_driver`, form, { headers: form.getHeaders() });
        return response.data;
    } catch (error) {
        console.error(`Error calling Python Face service:`, error.message);
        return { status: 'SERVICE_UNAVAILABLE', message: 'Face recognition service is down.' };
    }
}

// ====================================================================
// 🛑 MAIN VERIFICATION ENDPOINT
// ====================================================================

app.post('/api/verify', upload.fields([{ name: 'driverImage', maxCount: 1 }, { name: 'dlImage', maxCount: 1 }, { name: 'rcImage', maxCount: 1 }]), async (req, res) => {
    const { dl_number, rc_number, location, tollgate } = req.body;
    const driverImage = req.files && req.files['driverImage'] ? req.files['driverImage'][0] : null;
    const source = getRequestSource(req); 

    try {
        const [dlData, rcData, driverData] = await Promise.all([
            dl_number ? getDLData(dl_number) : Promise.resolve(null),
            rc_number ? getRCData(rc_number) : Promise.resolve(null),
            driverImage ? getFaceDataFromPython(driverImage.path) : Promise.resolve(null)
        ]);

        const logEntry = { 
            timestamp: new Date(), 
            scanned_by: source,
            location: location || 'Unknown', 
            tollgate: tollgate || 'Unknown' 
        };
        
        if (dlData) { 
            logEntry.dl_number = dlData.licenseNumber; 
            logEntry.dl_status = dlData.status; 
            if(dlData.name) logEntry.name = dlData.name; // Store name if available
        }
        
        if (rcData) { 
            logEntry.vehicle_number = rcData.regn_number; 
            logEntry.rc_status = rcData.status;
            // Add extended vehicle details if available in DB model
            if(rcData.owner_name) logEntry.owner_name = rcData.owner_name;
            if(rcData.crime_involved) logEntry.crime_involved = rcData.crime_involved;
        }
        
        if (driverData) { 
            logEntry.driver_status = driverData.status; 
            logEntry.driver_name = driverData.name; 
        }
        
        // Log to database
        if (Object.keys(logEntry).length > 4) await Log.create(logEntry);

        let suspicious = (dlData?.status === 'blacklisted' || rcData?.status === 'blacklisted');

        // Logic Check: DL used on multiple vehicles recently
        if (!suspicious && dlData && dlData.status !== 'blacklisted' && dlData.licenseNumber) {
            const twoDaysAgo = new Date();
            twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
            
            const recentLogs = await Log.findAll({
                where: {
                    dl_number: dlData.licenseNumber,
                    timestamp: { [Op.gte]: twoDaysAgo },
                    vehicle_number: { [Op.ne]: null }
                }
            });
            
            const uniqueVehicles = new Set(recentLogs.map(l => l.vehicle_number));
            
            if (uniqueVehicles.size >= 3) {
                suspicious = true;
                await Log.create({
                    timestamp: new Date(),
                    dl_number: dlData.licenseNumber,
                    alert_type: 'Suspicious DL Usage',
                    description: `DL ${dlData.licenseNumber} used with ${uniqueVehicles.size} different vehicles in last 2 days`,
                    location: location || 'Unknown',
                    tollgate: tollgate || 'Unknown',
                    scanned_by: 'System Alert',
                    suspicious: true
                });
            }
        }
        
        // Suspicious Driver Alert Log
        if (driverData?.status === 'ALERT') {
            suspicious = true;
            await Log.create({
                timestamp: new Date(),
                vehicle_number: rcData?.regn_number || null,
                dl_number: dlData?.licenseNumber || null,
                alert_type: 'Suspect Driver Identified',
                description: `Suspected person ${driverData.name} was identified driving vehicle.`,
                location: location || 'Unknown',
                tollgate: tollgate || 'Unknown',
                scanned_by: 'System Alert',
                suspicious: true
            });
        }

        res.json({ dlData, rcData, driverData, suspicious });

    } catch (err) { 
        console.error(err); 
        res.status(500).json({ message: "Verify Error" }); 
    } finally {
        if (req.files) Object.values(req.files).flat().forEach(f => { if(fs.existsSync(f.path)) fs.unlinkSync(f.path); });
    }
});

app.get('/api/dl-usage/:dl_number', verifyToken, async (req, res) => {
    const { dl_number } = req.params;
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    
    try {
        const logs = await Log.findAll({
            where: {
                dl_number: { [Op.iLike]: `%${dl_number}%` },
                timestamp: { [Op.gte]: twoDaysAgo },
                vehicle_number: { [Op.ne]: null }
            },
            order: [['timestamp', 'DESC']]
        });
        res.json(logs);
    } catch (error) {
        res.status(500).json({ message: "Error fetching DL usage logs." });
    }
});

app.get('/api/logs', verifyToken, verifySuperAdmin, async (req, res) => {
    try { 
        const logs = await Log.findAll({ 
            order: [['timestamp', 'DESC']],
            limit: 500 
        }); 
        res.json(logs); 
    } 
    catch (err) { 
        console.error("Error fetching logs:", err);
        res.status(500).json({ message: "Error fetching logs" }); 
    }
});

app.post('/api/status/inactive', (req, res) => { res.status(200).send('OK'); });

server.listen(port, () => {
    console.log(`Netra Sarathi Secure Server Running on Port: ${port}`);
});
