import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const PULL_TIMEOUT_MS = 25_000;
const REQ_TIMEOUT_MS = 22_000;

const rooms = new Map();

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function jsonResp(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function getOrCreateRoom(roomId, secret) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      id: roomId,
      secret,
      lastSeen: Date.now(),
      pullRes: null,
      pullTimer: null,
      queue: [],
      pending: new Map()
    };
    rooms.set(roomId, room);
  }
  return room;
}

function flushNextToPhone(room) {
  if (!room.pullRes || room.pullRes.writableEnded || !room.queue.length) return;
  const item = room.queue.shift();
  const res = room.pullRes;
  clearTimeout(room.pullTimer);
  room.pullRes = null;
  room.pullTimer = null;
  const data = Buffer.from(JSON.stringify(item), 'utf8');
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': data.length,
    'Cache-Control': 'no-store'
  });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && u.pathname === '/health') {
      return jsonResp(res, 200, {
        ok: true,
        service: 'friday-relay',
        rooms: rooms.size,
        uptimeSec: Math.floor(process.uptime())
      });
    }

    if (req.method === 'GET' && u.pathname === '/_phone/pull') {
      const roomId = String(u.searchParams.get('room') || '').trim();
      const secret = String(u.searchParams.get('secret') || '').trim();
      if (!roomId || !secret) return jsonResp(res, 400, { error: 'Missing room or secret' });

      const room = getOrCreateRoom(roomId, secret);
      if (room.secret !== secret) return jsonResp(res, 403, { error: 'Room secret mismatch' });
      room.lastSeen = Date.now();

      if (room.pullRes && !room.pullRes.writableEnded) {
        clearTimeout(room.pullTimer);
        room.pullRes.writeHead(204);
        room.pullRes.end();
      }
      room.pullRes = res;
      if (room.queue.length) {
        return flushNextToPhone(room);
      }
      room.pullTimer = setTimeout(() => {
        if (room.pullRes === res && !res.writableEnded) {
          room.pullRes = null;
          res.writeHead(204);
          res.end();
        }
      }, PULL_TIMEOUT_MS);
      res.on('close', () => {
        if (room.pullRes === res) {
          clearTimeout(room.pullTimer);
          room.pullRes = null;
        }
      });
      return;
    }

    if (req.method === 'POST' && u.pathname === '/_phone/reply') {
      const roomId = String(u.searchParams.get('room') || '').trim();
      const secret = String(u.searchParams.get('secret') || '').trim();
      const reqId = String(u.searchParams.get('id') || '').trim();
      const room = rooms.get(roomId);
      if (!room || room.secret !== secret) return jsonResp(res, 403, { error: 'Unauthorized room' });
      room.lastSeen = Date.now();

      const raw = await readRawBody(req);
      const parsed = JSON.parse(raw.toString('utf8'));
      const waiter = room.pending.get(reqId);
      if (waiter) {
        clearTimeout(waiter.timer);
        room.pending.delete(reqId);
        const outBuf = parsed.bodyB64 ? Buffer.from(parsed.bodyB64, 'base64') : Buffer.alloc(0);
        if (!waiter.res.writableEnded) {
          waiter.res.writeHead(Number(parsed.status || 200), {
            'Content-Type': String(parsed.contentType || 'application/json'),
            'Content-Length': outBuf.length,
            'Cache-Control': 'no-store'
          });
          waiter.res.end(outBuf);
        }
      }
      return jsonResp(res, 200, { ok: true });
    }

    const relayMatch = u.pathname.match(/^\/r\/([A-Za-z0-9_-]+)(\/.*)?$/);
    if (relayMatch) {
      const roomId = relayMatch[1];
      const subPath = (relayMatch[2] || '/admin/') + (u.search || '');
      const room = rooms.get(roomId);
      if (!room || Date.now() - room.lastSeen > 40_000) {
        return jsonResp(res, 503, { error: 'F.R.I.D.A.Y. phone is not connected to this relay room' });
      }
      if (room.queue.length >= 32) {
        return jsonResp(res, 429, { error: 'Relay queue full' });
      }

      const bodyBuf = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || '') ? await readRawBody(req) : Buffer.alloc(0);
      const id = crypto.randomBytes(12).toString('hex');
      const forwardHeaders = {};
      for (const h of ['content-type', 'authorization', 'x-phonebox-token', 'x-phonebox-pin', 'accept']) {
        if (req.headers[h]) forwardHeaders[h] = String(req.headers[h]);
      }

      const timer = setTimeout(() => {
        const w = room.pending.get(id);
        if (w) {
          room.pending.delete(id);
          if (!res.writableEnded) jsonResp(res, 504, { error: 'Phone tunnel response timed out' });
        }
      }, REQ_TIMEOUT_MS);

      room.pending.set(id, { res, timer });
      res.on('close', () => {
        const w = room.pending.get(id);
        if (w) { clearTimeout(w.timer); room.pending.delete(id); }
      });

      room.queue.push({
        id,
        method: req.method || 'GET',
        path: subPath,
        headers: forwardHeaders,
        bodyB64: bodyBuf.length ? bodyBuf.toString('base64') : ''
      });
      flushNextToPhone(room);
      return;
    }

    jsonResp(res, 404, { error: 'Unknown relay route. Use /r/<roomId>/...' });
  } catch (err) {
    if (!res.writableEnded) jsonResp(res, 500, { error: err?.message || 'Relay internal error' });
  }
});

setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [id, room] of rooms.entries()) {
    if (!room.pullRes && room.lastSeen < cutoff && room.pending.size === 0) rooms.delete(id);
  }
}, 60_000);

server.listen(PORT, HOST, () => {
  console.log(`F.R.I.D.A.Y. Relay Server listening on http://${HOST}:${PORT}`);
});
