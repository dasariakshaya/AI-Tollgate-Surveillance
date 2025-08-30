const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');

// ✅ APP CONFIG
const app = express();
const port = 3000;
app.use(cors());
app.use(express.json());
const upload = multer({ dest: 'uploads/' });

// ✅ MONGODB SETUP
const mongoUrl = 'mongodb://localhost:27017';
const client = new MongoClient(mongoUrl);
let licenseCollection, usersCollection, rcCollection, logsCollection;

// ✅ PYTHON SERVICE URLS
// --- REMOVED --- The old RC service URL is no longer needed.
// const PYTHON_RC_SERVICE_URL = 'http://localhost:5000/recognize_rc'; 
const PYTHON_DL_SERVICE_URL = 'http://localhost:5001/extract-dl';
// --- ADDED --- URL for your new, powerful ANPR service
const PYTHON_ANPR_SERVICE_URL = 'http://localhost:8000/recognize_plate/';

async function connectDB() {
  try {
    await client.connect();
    const db = client.db('licenseDB');
    licenseCollection = db.collection('licenses');
    usersCollection = db.collection('users');
    rcCollection = db.collection('registration_certificates');
    logsCollection = db.collection('logs');
    console.log("✅ MongoDB connected");
  } catch (e) {
    console.error("MongoDB Error:", e);
  }
}
connectDB();

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

        const newUser = {
            name,
            email,
            password, // In a real application, hash this password!
            role,
            isActive: false, 
            loginTime: null,
            logoutTime: null,
            createdAt: new Date()
        };
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

// --- BLACKLIST MANAGEMENT APIs ---

// GET Blacklisted DLs with pagination
app.get('/api/blacklist/dl', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    try {
        const totalCount = await licenseCollection.countDocuments({ Verification: "blacklisted" });
        const blacklistedDLs = await licenseCollection.find({ Verification: "blacklisted" })
                                                     .skip(skip)
                                                     .limit(limit)
                                                     .toArray();
        res.json({
            data: blacklistedDLs,
            total: totalCount,
            page: page,
            pages: Math.ceil(totalCount / limit)
        });
    } catch (err) {
        console.error("Error fetching blacklisted DLs:", err);
        res.status(500).json({ message: "Failed to fetch blacklisted DLs" });
  }
});

// GET Blacklisted RCs with pagination
app.get('/api/blacklist/rc', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    try {
        const totalCount = await rcCollection.countDocuments({ verification: "blacklisted" });
        const blacklistedRCs = await rcCollection.find({ verification: "blacklisted" })
                                                 .skip(skip)
                                                 .limit(limit)
                                                 .toArray();
        res.json({
            data: blacklistedRCs,
            total: totalCount,
            page: page,
            pages: Math.ceil(totalCount / limit)
        });
    } catch (err) {
        console.error("Error fetching blacklisted RCs:", err);
        res.status(500).json({ message: "Failed to fetch blacklisted RCs" });
    }
});

// POST Add new blacklist entry
app.post('/api/blacklist', async (req, res) => {
    const { type, number } = req.body;
    if (!type || !number) {
        return res.status(400).json({ message: "Type and number are required." });
    }

    const cleanedNumber = number.replace(/\s|-/g, '').toUpperCase();

    try {
        if (type === 'dl') {
            const result = await licenseCollection.updateOne(
                { dl_number: cleanedNumber },
                { $set: { Verification: "blacklisted" } },
                { upsert: true }
            );
            if (result.matchedCount === 0 && result.upsertedCount === 0) {
                 return res.status(404).json({ message: `Driving License ${cleanedNumber} not found.` });
            }
            res.json({ message: `Driving License ${cleanedNumber} added to blacklist.` });
        } else if (type === 'rc') {
            const result = await rcCollection.updateOne(
                { regn_number: cleanedNumber },
                { $set: { verification: "blacklisted" } },
                { upsert: true }
            );
            if (result.matchedCount === 0 && result.upsertedCount === 0) {
                return res.status(404).json({ message: `Registration Certificate ${cleanedNumber} not found.` });
            }
            res.json({ message: `Registration Certificate ${cleanedNumber} added to blacklist.` });
        } else {
            res.status(400).json({ message: "Invalid type specified. Must be 'dl' or 'rc'." });
        }
    } catch (err) {
        console.error("Error adding to blacklist:", err);
        res.status(500).json({ message: "Server error during blacklist addition" });
    }
});

