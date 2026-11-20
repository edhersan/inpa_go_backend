require('dotenv').config();

const app = require('./app');

const PORT = Number(process.env.PORT) || 3000;

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Inpa_Go API REST escuchando en http://localhost:${PORT}`);
  });
}

module.exports = app;
