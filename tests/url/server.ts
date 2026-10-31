import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export interface TestServer {
  readonly origin: string;
  url(path: string): string;
  route(path: string, handler: Handler): void;
  requests(path: string): string[];
  socketClosed(path: string): Promise<void>;
  close(): Promise<void>;
}

export function objectRoute(bytes: Uint8Array, { clamp = true }: { clamp?: boolean } = {}): Handler {
  return (req, res) => {
    const size = bytes.byteLength;
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (!m) {
      res.writeHead(200, { 'content-length': String(size) }).end(Buffer.from(bytes));
      return;
    }
    const first = Number(m[1]);
    const asked = m[2] === '' ? size - 1 : Number(m[2]);
    if (first >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
      return;
    }
    const last = clamp ? Math.min(asked, size - 1) : asked;
    const body = Buffer.from(bytes.subarray(first, last + 1));
    res.writeHead(206, { 'content-range': `bytes ${first}-${last}/${size}`, 'content-length': String(body.byteLength) }).end(body);
  };
}

export async function startServer(): Promise<TestServer> {
  const routes = new Map<string, Handler>();
  const log = new Map<string, string[]>();
  const waits = new Map<string, Array<() => void>>();
  const sockets = new Map<Socket, Set<string>>();
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const list = log.get(path) ?? [];
    list.push(req.headers.range ?? '');
    log.set(path, list);
    sockets.get(req.socket)?.add(path);
    const handler = routes.get(path);
    if (handler) handler(req, res);
    else res.writeHead(404).end();
  });
  server.on('connection', (socket) => {
    sockets.set(socket, new Set());
    socket.once('close', () => {
      for (const path of sockets.get(socket) ?? []) {
        for (const done of waits.get(path) ?? []) done();
        waits.delete(path);
      }
      sockets.delete(socket);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    url: (path) => `${origin}${path}`,
    route: (path, handler) => void routes.set(path, handler),
    requests: (path) => log.get(path) ?? [],
    socketClosed: (path) =>
      new Promise<void>((done) => {
        const list = waits.get(path) ?? [];
        list.push(done);
        waits.set(path, list);
      }),
    close: async () => {
      for (const socket of sockets.keys()) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
