require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const nodemailer = require("nodemailer");

const app = express();
app.use(bodyParser.json());

// --- Lógica de Cola Única y CONTEXTO AVANZADO para la IA ---
let isAwaitingAIReply = false;
let pendingQueryInfo = null;
let conversationContext = {}; // Memoria para seguir conversaciones por persona
const CONTEXT_TIMEOUT = 3 * 60 * 1000; // 3 minutos de memoria

// --- Diccionarios y Listas de Configuración ---
let lastGreetingTime = {};
const COOLDOWN_PERIOD_MS = 60 * 60 * 1000; // 1 hora

const gruposPermitidos = [
  "573124138249-1633615578@g.us",
  "573144117449-1420163618@g.us",
  "1579546575@g.us",
  "1390082199@g.us",
  "1410194235@g.us",
  "120363043316977258@g.us",
  "120363042095724140@g.us",
  "120363420822895904@g.us" // Grupo de pruebas
];

const respuestasPorGrupo = {
    "573124138249-1633615578@g.us": {
    "caídas las ingestas": "Se procederá a revisar al interno, por favor en paralelo escalarlo al equipo de GSOC para que nos indiquen los ID´s de las rutas.",
    "tenemos degradación": "Se procederá a revisar internamente.",
    "pixelados": "Procederemos a revisarlo.",
    "pixelaciones": "Procederemos a revisarlo.",
    "afectación en": "Se procederá a revisar al interno, por favor en paralelo escalarlo al equipo de GSOC para que nos indiquen los ID´s de las rutas.",
    "degradación de ingestas": "Se procederá a revisar al interno, por favor en paralelo escalarlo al equipo de GSOC para que nos indiquen los ID´s de las rutas.",
    "notamos el enlace intermitente": "Se procederá a revisar, por favor en paralelo escalarlo al equipo de GSOC para que nos indiquen los ID´s de las rutas.",
    "favor de verificar": "Se procederá a revisar, un momento por favor mientras lo revisamos.",
    "pixelaciones en los": "Se procederá a revisar al interno de manera prioritaria, por favor en paralelo escalarlo al equipo de GSOC para que nos indiquen los ID´s de las rutas.",
    "sin trafico": "Se procederá a revisar al interno de manera prioritaria, por favor en paralelo escalarlo al equipo de GSOC para que nos indiquen los ID´s de las rutas.",
    "degradacíon": "Se procederá a revisar al interno, por favor en paralelo escalarlo al equipo de GSOC para que nos indiquen los ID´s de las rutas.",
    },
    "573144117449-1420163618@g.us": {
    "viejo Hugo": "Ok enterado, procedere",
    "Buenos días compañeros cómo va todo": "Buen día todo en orden hasta el momento",
    "afectación de servicio": "procederemos a revisarlo, un momento por favor",
    },
};

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

// --- FUNCIONES DE AYUDA COMPLETAS ---

function enviarMensaje(to, body) {
  if (!body || body.trim() === "") {
    console.log("Se intentó enviar un mensaje vacío. Abortando.");
    return;
  }
  axios.post(process.env.ULTRAMSG_URL, {
      token: process.env.ULTRAMSG_TOKEN,
      to: to,
      body: body,
    })
    .then(response => console.log("Mensaje enviado: ", response.data))
    .catch(error => console.error("Error enviando mensaje: ", error));
}

function enviarEmail(to, subject, text) {
  const mailOptions = { from: process.env.EMAIL_USER, to, subject, text };
  transporter.sendMail(mailOptions, (error, info) => {
    if (error) console.log("Error enviando email: ", error);
    else console.log("Email enviado: " + info.response);
  });
}

