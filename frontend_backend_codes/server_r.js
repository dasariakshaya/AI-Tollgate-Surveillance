const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');
const { exec } = require('child_process'); // To run external scripts

// ✅ APP CONFIG
const app = express();
const port = 3000;
app.use(cors());
app.use(express.json());
const upload = multer({ dest: 'uploads/' });

// ✅ MONGODB SETUP (ATLAS)
const mongoUrl = process.env.MONGODB_URI;
const client = new MongoClient(mongoUrl);
let licenseCollection, usersCollection, rcCollection, logsCollection;

// ✅ PYTHON SERVICE URLS
const PYTHON_DL_SERVICE_URL = process.env.PYTHON_DL_SERVICE_URL;
const PYTHON_ANPR_SERVICE_URL = process.env.PYTHON_ANPR_SERVICE_URL;
// const PYTHON_FACE_SERVICE_URL = process.env.PYTHON_FACE_SERVICE_URL;

async function connectDB() {
  try {
    await client.connect();
    const db = client.db('licenseDB'); // still using licenseDB in Atlas
    licenseCollection = db.collection('licenses');
    usersCollection = db.collection('users');
    rcCollection = db.collection('registration_certificates');
    logsCollection = db.collection('logs');
    console.log("✅ MongoDB Atlas connected");
  } catch (e) {
    console.error("MongoDB Error:", e);
  }
}
connectDB();

// --- USER AUTH & MANAGEMENT ROUTES (UNCHANGED) ---
// 🔐 LOGIN
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await usersCollection.findOne({ email });
    if (user && user.password === password) {
      await usersCollection.updateOne(
        { email },
        { $set: { isActive: true, loginTime: new Date(), logoutTime: null } }
      );
      const roleLabel = user.role === 'superadmin' ? 'Super Admin' : user.role === 'admin' ? 'Admin' : 'Toll Operator';
      res.json({ message: "Login successful", userId: user._id, role: user.role, roleLabel, name: user.name || "User" });
    } else {
      res.status(401).json({ message: "Invalid credentials" });
    }
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Server error during login" });
  }
});

// 🔓 LOGOUT
app.post('/api/logout/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    await usersCollection.updateOne(
      { _id: new ObjectId(userId) },
      { $set: { isActive: false, logoutTime: new Date() } }
    );
    res.json({ message: "Logged out successfully" });
  } catch (err) {
      console.error("Logout update error:", err);
      res.status(500).json({ message: "Failed to update logout info" });
  }
});

// 👥 GET ALL USERS
app.get('/api/users', async (req, res) => {
  try {
    const users = await usersCollection.find().toArray();
    res.json(users);
  } catch (err) {
    console.error("User fetch error:", err);
    res.status(500).json({ message: "Failed to fetch user data" });
  }
});

// ➕ ADD NEW USER
app.post('/api/users', async (req, res) => {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) {
        return res.status(400).json({ message: "All fields are required: name, email, password, role" });
    }
    try {
        const existingUser = await usersCollection.findOne({ email });
        if (existingUser) {
            return res.status(409).json({ message: "User with this email already exists." });
        }
        const newUser = { name, email, password, role, isActive: false, loginTime: null, logoutTime: null, createdAt: new Date() };
        const result = await usersCollection.insertOne(newUser);
        res.status(201).json({ message: "User added successfully", userId: result.insertedId });
    } catch (err) {
        console.error("Error adding user:", err);
        res.status(500).json({ message: "Server error during user addition" });
    }
});

// ➖ DELETE USER
app.delete('/api/users/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const userToDelete = await usersCollection.findOne({ _id: new ObjectId(userId) });
        if (!userToDelete) {
            return res.status(404).json({ message: "User not found." });
        }
        if (userToDelete.role === 'superadmin') {
            const superadminsCount = await usersCollection.countDocuments({ role: 'superadmin' });
            if (superadminsCount <= 1) {
                return res.status(403).json({ message: "Cannot delete the last superadmin account." });
            }
        }
        const result = await usersCollection.deleteOne({ _id: new ObjectId(userId) });
        if (result.deletedCount === 1) {
            res.json({ message: "User deleted successfully" });
        } else {
            res.status(404).json({ message: "User not found" });
        }
    } catch (err) {
        console.error("Error deleting user:", err);
        res.status(500).json({ message: "Server error during user deletion" });
    }
});


