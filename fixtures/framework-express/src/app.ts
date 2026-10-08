import express from 'express';

const app = express();

function healthCheck(_req: unknown, res: { json(value: unknown): void }) {
  res.json({ ok: true });
}

app.get('/health', healthCheck);

export { app };
