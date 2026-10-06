const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

require('dotenv').config({ 
  path: path.resolve(__dirname, '../.env') 
});

// 1. Get password from environment variable
const adminUser = process.env.MQTT_ADMIN_USER || 'admin';
const plainPassword = process.env.MQTT_ADMIN_PASS || crypto.randomBytes(24).toString('hex');

// 2. Generate Mosquitto-compatible PBKDF2 SHA-512 Hash
const salt = crypto.randomBytes(12);
const iterations = 10100;
const keylen = 64;
const digest = 'sha512';

const derivedKey = crypto.pbkdf2Sync(plainPassword, salt, iterations, keylen, digest);

const saltBase64 = salt.toString('base64');
const hashBase64 = derivedKey.toString('base64');
const mosquittoHash = `PBKDF2$sha512$${iterations}$${saltBase64}$${hashBase64}`;

// 3. Construct JSON template
const dynsecConfig = {
  clients: [
    {
      username: adminUser,
      textName: "Express Backend Admin",
      password: mosquittoHash,
      salt: saltBase64,
      iterations: iterations,
      roles: [{ rolename: "admin" }]
    }
  ],
  roles: [
    {
      rolename: "admin",
      acls: [
        { aclType: "publishClientSend", topic: "$CONTROL/dynamic-security/#", priority: 0, allow: true },
        { aclType: "publishClientReceive", topic: "$CONTROL/dynamic-security/#", priority: 0, allow: true },
        { aclType: "subscribePattern", topic: "$CONTROL/dynamic-security/#", priority: 0, allow: true },
        { aclType: "unsubscribePattern", topic: "$CONTROL/dynamic-security/#", priority: 0, allow: true }
      ]
    }
  ],
  groups: [],
  defaultACLAccess: {
    publishClientSend: false,
    publishClientReceive: true,
    subscribe: false,
    unsubscribe: true
  }
};

// 4. Write to mounted config folder
const targetPath = path.join(__dirname, '../../eclipse-mosquitto/config/dynamic-security.json');

// Only generate if file doesn't exist yet to avoid overwriting existing dynamic state
if (!fs.existsSync(targetPath)) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(dynsecConfig, null, 2));
  console.log(`✅ Cleanly generated dynamic-security.json for user '${adminUser}'`);
} else {
  console.log(`ℹ️ dynamic-security.json already exists. Skipping seed.`);
}