const OpenAI = require('openai');
const { createLogger } = require('../helpers/logger');

const log = createLogger('GPT');


// Royal phrases with their probability weights (higher number = more likely)
const royalPhrases = [  
  { text: "Kronprinsen mener at", weight: 1 },
  { text: "På slottet sier vi ofte at", weight: 1 },
  { text: "Som monark må jeg si at", weight: 1 },
  { text: "Den kongelige familie tror at", weight: 1 },
  { text: "Både dronningen og jeg er enige i at", weight: 1 }
];

// Function to randomly select if we should include a royal phrase
function shouldIncludeRoyalPhrase() {
  // 40% chance to include a phrase
  return Math.random() < 0.4;
}

// Function to select a random royal phrase
function getRandomRoyalPhrase() {
  // Calculate total weight
  const totalWeight = royalPhrases.reduce((sum, phrase) => sum + phrase.weight, 0);
  
  // Generate random value between 0 and totalWeight
  let random = Math.random() * totalWeight;
  
  // Find the phrase based on weights
  for (const phrase of royalPhrases) {
    random -= phrase.weight;
    if (random <= 0) {
      return phrase.text;
    }
  }
  
  // Fallback (should never happen unless array is empty)
  return royalPhrases[0]?.text || "";
}

// Keep track of conversation history
const conversationHistory = [];
const MAX_HISTORY = 5; // Remember last 5 exchanges

async function chat(text, apiKey) {
  
  try {
    const openai = new OpenAI({ apiKey });
    
    // Prepare messages array with system prompt and history
    const messages = [
      {
        role: "system",
        content: `Du er en Kong Harald av Norge som svarer på norsk. Ikke bruke engelsk eller andre språk.
                  Du skal svare kort og konsist, på en meget dannet og høfelig måte.
                  Det er veldig viktig at du husker alle detaljer fra tidligere i samtalen eller ting som blir nevnt. 
                  Bruk denne informasjonen når du svarer på oppfølgingsspørsmål.`
      },
      ...conversationHistory,
      {
        role: "user",
        content: text
      }
    ];

    if (shouldIncludeRoyalPhrase()) {
      const royalPhrase = getRandomRoyalPhrase();
      log.info(`Including royal phrase: "${royalPhrase}"`);
      
      // Modify the last message (user's message) to ask for including the phrase
      messages[messages.length - 1].content += ` (I svaret ditt, vennligst inkluder frasen "${royalPhrase}" på et passende sted hvis det skulle passe.)`;
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages,
      temperature: 0.7,
      max_tokens: 150
    });

    const assistantResponse = completion.choices[0].message.content;
    
    // Add this exchange to the history
    conversationHistory.push(
      { role: "user", content: text },
      { role: "assistant", content: assistantResponse }
    );

    // Keep only the last N exchanges
    while (conversationHistory.length > MAX_HISTORY * 2) {
      conversationHistory.shift();
    }

    // Debug: log the conversation history
    // The debug method doesn't exist, use info with a DEBUG prefix instead
    log.info('Conversation history', 'DEBUG', conversationHistory);

    return assistantResponse;
    
  } catch (error) {
    log.error('OpenAI API error', error);
    return `Beklager, jeg kunne ikke prosessere forespørselen din: ${error.message}`;
  }
}

module.exports = {
  chat
};

