'use strict';
//const HomeyClient = require('./homey-client');
const {Agent, tool, setDefaultOpenAIKey, run } = require('@openai/agents');
const z = require('zod');
require('dotenv').config();

class OpenAIAgent {
    constructor(homeyClient) {
        this.homeyClient = homeyClient;
      
    }


    async initialize() {
        
    }    
}

async function main2() {

  console.log('OpenAI Agent starting...');
    //const client = new HomeyClient('192.168.0.99', 7709);
    //await client.initialize();

    
    setDefaultOpenAIKey(process.env.OPENAI_API_KEY); 

    const getWeatherTool = tool({
        name: 'get_weather',
        description: 'Get the weather for a given city',
        parameters: z.object({ city: z.string() }),
        async execute({ city }) {
            console.log(`Executing get_weather tool for city: ${city}`);
            return `The weather in ${city} is sunny.`;
        },
    });

    const historyFunFact = tool({
        // The name of the tool will be used by the agent to tell what tool to use.
        name: 'history_fun_fact',
        // The description is used to describe **when** to use the tool by telling it **what** it does.
        description: 'Give a fun fact about a historical event',
        // This tool takes no parameters, so we provide an empty Zod Object.
        parameters: z.object({}),
        execute: async () => {
            console.log('Executing history fun fact tool...');
            // The output will be returned back to the Agent to use
            return 'Sharks are older than trees.';
        },
    });    

    const agent = new Agent({
        name: 'History Tutor',
        instructions: 'You provide assistance with historical queries. Explain important events and context clearly.',
        // Adding the tool to the agent
        tools: [getWeatherTool, historyFunFact],
    });    
    
    console.log('Running agent...');
    const result = await run(agent, 'How is the weather in Paris?');
    console.log(result.finalOutput);
    console.log('Agent run completed.');
/*
    const agent = new OpenAIAgent(client);
    await agent.initialize();
    const response = await agent.sendMessage('Hello, world!');
    console.log(response);*/
}


main2();

module.exports = OpenAIAgent;



//@tag:nextEditSuggestions


/*

https://openai.github.io/openai-agents-js/guides/quickstart/

import { Agent, run } from '@openai/agents';

const historyTutorAgent = new Agent({
  name: 'History Tutor',
  instructions:
    'You provide assistance with historical queries. Explain important events and context clearly.',
});

const mathTutorAgent = new Agent({
  name: 'Math Tutor',
  instructions:
    'You provide help with math problems. Explain your reasoning at each step and include examples',
});

const triageAgent = new Agent({
  name: 'Triage Agent',
  instructions:
    "You determine which agent to use based on the user's homework question",
  handoffs: [historyTutorAgent, mathTutorAgent],
});

async function main() {
  const result = await run(triageAgent, 'What is the capital of France?');
  console.log(result.finalOutput);
}

main().catch((err) => console.error(err));

*/