// --- BLACKLIST MANAGEMENT APIs (with search) ---
app.get('/api/blacklist/dl', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    const search = req.query.search ? req.query.search.trim() : "";
    try {
        let query = { Verification: "blacklisted" };
        if (search) {
            query.dl_number = { $regex: new RegExp(search, "i") };
        }
        const totalCount = await licenseCollection.countDocuments(query);
        const blacklistedDLs = await licenseCollection.find(query).skip(skip).limit(limit).toArray();
        res.json({ data: blacklistedDLs, total: totalCount, page, pages: Math.ceil(totalCount / limit) });
    } catch (err) {
        console.error("Error fetching blacklisted DLs:", err);
        res.status(500).json({ message: "Failed to fetch blacklisted DLs" });
    }
});

app.get('/api/blacklist/rc', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    const search = req.query.search ? req.query.search.trim() : "";
    try {
        let query = { verification: "blacklisted" };
        if (search) {
            query.regn_number = { $regex: new RegExp(search, "i") };
        }
        const totalCount = await rcCollection.countDocuments(query);
        const blacklistedRCs = await rcCollection.find(query).skip(skip).limit(limit).toArray();
        res.json({ data: blacklistedRCs, total: totalCount, page, pages: Math.ceil(totalCount / limit) });
    } catch (err) {
        console.error("Error fetching blacklisted RCs:", err);
        res.status(500).json({ message: "Failed to fetch blacklisted RCs" });
    }
});

app.post('/api/blacklist', async (req, res) => {
    const { 
        type, number, name, phone_number, crime_involved,
        owner_name, maker_class, vehicle_class, wheel_type 
    } = req.body; 

    if (!type || !number) return res.status(400).json({ message: "Type and number are required." });
    const cleanedNumber = number.replace(/\s|-/g, '').toUpperCase();
    
    try {
        let updateData;
        if (type === 'dl') {
            updateData = { 
                $set: {
                    Verification: "blacklisted",
                    name: name || 'N/A',
                    phone_number: phone_number || 'N/A',
                    crime_involved: crime_involved || 'Not specified'
                }
            };
            await licenseCollection.updateOne({ dl_number: cleanedNumber }, updateData, { upsert: true });
            res.json({ message: `Driving License ${cleanedNumber} added to blacklist.` });
        } else if (type === 'rc') {
            updateData = {
                $set: {
                    verification: "blacklisted",
                    owner_name: owner_name || 'N/A',
                    maker_class: maker_class || 'N/A',
                    vehicle_class: vehicle_class || 'N/A',
                    wheel_type: wheel_type || 'N/A',
                    crime_involved: crime_involved || 'Not specified'
                }
            };
            await rcCollection.updateOne({ regn_number: cleanedNumber }, updateData, { upsert: true });
            res.json({ message: `Registration Certificate ${cleanedNumber} added to blacklist.` });
        } else {
            res.status(400).json({ message: "Invalid type specified. Must be 'dl' or 'rc'." });
        }
    } catch (err) {
        console.error("Error adding to blacklist:", err);
        res.status(500).json({ message: "Server error during blacklist addition" });
    }
});

