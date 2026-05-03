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
const conversaciones = {};

// ── Firebase Admin (opcional) ────────────────────────────────────
// Si tienes FIREBASE_SERVICE_ACCOUNT en Railway, se usa para guardar config/ventas.
// Si no, todo funciona igual pero sin persistencia en Firebase desde el server.
let db = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const admin = require('firebase-admin');
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT.replace(/\n/g, '\\n');
const serviceAccount = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log('✅ Firebase Admin conectado');

    // Cargar config guardada al iniciar
    db.collection('config').doc('bot').get().then(doc => {
      if (doc.exists) {
        const data = doc.data();
        if (data.instructions) botInstructions = data.instructions;
        if (data.serviceNumber) serviceNumber = data.serviceNumber;
        if (data.horario) horario = data.horario;
        console.log('📥 Config restaurada desde Firebase');
        console.log('   serviceNumber:', serviceNumber);
        console.log('   horario:', horario);
      }
    }).catch(e => console.error('Error cargando config:', e.message));
  }
} catch(e) {
  console.log('ℹ️ Firebase Admin no configurado, funcionando sin persistencia de servidor');
  console.log('❌ Error Firebase:', e.message);
  console.log('🔍 Primeros 100 chars de la variable:', process.env.FIREBASE_SERVICE_ACCOUNT ? process.env.FIREBASE_SERVICE_ACCOUNT.substring(0,100) : 'VACÍA');
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
  } catch(e) {
    console.error('Error guardando config:', e.message);
  }
}

async function saveVentaToFirebase(factura) {
  if (!db) return;
  try {
    await db.collection('ventas').add({ ...factura, createdAt: new Date().toISOString() });
    console.log('💾 Venta guardada en Firebase');
  } catch(e) {
    console.error('Error guardando venta:', e.message);
  }
}

// ── Chrome cleanup ───────────────────────────────────────────────
function killChrome() {
  try { execSync('pkill -f chromium || true', { stdio: 'ignore' }); } catch(e) {}
  try { execSync('pkill -f chrome || true', { stdio: 'ignore' }); } catch(e) {}
  try {
    const lockFile = '/app/.wwebjs_auth/session/SingletonLock';
    if (fs.existsSync(lockFile)) { fs.unlinkSync(lockFile); console.log('🔓 Lock file eliminado'); }
  } catch(e) {}
  try {
    execSync('rm -rf /app/.wwebjs_cache/SingletonLock || true', { stdio: 'ignore' });
  } catch(e) {}
}

