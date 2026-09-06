// Minimal echo server used to demo/test the Praxis Lens orchestrator.
// Run with `npm run example:b` (defaults to port 4002).
const express = require('express');

const PORT = process.env.PORT || 4002;
const NAME = process.env.NAME || 'serviceB';

const app = express();
app.use(express.json());

app.all('*', (req, res) => {
  console.log(`[${NAME}] ${req.method} ${req.originalUrl}`);
  res.json({
    handledBy: NAME,
    method: req.method,
    path: req.originalUrl,
    headers: req.headers,
    body: req.body,
  });
});

app.listen(PORT, () => {
  console.log(`[${NAME}] listening on http://localhost:${PORT}`);
});
