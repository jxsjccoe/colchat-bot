const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { Server } = require('socket.io');
const Groq = require('groq-sdk');
const qrcode = require('qrcode');
const http = require('http');
const cors = require('cors');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

let botInstructions = 'Eres un asistente de servicio al cliente amable y profesional.';
let serviceNumber = null;
let horario = null;
let clientWA = null;
let currentState = 'disconnected';
let lastQR = null;
let lastInfo = null;
let botActive = true;
let isCreatingClient = false;

const conversaciones = {};

function killChrome() {
  try { execSync('pkill -f chromium || true', { stdio: 'ignore' }); } catch(e) {}
  try { execSync('pkill -f chrome || true', { stdio: 'ignore' }); } catch(e) {}
  try {
    const lockFile = '/app/.wwebjs_auth/session/SingletonLock';
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
      console.log('🔓 Lock file eliminado');
    }
  } catch(e) {}
  try {
    const cacheDir = '/app/.wwebjs_cache';
    if (fs.existsSync(cacheDir)) {
      execSync('rm -rf ' + cacheDir + '/SingletonLock || true', { stdio: 'ignore' });
    }
  } catch(e) {}
}

function createClient() {
  if (isCreatingClient) {
    console.log('⚠️ Ya se está creando un cliente, ignorando...');
    return;
  }
  isCreatingClient = true;
  console.log('🚀 Creando cliente WhatsApp...');

  killChrome();

  setTimeout(() => {
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
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--no-default-browser-check',
        ]
      }
    });

    clientWA.on('qr', async (qr) => {
      console.log('📱 QR generado - escanea con WhatsApp');
      lastQR = await qrcode.toDataURL(qr);
      currentState = 'qr';
      isCreatingClient = false;
      io.emit('update', { qr: lastQR, state: 'qr' });
    });

    clientWA.on('ready', () => {
      console.log('✅ WhatsApp conectado y listo para recibir mensajes');
      currentState = 'ready';
      lastInfo = clientWA.info;
      lastQR = null;
      isCreatingClient = false;
      io.emit('update', { state: 'ready', info: lastInfo });
    });

    clientWA.on('authenticated', () => {
      console.log('🔐 Autenticado correctamente');
      currentState = 'connecting';
      io.emit('update', { state: 'connecting' });
    });

    clientWA.on('auth_failure', (msg) => {
      console.error('❌ Fallo de autenticación:', msg);
      currentState = 'disconnected';
      isCreatingClient = false;
    });

    clientWA.on('disconnected', (reason) => {
      console.log('🔌 Desconectado. Razón:', reason);
      currentState = 'disconnected';
      lastQR = null;
      isCreatingClient = false;
      io.emit('update', { state: 'disconnected' });
      console.log('⏳ Reconectando en 5 segundos...');
      setTimeout(createClient, 5000);
    });

    clientWA.on('message', async (msg) => {
      // ── LOGS DE DIAGNÓSTICO ──────────────────────────────────────
      console.log('────────────────────────────────────────');
      console.log('📨 Mensaje recibido');
      console.log('   De:', msg.from);
      console.log('   Texto:', msg.body);
      console.log('   fromMe:', msg.fromMe);
      console.log('   botActive:', botActive);
      console.log('   Estado bot:', currentState);
      // ────────────────────────────────────────────────────────────

      if (msg.fromMe) {
        console.log('⏭️ Ignorando mensaje propio');
        return;
      }

      if (!botActive) {
        console.log('⏸️ Bot pausado, no se responde');
        return;
      }

      // Verificar horario
      if (horario) {
        const now = const now = new Date(new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' }));
        const diasMap = { 0: 'dom', 1: 'lun', 2: 'mar', 3: 'mie', 4: 'jue', 5: 'vie', 6: 'sab' };
        const diaActual = diasMap[now.getDay()];
        const horaActual = now.getHours() * 60 + now.getMinutes();
        const [hi, mi] = horario.inicio.split(':').map(Number);
        const [hf, mf] = horario.fin.split(':').map(Number);
        const inicio = hi * 60 + mi;
        const fin = hf * 60 + mf;

        console.log('🕐 Verificando horario - Día:', diaActual, '| Hora actual (min):', horaActual, '| Rango:', inicio, '-', fin);

        if (!horario.dias.includes(diaActual) || horaActual < inicio || horaActual > fin) {
          console.log('🕐 Fuera de horario, enviando mensaje de horario');
          await msg.reply('Hola, en este momento estamos fuera de horario de atención. Te atenderemos pronto.');
          return;
        }
      }

      const from = msg.from;
      const body = msg.body.trim();

      if (!conversaciones[from]) conversaciones[from] = [];
      conversaciones[from].push({ role: 'user', content: body, time: new Date().toLocaleTimeString('es-CO') });

      io.emit('nuevoMensaje', { from, text: body, role: 'user', time: new Date().toLocaleTimeString('es-CO') });

      console.log('🤖 Enviando a Groq...');

      try {
        const systemPrompt = `${botInstructions}

REGLAS DE COMPRA:
1. Cuando el cliente quiera comprar, solicita: Nombre completo, número de teléfono y correo electrónico.
2. Una vez tengas los 3 datos, pregunta: "Para confirmar tu pedido, responde SI"
3. Cuando el cliente responda "SI", responde EXACTAMENTE con este formato y nada más:
FACTURA:{"nombre":"...","telefono":"...","correo":"...","producto":"...","precio":"...","fecha":"${new Date().toLocaleDateString('es-CO')}"}`;

        const messages = [
          { role: 'system', content: systemPrompt },
          ...conversaciones[from].slice(-12)
        ];

        const result = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages
        });

        let reply = result.choices[0].message.content;
        console.log('✅ Respuesta de Groq obtenida, longitud:', reply.length);

        conversaciones[from].push({ role: 'assistant', content: reply, time: new Date().toLocaleTimeString('es-CO') });
        io.emit('nuevoMensaje', { from, text: reply, role: 'bot', time: new Date().toLocaleTimeString('es-CO') });

        if (reply.includes('FACTURA:')) {
          console.log('🧾 Factura detectada, procesando...');
          const jsonStr = reply.split('FACTURA:')[1].trim();
          try {
            const factura = JSON.parse(jsonStr);
            const mensajeFactura = `🧾 *NUEVA VENTA - STREAMSHOP*\n\n*Nombre:* ${factura.nombre}\n*Teléfono:* ${factura.telefono}\n*Correo:* ${factura.correo}\n*Producto:* ${factura.producto}\n*Precio:* ${factura.precio}\n*Fecha:* ${factura.fecha}`;

            if (serviceNumber && clientWA) {
              const numLimpio = serviceNumber.replace(/\D/g, '');
              await clientWA.sendMessage(numLimpio + '@c.us', mensajeFactura);
              console.log('📤 Factura enviada a:', serviceNumber);
            }

            io.emit('nuevaVenta', factura);
            reply = '✅ *COMPRA CONFIRMADA* 🛒\n⚡ Activación en proceso\n\n✔ Tu acceso será entregado en breve\n✔ Revisa tu correo para recibir los datos\n\n🚨 IMPORTANTE:\n❌ No se hacen cancelaciones después de activar\n\n¡Gracias por confiar en STREAMSHOP! 🙌';
          } catch(e) {
            console.error('❌ Error parseando factura:', e.message);
          }
        }

        await msg.reply(reply);
        console.log('📤 Respuesta enviada a:', from);

      } catch (err) {
        console.error('❌ Error Groq:', err.message);
        console.error('   Stack:', err.stack);
      }

      console.log('────────────────────────────────────────');
    });

    clientWA.initialize().catch(err => {
      console.error('❌ Error inicializando cliente:', err.message);
      isCreatingClient = false;
      console.log('⏳ Reintentando en 8 segundos...');
      setTimeout(createClient, 8000);
    });

  }, 2000);
}

