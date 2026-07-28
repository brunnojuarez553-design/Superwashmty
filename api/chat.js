// /api/chat.js
// Función serverless de Vercel: motor conversacional del asistente de Super Wash MTY.
// Recibe el historial del chat + los datos ya recolectados, habla con Groq (Llama 3.3 70B)
// y devuelve { reply, collected, ready } para que el frontend siga la conversación
// y muestre el botón de WhatsApp cuando ya tenga todo lo necesario para agendar.
//
// Variables de entorno requeridas en Vercel (Project Settings → Environment Variables):
//   GROQ_API_KEY     -> obligatoria
//   OPENAI_API_KEY   -> opcional, se usa solo si Groq falla (fallback)

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const OPENAI_MODEL = 'gpt-4o-mini';

// Campos que el asistente necesita reunir antes de habilitar el botón de WhatsApp.
const REQUIRED_FIELDS = ['nombre', 'vehiculo', 'servicio', 'fecha'];

// Catálogo real del sitio, para que el asistente recomiende y cotice de forma consistente
// con lo que el cliente ya vio en la web (no tiene que inventar precios).
const CATALOGO = `
Catálogo y precios de referencia (MXN):
- Autos: exterior $200, completo $250, motor $300.
- SUV chica: desde $250. SUV grande: desde $350.
- Pickups: 2 puertas desde $350, 4 puertas desde $400.
- Vehículos especiales (RZR, Jeep modificado, chasis/lubricación): se cotiza según el caso.
- Servicio a domicilio: disponible en Monterrey, sujeto a zona de cobertura; precio se confirma según ubicación y vehículo.
Sucursal: Av. Revolución #401, Jardines del Contry, Monterrey, Nuevo León.
`.trim();

function buildSystemPrompt(collected) {
  return `
Eres el asistente virtual de Super Wash MTY, un lavado de autos y auto detailing premium en Monterrey, México.
Hablas como una persona real que atiende WhatsApp: cálida, natural, directa, con modismos mexicanos suaves
("oye", "va", "sale", "checamos", "de una"). Nunca suenas a formulario, a bot corporativo ni repites frases
robóticas como "para continuar necesito los siguientes datos". Platicas como platicaría un asesor de confianza.
Usa siempre tuteo (tú/tienes/quieres), nunca voseo.

${CATALOGO}

TU OBJETIVO
Ayudar al cliente a agendar su lavado, reuniendo de forma conversacional y sin que se note que es un
formulario, estos 4 datos:
- nombre: cómo se llama.
- vehiculo: qué vehículo tiene (con marca/modelo/color si lo comenta; si no, al menos el tipo: auto, SUV, pickup, etc.).
- servicio: qué servicio quiere o le conviene (puedes recomendarle según lo que cuente y el catálogo de arriba).
- fecha: cuándo le gustaría el turno (día y horario aproximado, no hace falta que sea exacto ni una fecha formal).

REGLAS DE CONVERSACIÓN
1. Haz como máximo UNA pregunta por mensaje. Nunca pidas dos datos juntos.
2. Nunca vuelvas a preguntar un dato que ya está en "datos ya recolectados" más abajo, salvo que el cliente
   lo mencione de nuevo o quiera corregirlo.
3. Si el cliente pregunta precios, servicios, ubicación u horarios, responde con la info real de arriba,
   breve, y después sigue naturalmente la charla hacia agendar el turno.
4. Si el cliente se desvía del tema, responde con calidez a lo que preguntó y llévalo de vuelta, sin presionar.
5. Mensajes cortos: 1 a 3 frases, como un mensaje real de WhatsApp, nunca un párrafo largo tipo email.
6. Nunca inventes datos que el cliente no dijo. Si algo no quedó claro, pregúntalo de nuevo con otras palabras.
7. Cuando ya tengas los 4 datos completos, avísale de forma natural y breve que ya tienes todo para pasarlo
   a confirmar por WhatsApp (algo como "Perfecto, con eso ya quedamos, ahora sí lo mandamos por WhatsApp
   para confirmar el horario 👇"). Marca "ready": true SOLO en ese mensaje o después de tenerlos todos.
8. Si el cliente ya escribió un saludo o mensaje inicial, responde de forma cálida y arranca pidiendo
   el primer dato que falte, sin sonar a checklist.

DATOS YA RECOLECTADOS HASTA AHORA (no los vuelvas a pedir si ya tienen valor):
${JSON.stringify(collected)}

FORMATO DE RESPUESTA — MUY IMPORTANTE
Respondé ÚNICAMENTE con un JSON válido, sin texto antes ni después, sin backticks ni markdown, con esta
forma exacta:
{"reply": "tu respuesta natural para mostrarle al cliente", "collected": {"nombre": "", "vehiculo": "", "servicio": "", "fecha": ""}, "ready": false}

- En "collected" incluí SIEMPRE los 4 campos, combinando lo que ya se sabía con lo nuevo que el cliente
  acaba de decir. Si un campo todavía no se sabe, dejalo como string vacío "".
- "ready" es true únicamente cuando los 4 campos tienen contenido real (ninguno vacío) Y ya se lo confirmaste
  al cliente en el "reply" de este mismo mensaje.
`.trim();
}

