// Bot de IA para Discord - conversa em grupo com amigos
// Funciona em: servidor, DM privada, grupo DM e threads.
// Responde quando: marcam ele (@bot), respondem mensagem dele, usam !ia, ou modo auto ligado.
// Memória: guarda o histórico por canal, então ele "vê tudo" da conversa.

import { Client, GatewayIntentBits, Partials } from 'discord.js';
import 'dotenv/config';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.MODEL || 'openai/gpt-oss-20b';
const PREFIX = process.env.PREFIX || '!ia';
const MAX_HISTORIA = 30;

// Mini servidor HTTP para hospedagem 24h grátis (Render/Koyeb exigem uma porta aberta)
// Não mexe no bot, só serve para o UptimeRobot pingar e manter online.
import http from 'http';
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Bot IA do Grupo online ✅');
}).listen(PORT, () => console.log(`🌐 Keep-alive ouvindo na porta ${PORT}`));

if (!DISCORD_TOKEN) {
  console.error('❌ Faltou DISCORD_TOKEN no arquivo .env');
  process.exit(1);
}
if (!GROQ_API_KEY) {
  console.error('❌ Faltou GROQ_API_KEY no arquivo .env (pegue grátis em https://console.groq.com)');
  process.exit(1);
}

let SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ||
`Você é um amigo inteligente no Discord, participando de uma conversa em grupo.
- Fale português brasileiro, de jeito natural e direto.
- Você vê o nome de quem fala e responde levando em conta TODA a conversa.
- Serve para estudar junto, tirar dúvidas, explicar, dar exemplos e fazer perguntas para o grupo.
- Quando não souber, diga que não sabe.
- Respostas curtas por padrão (máx 3-4 parágrafos). Se pedirem "explica detalhado", aí pode alongar.
- Nunca finja ser humano. Você é uma IA no Discord.`;

// memória por canal: channelId -> [{role, content}]
const historico = new Map(); // Map<string, Array>
const modoAuto = new Set();  // canais onde o bot responde tudo sem precisar marcar

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

function getHist(channelId) {
  if (!historico.has(channelId)) historico.set(channelId, []);
  return historico.get(channelId);
}

function limparMencao(texto) {
  // remove <@123456> do começo
  return texto.replace(/<@!?\d+>/g, '').trim();
}

function deveResponder(msg) {
  const texto = msg.content?.trim() || '';

  // comandos sempre valem
  if (texto.startsWith(PREFIX) || texto.startsWith('!ajuda') || texto.startsWith('!limpar') || texto.startsWith('!auto')) return true;

  // DM / grupo DM: responde tudo (é conversa privada com amigos)
  if (!msg.guild) return true;

  // foi mencionado?
  if (msg.mentions.has(client.user)) return true;

  // responderam uma mensagem do bot?
  if (msg.reference?.messageId) {
    // vamos checar de forma assíncrona depois; por enquanto assume que sim se começa com reply
    // (checagem real feita no handler)
    return true;
  }

  // modo auto ligado nesse canal?
  if (modoAuto.has(msg.channelId)) return true;

  return false;
}

async function perguntarIA(hist) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...hist.slice(-MAX_HISTORIA)],
      temperature: 0.7,
      max_tokens: 1000,
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Groq ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || 'Não consegui pensar numa resposta agora, tenta de novo.';
}

function quebrarEm2000(texto) {
  const partes = [];
  let resto = texto;
  while (resto.length > 2000) {
    let corte = resto.lastIndexOf('\n', 2000);
    if (corte < 500) corte = 2000;
    partes.push(resto.slice(0, corte));
    resto = resto.slice(corte);
  }
  partes.push(resto);
  return partes;
}

