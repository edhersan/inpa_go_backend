const mysql = require('mysql2/promise');

function buildPoolConfig() {
  const config = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'inpa_go_db',
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_LIMIT) || 5,
    queueLimit: 0,
    charset: 'utf8mb4',
    timezone: '-05:00',
    decimalNumbers: true,
  };

  if (String(process.env.DB_SSL).toLowerCase() === 'true') {
    config.ssl = {
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
    };
  }

  return config;
}

function getPool() {
  if (!globalThis.__inpaGoDbPool) {
    globalThis.__inpaGoDbPool = mysql.createPool(buildPoolConfig());
  }
  return globalThis.__inpaGoDbPool;
}

async function query(sql, params = []) {
  const pool = getPool();
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function getConnection() {
  const pool = getPool();
  return pool.getConnection();
}

module.exports = {
  getPool,
  query,
  getConnection,
};
