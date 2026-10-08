const express = require('express');
const app = express();
app.del('/old', handler);
app.get('/health', handler);
app.get('/*', handler);
app.get('/:file.:ext?', handler);
app.get('/[discussion|page]/:slug', handler);
function handler(req, res) {
  req.param('id');
  res.json({ ok: true }, 200);
  res.send(404);
  res.send('ok');
}
