/**
 * Flux d'événements serveur → navigateur (Server-Sent Events).
 * Suffisant ici : le trafic ne va que dans un sens, et une simple
 * requête HTTP traverse IIS sans configuration WebSocket particulière.
 */

const clients = new Set();
let nextId = 1;

export function subscribe(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');

  const client = { id: nextId++, res };
  clients.add(client);

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* connexion tombée */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });
}

export function broadcast(event, payload = {}) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of [...clients]) {
    try {
      client.res.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}

export function clientCount() {
  return clients.size;
}