// ── Crear cliente WhatsApp ───────────────────────────────────────
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
          '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
          '--single-process', '--disable-gpu', '--disable-extensions',
          '--disable-background-networking', '--disable-default-apps',
          '--no-default-browser-check',
        ]
      }
    });

    clientWA.on('qr', async (qr) => {
      console.log('📱 QR generado');
      lastQR = await qrcode.toDataURL(qr);
      currentState = 'qr';
      isCreatingClient = false;
      io.emit('update', { qr: lastQR, state: 'qr' });
    });

    clientWA.on('ready', () => {
      console.log('✅ WhatsApp conectado y listo');
      currentState = 'ready';
      lastInfo = clientWA.info;
      lastQR = null;
      isCreatingClient = false;
      io.emit('update', { state: 'ready', info: lastInfo });
    });

    clientWA.on('authenticated', () => {
      console.log('🔐 Autenticado');
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
      console.log('────────────────────────────────────────');
      console.log('📨 Mensaje de:', msg.from, '| fromMe:', msg.fromMe, '| botActive:', botActive);

      if (msg.fromMe) { console.log('⏭️ Mensaje propio, ignorando'); return; }
      if (!botActive) { console.log('⏸️ Bot pausado'); return; }

      // ── Verificar horario ──────────────────────────────────────
      if (horario) {
        const now = new Date(new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' }));
        const diasMap = { 0: 'dom', 1: 'lun', 2: 'mar', 3: 'mie', 4: 'jue', 5: 'vie', 6: 'sab' };
        const diaActual = diasMap[now.getDay()];
        const horaActual = now.getHours() * 60 + now.getMinutes();
        const [hi, mi] = horario.inicio.split(':').map(Number);
        const [hf, mf] = horario.fin.split(':').map(Number);
        const inicio = hi * 60 + mi;
        const fin = hf * 60 + mf;

        console.log(`🕐 Día: ${diaActual} | Hora: ${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')} | Rango: ${horario.inicio}-${horario.fin}`);
        console.log(`   Días activos: ${horario.dias.join(',')}`);

        if (!horario.dias.includes(diaActual) || horaActual < inicio || horaActual > fin) {
          console.log('🕐 Fuera de horario');
          await msg.reply('Hola, en este momento estamos fuera de horario de atención. Te atenderemos pronto.');
          return;
        }
      }

      const from = msg.from;
      const body = msg.body ? msg.body.trim() : '';
      if (!body) return;

      if (!conversaciones[from]) conversaciones[from] = [];
      conversaciones[from].push({ role: 'user', content: body, time: new Date().toLocaleTimeString('es-CO') });
      io.emit('nuevoMensaje', { from, text: body, role: 'user', time: new Date().toLocaleTimeString('es-CO') });

      console.log('🤖 Enviando a Groq...');

      try {
        const fechaHoy = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
        const systemPrompt = `${botInstructions}

REGLAS DE COMPRA:
1. Cuando el cliente quiera comprar, solicita: Nombre completo, número de teléfono y correo electrónico.
2. Una vez tengas los 3 datos, pregunta: "Para confirmar tu pedido, responde SI"
3. Cuando el cliente responda "SI", responde EXACTAMENTE con este formato y nada más:
FACTURA:{"nombre":"...","telefono":"...","correo":"...","producto":"...","precio":"...","fecha":"${fechaHoy}"}`;

        const messages = [
          { role: 'system', content: systemPrompt },
          ...conversaciones[from].slice(-12)
        ];

        const result = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          messages
        });

        let reply = result.choices[0].message.content;
        console.log('✅ Groq respondió, longitud:', reply.length);

        conversaciones[from].push({ role: 'assistant', content: reply, time: new Date().toLocaleTimeString('es-CO') });
        io.emit('nuevoMensaje', { from, text: reply, role: 'bot', time: new Date().toLocaleTimeString('es-CO') });

        // ── Procesar factura ─────────────────────────────────────
        if (reply.includes('FACTURA:')) {
          console.log('🧾 Factura detectada');
          const jsonStr = reply.split('FACTURA:')[1].trim();
          try {
            const factura = JSON.parse(jsonStr);

            // Enviar al número de servicio
            console.log('📤 Número de servicio configurado:', serviceNumber);
            if (serviceNumber && clientWA) {
              const numLimpio = serviceNumber.replace(/\D/g, '');
              const waId = numLimpio + '@c.us';
              const mensajeFactura = `🧾 *NUEVA VENTA*\n\n*Nombre:* ${factura.nombre}\n*Teléfono:* ${factura.telefono}\n*Correo:* ${factura.correo}\n*Producto:* ${factura.producto}\n*Precio:* ${factura.precio}\n*Fecha:* ${factura.fecha}`;
              await clientWA.sendMessage(waId, mensajeFactura);
              console.log('✅ Factura enviada a:', waId);
            } else {
              console.log('⚠️ No se envió factura - serviceNumber:', serviceNumber, '| clientWA:', !!clientWA);
            }

            // Guardar en Firebase
            await saveVentaToFirebase(factura);
            io.emit('nuevaVenta', factura);

            reply = '✅ *COMPRA CONFIRMADA* 🛒\n⚡ Activación en proceso\n\n✔ Tu acceso será entregado en breve\n✔ Revisa tu correo para recibir los datos\n\n🚨 IMPORTANTE:\n❌ No se hacen cancelaciones después de activar\n\n¡Gracias por confiar en nosotros! 🙌';
          } catch(e) {
            console.error('❌ Error parseando factura:', e.message);
            console.error('   JSON intentado:', reply.split('FACTURA:')[1]);
          }
        }

        await msg.reply(reply);
        console.log('📤 Respuesta enviada a:', from);

      } catch (err) {
        console.error('❌ Error Groq:', err.message);
      }

      console.log('────────────────────────────────────────');
    });

    clientWA.initialize().catch(err => {
      console.error('❌ Error inicializando cliente:', err.message);
      isCreatingClient = false;
      setTimeout(createClient, 8000);
    });

  }, 2000);
}

// ── API ──────────────────────────────────────────────────────────

app.post('/api/configure', async (req, res) => {
  const { instructions, serviceNumber: sn, horario: h } = req.body;
  if (!instructions) return res.status(400).json({ error: 'Instrucciones requeridas' });

  botInstructions = instructions;
  if (sn !== undefined) serviceNumber = sn || null;
  if (h !== undefined) horario = h || null;
  botActive = true;

  console.log('⚙️ Configuración actualizada');
  console.log('   serviceNumber:', serviceNumber);
  console.log('   horario:', horario);

  // Guardar en Firebase
  await saveConfigToFirebase();

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

app.get('/api/config', (req, res) => {
  // El frontend puede pedir la config guardada al cargar
  res.json({
    instructions: botInstructions,
    serviceNumber: serviceNumber || '',
    horario: horario || { dias: ['lun','mar','mie','jue','vie','sab'], inicio: '09:00', fin: '19:00' }
  });
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
  console.log('⏸️ Bot detenido');
  io.emit('update', { botStopped: true });
  res.json({ ok: true });
});

app.post('/api/horario', async (req, res) => {
  horario = req.body;
  console.log('🕐 Horario actualizado:', horario);
  await saveConfigToFirebase();
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.json({ status: 'Chatly Colombia corriendo', state: currentState });
});

io.on('connection', (socket) => {
  console.log('🖥️ Cliente conectado al socket');
  if (lastQR) socket.emit('update', { qr: lastQR, state: currentState });
  if (currentState === 'ready') socket.emit('update', { state: 'ready', info: lastInfo });
  // Enviar config actual al panel
  socket.emit('configData', {
    instructions: botInstructions,
    serviceNumber: serviceNumber || '',
    horario: horario || { dias: ['lun','mar','mie','jue','vie','sab'], inicio: '09:00', fin: '19:00' }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('🟢 Chatly Colombia activo en puerto ' + PORT);
  createClient();
});
