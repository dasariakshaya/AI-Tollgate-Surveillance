const { Sequelize, DataTypes } = require('sequelize');
const bcrypt = require('bcryptjs');

// 1. CONFIGURATION
const PASSWORD_PEPPER = "Abra_Ca_Dabra!_@616D7269736861@_#Khulja_Sim_Sim#_!@#";
// ⚠️ PASTE YOUR RENDER DATABASE URL HERE
const DATABASE_URL = "postgres://netra_user:wP7yNldjeDhrUXRRJOcNc8zjRqLXa2jW@dpg-d4gm6fqli9vc73dn3e1g-a.singapore-postgres.render.com/netra_db";

const sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    logging: false,
    dialectOptions: {
        ssl: {
            require: true,
            rejectUnauthorized: false
        }
    }
});

// Define minimal User model
const User = sequelize.define('User', {
    email: { type: DataTypes.STRING, unique: true },
    password: { type: DataTypes.STRING }
}, { tableName: 'Users', timestamps: true });

async function resetPassword() {
    try {
        await sequelize.authenticate();
        console.log("✅ Connected to DB.");

        const email = "superadmin@parivahan.com";
        const newPassword = "superadmin123";

        // Generate Hash
        const hashedPassword = await bcrypt.hash(newPassword + PASSWORD_PEPPER, 10);

        // Update DB
        const [updated] = await User.update(
            { password: hashedPassword },
            { where: { email: email } }
        );

        if (updated) {
            console.log(`✅ Success! Password for ${email} has been hashed.`);
            console.log(`New Hash starts with: ${hashedPassword.substring(0, 10)}...`);
        } else {
            console.log(`❌ User ${email} not found.`);
        }

    } catch (error) {
        console.error("Error:", error);
    } finally {
        await sequelize.close();
    }
}

resetPassword();