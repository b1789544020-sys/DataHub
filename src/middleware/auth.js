// DataHub - Auth Middleware
// Verifies JWT tokens and attaches user info to req.user.

const jwt = require('jsonwebtoken');
const config = require('../config');

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization Bearer token' });
  }

  try {
    const payload = jwt.verify(token, config.jwt.secret);
    req.user = { id: payload.sub, username: payload.username };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function authOptional(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return next();
  }

  try {
    const payload = jwt.verify(token, config.jwt.secret);
    req.user = { id: payload.sub, username: payload.username };
  } catch (_) {
    // ignore; treat as anonymous
  }
  next();
}

module.exports = { authRequired, authOptional };