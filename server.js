const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { Server } = require('socket.io');
const Groq = require('groq-sdk');
const qrcode = require('qrcode');
const http = require('http');
const cors = require('cors');
const { execSync } = require('child_process');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Estado en memoria ────────────────────────────────────────────
let botInstructions = 'Eres un asistente de servicio al cliente amable y profesional.';
let serviceNumber = null;
let horario = null;
let clientWA = null;
let currentState = 'disconnected';
let lastQR = null;
let lastInfo = null;
let botActive = true;
let isCreatingClient = false;
let reconnectTimer = null;
let qrCount = 0;           // cuántos QR se han generado en el ciclo actual
let qrExpireTimer = null;  // timer para expirar el QR sin que nadie lo escanee
const conversaciones = {};

// ── Hora Bogotá (UTC-5, sin horario de verano) ───────────────────
function getNowBogota() {
  return new Date(new Date().getTime() + (-5 * 60 * 60000));
}
function getFechaBogota() {
  const now = getNowBogota();
  const d = String(now.getUTCDate()).padStart(2, '0');
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${d}/${m}/${now.getUTCFullYear()}`;
}
function getTimeBogota() {
  const now = getNowBogota();
  return `${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}:${String(now.getUTCSeconds()).padStart(2,'0')}`;
}

// ── Firebase Admin ───────────────────────────────────────────────
let db = null;
try {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (raw) {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
    }
    db = admin.firestore();
    console.log('✅ Firebase Admin conectado');
    db.collection('config').doc('bot').get().then(doc => {
      if (doc.exists) {
        const data = doc.data();
        if (data.instructions) botInstructions = data.instructions;
        if (data.serviceNumber) serviceNumber = data.serviceNumber;
        if (data.horario) horario = data.horario;
        console.log('📥 Config restaurada desde Firebase');
        console.log('   serviceNumber:', serviceNumber);
        console.log('   horario:', JSON.stringify(horario));
      } else {
        console.log('📭 No hay config guardada en Firebase');
      }
    }).catch(e => console.error('❌ Error cargando config:', e.message));
  } else {
    console.log('⚠️ FIREBASE_SERVICE_ACCOUNT no definida');
  }
} catch (e) {
  console.error('❌ Error iniciando Firebase Admin:', e.message);
}

async function saveConfigToFirebase() {
  if (!db) return;
  try {
    await db.collection('config').doc('bot').set({
      instructions: botInstructions,
      serviceNumber: serviceNumber || null,
      horario: horario || null,
      updatedAt: new Date().toISOString()
    });
    console.log('💾 Config guardada en Firebase');
  } catch (e) {
    console.error('❌ Error guardando config:', e.message);
  }
}

async function saveVentaToFirebase(factura) {
  if (!db) return;
  try {
    await db.collection('ventas').add({ ...factura, createdAt: new Date().toISOString() });
    console.log('💾 Venta guardada en Firebase');
  } catch (e) {
    console.error('❌ Error guardando venta:', e.message);
  }
}

// ── Chrome cleanup ───────────────────────────────────────────────
function killChrome() {
  try { execSync('pkill -f chromium || true', { stdio: 'ignore' }); } catch (e) {}
  try { execSync('pkill -f chrome || true', { stdio: 'ignore' }); } catch (e) {}
  try { execSync('pkill -f "Google Chrome" || true', { stdio: 'ignore' }); } catch (e) {}
  const lockPaths = [
    '/app/.wwebjs_auth/session/SingletonLock',
    '/app/.wwebjs_auth/session/SingletonSocket',
    '/app/.wwebjs_auth/session/SingletonCookiesLock',
    '/app/.wwebjs_auth/session/DevToolsActivePort',
    '/app/.wwebjs_cache/SingletonLock',
  ];
  for (const p of lockPaths) {
    try { if (fs.existsSync(p)) { fs.unlinkSync(p); console.log('🔓 Lock eliminado:', p); } } catch (e) {}
  }
}

// ── Obtener path de Chromium ─────────────────────────────────────
function getChromiumPath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    console.log('🔍 Usando PUPPETEER_EXECUTABLE_PATH:', process.env.PUPPETEER_EXECUTABLE_PATH);
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const candidates = [
    '/run/current-system/sw/bin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/snap/bin/chromium',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) { console.log('🔍 Chromium encontrado en:', p); return p; }
  }
  console.log('🔍 Usando Chromium bundled de puppeteer');
  return undefined;
}

// ── Reconexión sin timers duplicados ────────────────────────────
function scheduleReconnect(delayMs = 8000) {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  // No reconectar si ya estamos creando o conectados
  if (isCreatingClient || currentState === 'ready') return;
  console.log(`⏳ Reconectando en ${delayMs / 1000}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    createClient();
  }, delayMs);
}

