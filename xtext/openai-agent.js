'use strict';
const HomeyClient = require('./homey-client');
const {Agent, tool, setDefaultOpenAIKey } = require('@openai/agents');
const z = require('zod');
require('dotenv').config();

const fetch = require('node-fetch');

class OpenAIAgent {
    constructor(homeyClient) {
        this.homeyClient = homeyClient;
      
    }


    async initialize() {
        
    }    
}

async function main() {

    const client = new HomeyClient('192.168.0.99', 7709);
    await client.initialize();

    setDefaultOpenAIKey(process.env.OPENAI_API_KEY); 

    const getWeatherTool = tool({
        name: 'get_weather',
        description: 'Get the weather for a given city',
        parameters: z.object({ city: z.string() }),
        async execute({ city }) {
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

/*
    const agent = new OpenAIAgent(client);
    await agent.initialize();
    const response = await agent.sendMessage('Hello, world!');
    console.log(response);*/
}


main();

module.exports = OpenAIAgent;



//@tag:nextEditSuggestions