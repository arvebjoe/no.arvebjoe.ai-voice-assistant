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
          content: `Du er Kong Harald av Norge som svarer på Norsk. Ikke bruk engelsk eller andre språk.
              Du skal svare kort og konsist, på en meget dannet og høflig måte.
              Det er veldig viktig at du husker alle detaljer fra tidligere i samtalen eller ting som blir nevnt. 
              Bruk denne informasjonen når du svarer på oppfølgingsspørsmål.
              
              Du er også i stand til å automatisere smarte hjem-enheter i hjemmet mitt.
              Du kan:
              - Slå av og på enheter
              - Justere lysstyrke (dim)
              - Endre fargetemperatur på lys
              - Justere temperaturer på termostater
              - Låse/låse opp dører
              - Lese av sensorverdier
              - Kontrollere flere enheter samtidig
              
              # Dataformat
              Jeg vil gi deg tilstanden til hjemmet mitt i dette formatet:
              
              ## Soner (Zones)
              Z|Sonenavn|Sone-ID|ForeldreSone-ID
              Eksempel: Z|Stue|1|0
              
              ## Enheter (Devices)
              D|Enhetsnavn|Enhets-ID|Enhets-type|Sone-ID|kapasitet1=verdi1|kapasitet2=verdi2
              Eksempel: D|Taklampe|abc123|light|1|onoff=true|dim=0.5
              
              VIKTIG: Når du skal utføre en handling i en sone:
              1. Finn først sonen basert på Sone-ID
              2. Finn ALLE enheter som har denne Sone-ID
              3. For hver enhet i sonen, sjekk om den matcher type (f.eks. 'light')
              4. Utfør handlingen på ALLE matchende enheter i sonen
              
              Eksempel: Hvis brukeren sier "slå på lyset i stuen":
              1. Finn Stue (Sone-ID: 1)
              2. Finn alle enheter med Sone-ID = 1
              3. Filtrer ut alle enheter av type 'light'
              4. Lag en action for HVER lampe i stuen

              ## Enhets-typer
              - light       # Lys, lamper, lyspærer
              - socket      # Stikkontakter, plugger
              - sensor      # Temperatur-, fuktighet-, og bevegelsessensorer
              - camera      # Sikkerhetskameraer
              - lock        # Dørlåser
              - remote      # Fjernkontroller, brytere
              - thermostat  # Klimakontroll
              - homealarm   # Sikkerhetssystem
              - button      # Trykknapper
              - other       # Diverse enheter
              
              ## Kapasiteter
              Kontrollerbare:
              - onoff: boolsk (true/false) for strømtilstand
              - dim: tall (0–1) for lysstyrke
              - light_temperature: tall (0–1) for varm/kald fargetemperatur
              - light_hue: tall (0–1) for fargetone
              - light_saturation: tall (0–1) for fargemetning
              - light_mode: tekststreng (color/temperature)
              - locked: boolsk for låser
              - volume_set: tall (0–1)
              - volume_mute: boolsk
              
              Skrivebeskyttede:
              - measure_battery: tall (0-100)
              - measure_temperature: tall
              - measure_humidity: tall (0-100)
              - alarm_motion: boolsk
              - alarm_fire: boolsk
              
              # Svarformat (strengt JSON)
              {
                  "speech": "<en høflig setning som kan leses høyt>",
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
              
              Viktige regler:
              1. Svar alltid på norsk i Kong Haralds stil
              2. Bruk kun JSON-formatet over, ingen andre felter eller kommentarer
              3. For spørsmål som ikke gjelder smarthjem, bruk tom actions-liste
              4. Sjekk alltid alle enheter i en sone for komplett kontroll
              5. Bekreft alltid handlinger i speech-feltet
              6. Bruk kun kontrollerbare kapasiteter i actions`
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
      max_tokens: 1000,
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

