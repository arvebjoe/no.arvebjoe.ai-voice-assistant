'use strict';
//const HomeyClient = require('./homey-client');
const {Agent, setDefaultOpenAIKey, run } = require('@openai/agents');
const createTools = require('./open-ai-tools.js');
require('dotenv').config();

class OpenAIAgent {
    constructor() {
		this.toolsPromise = null;
		this.tools = null;
		this.agent = null;
		this.thread = []; 
    }

    async initialize() {
        this.toolsPromise = createTools();			
    	setDefaultOpenAIKey(process.env.OPENAI_API_KEY); 
    } 

	async run(input) {

		if (!this.tools) {
			this.tools = await this.toolsPromise;
		}

		if(!this.agent){
			
			this.agent = new Agent({
					name: 'Smart Home Assistant',
					model: 'gpt-4.1-nano',//'gpt-3.5-turbo',
					instructions: `
						You are a helpful smart home assistant. You can control devices in the user's home using the tools provided.
						When the user asks to control a device:

						1. First check what types of devices are available using getAllDeviceTypes()
						2. If needed, check what zones exist using getZones()
						3. Find the relevant devices using getSmartHomeDevices(). Zone and Type are optional, but can help narrow down the search. But if  you don't know the zone or type, you can leave them empty.
						4. Control the devices using setDeviceCapability()
						5. If the user asks about the weather, use getWeatherTool()
						6. If the user asks for a fun fact, use historyFunFact()

			
						Common device capabilities:
						- lights: "onoff" (true/false), "dim" (0-1)
						- locks: "locked" (true/false)
						- thermostats: "target_temperature" (number)
						- plugs/sockets: "onoff" (true/false)

						Respond in a natural, helpful way. After completing an action, confirm what you did in a friendly manner.
						If you can't find a matching device or the request is unclear, ask for clarification.
						If the user asks a question unrelated to home automation, just answer normally without using the tools.
						Always start by determining whether the request involves smart home control or is just a general question.
					`,
					// Adding the tool to the agent
					tools: Object.values(this.tools),
			});
		}

		this.thread.push({ role: 'user', content: input });

		const result = await run(this.agent, this.thread);
		
		this.thread = result.history;

		return result.finalOutput;
	}
		
}

async function main2() {

	console.log('OpenAI Agent starting...');

	const client = new OpenAIAgent();
	await client.initialize();
	//const response = await client.run('Slå av alle lys som er på i 2. etasje, med unntak for badet');
	//console.log('Response from OpenAI Agent:', response);

	const response2 = await client.run('Hva er klokka i Norge?');
	console.log('Response from OpenAI Agent:', response2);	
	console.log('--------------------');


	const response3 = await client.run('Og hva er hovedstaden der?');
	console.log('Response from OpenAI Agent:', response3);
	
	//const response4 = await client.run('Lås døra');
	//console.log('Response from OpenAI Agent:', response4);

	console.log('Agent run completed.');
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