// PUT Mark as valid (remove from blacklist)
app.put('/api/blacklist/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid ID format." });
    }

    try {
        let result;
        if (type === 'dl') {
            result = await licenseCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { Verification: "valid" } }
            );
        } else if (type === 'rc') {
            result = await rcCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { verification: "valid" } }
            );
        } else {
            return res.status(400).json({ message: "Invalid type specified. Must be 'dl' or 'rc'." });
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


// ➕ Helpers
async function getDLData(dlNumberRaw) {
  if (!dlNumberRaw) return { status: "no_data_provided" };
  const dlNumber = dlNumberRaw.replace(/\s|-/g, '').toUpperCase();
  const dl = await licenseCollection.findOne({ dl_number: { $regex: new RegExp(`^${dlNumber}$`, 'i') } });
  return dl ? {
    status: dl.Verification,
    licenseNumber: dl.dl_number,
    name: dl.name,
    validity: dl.validity,
    phone_number: dl.phone_number
  } : { status: "not_found", licenseNumber: dlNumber };
}

async function getRCData(rcNumberRaw) {
  if (!rcNumberRaw) return { status: "no_data_provided" };
  const rcNumber = rcNumberRaw.replace(/\s|-/g, '').toUpperCase();
  const rc = await rcCollection.findOne({ regn_number: { $regex: new RegExp(`^${rcNumber}$`, 'i') } });
  return rc ? { ...rc, status: rc.verification } : { status: "not_found", regn_number: rcNumber };
}

// --- REMOVED --- Old RC OCR function is no longer needed
/*
async function getRCOCRFromPython(imagePath) {
    try {
        const form = new FormData();
        form.append('rc_image', fs.createReadStream(imagePath), {
            filename: path.basename(imagePath),
            contentType: 'image/jpeg',
        });

        const response = await axios.post(PYTHON_RC_SERVICE_URL, form, {
            headers: form.getHeaders(),
        });

        if (response.data && response.data.recognized_text) {
            console.log("Python RC OCR Result:", response.data.recognized_text);
            return response.data.recognized_text;
        } else {
            console.warn("Python RC service did not return 'recognized_text'. Full response:", response.data);
            return null;
        }
    } catch (error) {
        console.error(`Error calling Python RC OCR service at ${PYTHON_RC_SERVICE_URL}:`, error.message);
        if (error.response) {
            console.error("Python service detailed error response:", error.response.data);
        }
        return null;
    }
}
*/

// --- ADDED --- New helper function to call our advanced ANPR service
async function getANPRDataFromPython(imagePath) {
    try {
        const form = new FormData();
        // The new Python API expects the file field to be named 'file'
        form.append('file', fs.createReadStream(imagePath), {
            filename: path.basename(imagePath),
            contentType: 'image/jpeg', // Assuming jpeg, adjust if needed
        });

        const response = await axios.post(PYTHON_ANPR_SERVICE_URL, form, {
            headers: form.getHeaders(),
        });

        if (response.data && response.data.plate_number) {
            console.log("✅ Python ANPR Service Result:", response.data.plate_number);
            return response.data.plate_number; // Return the clean plate number
        } else {
            console.warn("ANPR service did not return a valid plate number. Raw Text:", response.data.raw_text);
            return null;
        }
    } catch (error) {
        console.error(`Error calling Python ANPR service at ${PYTHON_ANPR_SERVICE_URL}:`, error.message);
        if (error.response) {
            console.error("Python service detailed error response:", error.response.data);
        }
        return null;
    }
}


// NEW helper function to call Python service for DL OCR
async function getDLOCRFromPython(imagePath) {
    try {
        const form = new FormData();
        form.append('dl_image', fs.createReadStream(imagePath), {
            filename: path.basename(imagePath),
            contentType: 'image/jpeg',
        });

        const response = await axios.post(PYTHON_DL_SERVICE_URL, form, {
            headers: form.getHeaders(),
        });
        
        if (response.data && response.data.dl_numbers && response.data.dl_numbers.length > 0) {
            console.log("Python DL OCR Result:", response.data.dl_numbers[0]);
            return response.data.dl_numbers[0]; // Return the first detected DL number
        } else {
            console.warn("Python DL service did not return any DL numbers. Full response:", response.data);
            return null;
        }
    } catch (error) {
        console.error(`Error calling Python DL OCR service at ${PYTHON_DL_SERVICE_URL}:`, error.message);
        if (error.response) {
            console.error("Python service detailed error response:", error.response.data);
        }
        return null;
    }
}


// 🔍 VERIFY (MODIFIED ENDPOINT)
app.post('/api/verify', upload.fields([
    { name: 'dlImage', maxCount: 1 },
    { name: 'rcImage', maxCount: 1 }
]), async (req, res) => {
    const dlImage = req.files['dlImage']?.[0];
    const rcImage = req.files['rcImage']?.[0];
    const { dl_number: manualDlNumber, rc_number: manualRcNumber, location, tollgate } = req.body;

    let dlNumberFromOCR = null;
    let rcNumberFromOCR = null;
    let dlData = null;
    let rcData = null;
    
    try {
        // --- Process DL Image (using our new Python service) ---
        if (dlImage) {
            console.log("Sending DL image to Python service for processing...");
            dlNumberFromOCR = await getDLOCRFromPython(dlImage.path);
            if (dlNumberFromOCR) {
                console.log("✅ Extracted DL from Python Service:", dlNumberFromOCR);
            } else {
                console.warn("Could not extract DL number from image using Python service.");
            }
        }

        // --- MODIFIED --- Process RC Image using the new ANPR service
        if (rcImage) {
            rcNumberFromOCR = await getANPRDataFromPython(rcImage.path);
            if (rcNumberFromOCR) {
                console.log("🚘 ANPR Result (Final Plate Number):", rcNumberFromOCR);
            } else {
                console.warn("No valid plate number received from ANPR service.");
            }
        }

        const finalDlNumber = manualDlNumber || dlNumberFromOCR;
        const finalRcNumber = manualRcNumber || rcNumberFromOCR;

        // Fetch actual data for DL and RC if numbers are available
        if (finalDlNumber) {
            dlData = await getDLData(finalDlNumber);
        }
        if (finalRcNumber) {
            rcData = await getRCData(finalRcNumber);
        }
        
        // --- Consolidated Log Entry for the Current Transaction ---
        const logEntry = {
            timestamp: new Date(),
            scanned_by: (dlImage || rcImage) ? 'OCR' : 'Manual',
            location: location || 'unknown',
            tollgate: tollgate || 'unknown',
        };

        if (dlData) {
            logEntry.dl_number = dlData.licenseNumber;
            logEntry.dl_name = dlData.name || 'N/A';
            logEntry.phone_number = dlData.phone_number || 'N/A';
            logEntry.dl_status = dlData.status;
        } else if (finalDlNumber) {
            logEntry.dl_number = finalDlNumber;
            logEntry.dl_status = 'not_found';
        }

        if (rcData) {
            logEntry.vehicle_number = rcData.regn_number;
            logEntry.owner_name = rcData.owner_name || 'N/A';
            logEntry.engine_number = rcData.engine_number || 'N/A';
            logEntry.chassis_number = rcData.chassis_number || 'N/A';
            logEntry.rc_status = rcData.status;
        } else if (finalRcNumber) {
            logEntry.vehicle_number = finalRcNumber;
            logEntry.rc_status = 'not_found';
        }

        if (Object.keys(logEntry).length > 4) {
            await logsCollection.insertOne(logEntry);
        } else {
            console.warn("No valid DL or RC data to log for this transaction.");
        }

        // --- Check for suspicious DL usage ---
        let suspicious = false;
        if (dlData?.status !== "not_found" && dlData?.status !== "no_data_provided" && dlData?.licenseNumber) {
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
                    description: `DL ${dlData.licenseNumber} used with ${uniqueVehicles.size} vehicles in last 2 days`,
                    location: location || 'unknown',
                    tollgate: tollgate || 'unknown',
                    scanned_by: 'System',
                    suspicious: true
                });
            }
        }
        
        res.json({ dlData, rcData, suspicious });

    } catch (err) {
        console.error("🚨 Combined verification error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        // Clean up all temporary files
        const allPaths = [];
        if (dlImage) {
            allPaths.push(dlImage.path);
        }
        if (rcImage) {
            allPaths.push(rcImage.path);
        }
        allPaths.forEach(p => fs.existsSync(p) && fs.unlinkSync(p));
    }
});

// New endpoint for DL usage check
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