const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'GracieAdmin2026!';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

// Initialize database table
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key VARCHAR(255) PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  console.log('Database initialized');
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function checkAdmin(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return false;
  return auth.slice(7) === ADMIN_PASSWORD;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // --- API Routes ---

  // POST /api/subscribe — public
  if (req.method === 'POST' && url.pathname === '/api/subscribe') {
    try {
      const { name, email } = await readBody(req);
      if (!name || !email) return json(res, 400, { error: 'Name and email required' });

      await pool.query(
        'INSERT INTO subscribers (name, email) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING',
        [name.trim(), email.trim().toLowerCase()]
      );
      return json(res, 200, { success: true });
    } catch (err) {
      console.error('Subscribe error:', err);
      return json(res, 500, { error: 'Server error' });
    }
  }

  // GET /api/subscribers — admin only
  if (req.method === 'GET' && url.pathname === '/api/subscribers') {
    if (!checkAdmin(req)) return json(res, 401, { error: 'Unauthorized' });
    try {
      const { rows } = await pool.query('SELECT id, name, email, created_at FROM subscribers ORDER BY created_at DESC');
      return json(res, 200, { subscribers: rows });
    } catch (err) {
      console.error('List error:', err);
      return json(res, 500, { error: 'Server error' });
    }
  }

  // DELETE /api/subscribers/:id — admin only
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/subscribers/')) {
    if (!checkAdmin(req)) return json(res, 401, { error: 'Unauthorized' });
    const id = url.pathname.split('/').pop();
    try {
      await pool.query('DELETE FROM subscribers WHERE id = $1', [id]);
      return json(res, 200, { success: true });
    } catch (err) {
      console.error('Delete error:', err);
      return json(res, 500, { error: 'Server error' });
    }
  }

  // DELETE /api/subscribers (bulk) — admin only
  if (req.method === 'DELETE' && url.pathname === '/api/subscribers') {
    if (!checkAdmin(req)) return json(res, 401, { error: 'Unauthorized' });
    try {
      const { ids } = await readBody(req);
      if (!ids?.length) return json(res, 400, { error: 'No IDs provided' });
      await pool.query('DELETE FROM subscribers WHERE id = ANY($1)', [ids]);
      return json(res, 200, { success: true });
    } catch (err) {
      console.error('Bulk delete error:', err);
      return json(res, 500, { error: 'Server error' });
    }
  }

  // POST /api/auth — verify admin password
  if (req.method === 'POST' && url.pathname === '/api/auth') {
    try {
      const { password } = await readBody(req);
      if (password === ADMIN_PASSWORD) {
        return json(res, 200, { success: true, token: ADMIN_PASSWORD });
      }
      return json(res, 401, { error: 'Invalid password' });
    } catch (err) {
      return json(res, 400, { error: 'Invalid request' });
    }
  }

  // GET /api/stats — admin only
  if (req.method === 'GET' && url.pathname === '/api/stats') {
    if (!checkAdmin(req)) return json(res, 401, { error: 'Unauthorized' });
    try {
      const total = await pool.query('SELECT COUNT(*) FROM subscribers');
      const week = await pool.query("SELECT COUNT(*) FROM subscribers WHERE created_at >= NOW() - INTERVAL '7 days'");
      const today = await pool.query("SELECT COUNT(*) FROM subscribers WHERE created_at >= CURRENT_DATE");
      return json(res, 200, {
        total: parseInt(total.rows[0].count),
        week: parseInt(week.rows[0].count),
        today: parseInt(today.rows[0].count),
      });
    } catch (err) {
      console.error('Stats error:', err);
      return json(res, 500, { error: 'Server error' });
    }
  }

  // GET /api/settings/launch-date — public (needed by countdown)
  if (req.method === 'GET' && url.pathname === '/api/settings/launch-date') {
    try {
      const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'launch_date'");
      const date = rows.length ? rows[0].value : null;
      return json(res, 200, { date });
    } catch (err) {
      console.error('Settings error:', err);
      return json(res, 500, { error: 'Server error' });
    }
  }

  // PUT /api/settings/launch-date — admin only
  if (req.method === 'PUT' && url.pathname === '/api/settings/launch-date') {
    if (!checkAdmin(req)) return json(res, 401, { error: 'Unauthorized' });
    try {
      const { date } = await readBody(req);
      if (!date) return json(res, 400, { error: 'Date required' });
      await pool.query(
        "INSERT INTO settings (key, value) VALUES ('launch_date', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
        [date]
      );
      return json(res, 200, { success: true, date });
    } catch (err) {
      console.error('Settings update error:', err);
      return json(res, 500, { error: 'Server error' });
    }
  }

  // --- Static Files ---
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(__dirname, 'public', filePath);

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<h1>404 Not Found</h1>');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
