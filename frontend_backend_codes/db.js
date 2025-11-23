const { Sequelize, DataTypes, Op } = require('sequelize');

// 1. DATABASE CONNECTION
let sequelize;

if (process.env.DATABASE_URL) {
  // ☁️ CLOUD MODE (Render)
  console.log("☁️ Detected Cloud URL. Connecting to Render...");
  sequelize = new Sequelize(process.env.DATABASE_URL, {
    dialect: 'postgres',
    logging: false,
    dialectOptions: {
      ssl: {
        require: true,
        rejectUnauthorized: false // Required for Render
      }
    }
  });
} else {
  // 💻 LOCAL MODE
  console.log("💻 No Cloud URL found. Connecting to Localhost...");
  sequelize = new Sequelize('netra_sarathi_db', 'postgres', 'password', {
    host: 'localhost',
    dialect: 'postgres',
    logging: false
  });
}

// 2. DEFINE MODELS
const User = sequelize.define('User', {
  name: { type: DataTypes.STRING },
  email: { type: DataTypes.STRING, unique: true },
  password: { type: DataTypes.STRING },
  role: { type: DataTypes.STRING, defaultValue: 'operator' },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: false, field: 'isActive' },
  loginTime: { type: DataTypes.DATE, field: 'loginTime' },
  logoutTime: { type: DataTypes.DATE, field: 'logoutTime' }
}, { tableName: 'Users', timestamps: true, createdAt: 'createdAt', updatedAt: 'updatedAt' });

const License = sequelize.define('License', {
  dl_number: { type: DataTypes.STRING, unique: true },
  Verification: { type: DataTypes.STRING, defaultValue: 'valid', field: 'Verification' },
  name: { type: DataTypes.STRING },
  phone_number: { type: DataTypes.STRING },
  crime_involved: { type: DataTypes.STRING }
}, { tableName: 'Licenses', timestamps: true, createdAt: 'createdAt', updatedAt: 'updatedAt' });

const RC = sequelize.define('RC', {
  regn_number: { type: DataTypes.STRING, unique: true },
  verification: { type: DataTypes.STRING, defaultValue: 'valid' },
  owner_name: { type: DataTypes.STRING },
  crime_involved: { type: DataTypes.STRING },
  engine_number: { type: DataTypes.STRING },
  chassis_number: { type: DataTypes.STRING }
}, { tableName: 'RegistrationCertificates', timestamps: true, createdAt: 'createdAt', updatedAt: 'updatedAt' });

const Log = sequelize.define('Log', {
  timestamp: { type: DataTypes.DATE, defaultValue: Sequelize.NOW },
  scanned_by: { type: DataTypes.STRING },
  location: { type: DataTypes.STRING },
  tollgate: { type: DataTypes.STRING },
  dl_number: { type: DataTypes.STRING },
  dl_name: { type: DataTypes.STRING },
  phone_number: { type: DataTypes.STRING },
  dl_status: { type: DataTypes.STRING },
  vehicle_number: { type: DataTypes.STRING },
  owner_name: { type: DataTypes.STRING },
  engine_number: { type: DataTypes.STRING },
  chassis_number: { type: DataTypes.STRING },
  rc_status: { type: DataTypes.STRING },
  driver_status: { type: DataTypes.STRING },
  driver_name: { type: DataTypes.STRING },
  alert_type: { type: DataTypes.STRING },
  description: { type: DataTypes.TEXT },
  suspicious: { type: DataTypes.BOOLEAN, defaultValue: false }
}, { tableName: 'Logs', timestamps: true, createdAt: 'createdAt', updatedAt: 'updatedAt' });

// 3. CONNECT
const connectDB = async () => {
  try {
    await sequelize.authenticate();
    console.log('✅ Connection successful!');
    await sequelize.sync({ alter: true }); 
    console.log('✅ Models Synced (Tables Created)');
  } catch (err) {
    console.error('❌ Database Connection Error:', err);
  }
};

module.exports = { sequelize, User, License, RC, Log, connectDB, Op };