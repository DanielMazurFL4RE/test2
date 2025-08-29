// src/bot.mjs
import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Events,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import OpenAI from 'openai';

/* =========================
   Prefiksy (case-insensitive)
   ========================= */
const PREFIXES = ['gpt', 'julian'];

/* =========================
   ENV checks
   ========================= */
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) { console.error('❌ Missing DISCORD_TOKEN'); process.exit(1); }
if (!DISCORD_TOKEN.includes('.') || DISCORD_TOKEN.trim().length < 50) {
  console.error('❌ DISCORD_TOKEN looks invalid (paste raw bot token without quotes/"Bot ")');
  process.exit(1);
}
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) { console.error('❌ Missing OPENAI_API_KEY'); process.exit(1); }

/* =========================
   Helpers
   ========================= */
function flag(name, def=false) {
  const raw = (process.env[name] ?? '').toString();
  const clean = raw.split('#')[0].replace(/['"]/g,'').trim();
  if (!clean) return def;
  return /^(1|true|t|on|yes|y)$/i.test(clean);
}
function userNickFromInteraction(inter) {
  return inter.member?.nickname || inter.member?.displayName || inter.user?.globalName || inter.user?.username || 'Użytkownik';
}
function userNickFromMessage(msg) {
  return msg.member?.displayName || msg.author?.globalName || msg.author?.username || 'Użytkownik';
}
function chunkForDiscord(text, limit=2000) {
  if ((text||'').length<=limit) return [text||''];
  const out=[]; for(let i=0;i<text.length;i+=limit) out.push(text.slice(i,i+limit)); return out;
}

/* =========================
   OpenAI (Responses API)
   ========================= */
const MODEL = process.env.OPENAI_MODEL || 'gpt-5';
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// poprawne pola:
const DEFAULT_REASONING = (process.env.OPENAI_REASONING || 'low').toLowerCase(); // minimal|low|medium|high
const DEFAULT_VERBOSITY = (process.env.OPENAI_VERBOSITY || '').toLowerCase();    // low|medium|high

function buildToolsFromEnv() {
  const tools = [];
  if (flag('OPENAI_WEB_SEARCH')) tools.push({ type: 'web_search' });
  return tools;
}

function reasoningConfig() {
  return { reasoning: { effort: DEFAULT_REASONING } };
}
function textConfig() {
  if (!/^(low|medium|high)$/.test(DEFAULT_VERBOSITY)) return {};
  return { text: { verbosity: DEFAULT_VERBOSITY } };
}

const JULIAN_PERSONA =
  `Jesteś botem discordowym, który odpowiada jak Julian z „Chłopaków z baraków”.
Odpowiadasz krótko (jedno, maks dwa zdania), ton oschły i rzadko miły.
Zwracaj się po nicku rozmówcy. Jeśli korzystasz z wyszukiwania sieci, nie pokazuj źródeł ani linków.`;

/* Składanie promptu: historia + persona + aktualny rozmówca */
function buildPrompt(userNick, history, userText) {
  const hist = history
    .map(m => (m.role === 'user' ? `User: ${m.text}` : `Assistant: ${m.text}`))
    .join('\n');
  return `${JULIAN_PERSONA}\n\nAktualny rozmówca (nickname): ${userNick}\n\nConversation so far:\n${hist}\n\nUser: ${userText}\nAssistant:`;
}

/* Streaming helper */
async function* streamResponse(input, tools){
  const params = {
    model: MODEL,
    input,
    stream: true,
    ...(tools?.length ? { tools } : {}),
    ...reasoningConfig(),
    ...textConfig(),
  };
  const stream = await openai.responses.create(params);
  let accum = '';
  for await (const ev of stream) {
    if (ev?.type === 'response.output_text.delta') {
      accum += ev.delta || '';
      yield accum;
    }
  }
  return accum;
}

/* =========================
   Komendy (auto-register)
   ========================= */
const commands = [
  new SlashCommandBuilder()
    .setName('gpt')
    .setDescription('Porozmawiaj z GPT-5 (Julian)')
    .addStringOption(o => o.setName('prompt').setDescription('Twoja wiadomość').setRequired(true))
    .addBooleanOption(o => o.setName('ephemeral').setDescription('Pokaż odpowiedź tylko Tobie'))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('gpt-reset')
    .setDescription('Wyczyść Twój kontekst w tym kanale')
    .toJSON()
];
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

/* =========================
   Discord client
   ========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

/* =========================
   Pamięć: per SESJA (kanał + użytkownik)
   ========================= */
const memory = new Map(); // sessionKey -> [{role, text}]
const sessionKeyFromInteraction = (i) => `${i.channelId}:${i.user.id}`;
const sessionKeyFromMessage     = (m) => `${m.channelId}:${m.author.id}`;
const MAX_TURNS = parseInt(process.env.OPENAI_MEMORY_TURNS || '12', 10);

function getHistory(sk){ if(!memory.has(sk)) memory.set(sk, []); return memory.get(sk); }
function pushTurn(sk, role, text){
  const h = getHistory(sk);
  h.push({ role, text });
  memory.set(sk, h.slice(-MAX_TURNS));
}

/* =========================
   Startup: rejestracja komend + nick "Julian"
   ========================= */
async function setBotNicknameInGuild(guild){
  try{
    await guild.members.fetchMe();
    await guild.members.me.setNickname('Julian');
    console.log(`📝 Set nickname "Julian" in ${guild.name} (${guild.id})`);
  }catch(e){
    console.warn(`⚠️ Could not set nickname in ${guild.name} (${guild.id}):`, e?.message || e);
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Zalogowano jako ${c.user.tag}`);
  console.log(`[cfg] model=${MODEL} stream=${flag('OPENAI_STREAM', true)} web_search=${flag('OPENAI_WEB_SEARCH')} reasoning=${DEFAULT_REASONING} verbosity=${DEFAULT_VERBOSITY||'(off)'}`);
  try {
    await c.application?.fetch();
    const appId = c.application.id;
    for (const [, guild] of c.guilds.cache) {
      try {
        await rest.put(Routes.applicationGuildCommands(appId, guild.id), { body: commands });
        console.log(`✅ Commands registered in ${guild.name}`);
      } catch(e){ console.error(`❌ Register in ${guild?.name||guild?.id}:`, e); }
      await setBotNicknameInGuild(guild);
    }
  } catch (e) { console.error('❌ App fetch/register failed:', e); }
});

client.on('guildCreate', async (guild) => {
  try {
    await client.application?.fetch();
    await rest.put(Routes.applicationGuildCommands(client.application.id, guild.id), { body: commands });
    console.log(`✨ Commands added on invite: ${guild.name} (${guild.id})`);
  } catch (e) { console.error('❌ Register on join:', e); }
  await setBotNicknameInGuild(guild);
});

/* =========================
   Obsługa komend
   ========================= */
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const sk = sessionKeyFromInteraction(interaction);

  if (interaction.commandName === 'gpt-reset') {
    memory.delete(sk);
    await interaction.reply({ content: '🧹 Twój kontekst w tym kanale wyczyszczony.', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'gpt') {
    const userPrompt = interaction.options.getString('prompt', true);
    const ephemeral = interaction.options.getBoolean('ephemeral') ?? false;
    await interaction.deferReply({ ephemeral });

    try {
      pushTurn(sk, 'user', userPrompt);
      const hist = getHistory(sk);
      const userNick = userNickFromInteraction(interaction);
      const input = buildPrompt(userNick, hist, userPrompt);
      const tools = buildToolsFromEnv();
      const useStream = flag('OPENAI_STREAM', true);

      if (useStream) {
        let lastShown = '';
        let lastEdit = Date.now();
        for await (const partial of streamResponse(input, tools)) {
          if (Date.now() - lastEdit > 600) {
            await interaction.editReply(partial.slice(0, 1900) || '⏳ …');
            lastEdit = Date.now();
          }
          lastShown = partial;
        }
        const finalText = lastShown || '∅';
        pushTurn(sk, 'model', finalText);
        const chunks = chunkForDiscord(finalText);
        if (chunks.length === 1) await interaction.editReply(chunks[0]);
        else {
          await interaction.editReply(chunks[0] + '\n\n*(odpowiedź była długa — wysyłam resztę w kolejnych wiadomościach)*');
          for (let i=1;i<chunks.length;i++) await interaction.followUp({ content: chunks[i], ephemeral });
        }
      } else {
        const res = await openai.responses.create({
          model: MODEL,
          input,
          ...(tools.length ? { tools } : {}),
          ...reasoningConfig(),
          ...textConfig(),
        });
        const answer = res.output_text ?? res.output?.[0]?.content?.[0]?.text ?? '(brak treści)';
        pushTurn(sk, 'model', answer);
        const chunks = chunkForDiscord(answer);
        await interaction.editReply(chunks[0]);
        for (let i=1;i<chunks.length;i++) await interaction.followUp({ content: chunks[i], ephemeral });
      }
    } catch (err) {
      console.error(err);
      await interaction.editReply(`❌ Błąd: ${String(err?.message || err)}`);
    }
  }
});

/* =========================
   Wiadomości (prefiksy + @mention)
   ========================= */
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot) return;
    if (!client.user) return;

    const raw = (msg.content || '').trim();
    if (!raw) return;

    const mention = new RegExp(`^<@!?${client.user.id}>`);
    const startsWithMention = mention.test(raw);

    const lower = raw.toLowerCase();
    const matchedPrefix = PREFIXES.find(p => lower.startsWith(p));

    if (!startsWithMention && !matchedPrefix) return;

    let prompt = raw;
    if (matchedPrefix) prompt = raw.slice(matchedPrefix.length);
    else if (startsWithMention) prompt = raw.replace(mention, '');
    prompt = prompt.replace(/^[:\-–—,.\s]+/, '').trim();
    if (!prompt) { await msg.reply('Podaj treść po prefiksie (gpt/julian) lub po wzmiance.'); return; }

    await msg.channel.sendTyping();

    const sk = sessionKeyFromMessage(msg);
    pushTurn(sk, 'user', prompt);

    const hist = getHistory(sk);
    const userNick = userNickFromMessage(msg);
    const input = buildPrompt(userNick, hist, prompt);
    const tools = buildToolsFromEnv();
    const useStream = flag('OPENAI_STREAM', true);

    if (useStream) {
      const replyMsg = await msg.reply('⏳ …');
      let lastShown = '';
      let lastEdit = Date.now();
      for await (const partial of streamResponse(input, tools)) {
        if (Date.now() - lastEdit > 900) {
          await replyMsg.edit(partial.slice(0, 2000));
          lastEdit = Date.now();
        }
        lastShown = partial;
      }
      const finalText = lastShown || '∅';
      pushTurn(sk, 'model', finalText);
      if (finalText.length <= 2000) await replyMsg.edit(finalText);
      else {
        await replyMsg.edit(finalText.slice(0, 2000));
        const chunks = chunkForDiscord(finalText).slice(1);
        for (const ch of chunks) await msg.channel.send({ content: ch });
      }
    } else {
      const res = await openai.responses.create({
        model: MODEL,
        input,
        ...(tools.length ? { tools } : {}),
        ...reasoningConfig(),
        ...textConfig(),
      });
      const answer = res.output_text ?? res.output?.[0]?.content?.[0]?.text ?? '(brak treści)';
      pushTurn(sk, 'model', answer);
      const chunks = chunkForDiscord(answer);
      await msg.reply(chunks[0]);
      for (let i=1;i<chunks.length;i++) await msg.channel.send({ content: chunks[i] });
    }
  } catch (e) {
    console.error(e);
    try { await msg.reply('❌ Błąd: ' + (e.message || e)); } catch {}
  }
});

/* =========================
   Start
   ========================= */
client.login(DISCORD_TOKEN);
