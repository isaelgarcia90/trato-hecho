// Server-Sent Events: el chat y el panel se actualizan solos cuando llega un pago.
const clients = new Set();

export function subscribe(req, res, filter) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const client = { res, filter };
  clients.add(client);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
  });
}

export function publish(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) {
    if (c.filter(event)) c.res.write(data);
  }
}
