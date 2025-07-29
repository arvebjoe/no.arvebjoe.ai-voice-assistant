const OpenAI = require('openai');
const { createLogger } = require('../helpers/logger');

const log = createLogger('GPT');


const conversationHistory = []; // Keep track of conversation history
const MAX_HISTORY = 5; // Remember last 5 exchanges

async function chat(text, apiKey, deviceList) {
  
  try {
    const openai = new OpenAI({ apiKey });
        
    const messages = [
      {
        role: "system",
        content: `Du er en Kong Harald av Norge som svarer på Norsk. Ikke bruke Engelsk eller andre språk.
                  Du skal svare kort og konsist, på en meget dannet og høfelig måte.
                  Det er veldig viktig at du husker alle detaljer fra tidligere i samtalen eller ting som blir nevnt. 
                  Bruk denne informasjonen når du svarer på oppfølgingsspørsmål.
                  
                  Du er også i stand til å automatisere smarte hjem-enheter i hjemmet mitt.
                  Du kan slå av og på lys, justere temperaturer, låse dører osv.
                  Du kan også fortelle tilstanden til enheter i hjemmet mitt.

                  Jeg vil gi deg tilstanden til hjemmet mitt i dette formatet:
                  
                  Linjeformater:              
                  Z|Sonenavn|Sone-ID|ForeldreSone-ID # Zone - Definerer en sone og dens overordnede sone
                  D|Enhetsnavn|Enhets-ID|Enhets-type|readonly_cap=verdi # Device - Enhet i forrige sone, forteller hvilen type enhet dette er. Med valgfri skrivebeskyttet kapasiteter (0 til mange)
                  C|Kapasitet-ID|Verdi  # Capability - Skrivbar kapasitet for den forrige enheten

                  Kapasiteter:
                  - onoff: boolsk (true/false) for strømtilstand
                  - dim: tall (0–1) for lysstyrke
                  - light_temperature: tall (0–1) for varm/kald fargetemperatur
                  - light_hue: tall (0–1) for fargetone
                  - light_saturation: tall (0–1) for fargemetning
                  - light_mode: tekststreng (color/temperature)
                  - measure_battery: skrivebeskyttet tall (0–100)
                  - measure_temperature: skrivebeskyttet tall
                  - alarm_motion: skrivebeskyttet boolsk
                  - locked: boolsk for låser
                  - volume_set: tall (0–1)
                  - volume_mute: boolsk                  

                  Svarformat:
                  Når du skal gi ditt svar tilbake gjør du dette på følgende måte:

                  Svarformat (strengt JSON):
                  {
                    "speech": "<en høflig setning du kan leses høyt>",
                    "actions": [
                        {
                            "deviceName": "enhets‑navn",
                            "zoneName": "sone‑navn",
                            "deviceId": "enhets‑id",
                            "capability": "kapasitet‑id",
                            "value": ny‑verdi
                        }
                    ]
                  }
                  Ingen andre felter, ingen kommentarer. 
                  Merk at noen ganger kan du bli spurt om ting som ikke har med smart hjem å gjøre, da lar du feltet "actions" være tomt.
                  Husk at det kan være flere enheter i samme sone, så se nøye igjennom alle enhenter i sone for å finne alle riktige enheter.
                  `
      },
      { 
        role: "system",           
        content: deviceList 
      },
      ...conversationHistory,
      {
        role: "user",
        content: text
      }
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", // "gpt-3.5-turbo",
      messages,
      temperature: 0.7,
      max_tokens: 300,
      response_format: { type: "json_object" } 
    });

    const raw = completion.choices[0].message.content;
    log.info(`OpenAI raw:`, null, raw);


    const response = JSON.parse(raw);
    log.info(`OpenAI response:`, null, response);
    
    
    // Add this exchange to the history
    conversationHistory.push(
      { role: "user", content: text },
      { role: "assistant", content: response.speech  }
    );

    // Keep only the last N exchanges
    while (conversationHistory.length > MAX_HISTORY * 2) {
      conversationHistory.shift();
    }
    
    return response;
    
  } catch (error) {
    log.error('OpenAI API error', error);
    return `Beklager, jeg kunne ikke prosessere forespørselen din: ${error.message}`;
  }
}

module.exports = {
  chat
};

