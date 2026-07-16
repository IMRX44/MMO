// Thin Socket.IO wrapper + REST helpers.
export class Net {
  constructor() {
    this.socket = null;
    this.handlers = new Map();
  }

  connect() {
    this.socket = io();
    for (const [ev, fns] of this.handlers) {
      for (const fn of fns) this.socket.on(ev, fn);
    }
  }

  on(ev, fn) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, []);
    this.handlers.get(ev).push(fn);
    this.socket?.on(ev, fn);
  }

  emit(ev, data) { this.socket?.emit(ev, data); }

  join(token, charId) {
    return new Promise(resolve => this.socket.emit('join', { token, charId }, resolve));
  }
}

export async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Token': localStorage.getItem('vf_token') || '',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}