// ── Verificar horario ────────────────────────────────────────────
function dentroDeHorario() {
  if (!horario) return true;
  const now = getNowBogota();
  const diasMap = { 0: 'dom', 1: 'lun', 2: 'mar', 3: 'mie', 4: 'jue', 5: 'vie', 6: 'sab' };
  const diaActual = diasMap[now.getUTCDay()];
  const horaActual = now.getUTCHours() * 60 + now.getUTCMinutes();
  const [hi, mi] = horario.inicio.split(':').map(Number);
  const [hf, mf] = horario.fin.split(':').map(Number);
  const inicio = hi * 60 + mi;
  const fin = hf * 60 + mf;
  console.log(`🕐 Día: ${diaActual} | Bogotá: ${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')} | Rango: ${horario.inicio}-${horario.fin} | Días: ${horario.dias.join(',')}`);
  return horario.dias.includes(diaActual) && horaActual >= inicio && horaActual <= fin;
}

// ── Destruir cliente actual de forma segura ──────────────────────
async function destroyClient() {
  if (qrExpireTimer) { clearTimeout(qrExpireTimer); qrExpireTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (clientWA) {
    try { await clientWA.destroy(); } catch (e) {}
    clientWA = null;
  }
  lastQR = null;
  currentState = 'disconnected';
  isCreatingClient = false;
  qrCount = 0;
}

// ── Crear cliente WhatsApp ───────────────────────────────────────
function createClient() {
  if (isCreatingClient) {
    console.log('⚠️ Ya se está creando un cliente, ignorando...');
    return;
  }
  if (currentState === 'ready') {
    console.log('✅ Ya conectado, ignorando createClient');
    return;
  }

  isCreatingClient = true;
  qrCount = 0;
  console.log('🚀 Creando cliente WhatsApp...');
  killChrome();

  setTimeout(() => {
    try {
      const executablePath = getChromiumPath();

      clientWA = new Client({
        authStrategy: new LocalAuth({ dataPath: '/app/.wwebjs_auth' }),
        puppeteer: {
          headless: true,
          ...(executablePath ? { executablePath } : {}),
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
            '--disable-features=TranslateUI',
            '--disable-ipc-flooding-protection',
            '--memory-pressure-off',
          ],
          timeout: 60000,
        }
      });

      // ── QR generado ──────────────────────────────────────────
      clientWA.on('qr', async (qr) => {
        qrCount++;
        console.log(`📱 QR generado (intento #${qrCount})`);

        // Si ya van 5 QR sin escanear, reiniciar completamente
        if (qrCount > 5) {
          console.log('⚠️ 5 QR sin escanear — reiniciando cliente...');
          isCreatingClient = false;
          await destroyClient();
          scheduleReconnect(10000);
          return;
        }

        try {
          lastQR = await qrcode.toDataURL(qr);
          currentState = 'qr';
          isCreatingClient = false;
          io.emit('update', { qr: lastQR, state: 'qr' });

          // Timer: si nadie escanea en 60s, refrescar QR (no reiniciar)
          if (qrExpireTimer) clearTimeout(qrExpireTimer);
          qrExpireTimer = setTimeout(() => {
            if (currentState === 'qr') {
              console.log('⏱️ QR expirado sin escanear, esperando nuevo QR de WhatsApp...');
            }
          }, 60000);
        } catch (e) {
          console.error('❌ Error generando QR:', e.message);
        }
      });

      clientWA.on('loading_screen', (percent, message) => {
        console.log(`⏳ Cargando WhatsApp: ${percent}% - ${message}`);
      });

      clientWA.on('authenticated', () => {
        console.log('🔐 Autenticado');
        qrCount = 0;
        if (qrExpireTimer) { clearTimeout(qrExpireTimer); qrExpireTimer = null; }
        currentState = 'connecting';
        io.emit('update', { state: 'connecting' });
      });

      clientWA.on('ready', () => {
        console.log('✅ WhatsApp conectado y listo');
        currentState = 'ready';
        lastInfo = clientWA.info;
        lastQR = null;
        isCreatingClient = false;
        qrCount = 0;
        if (qrExpireTimer) { clearTimeout(qrExpireTimer); qrExpireTimer = null; }
        io.emit('update', { state: 'ready', info: lastInfo });
      });

      clientWA.on('auth_failure', (msg) => {
        console.error('❌ Fallo de autenticación:', msg);
        isCreatingClient = false;
        lastQR = null;
        currentState = 'disconnected';
        io.emit('update', { state: 'disconnected' });
        scheduleReconnect(12000);
      });

      clientWA.on('disconnected', (reason) => {
        console.log('🔌 Desconectado. Razón:', reason);
        isCreatingClient = false;
        lastQR = null;
        currentState = 'disconnected';
        clientWA = null;
        io.emit('update', { state: 'disconnected' });
        scheduleReconnect(6000);
      });

      // ── Mensajes entrantes ───────────────────────────────────
      clientWA.on('message', async (msg) => {
        console.log('────────────────────────────────────────');
        console.log('📨 De:', msg.from, '| fromMe:', msg.fromMe, '| botActive:', botActive);

        if (msg.fromMe) { console.log('⏭️ Propio, ignorando'); return; }
        if (!botActive) { console.log('⏸️ Bot pausado'); return; }

        if (!dentroDeHorario()) {
          console.log('🕐 Fuera de horario');
          await msg.reply('Hola, en este momento estamos fuera de horario de atención. Te atenderemos pronto. 🙏');
          return;
        }

        const from = msg.from;
        const body = msg.body ? msg.body.trim() : '';
        if (!body) return;

        const horaActual = getTimeBogota();
        if (!conversaciones[from]) conversaciones[from] = [];
        conversaciones[from].push({ role: 'user', content: body, time: horaActual });
        io.emit('nuevoMensaje', { from, text: body, role: 'user', time: horaActual });

        console.log('🤖 Enviando a Groq...');
        try {
          const fechaHoy = getFechaBogota();
          const systemPrompt = `${botInstructions}

REGLAS DE COMPRA:
1. Cuando el cliente quiera comprar, solicita: Nombre completo, número de teléfono y correo electrónico.
2. Una vez tengas los 3 datos, pregunta: "Para confirmar tu pedido, responde SI"
3. Cuando el cliente responda "SI", responde EXACTAMENTE con este formato y nada más:
FACTURA:{"nombre":"...","telefono":"...","correo":"...","producto":"...","precio":"...","fecha":"${fechaHoy}"}`;

          // IMPORTANTE: filtrar 'time' — Groq solo acepta role y content
          const messages = [
            { role: 'system', content: systemPrompt },
            ...conversaciones[from].slice(-12).map(({ role, content }) => ({ role, content }))
          ];

          const result = await groq.chat.completions.create({ model: 'llama-3.3-70b-versatile', messages });
          let reply = result.choices[0].message.content;
          console.log('✅ Groq respondió, longitud:', reply.length);

          conversaciones[from].push({ role: 'assistant', content: reply, time: horaActual });
          io.emit('nuevoMensaje', { from, text: reply, role: 'bot', time: horaActual });

          if (reply.includes('FACTURA:')) {
            console.log('🧾 Factura detectada');
            const jsonStr = reply.split('FACTURA:')[1].trim();
            try {
              const factura = JSON.parse(jsonStr);
              if (serviceNumber && clientWA) {
                const waId = serviceNumber.replace(/\D/g, '') + '@c.us';
                const mensajeFactura = `🧾 *NUEVA VENTA*\n\n*Nombre:* ${factura.nombre}\n*Teléfono:* ${factura.telefono}\n*Correo:* ${factura.correo}\n*Producto:* ${factura.producto}\n*Precio:* ${factura.precio}\n*Fecha:* ${factura.fecha}`;
                await clientWA.sendMessage(waId, mensajeFactura);
                console.log('✅ Factura enviada a:', waId);
              }
              await saveVentaToFirebase(factura);
              io.emit('nuevaVenta', factura);
              reply = '✅ *COMPRA CONFIRMADA* 🛒\n⚡ Activación en proceso\n\n✔ Tu acceso será entregado en breve\n✔ Revisa tu correo para recibir los datos\n\n🚨 IMPORTANTE:\n❌ No se hacen cancelaciones después de activar\n\n¡Gracias por confiar en nosotros! 🙌';
            } catch (e) {
              console.error('❌ Error parseando factura:', e.message);
            }
          }

          await msg.reply(reply);
          console.log('📤 Respuesta enviada a:', from);

        } catch (err) {
          console.error('❌ Error Groq:', err.message);
        }
        console.log('────────────────────────────────────────');
      });

      // ── Inicializar ──────────────────────────────────────────
      clientWA.initialize().catch(err => {
        console.error('❌ Error inicializando cliente:', err.message);
        isCreatingClient = false;
        clientWA = null;
        scheduleReconnect(10000);
      });

    } catch (err) {
      console.error('❌ Error creando cliente:', err.message);
      isCreatingClient = false;
      clientWA = null;
      scheduleReconnect(10000);
    }
  }, 3000);
}

