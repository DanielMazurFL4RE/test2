# GPT-5 Discord Bot

Bot Discord korzystający z **OpenAI GPT-5** (Responses API) z **streamingiem** i opcjonalnym **web search**.
- Auto-rejestracja `/gpt` i `/gpt-reset`
- Reakcja na prefixy: `gemini`, `ricky`, `rick` oraz wzmiankę @bota
- Ustawia swój nick: **Ricky** (jeśli uprawnienia pozwalają)

## Start lokalnie
```bash
npm i
cp .env.example .env
# uzupełnij DISCORD_TOKEN, OPENAI_API_KEY
npm start
```

## Wymagane uprawnienia
- Włącz **Message Content Intent** w Developer Portal.
- Zaproś bota linkiem z scope `bot applications.commands` i uprawnieniami: Send Messages, View Channels (opcjonalnie Read Message History).
