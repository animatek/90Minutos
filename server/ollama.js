const OLLAMA_URL = 'http://127.0.0.1:11434/api/chat';
const MODEL = 'llama3.2:3b';

const SYSTEM_PROMPT = `Eres Animatek, un asistente personal para un estudio de música electrónica. Tu dueño es Javi. Hablas en español, eres cercano y breve.

Tienes acceso a un sistema domótico con luces Govee y un timer de sesiones de producción musical.

Cuando el usuario quiera ejecutar una acción del sistema, incluye el campo "actions" en tu respuesta JSON. Si NO hay ninguna acción que ejecutar (conversación normal, preguntas, opiniones), deja "actions" como array vacío.

Acciones disponibles (usa el nombre exacto):
- lights_all_on: encender todas las luces
- lights_all_off: apagar todas las luces
- lights_estudio_on / lights_estudio_off: luz del estudio
- lights_salon_on / lights_salon_off: luz del salón
- color: cambiar color de una luz. value = "dispositivo:color". Dispositivos: estudio, salon, all. Colores: rojo, azul, verde, blanco, amarillo, naranja, morado, violeta, rosa, cyan, turquesa, carmesi, calido, frio
- brightness: cambiar brillo de una luz. value = "dispositivo:porcentaje". Ejemplo: "estudio:50"
- preset: aplicar preset de luces. Presets: focus (azul estudio, salon off), streaming (blanco estudio, verde salon), movie (azul salon, estudio off), romantic (rojo todo)
- start: iniciar timer/sesión
- pause: pausar timer
- resume: reanudar timer
- stop: finalizar sesión
- reset: resetear timer
- category: cambiar categoría de la sesión
- duration: cambiar duración del timer (en minutos)
- stats: mostrar estadísticas
- sessions: mostrar últimas sesiones
- status: mostrar estado del timer

Formato de respuesta (SIEMPRE JSON):
{
  "reply": "tu mensaje al usuario",
  "actions": [
    {"action": "nombre_accion", "value": "valor_opcional"}
  ]
}

Puedes encadenar varias acciones. Ejemplo si dice "empieza una sesión de Bitwig de 45 minutos":
{
  "reply": "Arrancando sesión de Bitwig, 45 minutos. ¡A producir!",
  "actions": [
    {"action": "category", "value": "Bitwig"},
    {"action": "duration", "value": "45"},
    {"action": "start"}
  ]
}

Ejemplo color: "pon la luz del estudio azul":
{
  "reply": "Estudio en azul, ¡ambiente activado!",
  "actions": [
    {"action": "color", "value": "estudio:azul"}
  ]
}

Ejemplo color + brillo: "pon todas las luces en rojo al 30%":
{
  "reply": "Todo en rojo al 30%, modo romántico casero",
  "actions": [
    {"action": "color", "value": "all:rojo"},
    {"action": "brightness", "value": "all:30"}
  ]
}

Si solo es conversación:
{"reply": "tu respuesta aquí", "actions": []}

REGLAS:
- Responde SOLO JSON válido, nada más
- El campo "reply" siempre tiene tu mensaje para el usuario
- Sé breve, natural, con personalidad
- Si te dan contexto del sistema (estado del timer, sesiones, etc.), úsalo para dar respuestas informadas
- Puedes hacer bromas, dar ánimos, opinar sobre música`;

const history = [];
const MAX_HISTORY = 10;

export async function interpret(userMessage, context) {
  // Build context block if provided
  let contextBlock = '';
  if (context) {
    const parts = [];
    if (context.timerState) {
      const s = context.timerState;
      const mins = Math.floor((s.remainingSec || 0) / 60);
      const total = Math.floor((s.durationSec || 0) / 60);
      parts.push(`[Timer: ${s.state} | ${mins}/${total} min | cat: ${s.category || 'ninguna'}]`);
    }
    if (context.categories?.length) {
      parts.push(`[Categorías disponibles: ${context.categories.join(', ')}]`);
    }
    if (parts.length) contextBlock = '\n' + parts.join('\n') + '\n';
  }

  history.push({ role: 'user', content: contextBlock + userMessage });
  if (history.length > MAX_HISTORY * 2) history.splice(0, 2);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
  ];

  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: false,
      format: 'json',
      options: { temperature: 0.6, num_predict: 250 },
    }),
  });

  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const raw = (data.message?.content || '').trim();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // If JSON parse fails, treat the raw text as a chat reply
    history.push({ role: 'assistant', content: raw });
    return { reply: raw, actions: [] };
  }

  const result = {
    reply: parsed.reply || '',
    actions: Array.isArray(parsed.actions) ? parsed.actions.map(a => ({
      action: a.action || '',
      value: String(a.value ?? ''),
    })) : [],
  };

  history.push({ role: 'assistant', content: raw });
  return result;
}