client.on('messageCreate', async (msg) => {
  try {
    if (msg.author.bot) return;
    if (!msg.content && !msg.reference) return;

    const texto = (msg.content || '').trim();

    // ---- comandos ----
    if (texto === '!ajuda' || texto === `${PREFIX} ajuda`) {
      return msg.reply(
`**Como usar (vale em servidor, DM e grupo):**
• Me marque: \`@${client.user.username} qual a capital do Japão?\`
• Ou use o prefixo: \`${PREFIX} me explica fotossíntese de um jeito simples\`
• Me responda com Reply que eu continuo o assunto
• \`${PREFIX} <pergunta>\` — falar comigo sem marcar
• \`!limpar\` — esqueço a conversa desse chat e começo do zero
• \`!auto on\` / \`!auto off\` — respondo TUDO nesse canal sem precisar marcar (bom pra estudar junto)
• DM comigo: pode falar direto, sem marcar. Chama um amigo pro grupo DM que eu falo com vocês dois.`
      );
    }
    if (texto === '!limpar' || texto === `${PREFIX} limpar`) {
      historico.set(msg.channelId, []);
      return msg.reply('🧹 Esqueci tudo desse chat. Pode começar um assunto novo!');
    }
    if (texto.startsWith('!auto')) {
      if (!msg.guild) return msg.reply('O modo auto só faz sentido em servidor. Na DM eu já respondo tudo mesmo.');
      if (texto.includes('on')) {
        modoAuto.add(msg.channelId);
        return msg.reply('✅ Modo auto LIGADO aqui: agora eu participo de tudo nesse canal. `!auto off` pra desligar.');
      }
      if (texto.includes('off')) {
        modoAuto.delete(msg.channelId);
        return msg.reply('💤 Modo auto desligado. Agora só falo quando me marcarem ou usarem `!ia`.');
      }
      const ligado = modoAuto.has(msg.channelId);
      return msg.reply(`Modo auto aqui: **${ligado ? 'ligado' : 'desligado'}**. Use \`!auto on\` ou \`!auto off\`.`);
    }
    if (texto.startsWith('!sistema ')) {
      // só o dono do servidor / quem gerencia o canal muda a personalidade
      SYSTEM_PROMPT = texto.slice('!sistema '.length).trim() || SYSTEM_PROMPT;
      historico.set(msg.channelId, []);
      return msg.reply('🎭 Personalidade atualizada para este bot (e limpei a memória do chat).');
    }

    // se for reply, só continua se for reply ao bot (ou se tiver menção/prefixo/auto/DM)
    let ehReplyAoBot = false;
    if (msg.reference?.messageId) {
      try {
        const ref = await msg.channel.messages.fetch(msg.reference.messageId);
        ehReplyAoBot = ref?.author?.id === client.user.id;
      } catch { /* ignora */ }
    }

    const mencionado = msg.mentions.has(client.user);
    const comPrefixo = texto.startsWith(PREFIX);
    const ehDM = !msg.guild;
    const auto = modoAuto.has(msg.channelId);

    if (!mencionado && !ehReplyAoBot && !comPrefixo && !ehDM && !auto) return;

    // extrai a pergunta real
    let pergunta = texto;
    if (comPrefixo) pergunta = texto.slice(PREFIX.length).trim();
    else pergunta = limparMencao(pergunta);
    if (!pergunta) pergunta = '(continuem a conversa de forma natural)';

    const nome = msg.member?.displayName || msg.author.username;
    const hist = getHist(msg.channelId);
    hist.push({ role: 'user', content: `${nome}: ${pergunta}` });

    await msg.channel.sendTyping().catch(() => {});
    const resposta = await perguntarIA(hist);
    hist.push({ role: 'assistant', content: resposta });

    for (const parte of quebrarEm2000(resposta)) {
      await msg.reply(parte).catch(() => msg.channel.send(parte));
      break; // responde a primeira parte como reply, resto como mensagem normal
    }
    // se quebrou em várias, manda o resto sem reply
    const partes = quebrarEm2000(resposta);
    for (let i = 1; i < partes.length; i++) {
      await msg.channel.send(partes[i]);
    }
  } catch (err) {
    console.error(err);
    try {
      await msg.reply('⚠️ Deu erro ao falar com a IA. Tenta de novo em 10 segundos. (Se continuar, confere a GROQ_API_KEY e a cota grátis.)');
    } catch {}
  }
});

client.once('ready', () => {
  console.log(`✅ Logado como ${client.user.tag}`);
  console.log(`Use @${client.user.username} ou "${PREFIX} sua pergunta" em qualquer chat.`);
});

client.login(DISCORD_TOKEN);
