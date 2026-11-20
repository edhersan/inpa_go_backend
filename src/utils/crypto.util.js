const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const BCRYPT_ROUNDS = 12;

async function hashPassword(plainPassword) {
  return bcrypt.hash(String(plainPassword), BCRYPT_ROUNDS);
}

async function verifyPassword(plainPassword, passwordHash) {
  if (!plainPassword || !passwordHash) {
    return false;
  }
  return bcrypt.compare(String(plainPassword), String(passwordHash));
}

function sha256String(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function generateRefreshToken() {
  return crypto.randomBytes(48).toString('hex');
}

function generateUuid() {
  return crypto.randomUUID();
}

module.exports = {
  BCRYPT_ROUNDS,
  hashPassword,
  verifyPassword,
  sha256String,
  sha256Buffer,
  generateRefreshToken,
  generateUuid,
};