// ── API ──────────────────────────────────────────────────────────

app.post('/api/configure', async (req, res) => {
  const { instructions, serviceNumber: sn, horario: h } = req.body;
  if (!instructions) return res.status(400).json({ error: 'Instrucciones requeridas' });
  botInstructions = instructions;
  if (sn !== undefined) serviceNumber = sn || null;
  if (h !== undefined) horario = h || null;
  botActive = true;
  console.log('⚙️ Config actualizada | serviceNumber:', serviceNumber, '| horario:', JSON.stringify(horario));
  await saveConfigToFirebase();
  await destroyClient();
  scheduleReconnect(2000);
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => {
  res.json({ state: currentState, qr: lastQR, info: lastInfo });
});

app.get('/api/config', (req, res) => {
  res.json({
    instructions: botInstructions,
    serviceNumber: serviceNumber || '',
    horario: horario || { dias: ['lun','mar','mie','jue','vie','sab','dom'], inicio: '09:00', fin: '19:00' }
  });
});

app.post('/api/restart', async (req, res) => {
  console.log('🔄 Reiniciando cliente...');
  botActive = true;
  await destroyClient();
  scheduleReconnect(2000);
  res.json({ ok: true });
});

app.post('/api/stop', (req, res) => {
  botActive = false;
  console.log('⏸️ Bot detenido');
  io.emit('update', { botStopped: true });
  res.json({ ok: true });
});

app.post('/api/horario', async (req, res) => {
  horario = req.body;
  console.log('🕐 Horario actualizado:', JSON.stringify(horario));
  await saveConfigToFirebase();
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.json({ status: 'Chatly Colombia corriendo', state: currentState });
});

// ── Socket.IO ────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('🖥️ Cliente conectado al socket');
  // Enviar estado actual al cliente recién conectado
  if (lastQR && currentState === 'qr') {
    socket.emit('update', { qr: lastQR, state: 'qr' });
  } else if (currentState === 'ready') {
    socket.emit('update', { state: 'ready', info: lastInfo });
  } else {
    socket.emit('update', { state: currentState });
  }
  socket.emit('configData', {
    instructions: botInstructions,
    serviceNumber: serviceNumber || '',
    horario: horario || { dias: ['lun','mar','mie','jue','vie','sab','dom'], inicio: '09:00', fin: '19:00' }
  });
});

// ── Arranque ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('🟢 Chatly Colombia activo en puerto ' + PORT);
  createClient();
});