function safeParseModelJSON(raw) {
  if (!raw) return null;
  let text = raw.trim();
  // Por si el modelo igual manda el JSON envuelto en ```json ... ```
  text = text.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(text);
  } catch (e) {
    // Último intento: rescatar el primer bloque { ... } del texto.
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e2) { return null; }
    }
    return null;
  }
}

function mergeCollected(prev, next) {
  const merged = { ...prev };
  REQUIRED_FIELDS.forEach((field) => {
    const value = next && typeof next[field] === 'string' ? next[field].trim() : '';
    if (value) merged[field] = value;
  });
  return merged;
}

function isComplete(collected) {
  return REQUIRED_FIELDS.every((field) => collected[field] && collected[field].trim().length > 0);
}

async function callModel(url, apiKey, model, systemPrompt, history) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-16) // limitamos el historial para no pasarnos de tokens en charlas largas
      .map((m) => ({ role: m.role, content: m.content })),
  ];

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.6,
      max_tokens: 350,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Model request failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : null;

  return content;
}

async function getModelReply(systemPrompt, history) {
  const groqKey = process.env.GROQ_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  // Intento 1: Groq (con un reintento corto ante fallos transitorios).
  if (groqKey) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const content = await callModel(GROQ_URL, groqKey, GROQ_MODEL, systemPrompt, history);
        if (content) return content;
      } catch (err) {
        if (attempt === 1) {
          // Se agotaron los reintentos con Groq, seguimos al fallback si existe.
          console.error('Groq falló:', err.message);
        } else {
          await new Promise((r) => setTimeout(r, 400));
        }
      }
    }
  }

  // Intento 2: fallback a OpenAI si está configurado.
  if (openaiKey) {
    try {
      const content = await callModel(OPENAI_URL, openaiKey, OPENAI_MODEL, systemPrompt, history);
      if (content) return content;
    } catch (err) {
      console.error('OpenAI (fallback) falló:', err.message);
    }
  }

  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const history = Array.isArray(body.messages) ? body.messages : [];
    const incomingCollected = body.collected && typeof body.collected === 'object' ? body.collected : {};

    const collectedSoFar = mergeCollected(
      { nombre: '', vehiculo: '', servicio: '', fecha: '' },
      incomingCollected
    );

    const systemPrompt = buildSystemPrompt(collectedSoFar);
    const rawContent = await getModelReply(systemPrompt, history);

    if (!rawContent) {
      res.status(200).json({
        reply: 'Uy, se me complicó la conexión un toque. ¿Me repetís lo último que me dijiste?',
        collected: collectedSoFar,
        ready: false,
      });
      return;
    }

    const parsed = safeParseModelJSON(rawContent);

    if (!parsed || typeof parsed.reply !== 'string') {
      // El modelo no devolvió el JSON esperado: mostramos algo razonable en vez de romper el chat.
      res.status(200).json({
        reply: rawContent.slice(0, 500),
        collected: collectedSoFar,
        ready: false,
      });
      return;
    }

    const mergedCollected = mergeCollected(collectedSoFar, parsed.collected || {});
    const ready = Boolean(parsed.ready) && isComplete(mergedCollected);

    res.status(200).json({
      reply: parsed.reply,
      collected: mergedCollected,
      ready,
    });
  } catch (err) {
    console.error('Error en /api/chat:', err);
    res.status(200).json({
      reply: 'Uy, tuve un problema técnico. ¿Podés intentar de nuevo en un segundo?',
      collected: { nombre: '', vehiculo: '', servicio: '', fecha: '' },
      ready: false,
    });
  }
};