// MODIFIED: Endpoint for adding a suspect with robust path checking
app.post('/api/blacklist/suspect', upload.single('photo'), async (req, res) => {
    const { name } = req.body;
    const photo = req.file;

    if (!name || !photo) {
        if (photo && fs.existsSync(photo.path)) fs.unlinkSync(photo.path);
        return res.status(400).json({ message: 'Suspect name and photo are required.' });
    }

    // This path assumes 'face_recognition_api' is a sibling to your 'server_r.js' parent directory
    const faceApiPath = path.join(__dirname, '..', 'face_recognition_api');
    
    // --- ROBUSTNESS CHECK ---
    // Check if the directory actually exists before proceeding
    if (!fs.existsSync(faceApiPath) || !fs.statSync(faceApiPath).isDirectory()) {
        console.error(`CRITICAL ERROR: The face recognition directory was not found at the expected path: ${faceApiPath}`);
        console.error(`Please ensure your 'face_recognition_api' folder and the folder containing 'server_r.js' are in the same parent directory.`);
        if (photo && fs.existsSync(photo.path)) fs.unlinkSync(photo.path); // Clean up uploaded file
        return res.status(500).json({ message: "Server configuration error: Face recognition path not found." });
    }
    
    const knownFacesDir = path.join(faceApiPath, 'app', 'known_faces');
    const suspectDirName = name.trim().replace(/\s+/g, '_'); // e.g., "John Doe" -> "John_Doe"
    const suspectDirPath = path.join(knownFacesDir, suspectDirName);

    try {
        if (!fs.existsSync(suspectDirPath)) {
            fs.mkdirSync(suspectDirPath, { recursive: true });
        }

        const fileExtension = path.extname(photo.originalname) || '.jpg';
        const newPhotoName = `${suspectDirName}_${Date.now()}${fileExtension}`;
        const newPhotoPath = path.join(suspectDirPath, newPhotoName);
        fs.renameSync(photo.path, newPhotoPath);

        const buildScriptPath = path.join(faceApiPath, 'tools', 'build_embeddings.py');
        console.log(`Executing script: python "${buildScriptPath}"`);
        
        // Execute the script to rebuild the model in the background
        exec(`python "${buildScriptPath}"`, { cwd: faceApiPath }, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error executing build_embeddings.py: ${error.message}`);
                console.error(`stderr from script: ${stderr}`);
                return;
            }
            console.log(`stdout from script: ${stdout}`);
            console.log(`✅ Face recognition model updated for new suspect: '${name}'.`);
        });

        res.status(201).json({ 
            message: `Suspect '${name}' added. The face recognition model is updating in the background.` 
        });

    } catch (err) {
        console.error("Error processing suspect upload:", err);
        if (photo && fs.existsSync(photo.path)) {
            fs.unlinkSync(photo.path);
        }
        res.status(500).json({ message: "A server error occurred while processing the suspect photo." });
    }
});


app.put('/api/blacklist/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid ID format." });
    try {
        let result;
        if (type === 'dl') {
            result = await licenseCollection.updateOne({ _id: new ObjectId(id) }, { $set: { Verification: "valid" } });
        } else if (type === 'rc') {
            result = await rcCollection.updateOne({ _id: new ObjectId(id) }, { $set: { verification: "valid" } });
        } else {
            return res.status(400).json({ message: "Invalid type specified." });
        }
        if (result.matchedCount === 0) {
            res.status(404).json({ message: `${type.toUpperCase()} entry not found.` });
        } else {
            res.json({ message: `${type.toUpperCase()} entry marked as valid.` });
        }
    } catch (err) {
        console.error("Error updating blacklist status:", err);
        res.status(500).json({ message: "Server error during status update" });
    }
});


// --- HELPER FUNCTIONS ---
async function getDLData(dlNumberRaw) {
    if (!dlNumberRaw) return { status: "no_data_provided" };
    const dlNumber = dlNumberRaw.replace(/\s|-/g, '').toUpperCase();
    const dl = await licenseCollection.findOne({ dl_number: { $regex: new RegExp(`^${dlNumber}$`, 'i') } });
    return dl ? { status: dl.Verification, licenseNumber: dl.dl_number, name: dl.name, validity: dl.validity, phone_number: dl.phone_number } : { status: "not_found", licenseNumber: dlNumber };
}

async function getRCData(rcNumberRaw) {
    if (!rcNumberRaw) return { status: "no_data_provided" };
    const rcNumber = rcNumberRaw.replace(/\s|-/g, '').toUpperCase();
    const rc = await rcCollection.findOne({ regn_number: { $regex: new RegExp(`^${rcNumber}$`, 'i') } });
    return rc ? { ...rc, status: rc.verification } : { status: "not_found", regn_number: rcNumber };
}

async function getANPRDataFromPython(imagePath) {
    try {
        const form = new FormData();
        form.append('file', fs.createReadStream(imagePath));
        const response = await axios.post(PYTHON_ANPR_SERVICE_URL, form, { headers: form.getHeaders() });
        return response.data;
    } catch (error) {
        console.error(`Error calling Python ANPR service:`, error.message);
        return null;
    }
}

async function getDLOCRFromPython(imagePath) {
    try {
        const form = new FormData();
        form.append('dl_image', fs.createReadStream(imagePath));
        const response = await axios.post(PYTHON_DL_SERVICE_URL, form, { headers: form.getHeaders() });
        return response.data.dl_numbers?.[0] || null;
    } catch (error) {
        console.error(`Error calling Python DL OCR service:`, error.message);
        return null;
    }
}

async function getFaceDataFromPython(imagePath) {
    try {
        const form = new FormData();
        form.append('image', fs.createReadStream(imagePath));
        const response = await axios.post(PYTHON_FACE_SERVICE_URL, form, { headers: form.getHeaders() });
        return response.data;
    } catch (error) {
        console.error(`Error calling Python Face service:`, error.message);
        return { status: 'SERVICE_UNAVAILABLE', message: 'Face recognition service is down.' };
    }
}


// --- OCR-ONLY ENDPOINTS FOR EDITABLE FEATURE ---
app.post('/api/ocr/dl', upload.single('dlImage'), async (req, res) => {
    const dlImage = req.file;
    if (!dlImage) {
        return res.status(400).json({ message: "DL image file is required." });
    }
    try {
        const extractedText = await getDLOCRFromPython(dlImage.path);
        res.json({ extracted_text: extractedText });
    } catch (err) {
        console.error("DL OCR endpoint error:", err);
        res.status(500).json({ message: "Error processing DL image" });
    } finally {
        if (dlImage && fs.existsSync(dlImage.path)) fs.unlinkSync(dlImage.path);
    }
});

app.post('/api/ocr/rc', upload.single('rcImage'), async (req, res) => {
    const rcImage = req.file;
    if (!rcImage) {
        return res.status(400).json({ message: "RC image file is required." });
    }
    try {
        const anprResult = await getANPRDataFromPython(rcImage.path);
        res.json({ extracted_text: anprResult?.plate_number });
    } catch (err) {
        console.error("RC OCR endpoint error:", err);
        res.status(500).json({ message: "Error processing RC image" });
    } finally {
        if (rcImage && fs.existsSync(rcImage.path)) fs.unlinkSync(rcImage.path);
    }
});


// --- MAIN VERIFY ENDPOINT ---
app.post('/api/verify', upload.single('driverImage'), async (req, res) => {
    const { dl_number, rc_number, location, tollgate } = req.body;
    const driverImage = req.file;
    let dlData = null;
    let rcData = null;
    let driverData = null;
    
    try {
        if (dl_number) dlData = await getDLData(dl_number);
        if (rc_number) rcData = await getRCData(rc_number);
        if (driverImage) driverData = await getFaceDataFromPython(driverImage.path);
        
        const logEntry = {
            timestamp: new Date(),
            scanned_by: 'OCR/Manual',
            location: location || 'unknown',
            tollgate: tollgate || 'unknown',
        };

        if (dlData) {
            logEntry.dl_number = dlData.licenseNumber;
            logEntry.dl_name = dlData.name || 'N/A';
            logEntry.phone_number = dlData.phone_number || 'N/A';
            logEntry.dl_status = dlData.status;
        } else if (dl_number) {
            logEntry.dl_number = dl_number;
            logEntry.dl_status = 'not_found';
        }

        if (rcData) {
            logEntry.vehicle_number = rcData.regn_number;
            logEntry.owner_name = rcData.owner_name || 'N/A';
            logEntry.engine_number = rcData.engine_number || 'N/A';
            logEntry.chassis_number = rcData.chassis_number || 'N/A';
            logEntry.rc_status = rcData.status;
            if (rcData.crime_involved) {
                logEntry.crime_involved = rcData.crime_involved;
            }
        } else if (rc_number) {
            logEntry.vehicle_number = rc_number;
            logEntry.rc_status = 'not_found';
        }

        if (driverData) {
            logEntry.driver_status = driverData.status;
            logEntry.driver_name = driverData.name;
        }

        if (Object.keys(logEntry).length > 4) {
            await logsCollection.insertOne(logEntry);
        }

        let suspicious = false;

        if (dlData?.status === 'blacklisted') {
            suspicious = true;
            await logsCollection.insertOne({
                timestamp: new Date(),
                dl_number: dlData.licenseNumber,
                alert_type: 'Blacklisted DL Scanned',
                description: `Blacklisted DL ${dlData.licenseNumber} was scanned. Potential crime involved.`,
                location: location || 'unknown',
                tollgate: tollgate || 'unknown',
                scanned_by: 'System Alert',
                suspicious: true
            });
        }
        if (rcData?.status === 'blacklisted') {
            suspicious = true;
            await logsCollection.insertOne({
                timestamp: new Date(),
                vehicle_number: rcData.regn_number,
                dl_number: dlData?.licenseNumber || null,
                alert_type: 'Blacklisted Vehicle Scanned',
                description: `Blacklisted vehicle ${rcData.regn_number} was scanned. Crime: ${rcData.crime_involved || 'Not specified'}.`,
                location: location || 'unknown',
                tollgate: tollgate || 'unknown',
                scanned_by: 'System Alert',
                suspicious: true
            });
        }
        
        if (driverData?.status === 'ALERT') {
            suspicious = true;
            await logsCollection.insertOne({
                timestamp: new Date(),
                vehicle_number: rcData?.regn_number || null,
                dl_number: dlData?.licenseNumber || null,
                alert_type: 'Suspect Driver Identified',
                description: `Suspected person ${driverData.name} was identified driving vehicle.`,
                location: location || 'unknown',
                tollgate: tollgate || 'unknown',
                scanned_by: 'System Alert',
                suspicious: true
            });
        }


        if (dlData?.status !== 'blacklisted' && dlData?.status !== "not_found" && dlData?.status !== "no_data_provided" && dlData?.licenseNumber) {
            const twoDaysAgo = new Date();
            twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
            const dlLogs = await logsCollection.find({
                dl_number: dlData.licenseNumber,
                timestamp: { $gte: twoDaysAgo },
                vehicle_number: { $exists: true, $ne: null },
                alert_type: { $exists: false }
            }).toArray();
            const uniqueVehicles = new Set(dlLogs.map(log => log.vehicle_number));
            if (uniqueVehicles.size >= 3) {
                suspicious = true;
                await logsCollection.insertOne({
                    timestamp: new Date(),
                    dl_number: dlData.licenseNumber,
                    alert_type: 'Suspicious DL Usage',
                    description: `DL ${dlData.licenseNumber} used with ${uniqueVehicles.size} or more vehicles in last 2 days`,
                    location: location || 'unknown',
                    tollgate: tollgate || 'unknown',
                    scanned_by: 'System Alert',
                    suspicious: true
                });
            }
        }
        
        res.json({ dlData, rcData, driverData, suspicious });

    } catch (err) {
        console.error("🚨 Verification error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        if (driverImage && fs.existsSync(driverImage.path)) fs.unlinkSync(driverImage.path);
    }
});


// --- OTHER LOGGING & USAGE ENDPOINTS ---
app.get('/api/dl-usage/:dl_number', async (req, res) => {
    const { dl_number } = req.params;
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    try {
        const logs = await logsCollection.find({
            dl_number: { $regex: new RegExp(dl_number, 'i') },
            timestamp: { $gte: twoDaysAgo },
            vehicle_number: { $exists: true, $ne: null },
            alert_type: { $exists: false }
        }).sort({ timestamp: -1 }).toArray();
        res.json(logs);
    } catch (error) {
        console.error("Error fetching DL usage logs:", error);
        res.status(500).json({ message: "Error fetching DL usage logs." });
    }
});

app.get('/api/logs', async (req, res) => {
  try {
    const logs = await logsCollection.find().sort({ timestamp: -1 }).toArray();
    res.json(logs);
  } catch (err) {
    console.error("Error fetching logs:", err);
    res.status(500).json({ message: "Internal server error" });
  }

});

app.listen(port, () => {
  console.log(`🌐 Server running at http://localhost:${port}`);
});