app.post('/api/configure', (req, res) => {
  const { instructions, serviceNumber: sn, horario: h } = req.body;
  if (!instructions) return res.status(400).json({ error: 'Instrucciones requeridas' });
  botInstructions = instructions;
  if (sn) serviceNumber = sn;
  if (h) horario = h;
  botActive = true;
  console.log('⚙️ Configuracion actualizada');
  if (clientWA) { clientWA.destroy().catch(() => {}); clientWA = null; }
  lastQR = null;
  currentState = 'disconnected';
  isCreatingClient = false;
  setTimeout(createClient, 2000);
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => {
  res.json({ state: currentState, qr: lastQR, info: lastInfo });
});

app.post('/api/restart', (req, res) => {
  console.log('🔄 Reiniciando cliente...');
  if (clientWA) { clientWA.destroy().catch(() => {}); clientWA = null; }
  lastQR = null;
  currentState = 'disconnected';
  isCreatingClient = false;
  botActive = true;
  setTimeout(createClient, 2000);
  res.json({ ok: true });
});

app.post('/api/stop', (req, res) => {
  botActive = false;
  console.log('⏸️ Bot detenido manualmente');
  io.emit('update', { botStopped: true });
  res.json({ ok: true });
});

app.post('/api/horario', (req, res) => {
  horario = req.body;
  console.log('🕐 Horario actualizado:', horario);
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.json({ status: 'Chatly Colombia corriendo', state: currentState });
});

io.on('connection', (socket) => {
  console.log('🖥️ Cliente conectado al socket');
  if (lastQR) socket.emit('update', { qr: lastQR, state: currentState });
  if (currentState === 'ready') socket.emit('update', { state: 'ready', info: lastInfo });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('🟢 Chatly Colombia activo en puerto ' + PORT);
  createClient();
});
