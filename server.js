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
let serviceNumber = null;
let clientWA = null;
let currentState = 'disconnected';
let lastQR = null;
let lastInfo = null;
let botActive = true;

const conversaciones = {};

function createClient() {
  clientWA = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-accelerated-2d-canvas','--no-first-run','--no-zygote','--single-process','--disable-gpu']
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
    if (!botActive) return;

    const from = msg.from;
    const body = msg.body.trim();

    if (!conversaciones[from]) {
      conversaciones[from] = { historial: [], fase: 'chat' };
    }

    const conv = conversaciones[from];
    conv.historial.push({ role: 'user', content: body });

    try {
      const systemPrompt = `${botInstructions}

REGLAS IMPORTANTES:
1. Cuando el cliente quiera comprar algo, debes recopilar esta informacion en orden:
   - Nombre completo
   - Numero de telefono
   - Correo electronico
   - Producto o servicio que desea comprar
   - Confirmar el precio final
2. Una vez tengas todos esos datos, pregunta: "Para confirmar tu pedido, responde SI"
3. Cuando el cliente responda "SI" para confirmar, responde EXACTAMENTE con este formato JSON y nada mas:
FACTURA:{"nombre":"...","telefono":"...","correo":"...","producto":"...","precio":"...","fecha":"${new Date().toLocaleDateString('es-CO')}"}
4. Si el cliente no quiere comprar, atiendelo normalmente segun tus instrucciones.`;

      const messages = [
        { role: 'system', content: systemPrompt },
        ...conv.historial.slice(-10)
      ];

      const result = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages
      });

      let reply = result.choices[0].message.content;
      conv.historial.push({ role: 'assistant', content: reply });

      if (reply.includes('FACTURA:')) {
        const jsonStr = reply.split('FACTURA:')[1].trim();
        try {
          const factura = JSON.parse(jsonStr);
          const mensajeFactura = `🧾 *NUEVA VENTA*\n\n*Nombre:* ${factura.nombre}\n*Teléfono:* ${factura.telefono}\n*Correo:* ${factura.correo}\n*Producto:* ${factura.producto}\n*Precio:* ${factura.precio}\n*Fecha:* ${factura.fecha}`;

          if (serviceNumber && clientWA) {
            const numLimpio = serviceNumber.replace(/\D/g, '');
            await clientWA.sendMessage(numLimpio + '@c.us', mensajeFactura);
            console.log('Factura enviada a:', serviceNumber);
          }

          io.emit('nuevaVenta', factura);
          reply = 'Tu pedido ha sido confirmado. Pronto nos pondremos en contacto contigo. Gracias por tu compra.';
          conv.fase = 'completado';
        } catch (e) {
          console.error('Error parseando factura:', e.message);
        }
      }

      await msg.reply(reply);
      console.log('Respondido a:', from);

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
  const { instructions, serviceNumber: sn } = req.body;
  if (!instructions) return res.status(400).json({ error: 'Instrucciones requeridas' });
  botInstructions = instructions;
  if (sn) serviceNumber = sn;
  botActive = true;
  console.log('Instrucciones actualizadas. Numero servicio:', serviceNumber);
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
  botActive = true;
  setTimeout(createClient, 1000);
  res.json({ ok: true });
});

app.post('/api/stop', (req, res) => {
  botActive = false;
  console.log('Bot detenido');
  io.emit('update', { botStopped: true });
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
  console.log('Servidor activo en puerto ' + PORT);
  createClient();
});
