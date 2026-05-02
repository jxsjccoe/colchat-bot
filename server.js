const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const qrcode = require('qrcode');
const http = require('http');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
let botInstructions = 'Eres un asistente de servicio al cliente.';
let clientWA = null;
let currentState = 'disconnected';
let lastQR = null;
let lastInfo = null;

function createClient() {
  clientWA = new Client({ authStrategy: new LocalAuth(), puppeteer: { args: ['--no-sandbox'] } });

  clientWA.on('qr', async (qr) => {
    lastQR = await qrcode.toDataURL(qr);
    currentState = 'qr';
    io.emit('update', { qr: lastQR, state: 'qr' });
  });

  clientWA.on('ready', () => {
    currentState = 'ready';
    lastInfo = clientWA.info;
    io.emit('update', { state: 'ready', info: lastInfo });
  });

  clientWA.on('message', async (msg) => {
    if (msg.fromMe) return;
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent(`${botInstructions}\n\nCliente: ${msg.body}\nRespuesta:`);
    msg.reply(result.response.text());
  });

  clientWA.initialize();
}

app.post('/api/configure', (req, res) => {
  botInstructions = req.body.instructions || botInstructions;
  if (clientWA) clientWA.destroy().catch(() => {});
  lastQR = null; currentState = 'disconnected';
  setTimeout(createClient, 1000);
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => {
  res.json({ state: currentState, qr: lastQR, info: lastInfo });
});

app.post('/api/restart', (req, res) => {
  if (clientWA) clientWA.destroy().catch(() => {});
  setTimeout(createClient, 1000);
  res.json({ ok: true });
});

server.listen(process.env.PORT || 3000, () => console.log('Servidor activo'));
createClient();