// Minimal echo server used to demo/test the Praxis Lens orchestrator.
// Run with `npm run example:a` (defaults to port 4001).
const express = require('express');

const PORT = process.env.PORT || 4001;
const NAME = process.env.NAME || 'serviceA';

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
