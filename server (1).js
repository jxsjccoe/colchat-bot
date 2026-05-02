const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { Server } = require('socket.io');
const Groq = require('groq-sdk');
const qrcode = require('qrcode');
const http = require('http');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
let botInstructions = 'Eres un asistente de servicio al cliente amable y profesional.';
let clientWA = null;
let currentState = 'disconnected';
let lastQR = null;
let lastInfo = null;

function createClient() {
  clientWA = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    }
  });

  clientWA.on('qr', async (qr) => {
    console.log('QR generado');
    lastQR = await qrcode.toDataURL(qr);
    currentState = 'qr';
    io.emit('update', { qr: lastQR, state: 'qr' });
  });

  clientWA.on('ready', () => {
    console.log('WhatsApp conectado');
    currentState = 'ready';
    lastInfo = clientWA.info;
    lastQR = null;
    io.emit('update', { state: 'ready', info: lastInfo });
  });

  clientWA.on('authenticated', () => {
    console.log('Autenticado');
    currentState = 'connecting';
    io.emit('update', { state: 'connecting' });
  });

  clientWA.on('disconnected', (reason) => {
    console.log('Desconectado:', reason);
    currentState = 'disconnected';
    lastQR = null;
    io.emit('update', { state: 'disconnected' });
    setTimeout(createClient, 3000);
  });

  clientWA.on('message', async (msg) => {
    if (msg.fromMe) return;
    try {
      const result = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: botInstructions },
          { role: 'user', content: msg.body }
        ]
      });
      const reply = result.choices[0].message.content;
      await msg.reply(reply);
      console.log('Respondido a:', msg.from);
    } catch (err) {
      console.error('Error Groq:', err.message);
    }
  });

  clientWA.initialize().catch(err => {
    console.error('Error inicializando cliente:', err.message);
    setTimeout(createClient, 5000);
  });
}

app.post('/api/configure', (req, res) => {
  const { instructions } = req.body;
  if (!instructions) return res.status(400).json({ error: 'Instrucciones requeridas' });
  botInstructions = instructions;
  console.log('Instrucciones actualizadas');
  if (clientWA) { clientWA.destroy().catch(() => {}); clientWA = null; }
  lastQR = null;
  currentState = 'disconnected';
  setTimeout(createClient, 1000);
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => {
  res.json({ state: currentState, qr: lastQR, info: lastInfo });
});

app.post('/api/restart', (req, res) => {
  if (clientWA) { clientWA.destroy().catch(() => {}); clientWA = null; }
  lastQR = null;
  currentState = 'disconnected';
  setTimeout(createClient, 1000);
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.json({ status: 'ColChat corriendo', state: currentState });
});

io.on('connection', (socket) => {
  console.log('Cliente conectado al socket');
  if (lastQR) socket.emit('update', { qr: lastQR, state: currentState });
  if (currentState === 'ready') socket.emit('update', { state: 'ready', info: lastInfo });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
  createClient();
});