function normalizarTexto(texto) {
  if (typeof texto !== 'string') return '';
  return texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

const palabrasSaludo = ["hola", "saludos", "viejo Hugo", "buen dia", "buenas", "buenas tardes", "buenas noches", "buenos dias"];

// MODIFICADO: La función ahora acepta el nombre de la persona para personalizar el saludo.
function obtenerSaludo(pushname) {
  const hora = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota", hour: "2-digit", hour12: false });
  let saludoBase;
  if (hora < 12) {
    saludoBase = "¡Buen día";
  } else if (hora < 18) {
    saludoBase = "¡Buenas tardes";
  } else {
    saludoBase = "¡Buenas noches";
  }
  // Si tenemos un nombre, lo añadimos. Si no, devolvemos el saludo genérico.
  return pushname && pushname !== 'Desconocido' ? `${saludoBase}, ${pushname}!` : `${saludoBase}!`;
}

function esSaludo(mensaje) {
  return palabrasSaludo.some(saludo => normalizarTexto(mensaje).includes(saludo));
}

function puedeSaludar(from, pushname) {
  const uniqueKey = `${from}_${pushname}`;
  const currentTime = new Date().getTime();
  if (!lastGreetingTime[uniqueKey] || currentTime - lastGreetingTime[uniqueKey] > COOLDOWN_PERIOD_MS) {
    lastGreetingTime[uniqueKey] = currentTime;
    return true;
  }
  return false;
}

function obtenerRespuestaEspecifica(mensaje) {
  for (const key in respuestasPorGrupo) {
    const respuestas = respuestasPorGrupo[key];
    for (const [clave, respuesta] of Object.entries(respuestas)) {
      if (normalizarTexto(mensaje).includes(normalizarTexto(clave))) return respuesta;
    }
  }
  return null;
}

function esMencionado(message, botNumber) {
  const normalizedMessage = normalizarTexto(message);
  const alias = ["backoffice tv colombia 📺📡", "@back tv claro", "hugo_romero"];
  if (message.includes(`@${botNumber}`)) return true;
  return alias.some(a => normalizedMessage.includes(normalizarTexto(a)));
}

function consultarIA_via_WhatsApp(userMessage, originalFrom, pushname, conversationHistory = "") {
    const aiWhatsappNumber = process.env.AI_WHATSAPP_NUMBER;
    if (!aiWhatsappNumber) {
        enviarMensaje(originalFrom, "La IA no está configurada correctamente.");
        return;
    }
    if (isAwaitingAIReply) {
        enviarMensaje(originalFrom, "🧑‍💻 Por favor un momento, estoy con otra consulta.");
        return;
    }
    isAwaitingAIReply = true;
    pendingQueryInfo = { from: originalFrom, pushname: pushname };

    const prompt = `Actúa como Hugo Romero, un experto en telecomunicaciones y sistemas operativos. Responde en primera persona y dirígete a tu colega por su nombre. La conversación anterior con esta persona fue: "${conversationHistory}". Ahora, tu colega '${pushname}' te pregunta: "${userMessage}"`;

    console.log(`Enviando a la IA (${aiWhatsappNumber}): "${prompt}"`);
    enviarMensaje(aiWhatsappNumber, prompt);
    
    if (!conversationHistory) {
        enviarMensaje(originalFrom, "🤖 Estamos revisando, un momento por favor...");
    }
}

// --- WEBHOOK ---
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    if (body.event_type === "message_received" && body.data) {

      if (body.data.fromMe) {
        return res.status(200).send("EVENT_RECEIVED_AND_IGNORED");
      }

      const originalMessage = body.data.body || '';
      const from = body.data.from || '';
      const pushname = body.data.pushname || 'Desconocido';
      
      if (!originalMessage || !from) return res.status(200).send("EVENT_RECEIVED_IGNORED");

      const aiWhatsappNumber = process.env.AI_WHATSAPP_NUMBER;
      
      if (from === aiWhatsappNumber) {
          console.log(`Respuesta recibida de la IA: "${originalMessage}"`);
          if (isAwaitingAIReply && pendingQueryInfo) {
              const { from: originalFrom, pushname: originalPushname } = pendingQueryInfo;
              
              const responseWithSignature = `*Para ${originalPushname}:*\n${originalMessage}`;
              enviarMensaje(originalFrom, responseWithSignature);

              const contextKey = `${originalFrom}_${originalPushname}`;
              conversationContext[contextKey] = {
                  lastMessage: originalMessage,
                  timestamp: Date.now()
              };

              isAwaitingAIReply = false;
              pendingQueryInfo = null;
              console.log(`IA ahora está 'disponible'. Contexto guardado para ${originalPushname} en ${originalFrom}.`);
          }
          return res.status(200).send("EVENT_RECEIVED");
      }
      
      const isGroup = from.includes("@g.us");
      const tuNumero = "573134846274"; 

      console.log(`\n--- NUEVO MENSAJE ---`);
      console.log(`Recibido de ${pushname} en ${from}: "${originalMessage}"`);

      const fueMencionado = esMencionado(originalMessage, tuNumero);
      const respuestaEspecifica = obtenerRespuestaEspecifica(originalMessage);
      const esUnSaludoSimple = esSaludo(originalMessage);
      const contextKey = `${from}_${pushname}`;

      if ((isGroup && gruposPermitidos.includes(from)) || !isGroup) {
        
        if (conversationContext[contextKey] && (Date.now() - conversationContext[contextKey].timestamp < CONTEXT_TIMEOUT)) {
            console.log(`Lógica: Detectada continuación de conversación de ${pushname} para IA.`);
            const history = `Mi última respuesta a ${pushname} fue: "${conversationContext[contextKey].lastMessage}"`;
            delete conversationContext[contextKey]; 
            consultarIA_via_WhatsApp(originalMessage, from, pushname, history);
        
        } else if (respuestaEspecifica) {
            console.log("Lógica: Coincidencia con diccionario encontrada.");
            enviarMensaje(from, respuestaEspecifica);
            if (isGroup) {
                enviarEmail("hugo.romero@claro.com.co", `Reporte de '${originalMessage}'`, `Mensaje de ${pushname} en ${from}: ${originalMessage}`);
            }
        
        } else if (fueMencionado) {
            console.log(`Lógica: Mención para IA detectada de ${pushname}.`);
            if (isGroup) {
                enviarEmail("hugo.romero@claro.com.co", `Mención para IA en ${from}`, `Mensaje de ${pushname}: ${originalMessage}`);
            }
            consultarIA_via_WhatsApp(originalMessage, from, pushname);
        
        } else if (esUnSaludoSimple && puedeSaludar(from, pushname)) {
            console.log("Lógica: Saludo simple y personalizado detectado.");
            // MODIFICADO: Se pasa el 'pushname' para personalizar el saludo.
            enviarMensaje(from, obtenerSaludo(pushname));
        }
      }
    }
    res.status(200).send("EVENT_RECEIVED");
  } catch (err) {
    console.error("Error fatal en el webhook:", err);
    res.status(500).send("SERVER_ERROR");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});