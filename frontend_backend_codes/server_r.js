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

// ✅ IMPORT DB MODULE
const { User, License, RC, Log, connectDB, Op } = require('./db');

const app = express();
const port = process.env.PORT || 3000;

// SECURITY HEADERS
app.use(helmet());

// CORS SETUP
const allowedOrigins = [
    process.env.APP_URL, 
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

// ====================================================================
// 🔐 CONFIGURATION
// ====================================================================
const PASSWORD_PEPPER = process.env.PASSWORD_PEPPER;
const JWT_SECRET = process.env.JWT_SECRET;
const DART_CLIENT_SALT = "Abra_Ca_Dabra!_@616D7269736861@_#Khulja_Sim_Sim#_!@#"; // Fixed Salt

// 1 HOUR Inactivity Limit (in milliseconds)
const INACTIVITY_LIMIT = 60 * 60 * 1000; 

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

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: "Too many login attempts, please try again later."
});

const httpsAgent = new https.Agent({ keepAlive: true });
const axiosClient = axios.create({ httpsAgent });

// RSA Keys
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

// Helper: Mimic Flutter Hashing
function convertToAppHash(plainPassword) {
    return crypto.createHash('sha256').update(plainPassword + DART_CLIENT_SALT).digest('hex');
}

// ====================================================================
//  💾 AUTOMATED BACKUP & SAFETY NET
// ====================================================================
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
    } catch (err) { console.error("❌ Backup Failed:", err); }
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
                lastActive: new Date()
            });
            console.log(`✅ Default Admin Created: ${defaultEmail}`);
        }
    } catch (err) { console.error("❌ Error creating default admin:", err); }
}

connectDB().then(() => { createDefaultAdmin(); });

// ====================================================================
//  🔐 MIDDLEWARE: AUTH & INACTIVITY CHECK
// ====================================================================

const verifyToken = async (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(403).json({ message: "No token provided" });
    
    const bearerToken = token.startsWith('Bearer ') ? token.split(' ')[1] : token;
    
    try {
        const decoded = jwt.verify(bearerToken, JWT_SECRET);
        
        // ✅ INACTIVITY CHECK & FRESH DATA FETCH
        const user = await User.findByPk(decoded.id);
        if (!user) return res.status(401).json({ message: "User not found" });

        const lastActiveTime = new Date(user.lastActive).getTime();
        const currentTime = new Date().getTime();

        if ((currentTime - lastActiveTime) > INACTIVITY_LIMIT) {
            // Session Expired
            await User.update({ isActive: false }, { where: { id: user.id } });
            return res.status(401).json({ message: "Session expired due to inactivity. Please login again." });
        }

        // ✅ Update lastActive time
        await User.update({ lastActive: new Date() }, { where: { id: user.id } });
        
        // Use fresh user object from DB (handles role changes instantly)
        req.user = user.toJSON(); 
        
        next();

    } catch (err) {
        return res.status(401).json({ message: "Unauthorized" });
    }
};

const verifySuperAdmin = (req, res, next) => {
    // Now req.user comes directly from DB, so this check is always accurate
    if (!req.user || req.user.role !== 'superadmin') {
        return res.status(403).json({ message: "Forbidden: Super Admin Access Required" });
    }
    next();
};

// ====================================================================
//  USER ROUTES
// ====================================================================

// ✅ LOGIN (Sets Initial Activity)
app.post('/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body;
    
    if (!isDomainAllowed(email)) return res.status(403).json({ message: "Access Denied: Domain not authorized." });

    try {
        const user = await User.findOne({ where: { email } });
        if (!user) return res.status(401).json({ message: "Invalid credentials" });
        
        // 1. Handle Hashes (App vs Web)
        const isAppHash = /^[a-f0-9]{64}$/i.test(password);
        let passwordToVerify = password;
        if (!isAppHash) {
            passwordToVerify = convertToAppHash(password);
        }

        const isMatch = await bcrypt.compare(passwordToVerify + PASSWORD_PEPPER, user.password);
        if (!isMatch) return res.status(401).json({ message: "Invalid credentials" });
        
        // 2. Update Tracking
        await User.update({ 
            isActive: true, 
            loginTime: new Date(),
            lastActive: new Date() // Reset inactivity timer
        }, { where: { id: user.id } });

        // 3. Long-Lived Token (Server enforces inactivity, not token)
        const token = jwt.sign(
            { id: user.id, role: user.role }, 
            JWT_SECRET, 
            { expiresIn: '24h' } 
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
        res.json({ message: "Logged out" });
    } catch (err) { res.status(500).json({ message: "Logout failed" }); }
});

// ✅ ADD USER (Fix Double Hashing Logic)
app.post('/api/users', verifyToken, verifySuperAdmin, async (req, res) => {
    const { name, email, password, role } = req.body;
    
    if (!isDomainAllowed(email)) return res.status(400).json({ message: "Domain not allowed." });

    try {
        const existing = await User.findOne({ where: { email } });
        if (existing) return res.status(409).json({ message: "Email exists" });
        
        // 1. Check if input is ALREADY a hash (from future App updates)
        const isInputAlreadyHashed = /^[a-f0-9]{64}$/i.test(password);
        let appStyleHash;

        if (isInputAlreadyHashed) {
            // If input looks like a hash (64 chars), assume it IS the App Hash
            appStyleHash = password;
        } else {
            // If input is plain text (Admin UI), convert it to App Hash first
            appStyleHash = convertToAppHash(password);
        }
        
        // 2. Encrypt result with Bcrypt (Storage format)
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

// ====================================================================
//  BLACKLIST & OCR
// ====================================================================

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
    const { count, rows } = await License.findAndCountAll({ where: { Verification: 'blacklisted' }, limit: 50 });
    res.json({ data: rows, total: count });
});

app.get('/api/blacklist/rc', verifyToken, async (req, res) => {
    const { count, rows } = await RC.findAndCountAll({ where: { verification: 'blacklisted' }, limit: 50 });
    res.json({ data: rows, total: count });
});

app.put('/api/blacklist/:type/:id', verifyToken, verifySuperAdmin, async (req, res) => {
    res.status(501).json({message: "Not implemented yet"});
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

// ✅ FIX: VERIFY WITH SOURCE TRACKING LOGGING
app.post('/api/verify', upload.fields([{ name: 'driverImage', maxCount: 1 }, { name: 'dlImage', maxCount: 1 }, { name: 'rcImage', maxCount: 1 }]), async (req, res) => {
    const { dl_number, rc_number, location, tollgate } = req.body;
    const driverImage = req.files && req.files['driverImage'] ? req.files['driverImage'][0] : null;

    // Capture Source
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

// Keep Alive & Start
app.post('/api/status/inactive', (req, res) => { res.status(200).send('OK'); }); // Simple ping

server.listen(port, () => {
    console.log(`🌐 Netra Sarathi Secure Server Running on Port: ${port}`);
});
